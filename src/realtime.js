'use strict';

const { Server } = require('socket.io');
const { userFromCookieHeader } = require('./auth');

/**
 * Socket.IO でのリアルタイム配信。
 * 各接続はユーザーごとのルーム(user:<id>)に入り、サーバー側で権限を判定した宛先にだけ送信する。
 */
function createRealtime(db) {
  let io = null;

  function attach(httpServer) {
    io = new Server(httpServer);
    io.use((socket, next) => {
      const user = userFromCookieHeader(db, socket.handshake.headers.cookie);
      if (!user || !user.emailVerified) return next(new Error('unauthorized'));
      socket.data.user = user;
      next();
    });
    io.on('connection', (socket) => {
      socket.join(`user:${socket.data.user.id}`);
      // 今どの画面を開いているか(開いているチャットへの通知を鳴らさないため)
      socket.data.view = null;
      socket.on('presence', (p) => {
        const id = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);
        socket.data.view = p && p.visible ? { groupId: id(p.groupId), channelId: id(p.channelId) } : null;
      });
    });
    return io;
  }

  function toUsers(userIds, event, payload) {
    if (!io || userIds.length === 0) return;
    io.to(userIds.map((id) => `user:${id}`)).emit(event, payload);
  }

  function toGroup(groupId, event, payload) {
    const ids = db
      .prepare('SELECT user_id FROM group_members WHERE group_id = ?')
      .all(groupId)
      .map((r) => r.user_id);
    toUsers(ids, event, payload);
  }

  /** ユーザーがアプリを前面に表示して、指定のグループ・チャットを見ているか */
  function isViewing(userId, { groupId, channelId }) {
    if (!io) return false;
    const room = io.sockets.adapter.rooms.get(`user:${userId}`);
    for (const sid of room ?? []) {
      const v = io.sockets.sockets.get(sid)?.data.view;
      if (!v) continue;
      if (channelId !== undefined ? v.channelId === channelId : v.groupId === groupId) return true;
    }
    return false;
  }

  function close() {
    if (io) io.close();
  }

  return { attach, toUsers, toGroup, isViewing, close };
}

module.exports = { createRealtime };
