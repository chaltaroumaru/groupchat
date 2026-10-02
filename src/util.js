'use strict';

const crypto = require('node:crypto');

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const now = () => Date.now();

const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

/** 紛らわしい文字(0/O, 1/I/L)を除いた招待コード */
function inviteCode(length = 8) {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(length);
  let code = '';
  for (const b of bytes) code += chars[b % chars.length];
  return code;
}

/** 文字列入力を検証してトリムする */
function str(value, name, { min = 0, max = 2000, required = true } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new HttpError(400, `${name}を入力してください`);
    return undefined;
  }
  if (typeof value !== 'string') throw new HttpError(400, `${name}が不正です`);
  const v = value.trim();
  if (v.length < min) throw new HttpError(400, min <= 1 ? `${name}を入力してください` : `${name}は${min}文字以上にしてください`);
  if (v.length > max) throw new HttpError(400, `${name}は${max}文字以内にしてください`);
  return v;
}

function intParam(value, name = 'ID') {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new HttpError(400, `${name}が不正です`);
  return n;
}

/** multipart で送られた "true"/"1" も真偽値として扱う */
function bool(value) {
  return value === true || value === 1 || value === 'true' || value === '1' || value === 'on';
}

module.exports = { HttpError, now, randomToken, inviteCode, str, intParam, bool };
