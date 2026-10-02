'use strict';

const path = require('node:path');

/** ホスティングサービスが自動で設定する環境変数から公開 URL を推定する */
function detectPublicUrl(env) {
  if (env.RENDER_EXTERNAL_URL) return env.RENDER_EXTERNAL_URL;
  if (env.RAILWAY_PUBLIC_DOMAIN) return `https://${env.RAILWAY_PUBLIC_DOMAIN}`;
  if (env.FLY_APP_NAME) return `https://${env.FLY_APP_NAME}.fly.dev`;
  return null;
}

/** リバースプロキシ(HTTPS 終端)の内側で動いているか */
function behindProxy(env) {
  if (env.TRUST_PROXY !== undefined) return env.TRUST_PROXY === 'true';
  return !!(env.RENDER || env.RAILWAY_ENVIRONMENT || env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_PUBLIC_DOMAIN || env.FLY_APP_NAME);
}

function loadConfig(env = process.env) {
  const port = Number(env.PORT || 3000);
  const dataDir = env.DATA_DIR || path.join(__dirname, '..', 'data');
  const baseUrl = (env.BASE_URL || detectPublicUrl(env) || `http://localhost:${port}`).replace(/\/+$/, '');
  const production = env.NODE_ENV === 'production';

  return {
    port,
    production,
    baseUrl,
    dbFile: env.DB_FILE || path.join(dataDir, 'groupchat.db'),
    // 旧バージョンの画像保存先(起動時に DB へ取り込む)
    uploadDir: env.UPLOAD_DIR || path.join(dataDir, 'uploads'),
    // HTTPS で公開している場合は Cookie に Secure を付ける
    secureCookies: env.COOKIE_SECURE !== undefined ? env.COOKIE_SECURE === 'true' : baseUrl.startsWith('https://'),
    trustProxy: behindProxy(env) ? 1 : false,
    // 本番(NODE_ENV=production)では認証リンクを API 応答に含めない
    exposeDevVerifyLink: !production,
  };
}

module.exports = { loadConfig };
