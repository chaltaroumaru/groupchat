'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let srv;
before(async () => {
  srv = await startServer();
});
after(() => srv.close());

/** オーナー + メンバー 3 人のグループと、既定ロール(管理者 / リーダー / 閲覧のみ)を返す */
async function setup(prefix) {
  const owner = await srv.user(`${prefix}-owner`);
  const users = {};
  for (const name of ['a', 'b', 'c']) users[name] = await srv.user(`${prefix}-${name}`);
  const { body: created } = await owner.post('/api/groups', { name: '模擬店' }).expect(201);
  const gid = created.id;
  const { body } = await owner.get(`/api/groups/${gid}`).expect(200);
  for (const u of Object.values(users)) await u.post('/api/groups/join', { inviteCode: body.group.inviteCode }).expect(201);
  const role = (level) => body.roles.find((r) => r.level === level).id;
  const assign = (u, roleIds) => owner.patch(`/api/groups/${gid}/members/${u.id}`, { roleIds }).expect(200);
  const { body: chs } = await owner.get(`/api/groups/${gid}/channels`).expect(200);
  return { owner, ...users, gid, role, assign, general: chs.channels[0].id };
}

test('グループ作成時に権限ごとの既定ロールが用意される', async () => {
  const { owner, gid } = await setup('r0');
  const { body } = await owner.get(`/api/groups/${gid}`).expect(200);
  assert.deepEqual(
    body.roles.map((r) => [r.name, r.level]),
    [
      ['管理者', 'admin'],
      ['リーダー', 'moderator'],
      ['閲覧のみ', 'read'],
    ],
  );
  assert.equal(body.me.level, 'admin');
  assert.equal(body.members.find((m) => !m.isOwner).level, 'write', 'ロールなしは閲覧・送信');
});

test('閲覧のみロール: どのチャットでも閲覧はできるが送信できない', async () => {
  const { owner, a, gid, role, assign, general } = await setup('r1');
  await assign(a, [role('read')]);

  await a.get(`/api/channels/${general}/messages`).expect(200);
  await a.post(`/api/channels/${general}/messages`, { body: 'x' }).expect(403);
  await a.postForm(`/api/groups/${gid}/announcements`, new FormData()).expect(403);
  await a.post(`/api/groups/${gid}/channels`, { name: 'x' }).expect(403);

  // 制限付きチャットでロールに送信を許可していても、閲覧のみに制限される
  const { body: r } = await owner.post(`/api/groups/${gid}/roles`, { name: '会計(閲覧のみ)', level: 'read' }).expect(201);
  await assign(a, [r.role.id]);
  const { body: ch } = await owner
    .post(`/api/groups/${gid}/channels`, { name: '会計', restricted: true, roles: [{ roleId: r.role.id, permission: 'write' }] })
    .expect(201);
  await a.get(`/api/channels/${ch.channel.id}/messages`).expect(200);
  await a.post(`/api/channels/${ch.channel.id}/messages`, { body: 'x' }).expect(403);
  const { body: members } = await owner.get(`/api/channels/${ch.channel.id}/members`).expect(200);
  assert.equal(members.members.find((m) => m.id === a.id).source, 'level');

  // 管理者が個別に許可すれば送信できる
  await owner.put(`/api/channels/${general}/members/${a.id}`, { permission: 'write' }).expect(200);
  await a.post(`/api/channels/${general}/messages`, { body: '許可されました' }).expect(201);
});

test('閲覧・送信ロール: 送信はできるがチャット作成・アナウンス・設定はできない', async () => {
  const { a, gid, general } = await setup('r2');
  await a.post(`/api/channels/${general}/messages`, { body: 'hi' }).expect(201);
  await a.post(`/api/groups/${gid}/channels`, { name: 'x' }).expect(403);
  const f = new FormData();
  f.append('title', 'x');
  await a.postForm(`/api/groups/${gid}/announcements`, f).expect(403);
  await a.patch(`/api/channels/${general}`, { name: 'x' }).expect(403);
  await a.patch(`/api/groups/${gid}`, { name: 'x' }).expect(403);
});

test('リーダーロール: チャット作成とアナウンスができ、自分のチャットだけ管理できる', async () => {
  const { owner, a, b, gid, role, assign, general } = await setup('r3');
  await assign(a, [role('moderator')]);

  const { body: me } = await a.get(`/api/groups/${gid}`).expect(200);
  assert.equal(me.me.canCreateChannels, true);
  assert.equal(me.me.canAnnounce, true);
  assert.equal(me.group.inviteCode, undefined, 'グループ設定(招待コード)は見えない');

  const f = new FormData();
  f.append('title', '買い出しリスト');
  await a.postForm(`/api/groups/${gid}/announcements`, f).expect(201);

  // 自分のロールを含めない制限付きチャットを作っても、作成者は参加できる
  const { body: r } = await owner.post(`/api/groups/${gid}/roles`, { name: '調理班' }).expect(201);
  await assign(b, [r.role.id]);
  const { body: ch } = await a
    .post(`/api/groups/${gid}/channels`, { name: '調理班連絡', restricted: true, roles: [{ roleId: r.role.id, permission: 'read' }] })
    .expect(201);
  const cid = ch.channel.id;
  assert.equal(ch.channel.canManage, true);
  await a.post(`/api/channels/${cid}/messages`, { body: '明日の仕込み' }).expect(201);
  await a.patch(`/api/channels/${cid}`, { description: '調理班の連絡用' }).expect(200);
  await a.put(`/api/channels/${cid}/members/${b.id}`, { permission: 'write' }).expect(200);
  await b.post(`/api/channels/${cid}/messages`, { body: '了解' }).expect(201);
  const { body: msgs } = await a.get(`/api/channels/${cid}/messages`).expect(200);
  await a.del(`/api/messages/${msgs.messages.at(-1).id}`).expect(200);

  // 他人が作ったチャットやグループ設定には干渉できない
  await a.patch(`/api/channels/${general}`, { name: 'x' }).expect(403);
  await a.del(`/api/channels/${general}`).expect(403);
  await a.put(`/api/channels/${general}/members/${b.id}`, { permission: 'read' }).expect(403);
  await a.patch(`/api/groups/${gid}`, { name: 'x' }).expect(403);
  await a.patch(`/api/groups/${gid}/members/${b.id}`, { roleIds: [] }).expect(403);
  await a.post(`/api/groups/${gid}/roles`, { name: 'x' }).expect(403);

  await a.del(`/api/channels/${cid}`).expect(200);
});

test('管理者ロール: 全チャットとグループ設定を管理できるが、管理者の任命はオーナーのみ', async () => {
  const { owner, a, b, gid, role, assign } = await setup('r4');
  await assign(a, [role('admin')]);

  const { body: ch } = await owner.post(`/api/groups/${gid}/channels`, { name: '代表連絡' }).expect(201);
  await a.patch(`/api/channels/${ch.channel.id}`, { name: '代表・管理者連絡' }).expect(200);
  await a.put(`/api/channels/${ch.channel.id}/members/${b.id}`, { permission: 'none' }).expect(200);
  await a.patch(`/api/groups/${gid}`, { name: '模擬店(更新)' }).expect(200);
  const { body: g } = await a.get(`/api/groups/${gid}`).expect(200);
  assert.ok(g.group.inviteCode);

  // 管理者以外のロールは付与・作成できる
  await a.patch(`/api/groups/${gid}/members/${b.id}`, { roleIds: [role('moderator')] }).expect(200);
  const { body: r } = await a.post(`/api/groups/${gid}/roles`, { name: '会計', level: 'moderator' }).expect(201);

  // 管理者権限の付与・取り消しはオーナーのみ
  await a.patch(`/api/groups/${gid}/members/${b.id}`, { roleIds: [role('admin')] }).expect(403);
  await a.post(`/api/groups/${gid}/roles`, { name: '副代表', level: 'admin' }).expect(403);
  await a.patch(`/api/groups/${gid}/roles/${r.role.id}`, { level: 'admin' }).expect(403);
  await a.patch(`/api/groups/${gid}/roles/${role('admin')}`, { level: 'write' }).expect(403);
  await a.del(`/api/groups/${gid}/roles/${role('admin')}`).expect(403);
  await owner.patch(`/api/groups/${gid}/roles/${r.role.id}`, { level: 'admin' }).expect(200);

  // 複数ロールを持つ場合は最も強い権限になる
  await owner.patch(`/api/groups/${gid}/members/${b.id}`, { roleIds: [role('read'), role('moderator')] }).expect(200);
  const { body: bView } = await b.get(`/api/groups/${gid}`).expect(200);
  assert.equal(bView.me.level, 'moderator');

  // オーナーが管理者ロールを外すと権限を失う
  await owner.patch(`/api/groups/${gid}/members/${a.id}`, { roleIds: [] }).expect(200);
  await a.patch(`/api/groups/${gid}`, { name: 'x' }).expect(403);
});
