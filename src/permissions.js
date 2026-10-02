'use strict';

const { HttpError } = require('./util');

/** チャットの権限: none < read(閲覧のみ) < write(閲覧・送信) */
const LEVEL = { none: 0, read: 1, write: 2 };

/**
 * ロールの権限レベル(グループ全体での立場)
 *   read      閲覧のみ
 *   write     閲覧・送信(ロールが無いメンバーもこの扱い)
 *   moderator 閲覧・送信 + チャット作成 + アナウンス(自分が作ったチャットは管理できる)
 *   admin     管理者: 全チャットの管理・ロール付与・グループ設定の編集
 */
const ROLE_LEVELS = ['read', 'write', 'moderator', 'admin'];
const ROLE_RANK = { read: 1, write: 2, moderator: 3, admin: 4 };
const DEFAULT_LEVEL = 'write';

/** メンバーのロールから権限レベルを求める(複数あれば最も強いもの) */
function levelFromRoles(levels, isOwner) {
  if (isOwner) return 'admin';
  if (levels.length === 0) return DEFAULT_LEVEL;
  return levels.reduce((best, l) => (ROLE_RANK[l] > ROLE_RANK[best] ? l : best));
}

function describeMember(level, isOwner) {
  const rank = ROLE_RANK[level];
  return {
    isOwner,
    level,
    isAdmin: rank >= ROLE_RANK.admin,
    canCreateChannels: rank >= ROLE_RANK.moderator,
    canAnnounce: rank >= ROLE_RANK.moderator,
    // チャットで送信できるか(閲覧のみロールなら false)
    baseChannelPermission: rank >= ROLE_RANK.write ? 'write' : 'read',
  };
}

function getMembership(db, groupId, userId) {
  const row = db
    .prepare(
      `SELECT g.owner_id FROM group_members gm JOIN groups g ON g.id = gm.group_id
        WHERE gm.group_id = ? AND gm.user_id = ?`,
    )
    .get(groupId, userId);
  if (!row) return null;
  const levels = db
    .prepare(
      `SELECT r.level FROM member_roles mr JOIN roles r ON r.id = mr.role_id
        WHERE mr.group_id = ? AND mr.user_id = ?`,
    )
    .all(groupId, userId)
    .map((r) => r.level);
  const isOwner = row.owner_id === userId;
  return describeMember(levelFromRoles(levels, isOwner), isOwner);
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
  return !!getMembership(db, groupId, userId)?.canAnnounce;
}

/** チャットの設定・参加者権限・削除を行えるか(管理者、または自分が作成したチャットのリーダー) */
function canManageChannel(membership, channel, userId) {
  if (!membership) return false;
  if (membership.isAdmin) return true;
  return membership.canCreateChannels && channel.created_by === userId;
}

/**
 * ユーザーのチャットに対する実効権限を求める。
 *
 * 優先順位:
 *   1. 管理者 → 常に write
 *   2. 自分が作成したチャット(リーダー) → write
 *   3. 参加者ごとの個別権限(channel_member_permissions)
 *   4. 制限付きチャット → 所持ロールに許可された権限の最大値(該当なしは none)
 *      通常チャット     → チャットの既定権限
 *   ※ 4 はロールの権限レベルが「閲覧のみ」なら read に制限される
 *
 * @returns {{ permission: 'none'|'read'|'write', source: 'admin'|'creator'|'override'|'role'|'default'|'level'|'not_member' }}
 */
function resolveChannelPermission(db, channel, userId, membership = getMembership(db, channel.group_id, userId)) {
  const m = membership;
  if (!m) return { permission: 'none', source: 'not_member' };
  if (m.isAdmin) return { permission: 'write', source: 'admin' };
  if (canManageChannel(m, channel, userId)) return { permission: 'write', source: 'creator' };

  const override = db
    .prepare('SELECT permission FROM channel_member_permissions WHERE channel_id = ? AND user_id = ?')
    .get(channel.id, userId);
  if (override) return { permission: override.permission, source: 'override' };

  let permission;
  let source;
  if (!channel.restricted) {
    permission = channel.default_permission;
    source = 'default';
  } else {
    const rows = db
      .prepare(
        `SELECT cr.permission FROM channel_roles cr
           JOIN member_roles mr ON mr.role_id = cr.role_id
          WHERE cr.channel_id = ? AND mr.user_id = ?`,
      )
      .all(channel.id, userId);
    permission = 'none';
    for (const r of rows) if (LEVEL[r.permission] > LEVEL[permission]) permission = r.permission;
    source = 'role';
  }
  if (LEVEL[permission] > LEVEL[m.baseChannelPermission]) {
    return { permission: m.baseChannelPermission, source: 'level' };
  }
  return { permission, source };
}

function getChannel(db, channelId) {
  const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  if (!ch) throw new HttpError(404, 'チャットが見つかりません');
  return ch;
}

/** 必要な権限を満たさなければ例外。チャットの存在自体を隠すため閲覧不可は 404 とする */
function requireChannelPermission(db, channelId, userId, needed) {
  const channel = getChannel(db, channelId);
  const membership = getMembership(db, channel.group_id, userId);
  const { permission } = resolveChannelPermission(db, channel, userId, membership);
  if (permission === 'none') throw new HttpError(404, 'チャットが見つかりません');
  if (LEVEL[permission] < LEVEL[needed]) throw new HttpError(403, 'このチャットでは閲覧のみ許可されています');
  return { channel, permission, membership };
}

/** チャットの管理権限が無ければ例外 */
function requireChannelManager(db, channelId, userId) {
  const { channel, membership } = requireChannelPermission(db, channelId, userId, 'read');
  if (!canManageChannel(membership, channel, userId)) {
    throw new HttpError(403, 'このチャットを管理できるのは管理者と作成したリーダーのみです');
  }
  return { channel, membership };
}

/** チャットを閲覧できるグループメンバーの ID 一覧(リアルタイム配信先の決定用) */
function channelReaderIds(db, channel) {
  const members = db.prepare('SELECT user_id FROM group_members WHERE group_id = ?').all(channel.group_id);
  return members.map((m) => m.user_id).filter((uid) => resolveChannelPermission(db, channel, uid).permission !== 'none');
}

module.exports = {
  LEVEL,
  ROLE_LEVELS,
  ROLE_RANK,
  levelFromRoles,
  describeMember,
  getMembership,
  requireMember,
  requireAdmin,
  canAnnounce,
  canManageChannel,
  resolveChannelPermission,
  getChannel,
  requireChannelPermission,
  requireChannelManager,
  channelReaderIds,
};
