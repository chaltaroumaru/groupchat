'use strict';

const path = require('node:path');
const express = require('express');
const { requireAuth } = require('./auth');
const { HttpError } = require('./util');
const { createUploader } = require('./uploads');

/**
 * @param {object} deps
 * @param {import('node:sqlite').DatabaseSync} deps.db
 * @param {{ send: Function, configured: boolean }} deps.mailer
 * @param {{ toUsers: Function, toGroup: Function }} deps.rt
 * @param {{ baseUrl: string, uploadDir: string, secureCookies: boolean, exposeDevVerifyLink: boolean }} deps.config
 */
function createApp({ db, mailer, rt, config }) {
  const app = express();
  const uploader = createUploader(path.resolve(config.uploadDir));
  const deps = { db, mailer, rt, config, uploader };

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy ?? false);
  app.use(securityHeaders);
  app.use(express.json({ limit: '100kb' }));

  // ホスティングサービスの死活監視用
  app.get('/healthz', (_req, res) => {
    db.prepare('SELECT 1').get();
    res.json({ ok: true });
  });

  app.use('/api/auth', require('./routes/auth')(deps));
  const api = express.Router();
  api.use(requireAuth(db));
  api.use('/groups', require('./routes/groups')(deps));
  api.use(require('./routes/channels')(deps));
  api.use(require('./routes/announcements')(deps));
  app.use('/api', api);

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not Found')));
  app.use(
    express.static(path.join(__dirname, '..', 'public'), {
      setHeaders(res, file) {
        // 更新がすぐ反映されるよう、HTML・JS・CSS・Service Worker は毎回再検証させる
        if (/\.(html|js|css|webmanifest)$/.test(file)) res.setHeader('Cache-Control', 'no-cache');
      },
    }),
  );

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'リクエストの形式が不正です' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'リクエストが大きすぎます' });
    console.error(err);
    res.status(500).json({ error: 'サーバーでエラーが発生しました' });
  });

  return app;
}

function securityHeaders(_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; " +
      "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  next();
}

module.exports = { createApp };
