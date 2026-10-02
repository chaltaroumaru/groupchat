'use strict';

const express = require('express');
const { transaction } = require('../db');
const { HttpError, now, str, intParam, bool } = require('../util');
const perm = require('../permissions');
const { serializeMessages, MESSAGE_SELECT } = require('../serialize');
const { membersOf } = require('./groups');

const PERMISSIONS = ['read', 'write'];

function channelRoles(db, channelId) {
  return db
    .prepare('SELECT role_id, permission FROM channel_roles WHERE channel_id = ? ORDER BY role_id')
    .all(channelId)
    .map((r) => ({ roleId: r.role_id, permission: r.permission }));
}

function serializeChannel(db, ch, userId) {
  return {
    id: ch.id,
    groupId: ch.group_id,
    name: ch.name,
    description: ch.description,
    restricted: !!ch.restricted,
    defaultPermission: ch.default_permission,
    roles: channelRoles(db, ch.id),
    myPermission: perm.resolveChannelPermission(db, ch, userId).permission,
  };
}

module.exports = function channelRoutes({ db, rt, uploader }) {
  const router = express.Router();

  const channelsChanged = (groupId) => rt.toGroup(groupId, 'channels:changed', { groupId });

  /** リクエストからチャット設定を読み取る(partial = 更新時は省略可) */
  function channelInput(gid, body, partial) {
    const out = {};
    if (!partial || body.name !== undefined) out.name = str(body.name, 'チャット名', { min: 1, max: 40 });
    if (body.description !== undefined) out.description = str(body.description, '説明', { max: 200 });
    if (body.restricted !== undefined) out.restricted = bool(body.restricted);
    if (body.defaultPermission !== undefined) {
      if (!PERMISSIONS.includes(body.defaultPermission)) throw new HttpError(400, '既定の権限が不正です');
      out.defaultPermission = body.defaultPermission;
    }
    if (body.roles !== undefined) {
      if (!Array.isArray(body.roles)) throw new HttpError(400, 'ロールの指定が不正です');
      const valid = new Set(
        db
          .prepare('SELECT id FROM roles WHERE group_id = ?')
          .all(gid)
          .map((r) => r.id),
      );
      const seen = new Map();
      for (const r of body.roles) {
        const roleId = intParam(r && r.roleId, 'ロールID');
        if (!valid.has(roleId)) throw new HttpError(400, '存在しないロールが指定されています');
        if (!PERMISSIONS.includes(r.permission)) throw new HttpError(400, 'ロールの権限が不正です');
        seen.set(roleId, r.permission);
      }
      out.roles = [...seen].map(([roleId, permission]) => ({ roleId, permission }));
    }
    return out;
  }

  function writeChannelRoles(channelId, roles) {
    db.prepare('DELETE FROM channel_roles WHERE channel_id = ?').run(channelId);
    const ins = db.prepare('INSERT INTO channel_roles (channel_id, role_id, permission) VALUES (?, ?, ?)');
    for (const r of roles) ins.run(channelId, r.roleId, r.permission);
  }

  // ---- チャット ----

  router.get('/groups/:gid/channels', (req, res) => {
    const gid = intParam(req.params.gid);
    perm.requireMember(db, gid, req.user.id);
    const channels = db
      .prepare('SELECT * FROM channels WHERE group_id = ? ORDER BY id')
      .all(gid)
      .map((ch) => serializeChannel(db, ch, req.user.id))
      .filter((ch) => ch.myPermission !== 'none');
    res.json({ channels });
  });

  router.post('/groups/:gid/channels', (req, res) => {
    const gid = intParam(req.params.gid);
    perm.requireAdmin(db, gid, req.user.id);
    const input = channelInput(gid, req.body, false);
    if (input.restricted && !(input.roles && input.roles.length)) {
      throw new HttpError(400, '制限付きチャットには閲覧できるロールを1つ以上指定してください');
    }
    const id = transaction(db, () => {
      const { lastInsertRowid } = db
        .prepare(
          `INSERT INTO channels (group_id, name, description, restricted, default_permission, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(gid, input.name, input.description ?? '', input.restricted ? 1 : 0, input.defaultPermission ?? 'write', req.user.id, now());
      const cid = Number(lastInsertRowid);
      writeChannelRoles(cid, input.roles ?? []);
      return cid;
    });
    channelsChanged(gid);
    res.status(201).json({ channel: serializeChannel(db, perm.getChannel(db, id), req.user.id) });
  });

  router.patch('/channels/:cid', (req, res) => {
    const ch = perm.getChannel(db, intParam(req.params.cid));
    perm.requireAdmin(db, ch.group_id, req.user.id);
    const input = channelInput(ch.group_id, req.body, true);
    const restricted = input.restricted ?? !!ch.restricted;
    const roles = input.roles ?? channelRoles(db, ch.id);
    if (restricted && roles.length === 0) throw new HttpError(400, '制限付きチャットには閲覧できるロールを1つ以上指定してください');
    transaction(db, () => {
      db.prepare('UPDATE channels SET name = ?, description = ?, restricted = ?, default_permission = ? WHERE id = ?').run(
        input.name ?? ch.name,
        input.description ?? ch.description,
        restricted ? 1 : 0,
        input.defaultPermission ?? ch.default_permission,
        ch.id,
      );
      if (input.roles) writeChannelRoles(ch.id, input.roles);
    });
    channelsChanged(ch.group_id);
    res.json({ channel: serializeChannel(db, perm.getChannel(db, ch.id), req.user.id) });
  });

  router.delete('/channels/:cid', (req, res) => {
    const ch = perm.getChannel(db, intParam(req.params.cid));
    perm.requireAdmin(db, ch.group_id, req.user.id);
    const files = db
      .prepare('SELECT a.stored_name FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.channel_id = ?')
      .all(ch.id);
    db.prepare('DELETE FROM channels WHERE id = ?').run(ch.id);
    uploader.removeStored(files.map((f) => f.stored_name));
    channelsChanged(ch.group_id);
    res.json({ ok: true });
  });

  // ---- 参加者と権限 ----

  router.get('/channels/:cid/members', (req, res) => {
    const { channel } = perm.requireChannelPermission(db, intParam(req.params.cid), req.user.id, 'read');
    const isAdmin = perm.getMembership(db, channel.group_id, req.user.id).isAdmin;
    const overrides = new Map(
      db
        .prepare('SELECT user_id, permission FROM channel_member_permissions WHERE channel_id = ?')
        .all(channel.id)
        .map((o) => [o.user_id, o.permission]),
    );
    const members = membersOf(db, channel.group_id)
      .map((m) => {
        const eff = perm.resolveChannelPermission(db, channel, m.id);
        return {
          id: m.id,
          displayName: m.displayName,
          roleIds: m.roleIds,
          isAdmin: m.isAdmin,
          permission: eff.permission,
          source: eff.source,
          // 個別設定の有無は管理者だけに見せる
          override: isAdmin ? (overrides.get(m.id) ?? null) : undefined,
        };
      })
      // 管理者以外には参加者(閲覧可能なメンバー)のみ表示
      .filter((m) => isAdmin || m.permission !== 'none');
    res.json({ members });
  });

  /** 参加者の権限を個別に設定する。permission = null で個別設定を解除(ロール・既定値に従う) */
  router.put('/channels/:cid/members/:uid', (req, res) => {
    const ch = perm.getChannel(db, intParam(req.params.cid));
    perm.requireAdmin(db, ch.group_id, req.user.id);
    const uid = intParam(req.params.uid);
    const target = perm.getMembership(db, ch.group_id, uid);
    if (!target) throw new HttpError(404, 'メンバーが見つかりません');
    const p = req.body.permission;
    if (p === null) {
      db.prepare('DELETE FROM channel_member_permissions WHERE channel_id = ? AND user_id = ?').run(ch.id, uid);
    } else {
      if (!['none', 'read', 'write'].includes(p)) throw new HttpError(400, '権限の指定が不正です');
      if (target.isAdmin) throw new HttpError(400, '管理者は常に全てのチャットを閲覧・送信できます');
      db.prepare(
        `INSERT INTO channel_member_permissions (channel_id, user_id, permission) VALUES (?, ?, ?)
         ON CONFLICT (channel_id, user_id) DO UPDATE SET permission = excluded.permission`,
      ).run(ch.id, uid, p);
    }
    channelsChanged(ch.group_id);
    const eff = perm.resolveChannelPermission(db, ch, uid);
    res.json({ permission: eff.permission, source: eff.source });
  });

  // ---- メッセージ ----

  router.get('/channels/:cid/messages', (req, res) => {
    const { channel } = perm.requireChannelPermission(db, intParam(req.params.cid), req.user.id, 'read');
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const before = req.query.before ? intParam(req.query.before) : Number.MAX_SAFE_INTEGER;
    const rows = db
      .prepare(`${MESSAGE_SELECT} WHERE m.channel_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?`)
      .all(channel.id, before, limit)
      .reverse();
    res.json({ messages: serializeMessages(db, rows), hasMore: rows.length === limit });
  });

  // 送信権限を確認してから画像を受け取る
  const canSend = (req, _res, next) => {
    req.channelCtx = perm.requireChannelPermission(db, intParam(req.params.cid), req.user.id, 'write');
    next();
  };

  router.post('/channels/:cid/messages', canSend, uploader.imagesMiddleware, (req, res) => {
    const { channel } = req.channelCtx;
    const files = req.files || [];
    let id;
    try {
      const body = str(req.body?.body ?? '', 'メッセージ', { max: 4000 });
      if (!body && files.length === 0) throw new HttpError(400, 'メッセージか画像を入力してください');
      id = transaction(db, () => {
        const { lastInsertRowid } = db
          .prepare('INSERT INTO messages (channel_id, user_id, body, created_at) VALUES (?, ?, ?, ?)')
          .run(channel.id, req.user.id, body, now());
        const mid = Number(lastInsertRowid);
        uploader.saveAttachments(db, files, { messageId: mid });
        return mid;
      });
    } catch (err) {
      uploader.cleanup(files);
      throw err;
    }
    const [message] = serializeMessages(db, [db.prepare(`${MESSAGE_SELECT} WHERE m.id = ?`).get(id)]);
    rt.toUsers(perm.channelReaderIds(db, channel), 'message:new', message);
    res.status(201).json({ message });
  });

  router.delete('/messages/:mid', (req, res) => {
    const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(intParam(req.params.mid));
    if (!msg) throw new HttpError(404, 'メッセージが見つかりません');
    const { channel } = perm.requireChannelPermission(db, msg.channel_id, req.user.id, 'read');
    const isAdmin = perm.getMembership(db, channel.group_id, req.user.id).isAdmin;
    if (msg.user_id !== req.user.id && !isAdmin) throw new HttpError(403, '自分のメッセージのみ削除できます');
    const files = db.prepare('SELECT stored_name FROM attachments WHERE message_id = ?').all(msg.id);
    db.prepare('DELETE FROM messages WHERE id = ?').run(msg.id);
    uploader.removeStored(files.map((f) => f.stored_name));
    rt.toUsers(perm.channelReaderIds(db, channel), 'message:deleted', { id: msg.id, channelId: channel.id });
    res.json({ ok: true });
  });

  return router;
};
