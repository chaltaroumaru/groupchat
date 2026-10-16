'use strict';

const express = require('express');
const { transaction } = require('../db');
const { HttpError, now, str } = require('../util');
const { listOrders, getOrder, parseCups, parseMenu, posSettings, setSoldOut, hashPin } = require('../orders');
const { broadcastOrder, broadcastPosSettings } = require('./orders');

/**
 * 屋台 POS 端末向けの API。POS は別のサイト(GitHub Pages など)や端末内の HTML から動くため、
 * Cookie ではなく接続コード(Authorization: Bearer <コード>)で認証し、どのサイトからの呼び出しも許可する。
 */
module.exports = function posRoutes({ db, rt, push }) {
  const router = express.Router();

  router.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
    res.setHeader('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') return res.status(204).end();
    const token = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
    const link = token && db.prepare('SELECT group_id FROM pos_links WHERE token = ?').get(token);
    if (!link) throw new HttpError(401, '接続コードが正しくありません。グループチャットの「グループ設定 → POS連携」で確認してください');
    req.groupId = link.group_id;
    next();
  });

  router.get('/state', (req, res) => {
    const group = db.prepare('SELECT name FROM groups WHERE id = ?').get(req.groupId);
    res.json({ groupName: group.name, ...posSettings(db, req.groupId), orders: listOrders(db, req.groupId) });
  });

  router.put('/menu', (req, res) => {
    const menu = parseMenu(req.body);
    db.prepare('UPDATE pos_links SET menu = ? WHERE group_id = ?').run(JSON.stringify(menu), req.groupId);
    rt.toPos(req.groupId, 'pos:menu', menu);
    broadcastPosSettings(db, rt, req.groupId);
    res.json({ menu });
  });

  /** 売り切れの切り替え(暗証番号なしで操作できる) */
  router.put('/sold-out', (req, res) => {
    const soldOut = setSoldOut(db, req.groupId, req.body);
    broadcastPosSettings(db, rt, req.groupId);
    res.json({ soldOut });
  });

  /** 暗証番号の確認(端末側で照合できないブラウザ向け) */
  router.post('/pin/check', (req, res) => {
    const { pin } = posSettings(db, req.groupId);
    res.json({ ok: !pin || (typeof req.body?.pin === 'string' && hashPin(pin.salt, req.body.pin) === pin.hash) });
  });

  /** 会計完了。clientId が同じ再送は重複させずに既存のオーダーを返す(電波が悪いときの再送対策) */
  router.post('/orders', (req, res) => {
    const clientId = str(req.body?.clientId, '会計ID', { min: 1, max: 64 });
    const cups = parseCups(req.body?.cups);
    const existing = db.prepare('SELECT id FROM orders WHERE group_id = ? AND client_id = ?').get(req.groupId, clientId);
    if (existing) return res.json({ order: getOrder(db, existing.id) });
    // 端末の時計で会計した時刻(オフライン中に会計して後から送った場合も正しい時刻にする)
    const t =
      Number.isSafeInteger(req.body?.createdAt) && Math.abs(req.body.createdAt - now()) < 7 * 24 * 3600 * 1000 ? req.body.createdAt : now();
    const id = transaction(db, () => {
      const { n } = db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM orders WHERE group_id = ?').get(req.groupId);
      const total = cups.reduce((sum, c) => sum + c.price, 0);
      const { lastInsertRowid } = db
        .prepare(
          `INSERT INTO orders (group_id, number, client_id, cups, total, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'new', ?, ?)`,
        )
        .run(req.groupId, n, clientId, JSON.stringify(cups), total, t, now());
      return Number(lastInsertRowid);
    });
    const order = getOrder(db, id);
    broadcastOrder(rt, req.groupId, 'order:new', order);
    push.notifyOrder(req.groupId, order);
    res.status(201).json({ order });
  });

  /** 会計履歴をすべて消去する(オーダー番号も 1 から振り直す) */
  router.delete('/orders', (req, res) => {
    db.prepare('DELETE FROM orders WHERE group_id = ?').run(req.groupId);
    broadcastOrder(rt, req.groupId, 'orders:cleared', { groupId: req.groupId });
    res.json({ ok: true });
  });

  return router;
};
