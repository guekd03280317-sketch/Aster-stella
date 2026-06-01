// Aster Stella - 予約操作(orders)：GASウェブアプリ経由でスプレッドシートに保存
//
// 旧方式（Firebase の nations/{id}/orders に直接書く）は、同時書き込みでデータが
// 消える問題があったため廃止。予約は GASウェブアプリ(doPost) を通じて「予約」シートに
// 1行ずつ追記し、GAS の runTurn がそれを読んで処理する。
//
//   addOrder        … doPost(submitOrder) でシートへ追記
//   cancelOrder     … doPost(cancelOrder)
//   listOrders      … doPost(listOrders) で自国の未処理予約を取得
//   subscribeOrders … Firebase購読の代わりにポーリング（送信/取消の直後は即時更新）
//
// 認可は nationId + password（セッション保持）を GAS が nations/{id}/password と照合する。
// GASウェブアプリURLは運営が ops.html で aster_stella/config/gasWebAppUrl に保存し、
// player.js が起動時に読み込んで setOrdersEndpoint() で渡す。

import { makeOrder } from "./player-schema.js";
import { getSessionCredentials } from "./player-auth.js";

const POLL_MS = 20000; // 予約一覧のポーリング間隔（控えめ）

let gasWebAppUrl = "";
const subscribers = new Set(); // 各購読の即時ポーリング関数（送信直後の更新用）

// player.js が起動時（config読み込み後）に呼ぶ。
export function setOrdersEndpoint(url) {
  gasWebAppUrl = (url || "").trim();
}
export function ordersEndpointReady() {
  return !!gasWebAppUrl;
}

// GASウェブアプリへ POST（CORSプリフライト回避のため text/plain）。
async function gasOrderPost(action, extra) {
  if (!gasWebAppUrl) throw new Error("予約APIのURLが未設定です（運営がops.htmlで設定してください）");
  const creds = getSessionCredentials() || {};
  const res = await fetch(gasWebAppUrl, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(Object.assign({ action, nationId: creds.nationId, password: creds.password }, extra || {}))
  });
  return res.json();
}

// 予約を1件追加する。kind と payload から order を生成してシートへ送る。
export async function addOrder(nationId, kind, payload) {
  const order = makeOrder(kind, payload);
  const r = await gasOrderPost("submitOrder", { order });
  if (!r || !r.ok) throw new Error((r && r.error) || "予約の送信に失敗しました");
  order.id = r.id || order.id;
  refreshSubscribers();
  return order;
}

// 既に生成済みの order をそのまま登録する（id を持つこと）。
export async function putOrder(nationId, order) {
  if (!order || !order.id) throw new Error("order に id がありません");
  const r = await gasOrderPost("submitOrder", { order });
  if (!r || !r.ok) throw new Error((r && r.error) || "予約の送信に失敗しました");
  refreshSubscribers();
  return order;
}

// 予約を取り消す。
export async function cancelOrder(nationId, orderId) {
  const r = await gasOrderPost("cancelOrder", { orderId });
  if (!r || !r.ok) throw new Error((r && r.error) || "予約の取消に失敗しました");
  refreshSubscribers();
}

// 自国の未処理予約を一度に取得する。戻り値は order 配列（at 昇順）。
export async function listOrders(nationId) {
  const r = await gasOrderPost("listOrders", {});
  const arr = (r && r.orders) ? r.orders.slice() : [];
  arr.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return arr;
}

// 予約の変化を購読する（ポーリング）。callback には order 配列が渡る。
// 戻り値は購読解除関数（タイマー停止）。
export function subscribeOrders(nationId, callback) {
  const entry = { stopped: false, timer: null, poll: null };

  async function poll() {
    if (entry.stopped) return;
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; } // 重複タイマー防止
    try {
      const list = await listOrders(nationId);
      if (!entry.stopped) callback(list);
    } catch (_) {
      if (!entry.stopped) callback([]); // URL未設定や通信失敗時は空表示
    }
    if (!entry.stopped) entry.timer = setTimeout(poll, POLL_MS);
  }

  entry.poll = poll;
  subscribers.add(entry);
  poll(); // 即時に1回

  return function unsubscribe() {
    entry.stopped = true;
    if (entry.timer) clearTimeout(entry.timer);
    subscribers.delete(entry);
  };
}

// 送信/取消の直後に、全購読を即時ポーリングして一覧を更新する。
function refreshSubscribers() {
  for (const entry of subscribers) {
    try { entry.poll(); } catch (_) { /* noop */ }
  }
}
