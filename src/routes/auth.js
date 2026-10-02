'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { HttpError, now, randomToken, str } = require('../util');
const auth = require('../auth');
const { rateLimit } = require('../ratelimit');

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = function authRoutes({ db, mailer, config }) {
  const router = express.Router();

  async function sendVerification(user, token) {
    const url = `${config.baseUrl}/api/auth/verify?token=${encodeURIComponent(token)}`;
    await mailer.send({
      to: user.email,
      subject: '【学祭グループチャット】メールアドレスの確認',
      text: `${user.display_name} さん\n\n以下のリンクを開いてメールアドレスの認証を完了してください(24時間有効)。\n${url}\n`,
    });
    return url;
  }

  // 携帯回線は多くの端末で IP アドレスを共有するため、IP 単位の上限は緩めにしてメールアドレス単位で絞る
  const emailKey = (prefix) => (req) => typeof req.body?.email === 'string' && `${prefix}:email:${req.body.email.trim().toLowerCase()}`;
  const ipKey = (prefix) => (req) => `${prefix}:ip:${req.ip}`;
  const loginLimit = [
    rateLimit({ windowMs: 15 * 60 * 1000, max: 10, key: emailKey('login') }),
    rateLimit({ windowMs: 15 * 60 * 1000, max: 100, key: ipKey('login') }),
  ];
  const registerLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 50, key: ipKey('register') });
  const resendLimit = [
    rateLimit({ windowMs: 60 * 60 * 1000, max: 5, key: emailKey('resend') }),
    rateLimit({ windowMs: 60 * 60 * 1000, max: 30, key: ipKey('resend') }),
  ];

  /** SMTP 未設定の開発環境では、画面から認証できるよう URL を返す */
  const devLink = (url) => (!mailer.configured && config.exposeDevVerifyLink ? { devVerifyUrl: url } : {});

  router.post('/register', registerLimit, async (req, res) => {
    const email = str(req.body.email, 'メールアドレス', { max: 254 }).toLowerCase();
    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'メールアドレスの形式が正しくありません');
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    if (password.length < 8 || password.length > 128) throw new HttpError(400, 'パスワードは8〜128文字にしてください');
    const displayName = str(req.body.displayName, '表示名', { min: 1, max: 40 });

    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
      throw new HttpError(409, 'このメールアドレスは既に登録されています');
    }
    const token = randomToken();
    const hash = await bcrypt.hash(password, 10);
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO users (email, password_hash, display_name, verify_token, verify_expires, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(email, hash, displayName, token, now() + VERIFY_TTL_MS, now());
    const url = await sendVerification({ email, display_name: displayName }, token);
    res.status(201).json({ id: Number(lastInsertRowid), message: '確認メールを送信しました', ...devLink(url) });
  });

  router.get('/verify', (req, res) => {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const user = token ? db.prepare('SELECT id, verify_expires FROM users WHERE verify_token = ?').get(token) : null;
    if (!user || user.verify_expires < now()) return res.redirect('/?verified=0');
    db.prepare('UPDATE users SET email_verified = 1, verify_token = NULL, verify_expires = NULL WHERE id = ?').run(user.id);
    res.redirect('/?verified=1');
  });

  router.post('/resend', resendLimit, async (req, res) => {
    const email = str(req.body.email, 'メールアドレス', { max: 254 }).toLowerCase();
    const user = db.prepare('SELECT id, email, display_name, email_verified FROM users WHERE email = ?').get(email);
    // 登録有無を推測されないよう、結果に関わらず同じ応答を返す
    let extra = {};
    if (user && !user.email_verified) {
      const token = randomToken();
      db.prepare('UPDATE users SET verify_token = ?, verify_expires = ? WHERE id = ?').run(token, now() + VERIFY_TTL_MS, user.id);
      extra = devLink(await sendVerification(user, token));
    }
    res.json({ message: '未認証のアカウントがあれば確認メールを再送しました', ...extra });
  });

  router.post('/login', loginLimit, async (req, res) => {
    const email = str(req.body.email, 'メールアドレス', { max: 254 }).toLowerCase();
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      throw new HttpError(401, 'メールアドレスまたはパスワードが違います');
    }
    if (!user.email_verified) {
      throw new HttpError(403, 'メールアドレスの認証が完了していません。確認メールのリンクを開いてください', 'EMAIL_NOT_VERIFIED');
    }
    const token = auth.createSession(db, user.id);
    res.setHeader('Set-Cookie', auth.sessionCookie(token, { secure: config.secureCookies }));
    res.json({ user: { id: user.id, email: user.email, displayName: user.display_name } });
  });

  router.post('/logout', (req, res) => {
    auth.destroySession(db, auth.parseCookies(req.headers.cookie)[auth.SESSION_COOKIE]);
    res.setHeader('Set-Cookie', auth.clearSessionCookie());
    res.json({ ok: true });
  });

  router.get('/me', auth.requireAuth(db), (req, res) => {
    const { id, email, displayName } = req.user;
    res.json({ user: { id, email, displayName } });
  });

  router.patch('/me', auth.requireAuth(db), (req, res) => {
    const displayName = str(req.body.displayName, '表示名', { min: 1, max: 40 });
    db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(displayName, req.user.id);
    res.json({ user: { id: req.user.id, email: req.user.email, displayName } });
  });

  return router;
};
