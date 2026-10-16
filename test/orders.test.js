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

const tick = () => new Promise((r) => setTimeout(r, 50));

/** POS 端末(接続コードで認証、Cookie なし) */
function pos(code) {
  const req = async (method, url, json) => {
    const headers = { origin: 'https://pos.example.com' };
    if (code) headers.authorization = `Bearer ${code}`;
    if (json !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${srv.baseUrl}/api/pos${url}`, {
      method,
      headers,
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
  };
  return {
    get: (url) => req('GET', url),
    put: (url, json) => req('PUT', url, json),
    post: (url, json) => req('POST', url, json),
    del: (url) => req('DELETE', url),
  };
}

const CUPS = [
  { syrups: ['ブルーキュラソー'], drink: '炭酸', ice: true, price: 500 },
  { syrups: [], drink: 'コーラ', ice: false, price: 400 },
];

async function setup(prefix) {
  const owner = await srv.user(`${prefix}-owner`);
  const a = await srv.user(`${prefix}-a`);
  const { body: created } = await owner.post('/api/groups', { name: '屋台' }).expect(201);
  const gid = created.id;
  const { body } = await owner.get(`/api/groups/${gid}`).expect(200);
  await a.post('/api/groups/join', { inviteCode: body.group.inviteCode }).expect(201);
  return { owner, a, gid, roles: body.roles };
}

test('POS 連携: 管理者だけが接続コードを発行でき、コードが無いと POS API は使えない', async () => {
  const { owner, a, gid } = await setup('o1');
  await a.get(`/api/groups/${gid}/pos`).expect(403);
  const { body: off } = await owner.get(`/api/groups/${gid}/pos`).expect(200);
  assert.equal(off.enabled, false);
  assert.equal((await pos(null).get('/state')).status, 401);

  const { body: on } = await owner.post(`/api/groups/${gid}/pos`).expect(200);
  assert.equal(on.enabled, true);
  assert.equal(on.serverUrl, srv.baseUrl);
  const state = await pos(on.code).get('/state');
  assert.equal(state.status, 200);
  assert.equal(state.headers.get('access-control-allow-origin'), '*');
  assert.equal(state.body.groupName, '屋台');
  assert.equal(state.body.menu, null);

  // 発行し直すと古いコードは使えない
  const { body: again } = await owner.post(`/api/groups/${gid}/pos`).expect(200);
  assert.notEqual(again.code, on.code);
  assert.equal((await pos(on.code).get('/state')).status, 401);
  // 無効にすると使えない
  await owner.del(`/api/groups/${gid}/pos`).expect(200);
  assert.equal((await pos(again.code).get('/state')).status, 401);
});

test('POS の CORS プリフライトに応答する', async () => {
  const res = await fetch(`${srv.baseUrl}/api/pos/orders`, {
    method: 'OPTIONS',
    headers: { origin: 'https://pos.example.com', 'access-control-request-method': 'POST' },
  });
  assert.equal(res.status, 204);
  assert.match(res.headers.get('access-control-allow-headers'), /authorization/);
});

test('会計完了でオーダーが作られ、メンバーと POS 端末にリアルタイム配信・通知される', async () => {
  const { owner, a, gid } = await setup('o2');
  const { body: link } = await owner.post(`/api/groups/${gid}/pos`).expect(200);
  const p = pos(link.code);
  await a.post('/api/push/subscribe', {
    subscription: {
      endpoint: 'https://fcm.googleapis.com/fcm/send/o2-a',
      keys: {
        p256dh: require('node:crypto').createECDH('prime256v1').generateKeys().toString('base64url'),
        auth: require('node:crypto').randomBytes(16).toString('base64url'),
      },
    },
  });

  const member = io(srv.baseUrl, { extraHeaders: { cookie: owner.cookie }, transports: ['websocket'] });
  const terminal = io(`${srv.baseUrl}/pos`, { auth: { token: link.code }, transports: ['websocket'] });
  await Promise.all([member, terminal].map((s) => new Promise((r, j) => (s.on('connect', r), s.on('connect_error', j)))));
  const got = { member: [], terminal: [] };
  member.on('order:new', (o) => got.member.push(o));
  member.on('order:updated', (o) => got.member.push(o));
  terminal.on('order:new', (o) => got.terminal.push(o));
  terminal.on('order:updated', (o) => got.terminal.push(o));

  const res = await p.post('/orders', { clientId: 'tx-1', cups: CUPS });
  assert.equal(res.status, 201);
  const order = res.body.order;
  assert.equal(order.number, 1);
  assert.equal(order.total, 900, '合計はサーバーで計算する');
  assert.equal(order.status, 'new');
  assert.deepEqual(order.cups, CUPS);

  // 同じ clientId の再送は重複しない
  const retry = await p.post('/orders', { clientId: 'tx-1', cups: CUPS });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.order.id, order.id);
  const second = await p.post('/orders', { clientId: 'tx-2', cups: [CUPS[1]] });
  assert.equal(second.body.order.number, 2);

  await tick();
  assert.deepEqual(
    got.member.map((o) => o.number),
    [1, 2],
  );
  assert.deepEqual(
    got.terminal.map((o) => o.number),
    [1, 2],
  );
  const notes = srv.pushes.filter((x) => x.endpoint.endsWith('/o2-a'));
  assert.equal(notes.length, 2);
  assert.equal(notes[0].title, '🧾 お呼び出し 1番(#1 / 2杯 / 900円)');
  assert.equal(notes[0].body, '・ブルーキュラソー × 炭酸(アイス)\n・コーラ');
  assert.equal(notes[0].url, `/?g=${gid}&orders=1`);

  // メンバーが状態を変更すると POS にも届く
  const { body: list } = await a.get(`/api/groups/${gid}/orders`).expect(200);
  assert.equal(list.orders.length, 2);
  assert.equal(list.canUpdate, true);
  await a.patch(`/api/orders/${order.id}`, { status: 'done' }).expect(200);
  await a.patch(`/api/orders/${order.id}`, { status: 'eaten' }).expect(400);
  await tick();
  assert.equal(got.terminal.at(-1).status, 'done');
  assert.equal((await p.get('/state')).body.orders.find((o) => o.id === order.id).status, 'done');

  // 古い接続コードの POS 端末は発行し直すと切断される
  const disconnected = new Promise((r) => terminal.on('disconnect', r));
  await owner.post(`/api/groups/${gid}/pos`).expect(200);
  await disconnected;
  member.close();
  terminal.close();
});

test('不正な注文・メニューは拒否し、メニューは全端末で共有される', async () => {
  const { owner, gid } = await setup('o3');
  const { body: link } = await owner.post(`/api/groups/${gid}/pos`).expect(200);
  const p = pos(link.code);
  assert.equal((await p.post('/orders', { clientId: 'x', cups: [] })).status, 400);
  assert.equal((await p.post('/orders', { clientId: 'x', cups: [{ drink: '', price: 400 }] })).status, 400);
  assert.equal((await p.post('/orders', { clientId: 'x', cups: [{ drink: '炭酸', price: -1 }] })).status, 400);
  assert.equal((await p.post('/orders', { cups: CUPS })).status, 400);
  assert.equal((await p.put('/menu', { syrups: [], drinks: [] })).status, 400);

  const t2 = io(`${srv.baseUrl}/pos`, { auth: { token: link.code }, transports: ['websocket'] });
  await new Promise((r) => t2.on('connect', r));
  const menus = [];
  t2.on('pos:menu', (m) => menus.push(m));
  const menu = { syrups: ['カシス'], drinks: ['炭酸', '紅茶'] };
  assert.equal((await p.put('/menu', menu)).status, 200);
  await tick();
  assert.deepEqual(menus, [menu]);
  assert.deepEqual((await p.get('/state')).body.menu, menu);

  // 不正な接続コードでは接続できない
  const bad = io(`${srv.baseUrl}/pos`, { auth: { token: 'nope' }, transports: ['websocket'] });
  await new Promise((r) => bad.on('connect_error', r));
  bad.close();
  t2.close();
});

test('閲覧のみのメンバーはオーダーの状態を変更できず、別グループのオーダーは見えない', async () => {
  const { owner, a, gid, roles } = await setup('o4');
  const { body: link } = await owner.post(`/api/groups/${gid}/pos`).expect(200);
  const { body } = await pos(link.code).post('/orders', { clientId: 'r', cups: CUPS });
  await owner.patch(`/api/groups/${gid}/members/${a.id}`, { roleIds: [roles.find((r) => r.level === 'read').id] }).expect(200);
  const { body: list } = await a.get(`/api/groups/${gid}/orders`).expect(200);
  assert.equal(list.canUpdate, false);
  await a.patch(`/api/orders/${body.order.id}`, { status: 'done' }).expect(403);

  const outsider = await srv.user('o4-x');
  await outsider.get(`/api/groups/${gid}/orders`).expect(404);
  await outsider.patch(`/api/orders/${body.order.id}`, { status: 'done' }).expect(404);
});

test('オーダー通知はオフにでき、オーダー画面を開いている人には鳴らさない', async () => {
  const { owner, a, gid } = await setup('o5');
  const crypto = require('node:crypto');
  const keys = {
    p256dh: crypto.createECDH('prime256v1').generateKeys().toString('base64url'),
    auth: crypto.randomBytes(16).toString('base64url'),
  };
  for (const [u, n] of [
    [owner, 'o5-owner'],
    [a, 'o5-a'],
  ]) {
    await u.post('/api/push/subscribe', { subscription: { endpoint: `https://fcm.googleapis.com/fcm/send/${n}`, keys } }).expect(201);
  }
  const { body: link } = await owner.post(`/api/groups/${gid}/pos`).expect(200);
  await a.put(`/api/groups/${gid}/orders/mute`, { muted: true }).expect(200);
  const s = io(srv.baseUrl, { extraHeaders: { cookie: owner.cookie }, transports: ['websocket'] });
  await new Promise((r) => s.on('connect', r));
  s.emit('presence', { groupId: gid, channelId: null, orders: true, visible: true });
  await tick();
  await pos(link.code).post('/orders', { clientId: 'm', cups: CUPS });
  await tick();
  const sent = (n) => srv.pushes.filter((x) => x.endpoint.endsWith(`/${n}`)).length;
  assert.equal(sent('o5-a'), 0, '通知オフ');
  assert.equal(sent('o5-owner'), 0, 'オーダー画面を表示中');
  s.close();
});

test('会計履歴の消去で番号が振り直される', async () => {
  const { owner, gid } = await setup('o6');
  const { body: link } = await owner.post(`/api/groups/${gid}/pos`).expect(200);
  const p = pos(link.code);
  await p.post('/orders', { clientId: '1', cups: CUPS });
  assert.equal((await p.del('/orders')).status, 200);
  assert.equal((await owner.get(`/api/groups/${gid}/orders`).expect(200)).body.orders.length, 0);
  assert.equal((await p.post('/orders', { clientId: '2', cups: CUPS })).body.order.number, 1);
});

test('未読数: 開くまでチャットごとに数え、既読にすると他の端末にも反映される', async () => {
  const { owner, a, gid } = await setup('o7');
  const { body: chs } = await a.get(`/api/groups/${gid}/channels`).expect(200);
  const general = chs.channels[0];
  assert.equal(general.unreadCount, 0);
  assert.equal(general.lastMessage, null);
  const { body: ch2 } = await owner.post(`/api/groups/${gid}/channels`, { name: '調理' }).expect(201);

  await owner.post(`/api/channels/${general.id}/messages`, { body: 'おはよう' }).expect(201);
  await owner.post(`/api/channels/${general.id}/messages`, { body: '集合' }).expect(201);
  await owner.post(`/api/channels/${ch2.channel.id}/messages`, { body: '麺' }).expect(201);
  await a.post(`/api/channels/${general.id}/messages`, { body: '了解' }).expect(201);

  const counts = async (u) =>
    Object.fromEntries((await u.get(`/api/groups/${gid}/channels`).expect(200)).body.channels.map((c) => [c.name, c.unreadCount]));
  assert.deepEqual(await counts(a), { 全体チャット: 2, 調理: 1 }, '自分のメッセージは数えない');
  assert.deepEqual(await counts(owner), { 全体チャット: 1, 調理: 0 });
  const { body: list } = await a.get(`/api/groups/${gid}/channels`).expect(200);
  assert.equal(list.channels[0].lastMessage.body, '了解');
  assert.equal(list.channels[0].lastMessage.authorName, 'o7-a');

  const other = io(srv.baseUrl, { extraHeaders: { cookie: a.cookie }, transports: ['websocket'] });
  await new Promise((r) => other.on('connect', r));
  const reads = [];
  other.on('channel:read', (e) => reads.push(e));
  const { body } = await a.post(`/api/channels/${general.id}/read`, {}).expect(200);
  assert.equal(body.unreadCount, 0);
  await tick();
  assert.deepEqual(reads, [{ channelId: general.id, unreadCount: 0 }]);
  assert.deepEqual(await counts(a), { 全体チャット: 0, 調理: 1 });
  other.close();

  // 閲覧できないチャットは既読にできない
  const outsider = await srv.user('o7-x');
  await outsider.post(`/api/channels/${general.id}/read`, {}).expect(404);
});

test('お呼び出し番号は 1〜15 を繰り返し、注文番号とは別に付く', async () => {
  const { owner, gid } = await setup('o8');
  const { body: link } = await owner.post(`/api/groups/${gid}/pos`).expect(200);
  const p = pos(link.code);
  const calls = [];
  for (let i = 1; i <= 17; i++) {
    const { body } = await p.post('/orders', { clientId: `c${i}`, cups: [CUPS[1]] });
    calls.push([body.order.number, body.order.callNumber]);
  }
  assert.deepEqual(calls.slice(13), [
    [14, 14],
    [15, 15],
    [16, 1],
    [17, 2],
  ]);
  // 履歴を消すと 1 から
  await p.del('/orders');
  const { body } = await p.post('/orders', { clientId: 'again', cups: [CUPS[1]] });
  assert.deepEqual([body.order.number, body.order.callNumber], [1, 1]);
});

test('暗証番号: 管理者が全端末共通で設定し、POS に配信される', async () => {
  const crypto = require('node:crypto');
  const { owner, a, gid } = await setup('o9');
  await owner.put(`/api/groups/${gid}/pos/pin`, { pin: '1234' }).expect(400, 'POS 連携前');
  const { body: link } = await owner.post(`/api/groups/${gid}/pos`).expect(200);
  assert.equal(link.pinSet, false);
  const p = pos(link.code);
  assert.equal((await p.get('/state')).body.pin, null);
  assert.equal((await p.post('/pin/check', { pin: '0000' })).body.ok, true, '未設定なら誰でも開ける');

  const t = io(`${srv.baseUrl}/pos`, { auth: { token: link.code }, transports: ['websocket'] });
  await new Promise((r) => t.on('connect', r));
  const got = [];
  t.on('pos:settings', (s) => got.push(s));

  await a.put(`/api/groups/${gid}/pos/pin`, { pin: '1234' }).expect(403);
  await owner.put(`/api/groups/${gid}/pos/pin`, { pin: '12' }).expect(400);
  await owner.put(`/api/groups/${gid}/pos/pin`, { pin: 'abcd' }).expect(400);
  const { body: set } = await owner.put(`/api/groups/${gid}/pos/pin`, { pin: '2580' }).expect(200);
  assert.equal(set.pinSet, true);
  const { pin } = (await p.get('/state')).body;
  assert.equal(crypto.createHash('sha256').update(`${pin.salt}2580`).digest('hex'), pin.hash, '端末側で照合できる');
  assert.equal((await p.post('/pin/check', { pin: '2580' })).body.ok, true);
  assert.equal((await p.post('/pin/check', { pin: '1111' })).body.ok, false);
  await tick();
  assert.equal(got.at(-1).pin.hash, pin.hash);
  // メンバーには暗証番号を渡さない
  const { body: list } = await a.get(`/api/groups/${gid}/orders`).expect(200);
  assert.equal(list.pin, undefined);

  await owner.put(`/api/groups/${gid}/pos/pin`, { pin: null }).expect(200);
  assert.equal((await p.get('/state')).body.pin, null);
  t.close();
});

test('売り切れ: POS とメンバーのどちらからでも切り替えられ、全端末に配信される', async () => {
  const { owner, a, gid, roles } = await setup('o10');
  const { body: link } = await owner.post(`/api/groups/${gid}/pos`).expect(200);
  const p = pos(link.code);
  assert.equal((await p.put('/sold-out', { kind: 'drinks', name: '炭酸', soldOut: true })).status, 400, 'メニュー登録前');
  await p.put('/menu', { syrups: ['カシス'], drinks: ['炭酸', '紅茶'] });

  const t = io(`${srv.baseUrl}/pos`, { auth: { token: link.code }, transports: ['websocket'] });
  const m = io(srv.baseUrl, { extraHeaders: { cookie: a.cookie }, transports: ['websocket'] });
  await Promise.all([t, m].map((s) => new Promise((r) => s.on('connect', r))));
  const toPos = [];
  const toMember = [];
  t.on('pos:settings', (s) => toPos.push(s.soldOut));
  m.on('pos:settings', (s) => toMember.push(s));

  // POS から(暗証番号なしで操作できる)
  await owner.put(`/api/groups/${gid}/pos/pin`, { pin: '1234' }).expect(200);
  assert.deepEqual((await p.put('/sold-out', { kind: 'drinks', name: '炭酸', soldOut: true })).body.soldOut, {
    syrups: [],
    drinks: ['炭酸'],
  });
  assert.equal((await p.put('/sold-out', { kind: 'drinks', name: 'メロン', soldOut: true })).status, 400);
  // メンバーから
  await a.put(`/api/groups/${gid}/pos/sold-out`, { kind: 'syrups', name: 'カシス', soldOut: true }).expect(200);
  await a.put(`/api/groups/${gid}/pos/sold-out`, { kind: 'drinks', name: '炭酸', soldOut: false }).expect(200);
  await tick();
  assert.deepEqual(toPos.at(-1), { syrups: ['カシス'], drinks: [] });
  assert.deepEqual(toMember.at(-1).soldOut, { syrups: ['カシス'], drinks: [] });
  assert.equal(toMember.at(-1).pin, undefined);
  const { body: list } = await a.get(`/api/groups/${gid}/orders`).expect(200);
  assert.deepEqual(list.menu, { syrups: ['カシス'], drinks: ['炭酸', '紅茶'] });
  assert.deepEqual(list.soldOut, { syrups: ['カシス'], drinks: [] });
  assert.deepEqual((await p.get('/state')).body.soldOut, { syrups: ['カシス'], drinks: [] });

  // メニューから消えた項目は売り切れからも消える
  await p.put('/menu', { syrups: [], drinks: ['炭酸'] });
  assert.deepEqual((await p.get('/state')).body.soldOut, { syrups: [], drinks: [] });

  // 閲覧のみのメンバーは変更できない
  await owner.patch(`/api/groups/${gid}/members/${a.id}`, { roleIds: [roles.find((r) => r.level === 'read').id] }).expect(200);
  await a.put(`/api/groups/${gid}/pos/sold-out`, { kind: 'drinks', name: '炭酸', soldOut: true }).expect(403);
  t.close();
  m.close();
});
