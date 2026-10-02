'use strict';

const { HttpError } = require('./util');

/** チャットの権限レベル: none < read(閲覧のみ) < write(閲覧・送信) */
const LEVEL = { none: 0, read: 1, write: 2 };

function getMembership(db, groupId, userId) {
  const row = db
    .prepare(
      `SELECT gm.is_admin, g.owner_id
         FROM group_members gm JOIN groups g ON g.id = gm.group_id
        WHERE gm.group_id = ? AND gm.user_id = ?`,
    )
    .get(groupId, userId);
  if (!row) return null;
  const isOwner = row.owner_id === userId;
  return { isOwner, isAdmin: isOwner || !!row.is_admin };
}

function requireMember(db, groupId, userId) {
  const m = getMembership(db, groupId, userId);
  if (!m) throw new HttpError(404, 'グループが見つかりません');
  return m;
}

function requireAdmin(db, groupId, userId) {
  const m = requireMember(db, groupId, userId);
  if (!m.isAdmin) throw new HttpError(403, 'この操作には管理者権限が必要です');
  return m;
}

function canAnnounce(db, groupId, userId) {
  const m = getMembership(db, groupId, userId);
  if (!m) return false;
  if (m.isAdmin) return true;
  const row = db
    .prepare(
      `SELECT 1 FROM member_roles mr JOIN roles r ON r.id = mr.role_id
        WHERE mr.group_id = ? AND mr.user_id = ? AND r.can_announce = 1 LIMIT 1`,
    )
    .get(groupId, userId);
  return !!row;
}

/**
 * ユーザーのチャットに対する実効権限を求める。
 *
 * 優先順位:
 *   1. グループ管理者・オーナー → 常に write
 *   2. 参加者ごとの個別権限(channel_member_permissions)
 *   3. 制限付きチャット → 所持ロールに許可された権限の最大値(該当なしは none)
 *   4. 通常チャット → チャットの既定権限
 *
 * @returns {{ permission: 'none'|'read'|'write', source: 'admin'|'override'|'role'|'default'|'not_member' }}
 */
function resolveChannelPermission(db, channel, userId) {
  const m = getMembership(db, channel.group_id, userId);
  if (!m) return { permission: 'none', source: 'not_member' };
  if (m.isAdmin) return { permission: 'write', source: 'admin' };

  const override = db
    .prepare('SELECT permission FROM channel_member_permissions WHERE channel_id = ? AND user_id = ?')
    .get(channel.id, userId);
  if (override) return { permission: override.permission, source: 'override' };

  if (!channel.restricted) return { permission: channel.default_permission, source: 'default' };

  const rows = db
    .prepare(
      `SELECT cr.permission FROM channel_roles cr
         JOIN member_roles mr ON mr.role_id = cr.role_id
        WHERE cr.channel_id = ? AND mr.user_id = ?`,
    )
    .all(channel.id, userId);
  let best = 'none';
  for (const r of rows) if (LEVEL[r.permission] > LEVEL[best]) best = r.permission;
  return { permission: best, source: 'role' };
}

function getChannel(db, channelId) {
  const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  if (!ch) throw new HttpError(404, 'チャットが見つかりません');
  return ch;
}

/** 必要な権限を満たさなければ例外。チャットの存在自体を隠すため閲覧不可は 404 とする */
function requireChannelPermission(db, channelId, userId, needed) {
  const channel = getChannel(db, channelId);
  const { permission } = resolveChannelPermission(db, channel, userId);
  if (permission === 'none') throw new HttpError(404, 'チャットが見つかりません');
  if (LEVEL[permission] < LEVEL[needed]) throw new HttpError(403, 'このチャットでは閲覧のみ許可されています');
  return { channel, permission };
}

/** チャットを閲覧できるグループメンバーの ID 一覧(リアルタイム配信先の決定用) */
function channelReaderIds(db, channel) {
  const members = db.prepare('SELECT user_id FROM group_members WHERE group_id = ?').all(channel.group_id);
  return members.map((m) => m.user_id).filter((uid) => resolveChannelPermission(db, channel, uid).permission !== 'none');
}

module.exports = {
  LEVEL,
  getMembership,
  requireMember,
  requireAdmin,
  canAnnounce,
  resolveChannelPermission,
  getChannel,
  requireChannelPermission,
  channelReaderIds,
};
