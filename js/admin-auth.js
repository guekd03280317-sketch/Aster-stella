// Aster Stella - 運営ページ向けの簡易パスワードゲート
//
// 役割:
//   index.html / admin.html / nations.html を開いたとき、
//   セッション内で初回のみパスワードを要求する。
//   合言葉が一致したら sessionStorage にフラグを置いて以降は通す。
//
// セキュリティはハウスルール程度。クライアント側でしか確認していないため、
// 本格的なアクセス制御ではない。あくまで「うっかり外部に見られない」用途。

const ADMIN_PASSWORD = "36524";
const SESSION_KEY = "aster_stella_admin_auth";

// アンロックされるまで他スクリプトの実行を遅らせるためのPromise
export function requireAdminAuth() {
  if (sessionStorage.getItem(SESSION_KEY) === "ok") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    buildOverlay(resolve);
  });
}

function buildOverlay(onSuccess) {
  // 既存のページ表示を覆い隠す
  const overlay = document.createElement("div");
  overlay.className = "admin-auth-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");

  const box = document.createElement("div");
  box.className = "admin-auth-box";

  const title = document.createElement("h2");
  title.textContent = "運営ページ ログイン";
  box.appendChild(title);

  const desc = document.createElement("p");
  desc.className = "admin-auth-desc";
  desc.textContent = "パスワードを入力してください。";
  box.appendChild(desc);

  const input = document.createElement("input");
  input.type = "password";
  input.className = "admin-auth-input";
  input.autocomplete = "off";
  input.inputMode = "numeric";
  input.placeholder = "パスワード";
  box.appendChild(input);

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "admin-auth-submit";
  btn.textContent = "ログイン";
  box.appendChild(btn);

  const msg = document.createElement("p");
  msg.className = "admin-auth-msg";
  box.appendChild(msg);

  overlay.appendChild(box);
  document.body.appendChild(overlay);

  // フォーカスは少し遅らせる（iOSのキーボード起動安定化）
  setTimeout(() => input.focus(), 50);

  const tryUnlock = () => {
    if (input.value === ADMIN_PASSWORD) {
      sessionStorage.setItem(SESSION_KEY, "ok");
      overlay.remove();
      onSuccess();
    } else {
      msg.textContent = "パスワードが違います。";
      msg.classList.add("err");
      input.value = "";
      input.focus();
    }
  };

  btn.addEventListener("click", tryUnlock);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") tryUnlock();
  });
}
