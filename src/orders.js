'use strict';

const crypto = require('node:crypto');
const { HttpError, str } = require('./util');

/** お呼び出し番号は 1〜15 を繰り返す(注文番号 16 → 呼び出し 1) */
const CALL_CYCLE = 15;
const callNumber = (number) => ((number - 1) % CALL_CYCLE) + 1;
const MENU_KINDS = ['syrups', 'drinks'];

/** オーダーの状態: new = 未着手 / making = 作成中 / done = 提供済み */
const ORDER_STATUSES = ['new', 'making', 'done'];

function serializeOrder(row) {
  return {
    id: row.id,
    groupId: row.group_id,
    number: row.number,
    callNumber: callNumber(row.number),
    clientId: row.client_id,
    cups: JSON.parse(row.cups),
    total: row.total,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function listOrders(db, groupId, limit = 500) {
  return db.prepare('SELECT * FROM orders WHERE group_id = ? ORDER BY id DESC LIMIT ?').all(groupId, limit).map(serializeOrder);
}

function getOrder(db, id) {
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  return row ? serializeOrder(row) : null;
}

const label = (v, name) => str(v, name, { min: 1, max: 40 });

/** POS から送られた 1 杯ずつの内容を検証する: { syrups: string[], drink: string, ice: boolean, price: number } */
function parseCups(value) {
  if (!Array.isArray(value) || value.length === 0) throw new HttpError(400, '注文内容がありません');
  if (value.length > 50) throw new HttpError(400, '1回の会計は50杯までです');
  return value.map((c) => {
    if (!c || typeof c !== 'object') throw new HttpError(400, '注文内容が不正です');
    const syrups = c.syrups ?? [];
    if (!Array.isArray(syrups) || syrups.length > 5) throw new HttpError(400, 'シロップの指定が不正です');
    const price = c.price;
    if (!Number.isSafeInteger(price) || price < 0 || price > 100000) throw new HttpError(400, '金額が不正です');
    return { syrups: syrups.map((s) => label(s, 'シロップ名')), drink: label(c.drink, '飲料名'), ice: c.ice === true, ...(c.presale === true ? { presale: true } : {}), price };
  });
}

/** POS のメニュー: { syrups: string[], drinks: string[] } */
function parseMenu(value) {
  const list = (v, name, min) => {
    if (!Array.isArray(v) || v.length < min || v.length > 50) throw new HttpError(400, `${name}の指定が不正です`);
    return v.map((s) => str(s, name, { min: 1, max: 20 }));
  };
  return { syrups: list(value?.syrups, 'シロップ', 0), drinks: list(value?.drinks, '割る飲料・単品', 1) };
}

const hashPin = (salt, pin) => crypto.createHash('sha256').update(`${salt}${pin}`).digest('hex');

/** 暗証番号は 4〜6 桁の数字 */
function parsePin(value) {
  if (typeof value !== 'string' || !/^\d{4,6}$/.test(value)) throw new HttpError(400, '暗証番号は4〜6桁の数字にしてください');
  return value;
}

/**
 * POS 端末で共有する設定: メニュー・売り切れ・暗証番号。
 * 暗証番号はハッシュだけを渡し、POS 端末はオフラインでも照合できる(お客さんに操作させないための鍵で、厳密な認証ではない)
 */
function posSettings(db, groupId) {
  const row = db.prepare('SELECT menu, sold_out, pin_salt, pin_hash FROM pos_links WHERE group_id = ?').get(groupId);
  if (!row) return null;
  const menu = row.menu ? JSON.parse(row.menu) : null;
  const soldOut = row.sold_out ? JSON.parse(row.sold_out) : { syrups: [], drinks: [] };
  // メニューから消えた項目は売り切れからも外す
  if (menu) for (const k of MENU_KINDS) soldOut[k] = soldOut[k].filter((n) => menu[k].includes(n));
  return { menu, soldOut, pin: row.pin_hash ? { salt: row.pin_salt, hash: row.pin_hash } : null };
}

/** 売り切れを切り替える。{ kind: 'syrups' | 'drinks', name, soldOut: boolean } */
function setSoldOut(db, groupId, body) {
  const settings = posSettings(db, groupId);
  if (!settings?.menu) throw new HttpError(400, 'POS のメニューがまだ登録されていません');
  if (!MENU_KINDS.includes(body?.kind)) throw new HttpError(400, '種類の指定が不正です');
  const name = str(body.name, '項目名', { min: 1, max: 20 });
  if (!settings.menu[body.kind].includes(name)) throw new HttpError(400, 'メニューにない項目です');
  const list = settings.soldOut[body.kind].filter((n) => n !== name);
  if (body.soldOut === true) list.push(name);
  settings.soldOut[body.kind] = list;
  db.prepare('UPDATE pos_links SET sold_out = ? WHERE group_id = ?').run(JSON.stringify(settings.soldOut), groupId);
  return settings.soldOut;
}

/** 1 杯の表示名(例: 「ブルーキュラソー × 炭酸」) */
const cupName = (cup) => (cup.syrups.length ? `${cup.syrups.join('・')} × ${cup.drink}` : cup.drink);

module.exports = {
  CALL_CYCLE,
  callNumber,
  hashPin,
  parsePin,
  posSettings,
  setSoldOut,
  ORDER_STATUSES,
  serializeOrder,
  listOrders,
  getOrder,
  parseCups,
  parseMenu,
  cupName,
};
