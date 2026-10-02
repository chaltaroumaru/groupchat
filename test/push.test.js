'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const { startServer } = require('./helpers');

let srv;
before(async () => {
  srv = await startServer();
});
after(() => srv.close());

const crypto = require('node:crypto');

const KEYS = {
  p256dh: crypto.createECDH('prime256v1').generateKeys().toString('base64url'),
  auth: crypto.randomBytes(16).toString('base64url'),
};
const sub = (name) => ({ subscription: { endpoint: `https://fcm.googleapis.com/fcm/send/${name}`, keys: KEYS } });
const tick = () => new Promise((r) => setTimeout(r, 50));
const sentTo = (name) => srv.pushes.filter((p) => p.endpoint.endsWith(`/${name}`));

async function setup(prefix) {
  const owner = await srv.user(`${prefix}-owner`);
  const a = await srv.user(`${prefix}-a`);
  const b = await srv.user(`${prefix}-b`);
  const { body: created } = await owner.post('/api/groups', { name: '模擬店' }).expect(201);
  const gid = created.id;
  const { body } = await owner.get(`/api/groups/${gid}`).expect(200);
  for (const u of [a, b]) await u.post('/api/groups/join', { inviteCode: body.group.inviteCode }).expect(201);
  for (const [u, n] of [
    [owner, `${prefix}-owner`],
    [a, `${prefix}-a`],
    [b, `${prefix}-b`],
  ]) {
    await u.post('/api/push/subscribe', sub(n)).expect(201);
  }
  const { body: chs } = await owner.get(`/api/groups/${gid}/channels`).expect(200);
  return { owner, a, b, gid, general: chs.channels[0].id };
}

test('公開鍵を取得でき、通知配信サーバー以外の宛先は登録できない', async () => {
  const c = await srv.user('p0');
  const { body } = await c.get('/api/push/key').expect(200);
  assert.match(body.publicKey, /^[A-Za-z0-9_-]{80,}$/);
  await c.post('/api/push/subscribe', { subscription: { endpoint: 'https://evil.example.com/x', keys: KEYS } }).expect(400);
  await c
    .post('/api/push/subscribe', { subscription: { endpoint: 'http://fcm.googleapis.com/x', keys: { p256dh: 'p', auth: 'a' } } })
    .expect(400);
  // 鍵は DB に保存され、再起動しても同じものが使われる
  const row = srv.db.prepare("SELECT value FROM app_settings WHERE key = 'vapid'").get();
  assert.equal(JSON.parse(row.value).publicKey, body.publicKey);
});

test('メッセージは送信者以外のメンバーに通知され、ミュートしたチャットは通知されない', async () => {
  const { owner, a, gid, general } = await setup('p1');
  await owner.post(`/api/channels/${general}/messages`, { body: '10時に集合' }).expect(201);
  await tick();
  assert.equal(sentTo('p1-owner').length, 0, '送信者本人には通知しない');
  const [n] = sentTo('p1-a');
  assert.match(n.title, /全体チャット/);
  assert.equal(n.body, 'p1-owner: 10時に集合');
  assert.match(n.url, new RegExp(`c=${general}`));
  assert.equal(sentTo('p1-b').length, 1);

  const { body } = await a.put(`/api/channels/${general}/mute`, { muted: true }).expect(200);
  assert.equal(body.muted, true);
  const list = await a.get(`/api/groups/${gid}/channels`).expect(200);
  assert.equal(list.body.channels[0].muted, true);
  await owner.post(`/api/channels/${general}/messages`, { body: '2通目' }).expect(201);
  await tick();
  assert.equal(sentTo('p1-a').length, 1, 'ミュート中は増えない');
  assert.equal(sentTo('p1-b').length, 2);
});

test('閲覧できないチャットの内容は通知されない', async () => {
  const { owner, b, gid } = await setup('p2');
  const { body } = await owner.post(`/api/groups/${gid}/channels`, { name: '会計' }).expect(201);
  await owner.put(`/api/channels/${body.channel.id}/members/${b.id}`, { permission: 'none' }).expect(200);
  await owner.post(`/api/channels/${body.channel.id}/messages`, { body: '売上 3万円' }).expect(201);
  await tick();
  assert.equal(sentTo('p2-a').length, 1);
  assert.equal(sentTo('p2-b').length, 0);
});

test('アナウンスはミュートに関係なく全員に通知される', async () => {
  const { owner, a, gid, general } = await setup('p3');
  await a.put(`/api/channels/${general}/mute`, { muted: true }).expect(200);
  await owner.post(`/api/groups/${gid}/announcements`, { title: '雨天時の連絡', body: '体育館前に集合' }).expect(201);
  await tick();
  const [n] = sentTo('p3-a');
  assert.equal(n.title, '📢 雨天時の連絡');
  assert.match(n.body, /体育館前に集合/);
  assert.equal(sentTo('p3-b').length, 1);
  assert.equal(sentTo('p3-owner').length, 0);
});

test('アプリでそのチャットを開いている人には通知しない', async () => {
  const { owner, a, gid, general } = await setup('p4');
  const s = await new Promise((resolve, reject) => {
    const sock = io(srv.baseUrl, { extraHeaders: { cookie: a.cookie }, transports: ['websocket'] });
    sock.on('connect', () => resolve(sock));
    sock.on('connect_error', reject);
  });
  s.emit('presence', { groupId: gid, channelId: general, visible: true });
  await tick();
  await owner.post(`/api/channels/${general}/messages`, { body: '見てる?' }).expect(201);
  await tick();
  assert.equal(sentTo('p4-a').length, 0);
  assert.equal(sentTo('p4-b').length, 1);

  // アプリを裏に回したら通知する
  s.emit('presence', { groupId: gid, channelId: general, visible: false });
  await tick();
  await owner.post(`/api/channels/${general}/messages`, { body: '2通目' }).expect(201);
  await tick();
  assert.equal(sentTo('p4-a').length, 1);
  s.close();
});

test('無効になった宛先は削除され、ログアウト時の解除で通知が止まる', async () => {
  const c = await srv.user('p5');
  await c
    .post('/api/push/subscribe', {
      subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/gone', keys: KEYS },
    })
    .expect(201);
  await c.post('/api/push/subscribe', sub('p5')).expect(201);
  const { body } = await c.post('/api/push/test').expect(200);
  assert.equal(body.delivered, 1);
  const count = () => srv.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(c.id).n;
  assert.equal(count(), 1, '410 を返した宛先は消える');
  await c.post('/api/push/unsubscribe', { endpoint: sub('p5').subscription.endpoint }).expect(200);
  assert.equal(count(), 0);
});

test('同じ端末で別のユーザーがログインすると宛先が付け替わる', async () => {
  const x = await srv.user('p6x');
  const y = await srv.user('p6y');
  await x.post('/api/push/subscribe', sub('shared')).expect(201);
  await y.post('/api/push/subscribe', sub('shared')).expect(201);
  const rows = srv.db.prepare("SELECT user_id FROM push_subscriptions WHERE endpoint LIKE '%/shared'").all();
  assert.deepEqual(
    rows.map((r) => r.user_id),
    [y.id],
  );
});
