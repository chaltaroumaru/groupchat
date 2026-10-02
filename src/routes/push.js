'use strict';

const express = require('express');
const { HttpError, str } = require('../util');
const { rateLimit } = require('../ratelimit');

// ブラウザの通知配信サーバー以外の URL へサーバーから送信させないための許可リスト
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /\.push\.apple\.com$/, /\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/];

function parseSubscription(body) {
  const sub = body?.subscription;
  const endpoint = str(sub?.endpoint, '通知の宛先', { min: 1, max: 1000 });
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new HttpError(400, '通知の宛先が不正です');
  }
  if (url.protocol !== 'https:' || !PUSH_HOSTS.some((re) => re.test(url.hostname))) {
    throw new HttpError(400, 'このブラウザの通知には対応していません');
  }
  const p256dh = str(sub.keys?.p256dh, '通知の鍵', { min: 1, max: 200 });
  const auth = str(sub.keys?.auth, '通知の鍵', { min: 1, max: 100 });
  // P-256 公開鍵(非圧縮 65 バイト)と 16 バイトの認証シークレット
  if (Buffer.from(p256dh, 'base64url').length !== 65 || Buffer.from(auth, 'base64url').length !== 16) {
    throw new HttpError(400, '通知の鍵が不正です');
  }
  return { endpoint, keys: { p256dh, auth } };
}

module.exports = function pushRoutes({ push }) {
  const router = express.Router();

  router.get('/key', (_req, res) => res.json({ publicKey: push.publicKey }));

  router.post('/subscribe', (req, res) => {
    push.subscribe(req.user.id, parseSubscription(req.body));
    res.status(201).json({ ok: true });
  });

  router.post('/unsubscribe', (req, res) => {
    push.unsubscribe(req.user.id, str(req.body?.endpoint, '通知の宛先', { min: 1, max: 1000 }));
    res.json({ ok: true });
  });

  router.post('/test', rateLimit({ windowMs: 60 * 1000, max: 5, key: (req) => `push-test:${req.user.id}` }), async (req, res) => {
    res.json({ delivered: await push.test(req.user.id) });
  });

  return router;
};
