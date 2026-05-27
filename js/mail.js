// Aster Stella - メール・掲示板・取引提案
//
// 競合対策は orders と同じく append-only（1件ごとに固有キーで書く）。
//   - メール: nations/{toId}/mail/{key}  … 本文は即時配信（直接書込）
//   - 掲示板: aster_stella/board/{key}
//   - 取引提案: aster_stella/tradeProposals/{key} … 受信側が承認(acceptTrade予約)で成立
//
// 国庫・資源の実際の移動は GAS が予約(sendTransfer / acceptTrade)で原子的に処理する。
// （プレイヤーが直接 stats/stockpile を書くと GAS のターン処理と競合するため）

import { db, ref, set, get, push, remove, onValue } from "./firebase-config.js";

function newKey(prefix) {
  return prefix + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6);
}

// ---- メール ----
export async function sendMail(toId, mail) {
  const key = newKey("ml");
  await set(ref(db, `aster_stella/nations/${toId}/mail/${key}`), { ...mail, at: Date.now() });
  return key;
}

export function subscribeMail(nationId, callback) {
  return onValue(ref(db, `aster_stella/nations/${nationId}/mail`), (snap) => {
    callback(toArray(snap.exists() ? snap.val() : null));
  });
}

export async function markMailRead(nationId, key) {
  await set(ref(db, `aster_stella/nations/${nationId}/mail/${key}/read`), true);
}

export async function deleteMail(nationId, key) {
  await remove(ref(db, `aster_stella/nations/${nationId}/mail/${key}`));
}

// ---- 掲示板 ----
export async function postBoard(post) {
  const key = newKey("bd");
  await set(ref(db, `aster_stella/board/${key}`), { ...post, at: Date.now() });
  return key;
}

export function subscribeBoard(callback) {
  return onValue(ref(db, "aster_stella/board"), (snap) => {
    callback(toArray(snap.exists() ? snap.val() : null));
  });
}

export async function deleteBoardPost(key) {
  await remove(ref(db, `aster_stella/board/${key}`));
}

// ---- 取引提案 ----
// proposal: { from, fromName, to, give:{money,resources{}}, want:{money,resources{}} }
export async function createTradeProposal(proposal) {
  const key = newKey("tp");
  await set(ref(db, `aster_stella/tradeProposals/${key}`), { ...proposal, at: Date.now(), status: "open" });
  return key;
}

export function subscribeTradeProposals(callback) {
  return onValue(ref(db, "aster_stella/tradeProposals"), (snap) => {
    callback(toArray(snap.exists() ? snap.val() : null));
  });
}

export async function cancelTradeProposal(key) {
  await remove(ref(db, `aster_stella/tradeProposals/${key}`));
}

function toArray(obj) {
  if (!obj || typeof obj !== "object") return [];
  const arr = Object.keys(obj).map((k) => ({ ...obj[k], key: k }));
  arr.sort((a, b) => (b.at || 0) - (a.at || 0)); // 新しい順
  return arr;
}
