'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { io } = require('socket.io-client');
const { startServer, PNG } = require('./helpers');

let srv;
before(async () => {
  srv = await startServer();
});
after(() => srv.close());

/** オーナー・メンバー2人のグループを作る */
async function setupGroup(prefix) {
  const owner = await srv.user(`${prefix}-owner`);
  const alice = await srv.user(`${prefix}-alice`);
  const bob = await srv.user(`${prefix}-bob`);
  const { body: created } = await owner.post('/api/groups', { name: '焼きそば屋' }).expect(201);
  const gid = created.id;
  const { body: detail } = await owner.get(`/api/groups/${gid}`).expect(200);
  for (const c of [alice, bob]) await c.post('/api/groups/join', { inviteCode: detail.group.inviteCode }).expect(201);
  return { owner, alice, bob, gid };
}

test('メール認証が終わるまでログインできない', async () => {
  const c = srv.client();
  await c.post('/api/auth/register', { email: 'new@example.com', password: 'password123', displayName: '新人' }).expect(201);
  const res = await c.post('/api/auth/login', { email: 'new@example.com', password: 'password123' }).expect(403);
  assert.equal(res.body.code, 'EMAIL_NOT_VERIFIED');

  const url = srv.mails.at(-1).text.match(/https?:\/\/\S+/)[0];
  const verify = await c.get(url.replace(srv.baseUrl, ''), { redirect: 'manual' });
  assert.equal(verify.headers.get('location'), '/?verified=1');
  await c.post('/api/auth/login', { email: 'new@example.com', password: 'password123' }).expect(200);
  await c.get('/api/auth/me').expect(200);

  await c.post('/api/auth/login', { email: 'new@example.com', password: 'wrong-pass' }).expect(401);
  await c.post('/api/auth/register', { email: 'NEW@example.com', password: 'password123', displayName: 'x' }).expect(409);
  await c.post('/api/auth/logout').expect(200);
  await c.get('/api/auth/me').expect(401);
});

test('グループ作成・招待コードで参加・ロール付与', async () => {
  const { owner, alice, bob, gid } = await setupGroup('g1');
  const { body: role } = await owner.post(`/api/groups/${gid}/roles`, { name: '調理班', color: '#ef4444' }).expect(201);
  await owner.patch(`/api/groups/${gid}/members/${alice.id}`, { roleIds: [role.role.id] }).expect(200);

  const { body } = await alice.get(`/api/groups/${gid}`).expect(200);
  assert.equal(body.group.inviteCode, undefined, '一般メンバーには招待コードを見せない');
  assert.deepEqual(body.members.find((m) => m.id === alice.id).roleIds, [role.role.id]);

  // 一般メンバーはロール操作不可
  await alice.post(`/api/groups/${gid}/roles`, { name: '会計' }).expect(403);
  // 管理者ロールを付与できるのはオーナーのみ
  const adminRole = body.roles.find((r) => r.level === 'admin');
  await owner.patch(`/api/groups/${gid}/members/${alice.id}`, { roleIds: [role.role.id, adminRole.id] }).expect(200);
  const { body: asAdmin } = await alice.get(`/api/groups/${gid}`).expect(200);
  assert.equal(asAdmin.me.isAdmin, true);
  await alice.patch(`/api/groups/${gid}/members/${bob.id}`, { roleIds: [adminRole.id] }).expect(403);
  await alice.patch(`/api/groups/${gid}/members/${bob.id}`, { roleIds: [role.role.id] }).expect(200);
  // 非メンバーにはグループが見えない
  const outsider = await srv.user('g1-outsider');
  await outsider.get(`/api/groups/${gid}`).expect(404);
});

test('1グループに複数チャットを作成でき、指定ロールのみ閲覧・送信できる', async () => {
  const { owner, alice, bob, gid } = await setupGroup('g2');
  const { body: r1 } = await owner.post(`/api/groups/${gid}/roles`, { name: '会計' }).expect(201);
  const { body: r2 } = await owner.post(`/api/groups/${gid}/roles`, { name: '代表' }).expect(201);
  await owner.patch(`/api/groups/${gid}/members/${alice.id}`, { roleIds: [r1.role.id] }).expect(200);

  // 会計ロールは閲覧のみ、代表ロールは送信も可
  const { body: ch } = await owner
    .post(`/api/groups/${gid}/channels`, {
      name: 'お金の話',
      restricted: true,
      roles: [
        { roleId: r1.role.id, permission: 'read' },
        { roleId: r2.role.id, permission: 'write' },
      ],
    })
    .expect(201);
  const cid = ch.channel.id;
  await owner.post(`/api/groups/${gid}/channels`, { name: '買い出し' }).expect(201);

  const { body: ownerList } = await owner.get(`/api/groups/${gid}/channels`).expect(200);
  assert.equal(ownerList.channels.length, 3, '全体チャット + 2つ');

  const { body: aliceList } = await alice.get(`/api/groups/${gid}/channels`).expect(200);
  assert.equal(aliceList.channels.find((c) => c.id === cid).myPermission, 'read');
  const { body: bobList } = await bob.get(`/api/groups/${gid}/channels`).expect(200);
  assert.ok(!bobList.channels.some((c) => c.id === cid), 'ロールが無いメンバーには見えない');

  await owner.post(`/api/channels/${cid}/messages`, { body: '売上報告です' }).expect(201);
  const { body: msgs } = await alice.get(`/api/channels/${cid}/messages`).expect(200);
  assert.equal(msgs.messages[0].body, '売上報告です');
  await alice.post(`/api/channels/${cid}/messages`, { body: '了解' }).expect(403);
  await bob.get(`/api/channels/${cid}/messages`).expect(404);
  await bob.post(`/api/channels/${cid}/messages`, { body: 'x' }).expect(404);

  // ロールを付け替えると送信可能に
  await owner.patch(`/api/groups/${gid}/members/${alice.id}`, { roleIds: [r1.role.id, r2.role.id] }).expect(200);
  await alice.post(`/api/channels/${cid}/messages`, { body: '了解' }).expect(201);

  // 制限付きチャットにはロール指定が必須
  await owner.post(`/api/groups/${gid}/channels`, { name: 'x', restricted: true, roles: [] }).expect(400);
  // 一般メンバーはチャットを作れない
  await alice.post(`/api/groups/${gid}/channels`, { name: 'x' }).expect(403);
});

test('参加者ごとに権限(閲覧のみ / 閲覧・送信 / 不可)を編集できる', async () => {
  const { owner, alice, bob, gid } = await setupGroup('g3');
  const { body: ch } = await owner.post(`/api/groups/${gid}/channels`, { name: '連絡', defaultPermission: 'write' }).expect(201);
  const cid = ch.channel.id;

  await alice.post(`/api/channels/${cid}/messages`, { body: 'hi' }).expect(201);

  await owner.put(`/api/channels/${cid}/members/${alice.id}`, { permission: 'read' }).expect(200);
  await alice.post(`/api/channels/${cid}/messages`, { body: 'hi' }).expect(403);
  await alice.get(`/api/channels/${cid}/messages`).expect(200);

  await owner.put(`/api/channels/${cid}/members/${bob.id}`, { permission: 'none' }).expect(200);
  await bob.get(`/api/channels/${cid}/messages`).expect(404);

  const { body: members } = await owner.get(`/api/channels/${cid}/members`).expect(200);
  const a = members.members.find((m) => m.id === alice.id);
  assert.equal(a.permission, 'read');
  assert.equal(a.override, 'read');
  const { body: aliceView } = await alice.get(`/api/channels/${cid}/members`).expect(200);
  assert.ok(!aliceView.members.some((m) => m.id === bob.id), '参加していない人は一般メンバーに表示しない');

  // 個別設定を解除すると既定値に戻る
  await owner.put(`/api/channels/${cid}/members/${alice.id}`, { permission: null }).expect(200);
  await alice.post(`/api/channels/${cid}/messages`, { body: 'hi again' }).expect(201);

  // 既定権限を閲覧のみに → アナウンス専用チャットのような運用
  await owner.patch(`/api/channels/${cid}`, { defaultPermission: 'read' }).expect(200);
  await alice.post(`/api/channels/${cid}/messages`, { body: 'x' }).expect(403);

  await alice.put(`/api/channels/${cid}/members/${bob.id}`, { permission: 'write' }).expect(403);
  await owner.put(`/api/channels/${cid}/members/${owner.id}`, { permission: 'read' }).expect(400);
});

test('アナウンスをグループ全員に送信し、既読を管理できる', async () => {
  const { owner, alice, bob, gid } = await setupGroup('g4');
  await alice.postForm(`/api/groups/${gid}/announcements`, form({ title: 'x' })).expect(403);

  // リーダー権限のロールを持てばアナウンスを送信できる
  const { body: role } = await owner.post(`/api/groups/${gid}/roles`, { name: '広報', level: 'moderator' }).expect(201);
  await owner.patch(`/api/groups/${gid}/members/${alice.id}`, { roleIds: [role.role.id] }).expect(200);

  const f = form({ title: '明日の集合時間', body: '8:00 に正門前集合です' });
  f.append('images', new Blob([PNG], { type: 'image/png' }), '地図.png');
  const { body: created } = await alice.postForm(`/api/groups/${gid}/announcements`, f).expect(201);
  const ann = created.announcement;
  assert.equal(ann.attachments.length, 1);
  assert.equal(ann.attachments[0].name, '地図.png');

  const { body: list } = await bob.get(`/api/groups/${gid}/announcements`).expect(200);
  assert.equal(list.announcements[0].title, '明日の集合時間');
  assert.equal(list.announcements[0].readByMe, false);
  assert.equal(list.memberCount, 3);
  await bob.get(ann.attachments[0].url).expect(200);

  await bob.post(`/api/announcements/${ann.id}/read`).expect(200);
  const { body: reads } = await owner.get(`/api/announcements/${ann.id}/reads`).expect(200);
  assert.equal(reads.reads.filter((r) => r.readAt).length, 2);
  await bob.get(`/api/announcements/${ann.id}/reads`).expect(403);

  const outsider = await srv.user('g4-outsider');
  await outsider.get(ann.attachments[0].url).expect(404);
});

test('チャットに画像を添付でき、閲覧権限のない人は取得できない', async () => {
  const { owner, alice, bob, gid } = await setupGroup('g5');
  const { body: ch } = await owner.post(`/api/groups/${gid}/channels`, { name: '写真' }).expect(201);
  const cid = ch.channel.id;

  const f = form({ body: 'ブースの写真' });
  f.append('images', new Blob([PNG], { type: 'image/png' }), 'booth.png');
  f.append('images', new Blob([PNG], { type: 'image/png' }), 'menu.png');
  const { body } = await alice.postForm(`/api/channels/${cid}/messages`, f).expect(201);
  assert.equal(body.message.attachments.length, 2);

  const img = await bob.get(body.message.attachments[0].url).expect(200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.deepEqual(img.buffer, PNG);

  // 画像のみのメッセージも送れる
  const onlyImage = new FormData();
  onlyImage.append('images', new Blob([PNG], { type: 'image/png' }), 'a.png');
  await alice.postForm(`/api/channels/${cid}/messages`, onlyImage).expect(201);

  // 画像以外・偽装ファイルは拒否
  const bad = new FormData();
  bad.append('images', new Blob(['<script>alert(1)</script>'], { type: 'text/html' }), 'x.html');
  await alice.postForm(`/api/channels/${cid}/messages`, bad).expect(400);
  const fake = new FormData();
  fake.append('images', new Blob(['not an image'], { type: 'image/png' }), 'x.png');
  await alice.postForm(`/api/channels/${cid}/messages`, fake).expect(400);
  const files = fs.readdirSync(srv.uploadDir);
  assert.equal(files.length >= 3, true);

  // 閲覧不可にすると画像も取得できない
  await owner.put(`/api/channels/${cid}/members/${bob.id}`, { permission: 'none' }).expect(200);
  await bob.get(body.message.attachments[0].url).expect(404);

  // 送信権限が無い場合はアップロード自体を受け付けない
  await owner.put(`/api/channels/${cid}/members/${bob.id}`, { permission: 'read' }).expect(200);
  const before = fs.readdirSync(srv.uploadDir).length;
  const f2 = new FormData();
  f2.append('images', new Blob([PNG], { type: 'image/png' }), 'b.png');
  await bob.postForm(`/api/channels/${cid}/messages`, f2).expect(403);
  assert.equal(fs.readdirSync(srv.uploadDir).length, before);

  // 削除すると画像ファイルも消える
  await alice.del(`/api/messages/${body.message.id}`).expect(200);
  await owner.get(body.message.attachments[0].url).expect(404);
});

test('新着メッセージは閲覧権限のあるメンバーにだけリアルタイム配信される', async () => {
  const { owner, alice, bob, gid } = await setupGroup('g6');
  const { body: ch } = await owner.post(`/api/groups/${gid}/channels`, { name: '秘密' }).expect(201);
  const cid = ch.channel.id;
  await owner.put(`/api/channels/${cid}/members/${bob.id}`, { permission: 'none' }).expect(200);

  const connect = (c) =>
    new Promise((resolve, reject) => {
      const s = io(srv.baseUrl, { extraHeaders: { cookie: c.cookie }, transports: ['websocket'] });
      s.on('connect', () => resolve(s));
      s.on('connect_error', reject);
    });
  const sa = await connect(alice);
  const sb = await connect(bob);
  const bobGot = [];
  sb.on('message:new', (m) => bobGot.push(m));
  const aliceGot = new Promise((resolve) => sa.on('message:new', resolve));

  await owner.post(`/api/channels/${cid}/messages`, { body: '内緒の話' }).expect(201);
  const m = await aliceGot;
  assert.equal(m.body, '内緒の話');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(bobGot.length, 0);
  sa.close();
  sb.close();
});

function form(fields) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
}

test('同じメールアドレスへのログイン試行は回数制限される', async () => {
  await srv.user('limit');
  const c = srv.client();
  // 登録時のログイン 1 回 + 失敗 9 回で上限(10 回)に達する
  for (let i = 0; i < 9; i++) await c.post('/api/auth/login', { email: 'limit@example.com', password: 'wrong-password' }).expect(401);
  const res = await c.post('/api/auth/login', { email: 'limit@example.com', password: 'password123' }).expect(429);
  assert.equal(res.body.code, 'RATE_LIMITED');
  assert.ok(Number(res.headers.get('retry-after')) > 0);
  // 他のアカウントには影響しない
  await srv.user('limit-other');
});

test('ヘルスチェックとセキュリティヘッダー', async () => {
  const c = srv.client();
  const res = await c.get('/healthz').expect(200);
  assert.deepEqual(res.body, { ok: true });
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  const manifest = await c.get('/manifest.webmanifest').expect(200);
  assert.equal(JSON.parse(manifest.buffer.toString()).display, 'standalone');
  await c.get('/sw.js').expect(200);
});
