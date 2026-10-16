'use strict';

const express = require('express');
const { HttpError, now, randomToken, intParam, bool } = require('../util');
const perm = require('../permissions');
const { ORDER_STATUSES, listOrders, getOrder, posSettings, setSoldOut, parsePin, hashPin } = require('../orders');

/** オーダーの変更をグループのメンバーと POS 端末の両方に配信する */
function broadcastOrder(rt, groupId, event, payload) {
  rt.toGroup(groupId, event, payload);
  rt.toPos(groupId, event, payload);
}

/** メニュー・売り切れ・暗証番号の変更を配信する(メンバーには暗証番号を送らない) */
function broadcastPosSettings(db, rt, groupId) {
  const s = posSettings(db, groupId);
  if (!s) return;
  rt.toPos(groupId, 'pos:settings', s);
  rt.toGroup(groupId, 'pos:settings', { groupId, menu: s.menu, soldOut: s.soldOut });
}

/** オーダー画面(メンバー向け)と POS 連携の設定(管理者向け) */
function orderRoutes({ db, rt, config }) {
  const router = express.Router();

  router.get('/groups/:gid/orders', (req, res) => {
    const gid = intParam(req.params.gid);
    const me = perm.requireMember(db, gid, req.user.id);
    res.json({
      orders: listOrders(db, gid),
      // 閲覧のみのロールの人は状態を変更できない
      canUpdate: me.baseChannelPermission === 'write',
      muted: !!db.prepare('SELECT 1 FROM order_mutes WHERE user_id = ? AND group_id = ?').get(req.user.id, gid),
      posEnabled: !!db.prepare('SELECT 1 FROM pos_links WHERE group_id = ?').get(gid),
      menu: posSettings(db, gid)?.menu ?? null,
      soldOut: posSettings(db, gid)?.soldOut ?? null,
    });
  });

  /** 売り切れの切り替え(閲覧のみの人以外ならだれでも。暗証番号は不要) */
  router.put('/groups/:gid/pos/sold-out', (req, res) => {
    const gid = intParam(req.params.gid);
    const me = perm.requireMember(db, gid, req.user.id);
    if (me.baseChannelPermission !== 'write') throw new HttpError(403, '閲覧のみの権限では売り切れを変更できません');
    if (!db.prepare('SELECT 1 FROM pos_links WHERE group_id = ?').get(gid)) throw new HttpError(400, 'POS と連携していません');
    const soldOut = setSoldOut(db, gid, req.body);
    broadcastPosSettings(db, rt, gid);
    res.json({ soldOut });
  });

  router.patch('/orders/:oid', (req, res) => {
    const order = getOrder(db, intParam(req.params.oid));
    const me = order && perm.getMembership(db, order.groupId, req.user.id);
    if (!me) throw new HttpError(404, 'オーダーが見つかりません');
    if (me.baseChannelPermission !== 'write') throw new HttpError(403, '閲覧のみの権限ではオーダーを変更できません');
    if (!ORDER_STATUSES.includes(req.body?.status)) throw new HttpError(400, '状態の指定が不正です');
    db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?').run(req.body.status, now(), order.id);
    const updated = getOrder(db, order.id);
    broadcastOrder(rt, order.groupId, 'order:updated', updated);
    res.json({ order: updated });
  });

  /** オーダーの通知をオン・オフする(自分だけの設定) */
  router.put('/groups/:gid/orders/mute', (req, res) => {
    const gid = intParam(req.params.gid);
    perm.requireMember(db, gid, req.user.id);
    const muted = bool(req.body?.muted);
    if (muted) db.prepare('INSERT OR IGNORE INTO order_mutes (user_id, group_id) VALUES (?, ?)').run(req.user.id, gid);
    else db.prepare('DELETE FROM order_mutes WHERE user_id = ? AND group_id = ?').run(req.user.id, gid);
    res.json({ muted });
  });

  // ---- POS 連携(管理者のみ) ----

  const posInfo = (gid) => {
    const link = db.prepare('SELECT token, pin_hash FROM pos_links WHERE group_id = ?').get(gid);
    return { enabled: !!link, serverUrl: config.baseUrl, code: link?.token ?? null, pinSet: !!link?.pin_hash };
  };

  router.get('/groups/:gid/pos', (req, res) => {
    const gid = intParam(req.params.gid);
    perm.requireAdmin(db, gid, req.user.id);
    res.json(posInfo(gid));
  });

  /** 接続コードを発行する(発行し直すと古いコードの POS 端末は使えなくなる) */
  router.post('/groups/:gid/pos', (req, res) => {
    const gid = intParam(req.params.gid);
    perm.requireAdmin(db, gid, req.user.id);
    db.prepare(
      `INSERT INTO pos_links (group_id, token, created_at) VALUES (?, ?, ?)
       ON CONFLICT (group_id) DO UPDATE SET token = excluded.token`,
    ).run(gid, randomToken(24), now());
    rt.disconnectPos(gid);
    res.json(posInfo(gid));
  });

  /** POS のスタッフ用暗証番号(全端末共通)を設定する。pin = null で解除 */
  router.put('/groups/:gid/pos/pin', (req, res) => {
    const gid = intParam(req.params.gid);
    perm.requireAdmin(db, gid, req.user.id);
    if (!db.prepare('SELECT 1 FROM pos_links WHERE group_id = ?').get(gid)) throw new HttpError(400, 'POS と連携していません');
    if (req.body?.pin === null) {
      db.prepare('UPDATE pos_links SET pin_salt = NULL, pin_hash = NULL WHERE group_id = ?').run(gid);
    } else {
      const pin = parsePin(req.body?.pin);
      const salt = randomToken(12);
      db.prepare('UPDATE pos_links SET pin_salt = ?, pin_hash = ? WHERE group_id = ?').run(salt, hashPin(salt, pin), gid);
    }
    broadcastPosSettings(db, rt, gid);
    res.json(posInfo(gid));
  });

  router.delete('/groups/:gid/pos', (req, res) => {
    const gid = intParam(req.params.gid);
    perm.requireAdmin(db, gid, req.user.id);
    db.prepare('DELETE FROM pos_links WHERE group_id = ?').run(gid);
    rt.disconnectPos(gid);
    res.json(posInfo(gid));
  });

  return router;
}

module.exports = { orderRoutes, broadcastOrder, broadcastPosSettings };
