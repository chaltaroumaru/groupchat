'use strict';

const express = require('express');
const QRCode = require('qrcode');
const { transaction } = require('../db');
const { HttpError, now, inviteCode, str, intParam } = require('../util');
const perm = require('../permissions');

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** グループ作成時に用意するロール */
const DEFAULT_ROLES = [
  { name: '管理者', color: '#ef4444', level: 'admin' },
  { name: 'リーダー', color: '#f97316', level: 'moderator' },
  { name: '閲覧のみ', color: '#6b7280', level: 'read' },
];

function rolesOf(db, groupId) {
  return db
    .prepare('SELECT id, name, color, level FROM roles WHERE group_id = ? ORDER BY id')
    .all(groupId)
    .map((r) => ({ id: r.id, name: r.name, color: r.color, level: r.level }));
}

function membersOf(db, groupId) {
  const group = db.prepare('SELECT owner_id FROM groups WHERE id = ?').get(groupId);
  const members = db
    .prepare(
      `SELECT u.id, u.display_name, u.email, gm.joined_at
         FROM group_members gm JOIN users u ON u.id = gm.user_id
        WHERE gm.group_id = ? ORDER BY gm.joined_at`,
    )
    .all(groupId);
  const roleRows = db
    .prepare('SELECT mr.user_id, mr.role_id, r.level FROM member_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.group_id = ?')
    .all(groupId);
  const rolesByUser = new Map();
  for (const r of roleRows) {
    if (!rolesByUser.has(r.user_id)) rolesByUser.set(r.user_id, []);
    rolesByUser.get(r.user_id).push(r);
  }
  return members.map((m) => {
    const roles = rolesByUser.get(m.id) || [];
    const isOwner = m.id === group.owner_id;
    const level = perm.levelFromRoles(
      roles.map((r) => r.level),
      isOwner,
    );
    return {
      id: m.id,
      displayName: m.display_name,
      email: m.email,
      isOwner,
      level,
      isAdmin: level === 'admin',
      roleIds: roles.map((r) => r.role_id),
      joinedAt: m.joined_at,
    };
  });
}

function createInviteCode(db) {
  for (;;) {
    const code = inviteCode();
    if (!db.prepare('SELECT 1 FROM groups WHERE invite_code = ?').get(code)) return code;
  }
}

function addMember(db, groupId, userId) {
  db.prepare('INSERT INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)').run(groupId, userId, now());
}

module.exports = function groupRoutes({ db, rt, config }) {
  const router = express.Router();

  /** 開くとそのままグループに参加できる招待リンク */
  const inviteUrl = (code) => `${config.baseUrl}/?invite=${encodeURIComponent(code)}`;

  /** グループ構成(メンバー・ロール・権限)が変わったことを全員に通知する */
  const changed = (groupId) => rt.toGroup(groupId, 'group:changed', { groupId });

  router.get('/', (req, res) => {
    const groups = db
      .prepare(
        `SELECT g.id, g.name, g.description
           FROM groups g JOIN group_members gm ON gm.group_id = g.id
          WHERE gm.user_id = ? ORDER BY g.created_at`,
      )
      .all(req.user.id);
    res.json({
      groups: groups.map((g) => ({
        id: g.id,
        name: g.name,
        description: g.description,
        isAdmin: perm.getMembership(db, g.id, req.user.id).isAdmin,
      })),
    });
  });

  router.post('/', (req, res) => {
    const name = str(req.body.name, 'グループ名', { min: 1, max: 60 });
    const description = str(req.body.description, '説明', { max: 500, required: false }) ?? '';
    const groupId = transaction(db, () => {
      const { lastInsertRowid } = db
        .prepare('INSERT INTO groups (name, description, invite_code, owner_id, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(name, description, createInviteCode(db), req.user.id, now());
      const gid = Number(lastInsertRowid);
      addMember(db, gid, req.user.id);
      const insRole = db.prepare('INSERT INTO roles (group_id, name, color, level) VALUES (?, ?, ?, ?)');
      for (const r of DEFAULT_ROLES) insRole.run(gid, r.name, r.color, r.level);
      db.prepare(
        `INSERT INTO channels (group_id, name, description, restricted, default_permission, created_by, created_at)
         VALUES (?, '全体チャット', 'メンバー全員が参加するチャットです', 0, 'write', ?, ?)`,
      ).run(gid, req.user.id, now());
      return gid;
    });
    res.status(201).json({ id: groupId });
  });

  router.post('/join', (req, res) => {
    const code = str(req.body.inviteCode, '招待コード', { min: 1, max: 32 }).toUpperCase();
    const group = db.prepare('SELECT id FROM groups WHERE invite_code = ?').get(code);
    if (!group) throw new HttpError(404, '招待コードが正しくありません');
    // 招待リンクを何度開いても困らないよう、参加済みならそのグループを返す
    if (perm.getMembership(db, group.id, req.user.id)) return res.json({ id: group.id, alreadyMember: true });
    addMember(db, group.id, req.user.id);
    changed(group.id);
    res.status(201).json({ id: group.id });
  });

  router.get('/:gid', (req, res) => {
    const gid = intParam(req.params.gid);
    const me = perm.requireMember(db, gid, req.user.id);
    const g = db.prepare('SELECT * FROM groups WHERE id = ?').get(gid);
    res.json({
      group: {
        id: g.id,
        name: g.name,
        description: g.description,
        // 招待コードは管理者にのみ表示
        inviteCode: me.isAdmin ? g.invite_code : undefined,
        inviteUrl: me.isAdmin ? inviteUrl(g.invite_code) : undefined,
      },
      me,
      roles: rolesOf(db, gid),
      members: membersOf(db, gid),
    });
  });

  router.patch('/:gid', (req, res) => {
    const gid = intParam(req.params.gid);
    perm.requireAdmin(db, gid, req.user.id);
    const name = str(req.body.name, 'グループ名', { min: 1, max: 60 });
    const description = str(req.body.description, '説明', { max: 500, required: false }) ?? '';
    db.prepare('UPDATE groups SET name = ?, description = ? WHERE id = ?').run(name, description, gid);
    changed(gid);
    res.json({ ok: true });
  });

  router.delete('/:gid', (req, res) => {
    const gid = intParam(req.params.gid);
    const me = perm.requireMember(db, gid, req.user.id);
    if (!me.isOwner) throw new HttpError(403, 'グループを削除できるのはオーナーのみです');
    const memberIds = membersOf(db, gid).map((m) => m.id);
    db.prepare('DELETE FROM groups WHERE id = ?').run(gid);
    rt.toUsers(memberIds, 'group:removed', { groupId: gid });
    res.json({ ok: true });
  });

  router.post('/:gid/invite-code', (req, res) => {
    const gid = intParam(req.params.gid);
    perm.requireAdmin(db, gid, req.user.id);
    const code = createInviteCode(db);
    db.prepare('UPDATE groups SET invite_code = ? WHERE id = ?').run(code, gid);
    res.json({ inviteCode: code, inviteUrl: inviteUrl(code) });
  });

  /** 招待リンクの QR コード(SVG)。対面でメンバーに読み取ってもらう用 */
  router.get('/:gid/invite-qr.svg', async (req, res) => {
    const gid = intParam(req.params.gid);
    perm.requireAdmin(db, gid, req.user.id);
    const { invite_code: code } = db.prepare('SELECT invite_code FROM groups WHERE id = ?').get(gid);
    const svg = await QRCode.toString(inviteUrl(code), { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'private, no-cache');
    res.send(svg);
  });

  // ---- メンバー ----

  router.patch('/:gid/members/:uid', (req, res) => {
    const gid = intParam(req.params.gid);
    const uid = intParam(req.params.uid);
    const me = perm.requireAdmin(db, gid, req.user.id);
    const target = perm.getMembership(db, gid, uid);
    if (!target) throw new HttpError(404, 'メンバーが見つかりません');

    transaction(db, () => {
      if (req.body.roleIds !== undefined) {
        if (!Array.isArray(req.body.roleIds)) throw new HttpError(400, 'ロールの指定が不正です');
        const roleIds = [...new Set(req.body.roleIds.map((r) => intParam(r, 'ロールID')))];
        const roles = new Map(rolesOf(db, gid).map((r) => [r.id, r]));
        if (roleIds.some((r) => !roles.has(r))) throw new HttpError(400, '存在しないロールが指定されています');
        // 管理者ロールの付与・解除(= 管理者の任命・解除)はオーナーのみ
        const current = db.prepare('SELECT role_id FROM member_roles WHERE group_id = ? AND user_id = ?').all(gid, uid);
        const currentIds = new Set(current.map((r) => r.role_id));
        const changedIds = [...roleIds.filter((r) => !currentIds.has(r)), ...[...currentIds].filter((r) => !roleIds.includes(r))];
        if (!me.isOwner && changedIds.some((r) => roles.get(r)?.level === 'admin')) {
          throw new HttpError(403, '管理者ロールの付与・解除はオーナーのみ行えます');
        }
        db.prepare('DELETE FROM member_roles WHERE group_id = ? AND user_id = ?').run(gid, uid);
        const ins = db.prepare('INSERT INTO member_roles (group_id, user_id, role_id) VALUES (?, ?, ?)');
        for (const r of roleIds) ins.run(gid, uid, r);
      }
    });
    changed(gid);
    res.json({ member: membersOf(db, gid).find((m) => m.id === uid) });
  });

  router.delete('/:gid/members/:uid', (req, res) => {
    const gid = intParam(req.params.gid);
    const uid = intParam(req.params.uid);
    const self = uid === req.user.id;
    const me = self ? perm.requireMember(db, gid, req.user.id) : perm.requireAdmin(db, gid, req.user.id);
    const target = perm.getMembership(db, gid, uid);
    if (!target) throw new HttpError(404, 'メンバーが見つかりません');
    if (target.isOwner) throw new HttpError(400, 'オーナーはグループから外れることができません');
    if (!self && target.isAdmin && !me.isOwner) throw new HttpError(403, '管理者を外せるのはオーナーのみです');
    transaction(db, () => {
      db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(gid, uid);
      db.prepare(
        'DELETE FROM channel_member_permissions WHERE user_id = ? AND channel_id IN (SELECT id FROM channels WHERE group_id = ?)',
      ).run(uid, gid);
    });
    rt.toUsers([uid], 'group:removed', { groupId: gid });
    changed(gid);
    res.json({ ok: true });
  });

  // ---- ロール ----

  function roleInput(body, partial) {
    const out = {};
    if (!partial || body.name !== undefined) out.name = str(body.name, 'ロール名', { min: 1, max: 30 });
    if (body.color !== undefined) {
      if (typeof body.color !== 'string' || !COLOR_RE.test(body.color)) throw new HttpError(400, '色の指定が不正です');
      out.color = body.color;
    }
    if (body.level !== undefined) {
      if (!perm.ROLE_LEVELS.includes(body.level)) throw new HttpError(400, 'ロールの権限が不正です');
      out.level = body.level;
    }
    return out;
  }

  function assertUniqueRoleName(gid, name, exceptId = 0) {
    if (db.prepare('SELECT 1 FROM roles WHERE group_id = ? AND name = ? AND id != ?').get(gid, name, exceptId)) {
      throw new HttpError(409, '同じ名前のロールが既にあります');
    }
  }

  router.post('/:gid/roles', (req, res) => {
    const gid = intParam(req.params.gid);
    const me = perm.requireAdmin(db, gid, req.user.id);
    const input = roleInput(req.body, false);
    if (input.level === 'admin' && !me.isOwner) throw new HttpError(403, '管理者権限のロールを作成できるのはオーナーのみです');
    assertUniqueRoleName(gid, input.name);
    const { lastInsertRowid } = db
      .prepare('INSERT INTO roles (group_id, name, color, level) VALUES (?, ?, ?, ?)')
      .run(gid, input.name, input.color || '#6b7280', input.level ?? 'write');
    changed(gid);
    res.status(201).json({ role: rolesOf(db, gid).find((r) => r.id === Number(lastInsertRowid)) });
  });

  function findRole(gid, rid) {
    const role = db.prepare('SELECT * FROM roles WHERE id = ? AND group_id = ?').get(rid, gid);
    if (!role) throw new HttpError(404, 'ロールが見つかりません');
    return role;
  }

  router.patch('/:gid/roles/:rid', (req, res) => {
    const gid = intParam(req.params.gid);
    const rid = intParam(req.params.rid);
    const me = perm.requireAdmin(db, gid, req.user.id);
    const role = findRole(gid, rid);
    const input = roleInput(req.body, true);
    const level = input.level ?? role.level;
    if (level !== role.level && (level === 'admin' || role.level === 'admin') && !me.isOwner) {
      throw new HttpError(403, '管理者権限の付与・取り消しはオーナーのみ行えます');
    }
    if (input.name) assertUniqueRoleName(gid, input.name, rid);
    db.prepare('UPDATE roles SET name = ?, color = ?, level = ? WHERE id = ?').run(
      input.name ?? role.name,
      input.color ?? role.color,
      level,
      rid,
    );
    changed(gid);
    res.json({ role: rolesOf(db, gid).find((r) => r.id === rid) });
  });

  router.delete('/:gid/roles/:rid', (req, res) => {
    const gid = intParam(req.params.gid);
    const rid = intParam(req.params.rid);
    const me = perm.requireAdmin(db, gid, req.user.id);
    const role = findRole(gid, rid);
    if (role.level === 'admin' && !me.isOwner) throw new HttpError(403, '管理者権限のロールを削除できるのはオーナーのみです');
    db.prepare('DELETE FROM roles WHERE id = ?').run(rid);
    changed(gid);
    res.json({ ok: true });
  });

  return router;
};

module.exports.membersOf = membersOf;
