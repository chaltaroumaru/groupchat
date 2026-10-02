'use strict';

const express = require('express');
const { transaction } = require('../db');
const { HttpError, now, inviteCode, str, intParam, bool } = require('../util');
const perm = require('../permissions');

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function rolesOf(db, groupId) {
  return db
    .prepare('SELECT id, name, color, can_announce FROM roles WHERE group_id = ? ORDER BY id')
    .all(groupId)
    .map((r) => ({ id: r.id, name: r.name, color: r.color, canAnnounce: !!r.can_announce }));
}

function membersOf(db, groupId) {
  const group = db.prepare('SELECT owner_id FROM groups WHERE id = ?').get(groupId);
  const members = db
    .prepare(
      `SELECT u.id, u.display_name, u.email, gm.is_admin, gm.joined_at
         FROM group_members gm JOIN users u ON u.id = gm.user_id
        WHERE gm.group_id = ? ORDER BY gm.joined_at`,
    )
    .all(groupId);
  const roleRows = db.prepare('SELECT user_id, role_id FROM member_roles WHERE group_id = ?').all(groupId);
  const rolesByUser = new Map();
  for (const r of roleRows) {
    if (!rolesByUser.has(r.user_id)) rolesByUser.set(r.user_id, []);
    rolesByUser.get(r.user_id).push(r.role_id);
  }
  return members.map((m) => ({
    id: m.id,
    displayName: m.display_name,
    email: m.email,
    isOwner: m.id === group.owner_id,
    isAdmin: m.id === group.owner_id || !!m.is_admin,
    roleIds: rolesByUser.get(m.id) || [],
    joinedAt: m.joined_at,
  }));
}

function createInviteCode(db) {
  for (;;) {
    const code = inviteCode();
    if (!db.prepare('SELECT 1 FROM groups WHERE invite_code = ?').get(code)) return code;
  }
}

function addMember(db, groupId, userId, isAdmin = false) {
  db.prepare('INSERT INTO group_members (group_id, user_id, is_admin, joined_at) VALUES (?, ?, ?, ?)').run(
    groupId,
    userId,
    isAdmin ? 1 : 0,
    now(),
  );
}

module.exports = function groupRoutes({ db, rt }) {
  const router = express.Router();

  /** グループ構成(メンバー・ロール・権限)が変わったことを全員に通知する */
  const changed = (groupId) => rt.toGroup(groupId, 'group:changed', { groupId });

  router.get('/', (req, res) => {
    const groups = db
      .prepare(
        `SELECT g.id, g.name, g.description, g.owner_id, gm.is_admin
           FROM groups g JOIN group_members gm ON gm.group_id = g.id
          WHERE gm.user_id = ? ORDER BY g.created_at`,
      )
      .all(req.user.id);
    res.json({
      groups: groups.map((g) => ({
        id: g.id,
        name: g.name,
        description: g.description,
        isAdmin: g.owner_id === req.user.id || !!g.is_admin,
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
      addMember(db, gid, req.user.id, true);
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
    if (perm.getMembership(db, group.id, req.user.id)) throw new HttpError(409, '既にこのグループに参加しています');
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
      },
      me: { ...me, canAnnounce: perm.canAnnounce(db, gid, req.user.id) },
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
    res.json({ inviteCode: code });
  });

  // ---- メンバー ----

  router.patch('/:gid/members/:uid', (req, res) => {
    const gid = intParam(req.params.gid);
    const uid = intParam(req.params.uid);
    const me = perm.requireAdmin(db, gid, req.user.id);
    const target = perm.getMembership(db, gid, uid);
    if (!target) throw new HttpError(404, 'メンバーが見つかりません');

    transaction(db, () => {
      if (req.body.isAdmin !== undefined) {
        if (!me.isOwner) throw new HttpError(403, '管理者の任命・解除はオーナーのみ行えます');
        if (target.isOwner) throw new HttpError(400, 'オーナーの管理者権限は変更できません');
        db.prepare('UPDATE group_members SET is_admin = ? WHERE group_id = ? AND user_id = ?').run(
          bool(req.body.isAdmin) ? 1 : 0,
          gid,
          uid,
        );
      }
      if (req.body.roleIds !== undefined) {
        if (!Array.isArray(req.body.roleIds)) throw new HttpError(400, 'ロールの指定が不正です');
        const roleIds = [...new Set(req.body.roleIds.map((r) => intParam(r, 'ロールID')))];
        const valid = new Set(rolesOf(db, gid).map((r) => r.id));
        if (roleIds.some((r) => !valid.has(r))) throw new HttpError(400, '存在しないロールが指定されています');
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
    if (body.canAnnounce !== undefined) out.canAnnounce = bool(body.canAnnounce);
    return out;
  }

  function assertUniqueRoleName(gid, name, exceptId = 0) {
    if (db.prepare('SELECT 1 FROM roles WHERE group_id = ? AND name = ? AND id != ?').get(gid, name, exceptId)) {
      throw new HttpError(409, '同じ名前のロールが既にあります');
    }
  }

  router.post('/:gid/roles', (req, res) => {
    const gid = intParam(req.params.gid);
    perm.requireAdmin(db, gid, req.user.id);
    const input = roleInput(req.body, false);
    assertUniqueRoleName(gid, input.name);
    const { lastInsertRowid } = db
      .prepare('INSERT INTO roles (group_id, name, color, can_announce) VALUES (?, ?, ?, ?)')
      .run(gid, input.name, input.color || '#6b7280', input.canAnnounce ? 1 : 0);
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
    perm.requireAdmin(db, gid, req.user.id);
    const role = findRole(gid, rid);
    const input = roleInput(req.body, true);
    if (input.name) assertUniqueRoleName(gid, input.name, rid);
    db.prepare('UPDATE roles SET name = ?, color = ?, can_announce = ? WHERE id = ?').run(
      input.name ?? role.name,
      input.color ?? role.color,
      input.canAnnounce === undefined ? role.can_announce : input.canAnnounce ? 1 : 0,
      rid,
    );
    changed(gid);
    res.json({ role: rolesOf(db, gid).find((r) => r.id === rid) });
  });

  router.delete('/:gid/roles/:rid', (req, res) => {
    const gid = intParam(req.params.gid);
    const rid = intParam(req.params.rid);
    perm.requireAdmin(db, gid, req.user.id);
    findRole(gid, rid);
    db.prepare('DELETE FROM roles WHERE id = ?').run(rid);
    changed(gid);
    res.json({ ok: true });
  });

  return router;
};

module.exports.membersOf = membersOf;
