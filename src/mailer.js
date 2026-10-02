'use strict';

const nodemailer = require('nodemailer');

/** "名前 <addr@example.com>" または "addr@example.com" を分解する */
function parseAddress(value) {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(value || '');
  if (m) return { name: m[1].replace(/^"|"$/g, '') || undefined, email: m[2] };
  return { email: (value || '').trim() };
}

/**
 * 確認メールの送信方法を環境変数から選ぶ。
 *   BREVO_API_KEY … Brevo の HTTP API(SMTP ポートが使えない無料ホスティング向け)
 *   SMTP_HOST     … SMTP(Gmail など)
 *   どちらも無い   … コンソールに出力(ローカル開発用)
 */
function createMailer(env = process.env, fetchImpl = globalThis.fetch) {
  if (env.BREVO_API_KEY) {
    const sender = parseAddress(env.MAIL_FROM);
    if (!sender.email) throw new Error('BREVO_API_KEY を使う場合は MAIL_FROM(送信元アドレス)も設定してください');
    sender.name ??= '学祭グループチャット';
    return {
      configured: true,
      async send({ to, subject, text }) {
        const res = await fetchImpl('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: { 'api-key': env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ sender, to: [{ email: to }], subject, textContent: text }),
        });
        if (!res.ok) throw new Error(`Brevo へのメール送信に失敗しました (${res.status}): ${await res.text()}`);
      },
    };
  }

  if (env.SMTP_HOST) {
    const transport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: Number(env.SMTP_PORT || 587),
      secure: env.SMTP_SECURE === 'true',
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    });
    const from = env.MAIL_FROM || env.SMTP_USER;
    return {
      configured: true,
      async send({ to, subject, text }) {
        await transport.sendMail({ from, to, subject, text });
      },
    };
  }

  return {
    configured: false,
    async send({ to, subject, text }) {
      console.log(`\n[mail] To: ${to}\n[mail] Subject: ${subject}\n${text}\n`);
    },
  };
}

module.exports = { createMailer, parseAddress };
