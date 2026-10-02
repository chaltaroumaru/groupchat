'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { openDatabase } = require('../src/db');
const { getMembership } = require('../src/permissions');

test('旧バージョンの「管理者」「アナウンス可」をロールの権限に移行する', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'groupchat-migrate-'));
  const file = path.join(dir, 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL, email_verified INTEGER NOT NULL DEFAULT 0, verify_token TEXT, verify_expires INTEGER, created_at INTEGER NOT NULL);
    CREATE TABLE groups (id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      invite_code TEXT NOT NULL UNIQUE, owner_id INTEGER NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL);
    CREATE TABLE group_members (group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, is_admin INTEGER NOT NULL DEFAULT 0,
      joined_at INTEGER NOT NULL, PRIMARY KEY (group_id, user_id));
    CREATE TABLE roles (id INTEGER PRIMARY KEY, group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#6b7280', can_announce INTEGER NOT NULL DEFAULT 0, UNIQUE (group_id, name));
    CREATE TABLE member_roles (group_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
      role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE, PRIMARY KEY (user_id, role_id),
      FOREIGN KEY (group_id, user_id) REFERENCES group_members(group_id, user_id) ON DELETE CASCADE);
    INSERT INTO users VALUES (1, 'o@x', 'h', 'owner', 1, NULL, NULL, 0), (2, 'a@x', 'h', 'admin', 1, NULL, NULL, 0),
      (3, 'p@x', 'h', 'pr', 1, NULL, NULL, 0), (4, 'm@x', 'h', 'member', 1, NULL, NULL, 0);
    INSERT INTO groups VALUES (1, 'g', '', 'CODE', 1, 0);
    INSERT INTO group_members VALUES (1, 1, 1, 0), (1, 2, 1, 0), (1, 3, 0, 0), (1, 4, 0, 0);
    INSERT INTO roles VALUES (1, 1, '広報', '#000000', 1), (2, 1, '管理者', '#000000', 0);
    INSERT INTO member_roles VALUES (1, 3, 1), (1, 4, 2);
  `);
  old.close();

  const db = openDatabase(file);
  assert.equal(getMembership(db, 1, 1).level, 'admin', 'オーナー');
  assert.equal(getMembership(db, 1, 2).level, 'admin', '旧管理者');
  assert.equal(getMembership(db, 1, 3).level, 'moderator', 'アナウンス可ロール');
  assert.equal(getMembership(db, 1, 4).level, 'write', '同名の既存ロールには管理者権限を付けない');
  const roles = db.prepare('SELECT name, level FROM roles ORDER BY id').all();
  assert.deepEqual(
    roles.map((r) => [r.name, r.level]),
    [
      ['広報', 'moderator'],
      ['管理者', 'write'],
      ['管理者2', 'admin'],
    ],
  );
  // 2 回目以降は何もしない
  db.close();
  openDatabase(file).close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('旧バージョンでディスクに保存した画像を DB に取り込む', () => {
  const { importLegacyFiles } = require('../src/uploads');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'groupchat-legacy-'));
  const db = openDatabase(':memory:');
  db.exec(`INSERT INTO users VALUES (1, 'o@x', 'h', 'o', 1, NULL, NULL, 0);
    INSERT INTO groups VALUES (1, 'g', '', 'CODE', 1, 0);
    INSERT INTO channels (id, group_id, name, created_at) VALUES (1, 1, 'c', 0);
    INSERT INTO messages (id, channel_id, user_id, body, created_at) VALUES (1, 1, 1, '', 0);
    INSERT INTO attachments (message_id, stored_name, original_name, mime_type, size, created_at)
      VALUES (1, 'abc.png', 'a.png', 'image/png', 3, 0), (1, 'missing.png', 'b.png', 'image/png', 3, 0);`);
  fs.writeFileSync(path.join(dir, 'abc.png'), Buffer.from([1, 2, 3]));

  assert.equal(importLegacyFiles(db, dir), 1);
  const rows = db.prepare('SELECT stored_name, data FROM attachments ORDER BY id').all();
  assert.deepEqual(Buffer.from(rows[0].data), Buffer.from([1, 2, 3]));
  assert.equal(rows[1].data, null);
  assert.equal(fs.existsSync(path.join(dir, 'abc.png')), false, '取り込んだファイルは削除する');
  assert.equal(importLegacyFiles(db, path.join(dir, 'none')), 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
