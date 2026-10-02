'use strict';

function attachmentsBy(db, column, ids) {
  const map = new Map();
  if (ids.length === 0) return map;
  const rows = db
    .prepare(
      `SELECT id, ${column} AS owner, original_name, mime_type, size FROM attachments
        WHERE ${column} IN (${ids.map(() => '?').join(',')}) ORDER BY id`,
    )
    .all(...ids);
  for (const a of rows) {
    if (!map.has(a.owner)) map.set(a.owner, []);
    map.get(a.owner).push({ id: a.id, url: `/api/attachments/${a.id}`, name: a.original_name, mimeType: a.mime_type, size: a.size });
  }
  return map;
}

/** messages の行(author_name を JOIN 済み)を API 応答の形に変換する */
function serializeMessages(db, rows) {
  const atts = attachmentsBy(
    db,
    'message_id',
    rows.map((r) => r.id),
  );
  return rows.map((r) => ({
    id: r.id,
    channelId: r.channel_id,
    author: r.user_id ? { id: r.user_id, displayName: r.author_name } : null,
    body: r.body,
    attachments: atts.get(r.id) || [],
    createdAt: r.created_at,
  }));
}

function serializeAnnouncements(db, rows) {
  const atts = attachmentsBy(
    db,
    'announcement_id',
    rows.map((r) => r.id),
  );
  return rows.map((r) => ({
    id: r.id,
    groupId: r.group_id,
    author: r.user_id ? { id: r.user_id, displayName: r.author_name } : null,
    title: r.title,
    body: r.body,
    attachments: atts.get(r.id) || [],
    createdAt: r.created_at,
    readCount: r.read_count ?? 0,
    readByMe: !!r.read_by_me,
  }));
}

const MESSAGE_SELECT = `SELECT m.*, u.display_name AS author_name FROM messages m LEFT JOIN users u ON u.id = m.user_id`;

module.exports = { serializeMessages, serializeAnnouncements, MESSAGE_SELECT };
