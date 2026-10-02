'use strict';

const nodemailer = require('nodemailer');

/**
 * SMTP_HOST が設定されていれば SMTP でメールを送信する。
 * 未設定の場合(ローカル開発)は送信内容をコンソールに出力する。
 */
function createMailer(env = process.env) {
  if (!env.SMTP_HOST) {
    return {
      configured: false,
      async send({ to, subject, text }) {
        console.log(`\n[mail] To: ${to}\n[mail] Subject: ${subject}\n${text}\n`);
      },
    };
  }

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

module.exports = { createMailer };
