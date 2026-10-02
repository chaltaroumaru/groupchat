'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY,
  email           TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash   TEXT    NOT NULL,
  display_name    TEXT    NOT NULL,
  email_verified  INTEGER NOT NULL DEFAULT 0,
  verify_token    TEXT,
  verify_expires  INTEGER,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT    PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS groups (
  id           INTEGER PRIMARY KEY,
  name         TEXT    NOT NULL,
  description  TEXT    NOT NULL DEFAULT '',
  invite_code  TEXT    NOT NULL UNIQUE,
  owner_id     INTEGER NOT NULL REFERENCES users(id),
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id   INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_admin   INTEGER NOT NULL DEFAULT 0,
  joined_at  INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);

-- グループ内のロール(例: 代表 / 調理班 / 会計 / 宣伝班)
CREATE TABLE IF NOT EXISTS roles (
  id            INTEGER PRIMARY KEY,
  group_id      INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  name          TEXT    NOT NULL,
  color         TEXT    NOT NULL DEFAULT '#6b7280',
  can_announce  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (group_id, name)
);

CREATE TABLE IF NOT EXISTS member_roles (
  group_id  INTEGER NOT NULL,
  user_id   INTEGER NOT NULL,
  role_id   INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id),
  FOREIGN KEY (group_id, user_id) REFERENCES group_members(group_id, user_id) ON DELETE CASCADE
);

-- restricted = 1 のチャットは channel_roles に登録されたロールの所持者のみ参加できる
CREATE TABLE IF NOT EXISTS channels (
  id                  INTEGER PRIMARY KEY,
  group_id            INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  name                TEXT    NOT NULL,
  description         TEXT    NOT NULL DEFAULT '',
  restricted          INTEGER NOT NULL DEFAULT 0,
  default_permission  TEXT    NOT NULL DEFAULT 'write' CHECK (default_permission IN ('read', 'write')),
  created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_roles (
  channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  role_id     INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission  TEXT    NOT NULL CHECK (permission IN ('read', 'write')),
  PRIMARY KEY (channel_id, role_id)
);

-- 参加者ごとの個別権限(ロールやチャットの既定値より優先される)
CREATE TABLE IF NOT EXISTS channel_member_permissions (
  channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission  TEXT    NOT NULL CHECK (permission IN ('none', 'read', 'write')),
  PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY,
  channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body        TEXT    NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, id);

CREATE TABLE IF NOT EXISTS announcements (
  id          INTEGER PRIMARY KEY,
  group_id    INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  title       TEXT    NOT NULL,
  body        TEXT    NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_announcements_group ON announcements(group_id, id);

CREATE TABLE IF NOT EXISTS announcement_reads (
  announcement_id  INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at          INTEGER NOT NULL,
  PRIMARY KEY (announcement_id, user_id)
);

CREATE TABLE IF NOT EXISTS attachments (
  id               INTEGER PRIMARY KEY,
  message_id       INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  announcement_id  INTEGER REFERENCES announcements(id) ON DELETE CASCADE,
  stored_name      TEXT    NOT NULL,
  original_name    TEXT    NOT NULL,
  mime_type        TEXT    NOT NULL,
  size             INTEGER NOT NULL,
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_attachments_announcement ON attachments(announcement_id);
`;

function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return db;
}

/** fn を 1 トランザクションで実行する */
function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { openDatabase, transaction };
