'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');

test('ローカルでは http://localhost を使い、Secure Cookie は付けない', () => {
  const c = loadConfig({ PORT: '4000' });
  assert.equal(c.baseUrl, 'http://localhost:4000');
  assert.equal(c.secureCookies, false);
  assert.equal(c.trustProxy, false);
  assert.equal(c.exposeDevVerifyLink, true);
});

test('ホスティングサービスの環境変数から公開 URL を推定する', () => {
  assert.equal(loadConfig({ RENDER: 'true', RENDER_EXTERNAL_URL: 'https://chat.onrender.com' }).baseUrl, 'https://chat.onrender.com');
  const railway = loadConfig({ RAILWAY_ENVIRONMENT: 'production', RAILWAY_PUBLIC_DOMAIN: 'chat.up.railway.app' });
  assert.equal(railway.baseUrl, 'https://chat.up.railway.app');
  assert.equal(railway.secureCookies, true);
  assert.equal(railway.trustProxy, 1);
  assert.equal(loadConfig({ FLY_APP_NAME: 'gakusai' }).baseUrl, 'https://gakusai.fly.dev');
});

test('BASE_URL・COOKIE_SECURE・TRUST_PROXY の明示指定が優先される', () => {
  const c = loadConfig({
    BASE_URL: 'https://example.com/',
    RAILWAY_PUBLIC_DOMAIN: 'x.up.railway.app',
    RAILWAY_ENVIRONMENT: 'production',
    COOKIE_SECURE: 'false',
    TRUST_PROXY: 'false',
    NODE_ENV: 'production',
  });
  assert.equal(c.baseUrl, 'https://example.com');
  assert.equal(c.secureCookies, false);
  assert.equal(c.trustProxy, false);
  assert.equal(c.exposeDevVerifyLink, false);
});

test('Brevo の HTTP API で確認メールを送れる', async () => {
  const { createMailer, parseAddress } = require('../src/mailer');
  assert.deepEqual(parseAddress('学祭チャット <noreply@example.com>'), { name: '学祭チャット', email: 'noreply@example.com' });
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true };
  };
  const mailer = createMailer({ BREVO_API_KEY: 'key', MAIL_FROM: 'me@example.com', SMTP_HOST: 'ignored' }, fakeFetch);
  assert.equal(mailer.configured, true);
  await mailer.send({ to: 'a@example.com', subject: '件名', text: '本文' });
  assert.equal(calls[0].url, 'https://api.brevo.com/v3/smtp/email');
  assert.equal(calls[0].opts.headers['api-key'], 'key');
  assert.deepEqual(JSON.parse(calls[0].opts.body), {
    sender: { email: 'me@example.com', name: '学祭グループチャット' },
    to: [{ email: 'a@example.com' }],
    subject: '件名',
    textContent: '本文',
  });
  assert.throws(() => createMailer({ BREVO_API_KEY: 'key' }), /MAIL_FROM/);
});
