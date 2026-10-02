'use strict';

const { HttpError } = require('./util');

/**
 * メモリ上の簡易レート制限(固定ウィンドウ)。
 * インターネットに公開したときのパスワード総当たりや登録スパムを防ぐ。
 */
function rateLimit({ windowMs, max, key, message = '試行回数が多すぎます。しばらく待ってから再度お試しください' }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const t = Date.now();
    for (const [k, v] of hits) if (v.reset <= t) hits.delete(k);
  }, windowMs);
  timer.unref();

  return (req, res, next) => {
    const keys = [].concat(key(req)).filter(Boolean);
    const t = Date.now();
    for (const k of keys) {
      let entry = hits.get(k);
      if (!entry || entry.reset <= t) {
        entry = { count: 0, reset: t + windowMs };
        hits.set(k, entry);
      }
      entry.count += 1;
      if (entry.count > max) {
        res.setHeader('Retry-After', Math.ceil((entry.reset - t) / 1000));
        return next(new HttpError(429, message, 'RATE_LIMITED'));
      }
    }
    next();
  };
}

module.exports = { rateLimit };
