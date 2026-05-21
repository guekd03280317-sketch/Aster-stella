// Aster Stella - 予約操作(orders)キュー
//
// プレイヤーの操作は集計済みステータスを直接書き換えず、
// aster_stella/nations/{id}/orders/{orderId} に「予約」として積む。
// GASが一定時刻に全国家分を読み込んで一斉処理(ターン進行)する。
//
// 競合対策（重要）:
//   予約は配列まるごとではなく「1件ごとに固有キーの子ノード」として読み書きする。
//   - 追加: orders/{orderId} にその1件だけ set → 他の予約・他国に触れないので衝突しない
//   - 取消: orders/{orderId} だけ remove
//   - GAS : 読んだキーだけ処理後に remove。処理中に増えた予約は別キーなので生き残る
//   これにより「同一ノードへの read-modify-write 上書き」を構造的に避ける。

import { db, ref, set, get, remove, onValue } from "./firebase-config.js";
import { makeOrder } from "./player-schema.js";

function ordersRoot(nationId) {
  return `aster_stella/nations/${nationId}/orders`;
}

// 予約を1件追加する。kind と payload から order を生成し、固有キーに書く。
// 戻り値は生成された order。
export async function addOrder(nationId, kind, payload) {
  const order = makeOrder(kind, payload);
  await set(ref(db, `${ordersRoot(nationId)}/${order.id}`), order);
  return order;
}

// 既に生成済みの order オブジェクトをそのまま登録する（id を持つこと）。
export async function putOrder(nationId, order) {
  if (!order || !order.id) throw new Error("order に id がありません");
  await set(ref(db, `${ordersRoot(nationId)}/${order.id}`), order);
  return order;
}

// 予約を取り消す（そのキーだけ削除）。
export async function cancelOrder(nationId, orderId) {
  await remove(ref(db, `${ordersRoot(nationId)}/${orderId}`));
}

// 予約を一度に全件取得する。戻り値は order の配列（at 昇順）。
export async function listOrders(nationId) {
  const snap = await get(ref(db, ordersRoot(nationId)));
  return toOrderArray(snap.exists() ? snap.val() : null);
}

// 予約の変化を購読する。callback には order 配列（at 昇順）が渡る。
// 戻り値は購読解除関数。
export function subscribeOrders(nationId, callback) {
  return onValue(ref(db, ordersRoot(nationId)), (snap) => {
    callback(toOrderArray(snap.exists() ? snap.val() : null));
  });
}

function toOrderArray(obj) {
  if (!obj || typeof obj !== "object") return [];
  const arr = Object.keys(obj).map((k) => {
    const o = obj[k] || {};
    return { ...o, id: o.id || k };
  });
  arr.sort((a, b) => (a.at || 0) - (b.at || 0));
  return arr;
}
