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
  joined_at  INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);

-- グループ内のロール(例: 代表 / 調理班 / 会計 / 宣伝班)
-- level: read = 閲覧のみ / write = 閲覧・送信 / moderator = チャット作成・アナウンス可 / admin = 管理者
CREATE TABLE IF NOT EXISTS roles (
  id        INTEGER PRIMARY KEY,
  group_id  INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  name      TEXT    NOT NULL,
  color     TEXT    NOT NULL DEFAULT '#6b7280',
  level     TEXT    NOT NULL DEFAULT 'write' CHECK (level IN ('read', 'write', 'moderator', 'admin')),
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
  position            INTEGER NOT NULL DEFAULT 0,
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
  -- 画像本体。DB ファイル 1 つにまとめておくとバックアップ・復元が簡単になる
  data             BLOB,
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_attachments_announcement ON attachments(announcement_id);

-- プッシュ通知の宛先(端末ごと)
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint    TEXT    NOT NULL UNIQUE,
  p256dh      TEXT    NOT NULL,
  auth        TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);

-- 通知をオフにしたチャット
CREATE TABLE IF NOT EXISTS channel_mutes (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, channel_id)
);

-- チャットごとの既読位置(未読数のバッジ表示用)
CREATE TABLE IF NOT EXISTS channel_reads (
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id    INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  last_read_id  INTEGER NOT NULL,
  PRIMARY KEY (user_id, channel_id)
);

-- 屋台 POS との連携(グループごとに 1 つ)。token を知っている POS 端末だけがオーダーを送れる
CREATE TABLE IF NOT EXISTS pos_links (
  group_id    INTEGER PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
  token       TEXT    NOT NULL UNIQUE,
  menu        TEXT,
  -- 売り切れ {"syrups": [名前], "drinks": [名前]}
  sold_out    TEXT,
  -- スタッフ用の暗証番号(全 POS 端末共通)。sha256(salt + 暗証番号)
  pin_salt    TEXT,
  pin_hash    TEXT,
  created_at  INTEGER NOT NULL
);

-- POS で会計したオーダー
-- status: new = 未着手 / making = 作成中 / done = 提供済み
CREATE TABLE IF NOT EXISTS orders (
  id          INTEGER PRIMARY KEY,
  group_id    INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  number      INTEGER NOT NULL,
  client_id   TEXT    NOT NULL,
  cups        TEXT    NOT NULL,
  total       INTEGER NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'making', 'done')),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (group_id, client_id)
);
CREATE INDEX IF NOT EXISTS idx_orders_group ON orders(group_id, id);

-- オーダーの通知をオフにしたメンバー
CREATE TABLE IF NOT EXISTS order_mutes (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id  INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, group_id)
);

-- サーバーの設定値(プッシュ通知の鍵など)
CREATE TABLE IF NOT EXISTS app_settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
`;

function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  if (file !== ':memory:') {
    // WAL: 書き込み中も読み取りでき、Litestream によるバックアップにも必要
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
  }
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

const columns = (db, table) =>
  db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name);

/** 旧バージョンのデータベースを現在のスキーマに移行する */
function migrate(db) {
  transaction(db, () => {
    // v1: roles.can_announce → roles.level(アナウンス可だったロールは moderator に)
    if (!columns(db, 'roles').includes('level')) {
      db.exec(`ALTER TABLE roles ADD COLUMN level TEXT NOT NULL DEFAULT 'write' CHECK (level IN ('read', 'write', 'moderator', 'admin'))`);
      if (columns(db, 'roles').includes('can_announce')) {
        db.exec(`UPDATE roles SET level = 'moderator' WHERE can_announce = 1`);
        db.exec('ALTER TABLE roles DROP COLUMN can_announce');
      }
    }

    // v2: 画像をファイルではなく DB に保存する(既存ファイルは importLegacyFiles で取り込む)
    if (!columns(db, 'attachments').includes('data')) {
      db.exec('ALTER TABLE attachments ADD COLUMN data BLOB');
    }

    // v1: group_members.is_admin → 「管理者」ロール(level = admin)の付与
    if (columns(db, 'group_members').includes('is_admin')) {
      const admins = db
        .prepare(
          `SELECT gm.group_id, gm.user_id FROM group_members gm JOIN groups g ON g.id = gm.group_id
            WHERE gm.is_admin = 1 AND gm.user_id != g.owner_id`,
        )
        .all();
      const roleIds = new Map();
      for (const { group_id: gid, user_id: uid } of admins) {
        if (!roleIds.has(gid)) {
          let name = '管理者';
          for (let i = 2; db.prepare('SELECT 1 FROM roles WHERE group_id = ? AND name = ?').get(gid, name); i++) name = `管理者${i}`;
          const { lastInsertRowid } = db
            .prepare(`INSERT INTO roles (group_id, name, color, level) VALUES (?, ?, '#ef4444', 'admin')`)
            .run(gid, name);
          roleIds.set(gid, Number(lastInsertRowid));
        }
        db.prepare('INSERT OR IGNORE INTO member_roles (group_id, user_id, role_id) VALUES (?, ?, ?)').run(gid, uid, roleIds.get(gid));
      }
      db.exec('ALTER TABLE group_members DROP COLUMN is_admin');
    }

    // v4: チャットの並び順(既存のチャットは作成順)
    if (!columns(db, 'channels').includes('position')) {
      db.exec('ALTER TABLE channels ADD COLUMN position INTEGER NOT NULL DEFAULT 0');
      db.exec('UPDATE channels SET position = id');
    }

    // v5: POS の売り切れ・暗証番号
    if (!columns(db, 'pos_links').includes('sold_out')) {
      db.exec('ALTER TABLE pos_links ADD COLUMN sold_out TEXT');
      db.exec('ALTER TABLE pos_links ADD COLUMN pin_salt TEXT');
      db.exec('ALTER TABLE pos_links ADD COLUMN pin_hash TEXT');
    }

    // v3: 未読数のバッジ。既存のメッセージは既読扱いにして、更新直後に大量の未読が付かないようにする
    if (!db.prepare("SELECT 1 FROM app_settings WHERE key = 'channel_reads_v1'").get()) {
      db.exec(`INSERT OR IGNORE INTO channel_reads (user_id, channel_id, last_read_id)
               SELECT gm.user_id, c.id, MAX(m.id) FROM channels c
                 JOIN group_members gm ON gm.group_id = c.group_id
                 JOIN messages m ON m.channel_id = c.id
                GROUP BY gm.user_id, c.id`);
      db.exec("INSERT INTO app_settings (key, value) VALUES ('channel_reads_v1', '1')");
    }
  });
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
