'use strict';

const { HttpError, now, randomToken } = require('./util');

const SESSION_COOKIE = 'sid';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    try {
      out[key] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // 壊れた Cookie は無視
    }
  }
  return out;
}

function createSession(db, userId) {
  const token = randomToken();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, now() + SESSION_TTL_MS);
  return token;
}

function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

/** Cookie ヘッダからログイン中のユーザーを取り出す(未ログインなら null) */
function userFromCookieHeader(db, cookieHeader) {
  const token = parseCookies(cookieHeader)[SESSION_COOKIE];
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.email, u.display_name, u.email_verified, s.expires_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token = ?`,
    )
    .get(token);
  if (!row) return null;
  if (row.expires_at < now()) {
    destroySession(db, token);
    return null;
  }
  return { id: row.id, email: row.email, displayName: row.display_name, emailVerified: !!row.email_verified, token };
}

function sessionCookie(token, { secure }) {
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_TTL_MS / 1000}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** ログイン必須のルートに付けるミドルウェア */
function requireAuth(db) {
  return (req, _res, next) => {
    const user = userFromCookieHeader(db, req.headers.cookie);
    if (!user) return next(new HttpError(401, 'ログインしてください', 'UNAUTHENTICATED'));
    if (!user.emailVerified) return next(new HttpError(403, 'メールアドレスの認証が完了していません', 'EMAIL_NOT_VERIFIED'));
    req.user = user;
    next();
  };
}

module.exports = {
  SESSION_COOKIE,
  parseCookies,
  createSession,
  destroySession,
  userFromCookieHeader,
  sessionCookie,
  clearSessionCookie,
  requireAuth,
};
