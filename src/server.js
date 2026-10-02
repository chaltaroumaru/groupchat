'use strict';

const http = require('node:http');
const { openDatabase } = require('./db');
const { createApp } = require('./app');
const { createMailer } = require('./mailer');
const { createRealtime } = require('./realtime');
const { loadConfig } = require('./config');
const { importLegacyFiles } = require('./uploads');

const config = loadConfig();
const db = openDatabase(config.dbFile);
const imported = importLegacyFiles(db, config.uploadDir);
if (imported) console.log(`旧バージョンの画像 ${imported} 件をデータベースに取り込みました`);
const mailer = createMailer(process.env);
const rt = createRealtime(db);
const app = createApp({ db, mailer, rt, config });
const server = http.createServer(app);
rt.attach(server);

server.listen(config.port, () => {
  console.log(`学祭グループチャット: ${config.baseUrl} (port ${config.port})`);
  if (!mailer.configured) {
    if (config.production) {
      console.warn('[警告] SMTP が未設定です。本番環境では認証メールが届かず、新規登録したユーザーがログインできません。');
    } else {
      console.log('SMTP 未設定のため、認証メールはコンソールに出力されます');
    }
  }
});

// ホスティングサービスの再起動・デプロイ時に安全に終了する
function shutdown(signal) {
  console.log(`${signal} を受信したため終了します`);
  rt.close();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
