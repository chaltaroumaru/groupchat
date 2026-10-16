'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { requireAuth } = require('./auth');
const { HttpError } = require('./util');
const { createUploader } = require('./uploads');
const { createPush } = require('./push');

/**
 * @param {object} deps
 * @param {import('node:sqlite').DatabaseSync} deps.db
 * @param {{ send: Function, configured: boolean }} deps.mailer
 * @param {{ toUsers: Function, toGroup: Function }} deps.rt
 * @param {{ baseUrl: string, secureCookies: boolean, exposeDevVerifyLink: boolean }} deps.config
 */
function createApp({ db, mailer, rt, config, push = createPush({ db, rt, config }) }) {
  const app = express();
  const uploader = createUploader();
  const deps = { db, mailer, rt, config, uploader, push };

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
  app.use('/api/pos', require('./routes/pos')(deps));
  const api = express.Router();
  api.use(requireAuth(db));
  api.use('/groups', require('./routes/groups')(deps));
  api.use(require('./routes/channels')(deps));
  api.use(require('./routes/announcements')(deps));
  api.use(require('./routes/orders').orderRoutes(deps));
  api.use('/push', require('./routes/push')(deps));
  app.use('/api', api);

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not Found')));
  app.use('/pos', posPage());
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

const csp = (scriptSrc) =>
  `default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src ${scriptSrc}; connect-src 'self'; ` +
  "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

function securityHeaders(_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', csp("'self'"));
  next();
}

/**
 * 屋台 POS(pos/index.html、yatai-pos リポジトリと同じファイル)を /pos/ で配信する。
 * <meta name="pos-server"> を差し込むと、POS はこのサーバーと自動で連携する(サーバー URL の入力が不要になる)。
 * POS は 1 ファイルで完結しているため、埋め込みスクリプトだけをハッシュで許可する。
 */
function posPage() {
  const dir = path.join(__dirname, '..', 'pos');
  const router = express.Router();
  let page = null;
  const load = () => {
    if (page) return page;
    const html = fs
      .readFileSync(path.join(dir, 'index.html'), 'utf8')
      .replace('<head>', '<head>\n<meta name="pos-server" content="same-origin">');
    const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
      (m) => `'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`,
    );
    page = { html, csp: csp(["'self'", ...hashes].join(' ')) };
    return page;
  };
  router.get('/', (req, res) => {
    if (!req.originalUrl.split('?')[0].endsWith('/')) {
      const q = req.originalUrl.indexOf('?');
      return res.redirect(301, `/pos/${q >= 0 ? req.originalUrl.slice(q) : ''}`);
    }
    const { html, csp: policy } = load();
    res.setHeader('Content-Security-Policy', policy);
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(html);
  });
  router.get('/sw.js', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(dir, 'sw.js'));
  });
  return router;
}

module.exports = { createApp };
