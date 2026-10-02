'use strict';

const webpush = require('web-push');
const perm = require('./permissions');
const { now } = require('./util');

/**
 * Web Push の鍵(VAPID)。環境変数があればそれを使い、無ければ初回起動時に生成して DB に保存する。
 * DB は Litestream でバックアップされるので、再デプロイしても鍵は変わらない(=通知の登録が無効にならない)。
 */
function vapidKeys(db, env) {
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
    return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
  }
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'vapid'").get();
  if (row) return JSON.parse(row.value);
  const keys = webpush.generateVAPIDKeys();
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('vapid', ?)").run(JSON.stringify(keys));
  return keys;
}

/** 通知の送信者を示す連絡先(Apple・Google が問題発生時に使う)。https の URL か mailto が必要 */
function vapidSubject(env, baseUrl) {
  if (env.VAPID_SUBJECT) return env.VAPID_SUBJECT;
  if (baseUrl.startsWith('https://')) return baseUrl;
  return 'mailto:admin@localhost.localdomain';
}

const truncate = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * プッシュ通知。
 * @param {object} deps
 * @param {Function} [deps.send] 送信関数(テスト用に差し替え可能)。web-push の sendNotification と同じ形
 */
function createPush({ db, rt, config, env = process.env, send = webpush.sendNotification }) {
  const keys = vapidKeys(db, env);
  const vapidDetails = { subject: vapidSubject(env, config.baseUrl), publicKey: keys.publicKey, privateKey: keys.privateKey };

  function subscribe(userId, sub) {
    // 同じ端末で別のユーザーがログインした場合は宛先を付け替える
    db.prepare(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
    ).run(userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, now());
  }

  function unsubscribe(userId, endpoint) {
    db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(userId, endpoint);
  }

  /** userIds の全端末に送り、届いた端末数を返す。呼び出し元(API 応答)は結果を待たなくてよい */
  function sendToUsers(userIds, payload) {
    if (userIds.length === 0) return Promise.resolve(0);
    const subs = db.prepare(`SELECT * FROM push_subscriptions WHERE user_id IN (${userIds.map(() => '?').join(',')})`).all(...userIds);
    const body = JSON.stringify(payload);
    return Promise.all(
      subs.map((s) =>
        send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, {
          vapidDetails,
          TTL: 12 * 60 * 60, // 圏外の端末にも 12 時間以内に繋がれば届ける
          urgency: 'high',
        }).then(
          () => true,
          (err) => {
            // 404 / 410 = 通知がオフにされた・アプリが削除された → 宛先を消す
            if (err.statusCode === 404 || err.statusCode === 410) {
              db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(s.id);
            } else {
              console.error(`プッシュ通知の送信に失敗しました (${err.statusCode ?? err.message})`);
            }
            return false;
          },
        ),
      ),
    ).then((results) => results.filter(Boolean).length);
  }

  function groupName(groupId) {
    return db.prepare('SELECT name FROM groups WHERE id = ?').get(groupId)?.name ?? '';
  }

  /** 新着メッセージ: 閲覧権限があり、ミュートしておらず、今そのチャットを見ていない人に通知 */
  function notifyMessage(channel, message) {
    const muted = new Set(
      db
        .prepare('SELECT user_id FROM channel_mutes WHERE channel_id = ?')
        .all(channel.id)
        .map((r) => r.user_id),
    );
    const ids = perm
      .channelReaderIds(db, channel)
      .filter((uid) => uid !== message.author?.id && !muted.has(uid) && !rt.isViewing(uid, { channelId: channel.id }));
    const text = message.body || (message.attachments.length ? '📷 画像を送信しました' : '');
    return sendToUsers(ids, {
      title: `${channel.restricted ? '🔒' : '#'}${channel.name}(${groupName(channel.group_id)})`,
      body: truncate(`${message.author?.displayName ?? ''}: ${text}`, 150),
      url: `/?g=${channel.group_id}&c=${channel.id}`,
      tag: `channel-${channel.id}`,
    });
  }

  /** アナウンス: 大事な連絡なのでミュートに関係なくグループ全員(アプリを開いている人は除く)に通知 */
  function notifyAnnouncement(groupId, announcement) {
    const ids = db
      .prepare('SELECT user_id FROM group_members WHERE group_id = ?')
      .all(groupId)
      .map((r) => r.user_id)
      .filter((uid) => uid !== announcement.author?.id && !rt.isViewing(uid, { groupId }));
    return sendToUsers(ids, {
      title: `📢 ${announcement.title}`,
      body: truncate(`${groupName(groupId)}のアナウンス${announcement.body ? `\n${announcement.body}` : ''}`, 150),
      url: `/?g=${groupId}&ann=1`,
      tag: `announcement-${announcement.id}`,
    });
  }

  function test(userId) {
    return sendToUsers([userId], { title: '🔔 通知テスト', body: 'この端末で通知を受け取れます', url: '/', tag: 'test' });
  }

  return { publicKey: keys.publicKey, subscribe, unsubscribe, notifyMessage, notifyAnnouncement, test };
}

module.exports = { createPush };
