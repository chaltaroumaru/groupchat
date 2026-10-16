'use strict';

const { HttpError, str } = require('./util');

/** オーダーの状態: new = 未着手 / making = 作成中 / done = 提供済み */
const ORDER_STATUSES = ['new', 'making', 'done'];

function serializeOrder(row) {
  return {
    id: row.id,
    groupId: row.group_id,
    number: row.number,
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
    return { syrups: syrups.map((s) => label(s, 'シロップ名')), drink: label(c.drink, '飲料名'), ice: c.ice === true, price };
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

/** 1 杯の表示名(例: 「ブルーキュラソー × 炭酸」) */
const cupName = (cup) => (cup.syrups.length ? `${cup.syrups.join('・')} × ${cup.drink}` : cup.drink);

module.exports = { ORDER_STATUSES, serializeOrder, listOrders, getOrder, parseCups, parseMenu, cupName };
