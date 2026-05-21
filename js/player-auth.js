// Aster Stella - playerサイドの認証
//
// 役割:
//   - player-login.html: nationId + password を Firebase の nations と突合
//   - player.html      : セッションが無ければログイン画面へ送る
//
// セッションは sessionStorage に { nationId, loginAt } を保存し、
// リロード時に自動ログインを継続する。
// パスワードは平文比較（共同プレイ用途。強い秘匿性は要求しない）。

import { db, ref, get } from "./firebase-config.js";

const SESSION_KEY = "aster_stella_player_session";
const DB_PATH_NATIONS = "aster_stella/nations";

export function getSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (s && typeof s.nationId === "string" && s.nationId) return s;
    return null;
  } catch (_) {
    return null;
  }
}

export function setSession(nationId) {
  const s = { nationId, loginAt: Date.now() };
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
  return s;
}

export function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
}

// 全国家を取得（ログイン画面の国家リスト用）。
// 戻り値: { [nationId]: { id, name, color, hasPassword } }
export async function fetchNationsForLogin() {
  const snap = await get(ref(db, DB_PATH_NATIONS));
  const raw = snap.exists() ? (snap.val() || {}) : {};
  const out = {};
  for (const id of Object.keys(raw)) {
    const n = raw[id] || {};
    out[id] = {
      id,
      name: n.name || id,
      color: n.color || "#888888",
      hasPassword: typeof n.password === "string" && n.password.length > 0
    };
  }
  return out;
}

// nationId + password を突合。成功すれば true。
export async function authenticate(nationId, password) {
  if (!nationId) return false;
  const snap = await get(ref(db, `${DB_PATH_NATIONS}/${nationId}/password`));
  if (!snap.exists()) return false;
  const stored = snap.val();
  if (typeof stored !== "string" || stored.length === 0) return false;
  return stored === password;
}

// player.html 用: セッションが無ければログイン画面へリダイレクトする。
// セッションが有れば nationId を返す。
export function requirePlayerSession() {
  const s = getSession();
  if (!s) {
    window.location.replace("player-login.html");
    return null;
  }
  return s.nationId;
}
