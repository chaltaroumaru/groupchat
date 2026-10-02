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
  app.use(express.json({ limit: '100kb' }));

  app.use('/api/auth', require('./routes/auth')(deps));
  const api = express.Router();
  api.use(requireAuth(db));
  api.use('/groups', require('./routes/groups')(deps));
  api.use(require('./routes/channels')(deps));
  api.use(require('./routes/announcements')(deps));
  app.use('/api', api);

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not Found')));
  app.use(express.static(path.join(__dirname, '..', 'public')));

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

module.exports = { createApp };
