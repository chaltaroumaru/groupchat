'use strict';

const http = require('node:http');
const path = require('node:path');
const { openDatabase } = require('./db');
const { createApp } = require('./app');
const { createMailer } = require('./mailer');
const { createRealtime } = require('./realtime');

const env = process.env;
const port = Number(env.PORT || 3000);
const dataDir = env.DATA_DIR || path.join(__dirname, '..', 'data');

const config = {
  baseUrl: env.BASE_URL || `http://localhost:${port}`,
  uploadDir: env.UPLOAD_DIR || path.join(dataDir, 'uploads'),
  secureCookies: env.COOKIE_SECURE === 'true',
  trustProxy: env.TRUST_PROXY === 'true' ? 1 : false,
  // 本番(NODE_ENV=production)では認証リンクを API 応答に含めない
  exposeDevVerifyLink: env.NODE_ENV !== 'production',
};

const db = openDatabase(env.DB_FILE || path.join(dataDir, 'groupchat.db'));
const mailer = createMailer(env);
const rt = createRealtime(db);
const app = createApp({ db, mailer, rt, config });
const server = http.createServer(app);
rt.attach(server);

server.listen(port, () => {
  console.log(`学祭グループチャット: ${config.baseUrl}`);
  if (!mailer.configured) console.log('SMTP 未設定のため、認証メールはコンソールに出力されます');
});
