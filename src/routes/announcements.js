'use strict';

const express = require('express');
const { transaction } = require('../db');
const { HttpError, now, str, intParam } = require('../util');
const perm = require('../permissions');
const { serializeAnnouncements } = require('../serialize');

const ANNOUNCEMENT_SELECT = `
  SELECT a.*, u.display_name AS author_name,
         (SELECT COUNT(*) FROM announcement_reads r WHERE r.announcement_id = a.id) AS read_count,
         EXISTS (SELECT 1 FROM announcement_reads r WHERE r.announcement_id = a.id AND r.user_id = ?) AS read_by_me
    FROM announcements a LEFT JOIN users u ON u.id = a.user_id`;

module.exports = function announcementRoutes({ db, rt, uploader }) {
  const router = express.Router();

  function getAnnouncement(id, userId) {
    const a = db.prepare(`${ANNOUNCEMENT_SELECT} WHERE a.id = ?`).get(userId, id);
    if (!a || !perm.getMembership(db, a.group_id, userId)) throw new HttpError(404, 'アナウンスが見つかりません');
    return a;
  }

  router.get('/groups/:gid/announcements', (req, res) => {
    const gid = intParam(req.params.gid);
    perm.requireMember(db, gid, req.user.id);
    const rows = db.prepare(`${ANNOUNCEMENT_SELECT} WHERE a.group_id = ? ORDER BY a.id DESC LIMIT 100`).all(req.user.id, gid);
    const memberCount = db.prepare('SELECT COUNT(*) AS n FROM group_members WHERE group_id = ?').get(gid).n;
    res.json({ announcements: serializeAnnouncements(db, rows), memberCount });
  });

  const canPost = (req, _res, next) => {
    const gid = intParam(req.params.gid);
    perm.requireMember(db, gid, req.user.id);
    if (!perm.canAnnounce(db, gid, req.user.id))
      throw new HttpError(403, 'アナウンスを送信できるのはリーダー以上の権限を持つメンバーのみです');
    req.groupId = gid;
    next();
  };

  router.post('/groups/:gid/announcements', canPost, uploader.imagesMiddleware, (req, res) => {
    const files = req.files || [];
    const title = str(req.body?.title, 'タイトル', { min: 1, max: 100 });
    const body = str(req.body?.body ?? '', '本文', { max: 4000 });
    const id = transaction(db, () => {
      const { lastInsertRowid } = db
        .prepare('INSERT INTO announcements (group_id, user_id, title, body, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(req.groupId, req.user.id, title, body, now());
      const aid = Number(lastInsertRowid);
      // 送信者本人は既読扱い
      db.prepare('INSERT INTO announcement_reads (announcement_id, user_id, read_at) VALUES (?, ?, ?)').run(aid, req.user.id, now());
      uploader.saveAttachments(db, files, { announcementId: aid });
      return aid;
    });
    const [announcement] = serializeAnnouncements(db, [getAnnouncement(id, req.user.id)]);
    rt.toGroup(req.groupId, 'announcement:new', { ...announcement, readByMe: false });
    res.status(201).json({ announcement });
  });

  router.post('/announcements/:aid/read', (req, res) => {
    const a = getAnnouncement(intParam(req.params.aid), req.user.id);
    db.prepare('INSERT OR IGNORE INTO announcement_reads (announcement_id, user_id, read_at) VALUES (?, ?, ?)').run(
      a.id,
      req.user.id,
      now(),
    );
    const readCount = db.prepare('SELECT COUNT(*) AS n FROM announcement_reads WHERE announcement_id = ?').get(a.id).n;
    rt.toGroup(a.group_id, 'announcement:read', { id: a.id, groupId: a.group_id, readCount });
    res.json({ ok: true, readCount });
  });

  /** 既読者・未読者の一覧(送信者と管理者のみ) */
  router.get('/announcements/:aid/reads', (req, res) => {
    const a = getAnnouncement(intParam(req.params.aid), req.user.id);
    if (a.user_id !== req.user.id && !perm.getMembership(db, a.group_id, req.user.id).isAdmin) {
      throw new HttpError(403, '既読状況を確認できるのは送信者と管理者のみです');
    }
    const rows = db
      .prepare(
        `SELECT u.id, u.display_name, r.read_at FROM group_members gm
           JOIN users u ON u.id = gm.user_id
           LEFT JOIN announcement_reads r ON r.announcement_id = ? AND r.user_id = gm.user_id
          WHERE gm.group_id = ? ORDER BY r.read_at IS NULL, u.display_name`,
      )
      .all(a.id, a.group_id);
    res.json({ reads: rows.map((r) => ({ id: r.id, displayName: r.display_name, readAt: r.read_at })) });
  });

  router.delete('/announcements/:aid', (req, res) => {
    const a = getAnnouncement(intParam(req.params.aid), req.user.id);
    if (a.user_id !== req.user.id && !perm.getMembership(db, a.group_id, req.user.id).isAdmin) {
      throw new HttpError(403, '削除できるのは送信者と管理者のみです');
    }
    db.prepare('DELETE FROM announcements WHERE id = ?').run(a.id);
    rt.toGroup(a.group_id, 'announcement:deleted', { id: a.id, groupId: a.group_id });
    res.json({ ok: true });
  });

  // ---- 添付画像の配信(閲覧権限を確認してから返す) ----

  router.get('/attachments/:id', (req, res) => {
    const att = db.prepare('SELECT * FROM attachments WHERE id = ?').get(intParam(req.params.id));
    if (!att) throw new HttpError(404, 'ファイルが見つかりません');
    if (att.message_id) {
      const msg = db.prepare('SELECT channel_id FROM messages WHERE id = ?').get(att.message_id);
      perm.requireChannelPermission(db, msg.channel_id, req.user.id, 'read');
    } else {
      const a = db.prepare('SELECT group_id FROM announcements WHERE id = ?').get(att.announcement_id);
      if (!a || !perm.getMembership(db, a.group_id, req.user.id)) throw new HttpError(404, 'ファイルが見つかりません');
    }
    res.setHeader('Content-Type', att.mime_type);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    const disposition = req.query.download ? 'attachment' : 'inline';
    res.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(att.original_name)}`);
    if (!att.data) throw new HttpError(404, 'ファイルが見つかりません');
    res.end(Buffer.from(att.data));
  });

  return router;
};
