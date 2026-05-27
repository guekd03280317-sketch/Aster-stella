// Aster Stella - 運営ページ
//
// - 資源配分設定(aster_stella/config/resourceDist)の編集・保存
// - GASウェブアプリ経由でターン実行/バックアップ/過去データ読込/Config調整
//
// GAS URL と API_KEY はこのブラウザの localStorage に保存する。

import { db, ref, set, get } from "./firebase-config.js";
import { requireAdminAuth } from "./admin-auth.js";
import { DEFAULT_DIST } from "./random-placement.js";

const DIST_PATH = "aster_stella/config/resourceDist";
const LS_URL = "aster_stella_gas_url";
const LS_KEY = "aster_stella_gas_key";

function $(id) { return document.getElementById(id); }
function setStatus(el, msg, kind) { el.textContent = msg; el.className = "status" + (kind ? " " + kind : ""); }

// ---- 資源配分設定 ----
function renderDistForm(values) {
  const form = $("dist-form");
  form.innerHTML = "";
  for (const k of Object.keys(DEFAULT_DIST)) {
    const label = document.createElement("label");
    label.className = "field";
    const span = document.createElement("span");
    span.textContent = k;
    const input = document.createElement("input");
    input.type = "number";
    input.step = "any";
    input.dataset.key = k;
    input.value = values[k];
    label.appendChild(span);
    label.appendChild(input);
    form.appendChild(label);
  }
}
function readDistForm() {
  const out = {};
  for (const input of $("dist-form").querySelectorAll("input[data-key]")) {
    const v = parseFloat(input.value);
    out[input.dataset.key] = isFinite(v) ? v : DEFAULT_DIST[input.dataset.key];
  }
  return out;
}
async function loadDist() {
  setStatus($("dist-status"), "読込中...", "");
  try {
    const snap = await get(ref(db, DIST_PATH));
    const v = snap.exists() ? snap.val() : {};
    const merged = { ...DEFAULT_DIST, ...v };
    renderDistForm(merged);
    setStatus($("dist-status"), "読み込みました。", "ok");
  } catch (err) {
    setStatus($("dist-status"), "読込失敗: " + err.message, "err");
  }
}
async function saveDist() {
  setStatus($("dist-status"), "保存中...", "");
  try {
    await set(ref(db, DIST_PATH), readDistForm());
    setStatus($("dist-status"), "保存しました。管理者ページのランダム配置で使われます。", "ok");
  } catch (err) {
    setStatus($("dist-status"), "保存失敗: " + err.message, "err");
  }
}

// ---- GAS連携 ----
function gasUrl() { return ($("gas-url").value || "").trim(); }
function gasKey() { return ($("gas-key").value || "").trim(); }
function loadGasCreds() {
  $("gas-url").value = localStorage.getItem(LS_URL) || "";
  $("gas-key").value = localStorage.getItem(LS_KEY) || "";
}
function saveGasCreds() {
  localStorage.setItem(LS_URL, gasUrl());
  localStorage.setItem(LS_KEY, gasKey());
  setStatus($("gas-status"), "保存しました。", "ok");
}
async function gasGet(params) {
  const url = new URL(gasUrl());
  url.searchParams.set("key", gasKey());
  for (const k of Object.keys(params)) url.searchParams.set(k, params[k]);
  const res = await fetch(url.toString(), { method: "GET" });
  return res.json();
}
async function gasPost(body) {
  // GASのウェブアプリはCORSプリフライトを避けるため text/plain で送る
  const res = await fetch(gasUrl(), {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ key: gasKey(), ...body })
  });
  return res.json();
}
function requireGas(statusEl) {
  if (!gasUrl() || !gasKey()) { setStatus(statusEl, "先にGAS URLとAPI_KEYを入力・保存してください。", "err"); return false; }
  return true;
}

async function runTurn() {
  if (!requireGas($("gas-status"))) return;
  if (!confirm("全国家の予約を一斉処理して1ターン進めます。実行しますか？")) return;
  const btn = $("btn-run-turn");
  const orig = btn.textContent;
  btn.disabled = true;
  btn.classList.add("loading");
  btn.textContent = "● 実行中...";
  setStatus($("gas-status"), "ターン実行中...", "");
  try {
    const t0 = Date.now();
    const r = await gasGet({ action: "runturn" });
    const ms = Date.now() - t0;
    setStatus($("gas-status"), r.ok ? `ターンを実行しました（${ms}ms）。` : ("エラー: " + JSON.stringify(r)), r.ok ? "ok" : "err");
  } catch (err) {
    setStatus($("gas-status"), "失敗: " + err.message, "err");
  } finally {
    btn.disabled = false; btn.classList.remove("loading"); btn.textContent = orig;
  }
}
async function runBackup() {
  if (!requireGas($("gas-status"))) return;
  const btn = $("btn-run-backup");
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = "● 実行中...";
  setStatus($("gas-status"), "バックアップ実行中...", "");
  try {
    const r = await gasGet({ action: "runbackup" });
    setStatus($("gas-status"), r.ok ? "バックアップを実行しました（スプレッドシートをご確認ください）。" : ("エラー: " + JSON.stringify(r)), r.ok ? "ok" : "err");
  } catch (err) {
    setStatus($("gas-status"), "失敗: " + err.message, "err");
  } finally {
    btn.disabled = false; btn.textContent = orig;
  }
}

// ---- Config（計算式）----
function renderConfigForm(cfg) {
  const form = $("config-form");
  form.innerHTML = "";
  for (const k of Object.keys(cfg)) {
    const label = document.createElement("label");
    label.className = "field";
    const span = document.createElement("span");
    span.textContent = k;
    const input = document.createElement("input");
    input.type = "number";
    input.step = "any";
    input.dataset.key = k;
    input.value = cfg[k];
    label.appendChild(span);
    label.appendChild(input);
    form.appendChild(label);
  }
}
async function getConfig() {
  if (!requireGas($("config-status"))) return;
  setStatus($("config-status"), "取得中...", "");
  try { const cfg = await gasGet({ action: "getconfig" }); renderConfigForm(cfg); setStatus($("config-status"), "取得しました。", "ok"); }
  catch (err) { setStatus($("config-status"), "失敗: " + err.message, "err"); }
}
async function setConfig() {
  if (!requireGas($("config-status"))) return;
  const cfg = {};
  for (const input of $("config-form").querySelectorAll("input[data-key]")) {
    const v = parseFloat(input.value);
    if (isFinite(v)) cfg[input.dataset.key] = v;
  }
  setStatus($("config-status"), "更新中...", "");
  try { const r = await gasPost({ action: "setconfig", config: cfg }); setStatus($("config-status"), r.ok ? "更新しました。次のターンから反映されます。" : ("エラー: " + JSON.stringify(r)), r.ok ? "ok" : "err"); }
  catch (err) { setStatus($("config-status"), "失敗: " + err.message, "err"); }
}

// ---- 過去データ ----
async function getBackup() {
  if (!requireGas($("backup-status"))) return;
  setStatus($("backup-status"), "取得中...", "");
  try {
    const date = ($("backup-date").value || "").trim();
    const r = await gasGet(date ? { action: "backup", date } : { action: "backup" });
    $("backup-output").value = JSON.stringify(r, null, 2);
    setStatus($("backup-status"), "取得しました。", "ok");
  } catch (err) { setStatus($("backup-status"), "失敗: " + err.message, "err"); }
}

function init() {
  renderDistForm({ ...DEFAULT_DIST });
  loadGasCreds();
  $("btn-dist-load").addEventListener("click", loadDist);
  $("btn-dist-default").addEventListener("click", () => renderDistForm({ ...DEFAULT_DIST }));
  $("btn-dist-save").addEventListener("click", saveDist);
  $("btn-gas-save").addEventListener("click", saveGasCreds);
  $("btn-run-turn").addEventListener("click", runTurn);
  $("btn-run-backup").addEventListener("click", runBackup);
  $("btn-config-get").addEventListener("click", getConfig);
  $("btn-config-set").addEventListener("click", setConfig);
  $("btn-backup-get").addEventListener("click", getBackup);
  loadDist();
}

requireAdminAuth().then(init);
