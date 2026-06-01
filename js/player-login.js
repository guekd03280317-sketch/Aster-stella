// Aster Stella - ログイン画面の処理
//
// 国家リストを表示し、選んだ国家のパスワードを Firebase と突合する。
// 成功でセッションを保存して player.html へ遷移する。
// すでにセッションがあれば自動的に player.html へ。

import { getSession, setSession, fetchNationsForLogin, authenticate } from "./player-auth.js";

const choicesEl = document.getElementById("nation-choices");
const passwordEl = document.getElementById("password");
const statusEl = document.getElementById("login-status");
const loginBtn = document.getElementById("btn-login");
const toggleBtn = document.getElementById("btn-toggle-pw");

let selectedId = null;

function setStatus(msg, kind) {
  statusEl.textContent = msg;
  statusEl.className = "status" + (kind ? " " + kind : "");
}

// すでにログイン済みなら直行
if (getSession()) {
  window.location.replace("player.html");
}

async function loadNations() {
  try {
    const nations = await fetchNationsForLogin();
    const ids = Object.keys(nations).filter((id) => nations[id].hasPassword);
    if (ids.length === 0) {
      choicesEl.innerHTML =
        '<p class="loading">ログイン可能な国家がありません。管理者がパスワードを設定すると表示されます。</p>';
      return;
    }
    choicesEl.innerHTML = "";
    ids.sort((a, b) => nations[a].name.localeCompare(nations[b].name, "ja"));
    for (const id of ids) {
      const n = nations[id];
      const item = document.createElement("button");
      item.type = "button";
      item.className = "nation-item";
      item.dataset.id = id;

      const swatch = document.createElement("span");
      swatch.className = "nation-swatch";
      swatch.style.background = n.color;

      const label = document.createElement("span");
      label.className = "nation-label";
      const strong = document.createElement("strong");
      strong.textContent = n.name;
      label.appendChild(strong);

      item.appendChild(swatch);
      item.appendChild(label);
      item.addEventListener("click", () => selectNation(id));
      choicesEl.appendChild(item);
    }
  } catch (err) {
    choicesEl.innerHTML = '<p class="loading">国家の読み込みに失敗しました。</p>';
    setStatus("読み込みエラー: " + err.message, "err");
  }
}

function selectNation(id) {
  selectedId = id;
  for (const el of choicesEl.querySelectorAll(".nation-item")) {
    el.classList.toggle("active", el.dataset.id === id);
  }
  setStatus("", "");
  passwordEl.focus();
}

async function tryLogin() {
  if (!selectedId) {
    setStatus("国家を選択してください。", "err");
    return;
  }
  const pw = passwordEl.value;
  if (!pw) {
    setStatus("パスワードを入力してください。", "err");
    return;
  }
  loginBtn.disabled = true;
  setStatus("認証中...", "");
  try {
    const ok = await authenticate(selectedId, pw);
    if (ok) {
      setSession(selectedId, pw);
      setStatus("ログインしました。移動します...", "ok");
      window.location.replace("player.html");
    } else {
      setStatus("パスワードが違います。", "err");
      passwordEl.value = "";
      passwordEl.focus();
    }
  } catch (err) {
    setStatus("認証に失敗しました: " + err.message, "err");
  } finally {
    loginBtn.disabled = false;
  }
}

loginBtn.addEventListener("click", tryLogin);
passwordEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") tryLogin();
});
toggleBtn.addEventListener("click", () => {
  if (passwordEl.type === "password") {
    passwordEl.type = "text";
    toggleBtn.textContent = "隠す";
  } else {
    passwordEl.type = "password";
    toggleBtn.textContent = "表示";
  }
});

loadNations();
