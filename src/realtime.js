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
    io.on('connection', (socket) => socket.join(`user:${socket.data.user.id}`));
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

  function close() {
    if (io) io.close();
  }

  return { attach, toUsers, toGroup, close };
}

module.exports = { createRealtime };
