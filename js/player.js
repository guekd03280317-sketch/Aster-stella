// Aster Stella - playerサイド メイン画面
//
// 役割（このセッションの実装範囲）:
//   - セッション確認（無ければログイン画面へ）
//   - 自国 + 全ステート + 地図SVG の読み込み
//   - タブ切替
//   - ダッシュボード（概要 / 主要ステータス / ミニ地図 / ログ）
//   - 地図タブ（塗り分け・表示モード・自国ハイライト・ステート情報の読取専用表示）
//
// 内政/産業/経済/研究/外交タブは予約方式(js/orders.js)の上に次のセッションで実装する。

import { db, ref, get, set } from "./firebase-config.js";
import { requirePlayerSession, clearSession } from "./player-auth.js";
import { attachPanZoom } from "./map-pan-zoom.js";
import { normalizeState, INDUSTRY_FIELDS } from "./state-schema.js";
import {
  normalizeNation,
  nationLabel,
  computeDerivedStats,
  computeNationComputed,
  ECONOMIC_IDEOLOGIES,
  POLITICAL_IDEOLOGIES
} from "./nation-schema.js";
import { addOrder, cancelOrder, subscribeOrders } from "./orders.js";
import { describeOrder, orderLabel, MARKET_RESOURCES, normalizeMarket } from "./player-schema.js";
import {
  FLOW_RESOURCES, computeTurn, investCost, CONFIG,
  buildCost, canBuildIndustry, civilianIdeology, annexCost
} from "./economy.js";
import { barChart, pieChart, lineChart, chartLegend } from "./charts.js";
import {
  sendMail, subscribeMail, markMailRead, deleteMail,
  postBoard, subscribeBoard, deleteBoardPost,
  createTradeProposal, subscribeTradeProposals, cancelTradeProposal
} from "./mail.js";

const PICKED_STROKE = "#ffd166";
const PICKED_STROKE_W = "2.5";

const SVG_URL = "MapChart_Map.svg";
const PRESENCE_YES = "#7be0c7";

// 地図テーマ（標準 / ダーク / ハイコントラスト）。CSS filter と未所属色をまとめる。
const MAP_THEMES = {
  normal:   { noCountry: "#1d2738", fadeOther: "#10151f", heatLow: [29, 39, 56],  heatHigh: [90, 169, 255], filter: "" },
  dark:     { noCountry: "#070b13", fadeOther: "#050810", heatLow: [12, 20, 34],  heatHigh: [74, 142, 220], filter: "brightness(0.82) saturate(1.05) contrast(1.05)" },
  contrast: { noCountry: "#26334d", fadeOther: "#0c1320", heatLow: [40, 60, 100], heatHigh: [120, 200, 255], filter: "saturate(1.35) contrast(1.18)" }
};
let mapTheme = (typeof localStorage !== "undefined" && localStorage.getItem("aster_stella_map_theme")) || "normal";
function theme() { return MAP_THEMES[mapTheme] || MAP_THEMES.normal; }

// 地図の表示モード（playerサイド版）。
// 資源は仕様により「あるかないか」のみ表示する（presence）。
const DISPLAY_MODES = [
  { value: "country",        label: "所属国家",      kind: "category" },
  { value: "economy",        label: "経済力",        kind: "number", path: ["economy"] },
  { value: "development",    label: "開発度",        kind: "number", path: ["development"] },
  { value: "population",     label: "人口",          kind: "number", path: ["population"] },
  { value: "governance",     label: "統治レベル",    kind: "number", path: ["governance"] },
  { value: "infrastructure", label: "インフラレベル", kind: "number", path: ["infrastructure"] },
  { value: "livingStandard", label: "生活水準",      kind: "number", path: ["livingStandard"] },
  { value: "res:fertility",  label: "資源: 肥沃度",       kind: "presence", path: ["resources", "fertility"] },
  { value: "res:metal",      label: "資源: 金属",         kind: "presence", path: ["resources", "metal"] },
  { value: "res:oil",        label: "資源: 石油",         kind: "presence", path: ["resources", "oil"] },
  { value: "res:coal",       label: "資源: 石炭",         kind: "presence", path: ["resources", "coal"] },
  { value: "res:rareMineral",label: "資源: 重要鉱物",     kind: "presence", path: ["resources", "rareMineral"] }
];

const INFO_FIELDS = [
  { key: "economy",        label: "経済力" },
  { key: "development",    label: "開発度" },
  { key: "population",     label: "人口" },
  { key: "governance",     label: "統治レベル" },
  { key: "infrastructure", label: "インフラレベル" },
  { key: "livingStandard", label: "生活水準" }
];

// ---- 状態 ----
const nationId = requirePlayerSession();
let nation = null;
let statesData = {};
let nationsById = {};      // 他国名の解決用（id -> nation軽量情報）
let svgText = "";
let mapSvg = null;
let panZoom = null;
const elById = new Map();
const originalStrokes = new Map(); // path -> {stroke, width} 選択ハイライト解除用
let selectedMode = "country";
let highlightOwn = false;
let world = null;          // aster_stella/world（世界景気）
let market = null;         // aster_stella/market
let history = [];          // aster_stella/history（日次スナップショット配列）
let latestOrders = [];     // 自国の予約一覧（subscribeで更新）
let pickedStateName = null; // 政策対象として地図で選んだ自国ステート
let lastTappedStateName = null; // 編入用：直近にタップしたステート（自国以外も）
let adjacency = {};         // aster_stella/map の隣接関係
let latestMail = [];
let latestBoard = [];
let latestProposals = [];
const policyUpdaters = {};  // { domestic, industry, annex } 選択ステート反映の更新関数

// ---- DOM ----
const hdrNation = document.getElementById("hdr-nation");
const mapStatus = document.getElementById("map-status");
const displayModeSelect = document.getElementById("display-mode");
const highlightChk = document.getElementById("highlight-own");

function setStatus(el, msg, kind) {
  if (!el) return;
  el.textContent = msg;
  el.className = "status" + (kind ? " " + kind : "");
}

function fmt(v) {
  if (typeof v !== "number" || !isFinite(v)) v = Number(v) || 0;
  if (Number.isInteger(v)) return v.toLocaleString();
  return v.toFixed(2);
}

// -----------------------------------------------------------------------------
// 初期化
// -----------------------------------------------------------------------------
async function init() {
  if (!nationId) return; // requirePlayerSession がリダイレクト済み
  try {
    await loadData();
  } catch (err) {
    hdrNation.textContent = "読み込み失敗";
    setStatus(mapStatus, "データ読み込みに失敗: " + err.message, "err");
    return;
  }
  hdrNation.textContent = nationLabel(nation);
  buildDisplayModes();
  renderDashboard();
  renderDomestic();
  renderStatePolicy();
  renderEconomy();
  renderResearch();
  renderSettings();
  await loadMaps();
  setupTabs();
  setupSettings();

  // 予約の変化を購読して各タブの予約一覧を更新
  subscribeOrders(nationId, (orders) => {
    latestOrders = orders;
    renderAllPendingOrders();
  });
  // メール・掲示板・取引提案を購読
  subscribeMail(nationId, (list) => { latestMail = list; renderMailInbox(); });
  subscribeBoard((list) => { latestBoard = list; renderBoardList(); });
  subscribeTradeProposals((list) => { latestProposals = list; renderTradeList(); });
  renderDiplomacy();
}

function ownStatesList() {
  const arr = [];
  for (const name of Object.keys(statesData)) {
    if (statesData[name].country === nation.id) arr.push({ name, ...statesData[name] });
  }
  arr.sort((a, b) => a.name.localeCompare(b.name, "ja"));
  return arr;
}

async function loadData() {
  const [nationSnap, statesSnap, nationsSnap, worldSnap, marketSnap, historySnap, mapSnap] = await Promise.all([
    get(ref(db, `aster_stella/nations/${nationId}`)),
    get(ref(db, "aster_stella/states")),
    get(ref(db, "aster_stella/nations")),
    get(ref(db, "aster_stella/world")),
    get(ref(db, "aster_stella/market")),
    get(ref(db, "aster_stella/history")),
    get(ref(db, "aster_stella/map"))
  ]);
  const mapData = mapSnap.exists() ? mapSnap.val() : null;
  adjacency = (mapData && mapData.adjacency) ? mapData.adjacency : {};
  if (!nationSnap.exists()) throw new Error("自国データが見つかりません");
  nation = normalizeNation(nationSnap.val());
  if (!nation.id) nation.id = nationId;

  const statesRaw = statesSnap.exists() ? (statesSnap.val() || {}) : {};
  statesData = {};
  for (const name of Object.keys(statesRaw)) {
    statesData[name] = normalizeState(statesRaw[name]);
  }

  const nationsRaw = nationsSnap.exists() ? (nationsSnap.val() || {}) : {};
  nationsById = {};
  for (const id of Object.keys(nationsRaw)) {
    const n = nationsRaw[id] || {};
    nationsById[id] = {
      id, name: n.name || id, color: n.color || theme().noCountry,
      totalEconomy: Number(n.stats && n.stats.totalEconomy) || 0
    };
  }

  world = worldSnap.exists() ? worldSnap.val() : { value: 10, trend: "通常" };
  market = normalizeMarket(marketSnap.exists() ? marketSnap.val() : null);
  const histRaw = historySnap.exists() ? historySnap.val() : null;
  history = Array.isArray(histRaw) ? histRaw : (histRaw && typeof histRaw === "object" ? Object.values(histRaw) : []);
}

// -----------------------------------------------------------------------------
// ダッシュボード
// -----------------------------------------------------------------------------
function renderDashboard() {
  const derived = computeDerivedStats(nation.id, statesData);
  const computed = computeNationComputed(nation, derived);

  const overview = document.getElementById("dash-overview");
  overview.innerHTML = "";
  overview.appendChild(swatchField("国名", nationLabel(nation), nation.color));
  overview.appendChild(roField("首都", nation.capital || "（未設定）"));
  overview.appendChild(roField("経済イデオロギー", ideologyLabel(nation.ideology, ECONOMIC_IDEOLOGIES)));
  overview.appendChild(roField("政治体制", ideologyLabel(nation.government, POLITICAL_IDEOLOGIES)));
  overview.appendChild(roField("合計ステート数", fmt(derived.totalStates)));

  const stats = document.getElementById("dash-stats");
  stats.innerHTML = "";
  stats.appendChild(roField("合計経済力", fmt(derived.totalEconomy)));
  stats.appendChild(roField("国庫", fmt(nation.stats.treasury)));
  stats.appendChild(roField("政治力", fmt(nation.stats.politicalPower)));
  stats.appendChild(roField("威信", fmt(computed.prestige)));
  stats.appendChild(roField("合計人口", fmt(derived.totalPopulation)));
  stats.appendChild(roField("平均生活水準", fmt(derived.avgLivingStandard)));
  stats.appendChild(roField("税率", fmt(nation.stats.taxRate)));
  stats.appendChild(roField("国家別景気", fmt(nation.stats.economyTrend)));
  stats.appendChild(roField("合計兵力", fmt(computed.totalTroops)));

  renderLogs();
}

function renderLogs() {
  const box = document.getElementById("dash-logs");
  const logs = Array.isArray(nation.logs) ? nation.logs.slice().reverse() : [];
  if (logs.length === 0) {
    box.innerHTML = '<p class="loading">まだ記録がありません。</p>';
    return;
  }
  box.innerHTML = "";
  for (const log of logs.slice(0, 30)) {
    const row = document.createElement("div");
    row.className = "log-row";
    const time = document.createElement("span");
    time.className = "log-time";
    time.textContent = formatTime(log.at);
    const kind = document.createElement("span");
    kind.className = "log-kind log-kind-" + (log.kind || "");
    kind.textContent = log.kind || "";
    const text = document.createElement("span");
    text.className = "log-text";
    text.textContent = log.text || "";
    row.appendChild(time);
    row.appendChild(kind);
    row.appendChild(text);
    box.appendChild(row);
  }
}

function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function ideologyLabel(v, list) {
  if (!v) return "（未設定）";
  return list.includes(v) ? v : v;
}

function roField(label, value) {
  const wrap = document.createElement("div");
  wrap.className = "field readonly";
  const span = document.createElement("span");
  span.textContent = label;
  const val = document.createElement("div");
  val.className = "field-value";
  val.textContent = value;
  wrap.appendChild(span);
  wrap.appendChild(val);
  return wrap;
}

function swatchField(label, value, color) {
  const wrap = roField(label, value);
  const val = wrap.querySelector(".field-value");
  const sw = document.createElement("span");
  sw.className = "nation-swatch inline";
  sw.style.background = color || theme().noCountry;
  val.prepend(sw);
  return wrap;
}

// -----------------------------------------------------------------------------
// 地図
// -----------------------------------------------------------------------------
function buildDisplayModes() {
  displayModeSelect.innerHTML = "";
  for (const m of DISPLAY_MODES) {
    const opt = document.createElement("option");
    opt.value = m.value;
    opt.textContent = m.label;
    displayModeSelect.appendChild(opt);
  }
  displayModeSelect.value = selectedMode;
}

async function loadMaps() {
  try {
    const res = await fetch(SVG_URL);
    if (!res.ok) throw new Error("HTTP " + res.status);
    svgText = await res.text();
  } catch (err) {
    document.getElementById("map-container").innerHTML =
      '<p class="loading">地図を読み込めませんでした。ローカルサーバー経由で開いてください。<br>詳細: ' +
      err.message + "</p>";
    return;
  }

  // メイン地図（操作あり）
  mapSvg = makeMapSvg();
  const container = document.getElementById("map-container");
  container.innerHTML = "";
  container.appendChild(mapSvg);
  panZoom = attachPanZoom(mapSvg);
  indexPaths(mapSvg, elById);
  applyMapColors();

  // ミニ地図（自国強調・操作なし）
  const mini = makeMapSvg();
  const miniBox = document.getElementById("mini-map");
  miniBox.innerHTML = "";
  miniBox.appendChild(mini);
  paintMini(mini);
}

function makeMapSvg() {
  const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
  const svg = document.importNode(doc.documentElement, true);
  svg.removeAttribute("width");
  svg.removeAttribute("height");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  return svg;
}

function indexPaths(svg, map) {
  map.clear();
  originalStrokes.clear();
  svg.querySelectorAll("#map > path").forEach((p) => {
    if (!p.id || p.id.startsWith("pattern")) return;
    map.set(p.id, p);
    originalStrokes.set(p.id, { stroke: p.getAttribute("stroke"), width: p.getAttribute("stroke-width") });
  });
}

function restoreStroke(name) {
  const el = elById.get(name);
  const orig = originalStrokes.get(name);
  if (!el || !orig) return;
  if (orig.stroke === null) el.removeAttribute("stroke"); else el.setAttribute("stroke", orig.stroke);
  if (orig.width === null) el.removeAttribute("stroke-width"); else el.setAttribute("stroke-width", orig.width);
}

function paintMini(svg) {
  svg.querySelectorAll("#map > path").forEach((p) => {
    if (!p.id || p.id.startsWith("pattern")) return;
    const own = statesData[p.id] && statesData[p.id].country === nation.id;
    p.setAttribute("fill", own ? (nation.color || "#5aa9ff") : theme().fadeOther);
    p.style.cursor = "default";
  });
}

function applyMapColors() {
  const mode = DISPLAY_MODES.find((m) => m.value === selectedMode) || DISPLAY_MODES[0];

  // 数値モードは自国領のレンジで色付け（自国に関わる比較を見やすく）
  let min = Infinity, max = -Infinity;
  if (mode.kind === "number") {
    for (const [name, s] of Object.entries(statesData)) {
      if (highlightOwn && s.country !== nation.id) continue;
      const v = Number(getByPath(s, mode.path)) || 0;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (!isFinite(min)) { min = 0; max = 1; }
    if (min === max) max = min + 1;
  }

  for (const [name, p] of elById) {
    const s = statesData[name];
    const isOwn = s && s.country === nation.id;
    if (highlightOwn && !isOwn) {
      p.setAttribute("fill", theme().fadeOther);
      continue;
    }
    let fill = theme().noCountry;
    if (!s) {
      fill = theme().noCountry;
    } else if (mode.kind === "category") {
      const n = s.country ? nationsById[s.country] : null;
      fill = n ? n.color : theme().noCountry;
    } else if (mode.kind === "number") {
      const v = Number(getByPath(s, mode.path)) || 0;
      fill = heat((v - min) / (max - min));
    } else if (mode.kind === "presence") {
      const v = Number(getByPath(s, mode.path)) || 0;
      fill = v > 0 ? PRESENCE_YES : theme().noCountry;
    }
    p.setAttribute("fill", fill);
  }
}

function getByPath(obj, path) {
  let cur = obj;
  for (const k of path) {
    if (cur == null) return undefined;
    cur = cur[k];
  }
  return cur;
}

function heat(t) {
  t = Math.max(0, Math.min(1, t));
  const lo = theme().heatLow, hi = theme().heatHigh;
  const c = lo.map((v, i) => Math.round(v + (hi[i] - v) * t));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

function showStateInfo(name) {
  const s = statesData[name];
  const box = document.getElementById("state-info");
  if (!s) {
    box.innerHTML = '<p class="loading">このステートのデータがありません。</p>';
    return;
  }
  const owner = s.country ? nationsById[s.country] : null;
  box.innerHTML = "";

  const head = document.createElement("h3");
  head.className = "state-info-name";
  head.textContent = name;
  box.appendChild(head);

  const ownerP = document.createElement("p");
  ownerP.className = "state-info-owner";
  ownerP.textContent = "所属: " + (owner ? owner.name : "未所属") +
    (s.country === nation.id ? "（自国）" : "");
  box.appendChild(ownerP);

  const grid = document.createElement("div");
  grid.className = "field-grid";
  for (const f of INFO_FIELDS) grid.appendChild(roField(f.label, fmt(Number(s[f.key]) || 0)));
  box.appendChild(grid);

  // 資源は「あるかないか」のみ
  const resHead = document.createElement("h4");
  resHead.className = "subhead";
  resHead.textContent = "資源の埋蔵（有無のみ）";
  box.appendChild(resHead);
  const resGrid = document.createElement("div");
  resGrid.className = "field-grid";
  const resList = [
    ["fertility", "肥沃度"], ["metal", "金属"], ["oil", "石油"],
    ["coal", "石炭"], ["rareMineral", "重要鉱物"]
  ];
  for (const [k, lbl] of resList) {
    const has = Number(s.resources && s.resources[k]) > 0;
    resGrid.appendChild(roField(lbl, has ? "あり" : "なし"));
  }
  box.appendChild(resGrid);
}

// -----------------------------------------------------------------------------
// タブ・設定
// -----------------------------------------------------------------------------
function switchTab(tab) {
  const buttons = document.querySelectorAll(".tab-btn");
  const panels = document.querySelectorAll(".tab-panel");
  for (const b of buttons) b.classList.toggle("active", b.dataset.tab === tab);
  for (const p of panels) p.classList.toggle("active", p.dataset.tab === tab);
}

function applyMapTheme() {
  const f = theme().filter || "";
  const mc = document.getElementById("map-container");
  if (mc) mc.style.filter = f;
  const mini = document.getElementById("mini-map");
  if (mini) mini.style.filter = f;
}

function applyPickedHighlight() {
  if (!pickedStateName) return;
  const el = elById.get(pickedStateName);
  if (el) {
    el.setAttribute("stroke", PICKED_STROKE);
    el.setAttribute("stroke-width", PICKED_STROKE_W);
    el.parentNode.appendChild(el); // 最前面へ
  }
}

function pickState(name) {
  const s = statesData[name];
  if (!s || s.country !== nation.id) {
    flash("自国のステートを選んでください。", "err");
    return;
  }
  if (pickedStateName && pickedStateName !== name) restoreStroke(pickedStateName);
  pickedStateName = name;
  applyPickedHighlight();
  if (policyUpdaters.statepolicy) policyUpdaters.statepolicy();
  flash(name + " を政策対象に選択しました。", "ok");
}

function setupTabs() {
  const buttons = document.querySelectorAll(".tab-btn");
  for (const btn of buttons) {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  }

  document.getElementById("map-container").addEventListener("click", (e) => {
    if (panZoom && panZoom.wasDragging()) return;
    const p = e.target.closest("path");
    if (!p || !elById.has(p.id)) return;
    showStateInfo(p.id);
    lastTappedStateName = p.id;
    if (statesData[p.id] && statesData[p.id].country === nation.id) pickState(p.id);
    if (policyUpdaters.annex) policyUpdaters.annex();
  });

  displayModeSelect.addEventListener("change", () => {
    selectedMode = displayModeSelect.value;
    applyMapColors();
  });
  highlightChk.addEventListener("change", () => {
    highlightOwn = highlightChk.checked;
    applyMapColors();
  });
  const themeSel = document.getElementById("map-theme");
  if (themeSel) {
    themeSel.value = mapTheme;
    themeSel.addEventListener("change", () => {
      mapTheme = themeSel.value;
      try { localStorage.setItem("aster_stella_map_theme", mapTheme); } catch (_) {}
      applyMapColors();
      applyPickedHighlight();
      applyMapTheme();
      // ミニ地図の自国強調も塗り直す（fadeOther を使うため）
      const miniSvg = document.querySelector("#mini-map svg");
      if (miniSvg) paintMini(miniSvg);
    });
  }
  applyMapTheme();

  document.getElementById("btn-zoom-in").addEventListener("click", () => panZoom && panZoom.zoomIn());
  document.getElementById("btn-zoom-out").addEventListener("click", () => panZoom && panZoom.zoomOut());
  document.getElementById("btn-zoom-reset").addEventListener("click", () => panZoom && panZoom.reset());
}

function setupSettings() {
  document.getElementById("btn-logout").addEventListener("click", () => {
    clearSession();
    window.location.replace("player-login.html");
  });
}

function otherNationOptions() {
  return Object.values(nationsById)
    .filter((n) => n.id !== nation.id)
    .map((n) => ({ value: n.id, label: n.name }));
}
function nationName(id) {
  return (nationsById[id] && nationsById[id].name) || id;
}
function resourceSelect(includeNone) {
  const opts = FLOW_RESOURCES.map((r) => ({ value: r.key, label: r.label }));
  if (includeNone) opts.unshift({ value: "", label: "（なし）" });
  return selectInput(opts);
}

// -----------------------------------------------------------------------------
// 設定（パスワード変更・国旗色変更）
// -----------------------------------------------------------------------------
function renderSettings() {
  // パスワード
  const pwBox = document.getElementById("password-control");
  pwBox.innerHTML = "";
  const oldI = document.createElement("input"); oldI.type = "password"; oldI.placeholder = "現在のパスワード";
  const newI = document.createElement("input"); newI.type = "password"; newI.placeholder = "新しいパスワード";
  const conf = document.createElement("input"); conf.type = "password"; conf.placeholder = "新しいパスワード（確認）";
  for (const i of [oldI, newI, conf]) i.className = "settings-input";
  const pwBtn = actionButton("パスワードを変更", async () => {
    if (oldI.value !== (nation.password || "")) { flash("現在のパスワードが違います。", "err"); return; }
    if (!newI.value) { flash("新しいパスワードを入力してください。", "err"); return; }
    if (newI.value !== conf.value) { flash("確認用が一致しません。", "err"); return; }
    pwBtn.disabled = true;
    try {
      await set(ref(db, `aster_stella/nations/${nation.id}/password`), newI.value);
      nation.password = newI.value;
      oldI.value = newI.value = conf.value = "";
      flash("パスワードを変更しました。", "ok");
    } catch (err) { flash("変更に失敗: " + err.message, "err"); }
    finally { pwBtn.disabled = false; }
  });
  pwBox.appendChild(labeled("現在のパスワード", oldI));
  pwBox.appendChild(labeled("新しいパスワード", newI));
  pwBox.appendChild(labeled("新しいパスワード（確認）", conf));
  pwBox.appendChild(row(pwBtn));

  // 国旗色
  const colorBox = document.getElementById("color-control");
  colorBox.innerHTML = "";
  const colorI = document.createElement("input"); colorI.type = "color"; colorI.value = nation.color || "#888888";
  const colorBtn = actionButton("国旗色を変更", async () => {
    colorBtn.disabled = true;
    try {
      await set(ref(db, `aster_stella/nations/${nation.id}/color`), colorI.value);
      nation.color = colorI.value;
      if (nationsById[nation.id]) nationsById[nation.id].color = colorI.value;
      applyMapColors(); applyPickedHighlight();
      renderDashboard();
      flash("国旗色を変更しました。", "ok");
    } catch (err) { flash("変更に失敗: " + err.message, "err"); }
    finally { colorBtn.disabled = false; }
  });
  colorBox.appendChild(row(labeled("色", colorI), colorBtn));
  colorBox.appendChild(noteP("地図やダッシュボードの自国色に反映されます。"));
}

// -----------------------------------------------------------------------------
// 外交 / 通信（メール・取引提案・掲示板）
// -----------------------------------------------------------------------------
function renderDiplomacy() {
  // メール作成
  const mc = document.getElementById("mail-compose");
  mc.innerHTML = "";
  if (!otherNationOptions().length) {
    mc.appendChild(noteP("他の国家がいません。"));
  } else {
    const toSel = selectInput(otherNationOptions());
    const subj = document.createElement("input"); subj.className = "settings-input"; subj.placeholder = "件名";
    const body = document.createElement("textarea"); body.className = "nation-description"; body.placeholder = "本文";
    const moneyI = numberInput(0, { step: "1", min: 0 });
    const resSel = resourceSelect(true);
    const resAmt = numberInput(0, { step: "1", min: 0 });
    const sendBtn = actionButton("送信", async () => {
      const to = toSel.value;
      if (!to) return;
      sendBtn.disabled = true;
      try {
        await sendMail(to, { from: nation.id, fromName: nationLabel(nation), subject: subj.value || "(件名なし)", body: body.value || "", read: false });
        const money = Math.max(0, parseInt(moneyI.value) || 0);
        const ra = Math.max(0, parseInt(resAmt.value) || 0);
        if (money > 0 || (resSel.value && ra > 0)) {
          const resources = (resSel.value && ra > 0) ? { [resSel.value]: ra } : {};
          await addOrder(nationId, "sendTransfer", { to, toName: nationName(to), money, resources });
        }
        subj.value = ""; body.value = ""; moneyI.value = "0"; resAmt.value = "0";
        flash("メールを送信しました（送金/物資はターン処理で反映）。", "ok");
      } catch (err) { flash("送信失敗: " + err.message, "err"); }
      finally { sendBtn.disabled = false; }
    });
    mc.appendChild(labeled("宛先", toSel));
    mc.appendChild(labeled("件名", subj));
    mc.appendChild(labeled("本文", body));
    mc.appendChild(row(labeled("送金（国庫）", moneyI), labeled("資源", resSel), labeled("資源量", resAmt)));
    mc.appendChild(row(sendBtn));
    mc.appendChild(noteP("本文は即時に届きます。送金・物資は予約され、ターン処理で残高を確認して送付されます。"));
  }

  // 取引提案作成
  const tc = document.getElementById("trade-compose");
  tc.innerHTML = "";
  if (!otherNationOptions().length) {
    tc.appendChild(noteP("他の国家がいません。"));
  } else {
    const toSel = selectInput(otherNationOptions());
    const giveMoney = numberInput(0, { step: "1", min: 0 });
    const giveRes = resourceSelect(true); const giveAmt = numberInput(0, { step: "1", min: 0 });
    const wantMoney = numberInput(0, { step: "1", min: 0 });
    const wantRes = resourceSelect(true); const wantAmt = numberInput(0, { step: "1", min: 0 });
    const propBtn = actionButton("取引を提案", async () => {
      const to = toSel.value; if (!to) return;
      const give = { money: Math.max(0, parseInt(giveMoney.value) || 0), resources: {} };
      const want = { money: Math.max(0, parseInt(wantMoney.value) || 0), resources: {} };
      if (giveRes.value && parseInt(giveAmt.value) > 0) give.resources[giveRes.value] = parseInt(giveAmt.value);
      if (wantRes.value && parseInt(wantAmt.value) > 0) want.resources[wantRes.value] = parseInt(wantAmt.value);
      propBtn.disabled = true;
      try {
        await createTradeProposal({ from: nation.id, fromName: nationLabel(nation), to, give, want });
        await sendMail(to, { from: nation.id, fromName: nationLabel(nation), subject: "取引の提案が届きました", body: "外交タブの提案一覧から確認してください。", read: false });
        giveMoney.value = wantMoney.value = giveAmt.value = wantAmt.value = "0";
        flash("取引を提案しました。", "ok");
      } catch (err) { flash("提案失敗: " + err.message, "err"); }
      finally { propBtn.disabled = false; }
    });
    tc.appendChild(labeled("相手", toSel));
    tc.appendChild(row(labeled("渡す国庫", giveMoney), labeled("渡す資源", giveRes), labeled("量", giveAmt)));
    tc.appendChild(row(labeled("欲しい国庫", wantMoney), labeled("欲しい資源", wantRes), labeled("量", wantAmt)));
    tc.appendChild(row(propBtn));
    tc.appendChild(noteP("相手が承認するとターン処理で双方の残高を確認して交換します。"));
  }

  // 掲示板作成
  const bc = document.getElementById("board-compose");
  bc.innerHTML = "";
  const postI = document.createElement("input"); postI.className = "settings-input"; postI.placeholder = "掲示板に書き込む";
  const postBtn = actionButton("投稿", async () => {
    if (!postI.value.trim()) return;
    postBtn.disabled = true;
    try { await postBoard({ by: nation.id, byName: nationLabel(nation), text: postI.value.trim() }); postI.value = ""; flash("投稿しました。", "ok"); }
    catch (err) { flash("投稿失敗: " + err.message, "err"); }
    finally { postBtn.disabled = false; }
  });
  bc.appendChild(row(labeled("メッセージ", postI), postBtn));

  renderMailInbox();
  renderBoardList();
  renderTradeList();
}

function renderMailInbox() {
  const box = document.getElementById("mail-inbox");
  if (!box) return;
  if (!latestMail.length) { box.innerHTML = '<p class="loading">メールはありません。</p>'; return; }
  box.innerHTML = "";
  for (const m of latestMail) {
    const item = document.createElement("div");
    item.className = "mail-item" + (m.read ? "" : " unread");
    const head = document.createElement("div");
    head.className = "mail-head";
    head.innerHTML = `<span class="mail-from">${escapeHtml(m.fromName || m.from || "?")}</span>` +
      `<span class="mail-subj">${escapeHtml(m.subject || "(件名なし)")}</span>` +
      `<span class="log-time">${formatTime(m.at)}</span>`;
    const bodyEl = document.createElement("div");
    bodyEl.className = "mail-body";
    bodyEl.textContent = m.body || "";
    const btns = document.createElement("div");
    btns.className = "buttons";
    if (!m.read) btns.appendChild(actionButton("既読", () => markMailRead(nationId, m.key).catch(() => {}), "secondary order-cancel"));
    btns.appendChild(actionButton("削除", () => deleteMail(nationId, m.key).catch(() => {}), "secondary order-cancel"));
    item.appendChild(head); item.appendChild(bodyEl); item.appendChild(btns);
    box.appendChild(item);
  }
}

function renderBoardList() {
  const box = document.getElementById("board-list");
  if (!box) return;
  if (!latestBoard.length) { box.innerHTML = '<p class="loading">まだ投稿がありません。</p>'; return; }
  box.innerHTML = "";
  for (const p of latestBoard) {
    const item = document.createElement("div");
    item.className = "mail-item";
    const head = document.createElement("div");
    head.className = "mail-head";
    head.innerHTML = `<span class="mail-from">${escapeHtml(p.byName || p.by || "?")}</span><span class="log-time">${formatTime(p.at)}</span>`;
    const bodyEl = document.createElement("div");
    bodyEl.className = "mail-body";
    bodyEl.textContent = p.text || "";
    item.appendChild(head); item.appendChild(bodyEl);
    if (p.by === nation.id) {
      const btns = document.createElement("div"); btns.className = "buttons";
      btns.appendChild(actionButton("削除", () => deleteBoardPost(p.key).catch(() => {}), "secondary order-cancel"));
      item.appendChild(btns);
    }
    box.appendChild(item);
  }
}

function renderTradeList() {
  const box = document.getElementById("trade-list");
  if (!box) return;
  const mine = latestProposals.filter((p) => p.to === nation.id || p.from === nation.id);
  if (!mine.length) { box.innerHTML = '<p class="loading">取引提案はありません。</p>'; return; }
  box.innerHTML = "";
  for (const p of mine) {
    const item = document.createElement("div");
    item.className = "order-item";
    const main = document.createElement("div"); main.className = "order-main";
    const dir = p.from === nation.id ? ("→ " + nationName(p.to)) : ("← " + (p.fromName || p.from));
    const k = document.createElement("span"); k.className = "order-kind";
    k.textContent = dir + "（" + (p.status === "open" ? "提案中" : p.status) + "）";
    const d = document.createElement("span"); d.className = "order-desc";
    d.textContent = "渡す: " + transferText(p.give) + " / 欲しい: " + transferText(p.want);
    main.appendChild(k); main.appendChild(d);
    item.appendChild(main);
    if (p.status === "open" && p.to === nation.id) {
      item.appendChild(actionButton("承認", () => queue(item, "acceptTrade", { proposalId: p.key }), "order-cancel"));
    } else if (p.from === nation.id && p.status === "open") {
      item.appendChild(actionButton("取消", () => cancelTradeProposal(p.key).catch(() => {}), "secondary order-cancel"));
    }
    box.appendChild(item);
  }
}

function transferText(t) {
  if (!t) return "なし";
  const parts = [];
  if (t.money) parts.push("国庫" + t.money);
  if (t.resources) for (const k of Object.keys(t.resources)) if (t.resources[k]) {
    const lbl = (FLOW_RESOURCES.find((r) => r.key === k) || {}).label || k;
    parts.push(lbl + t.resources[k]);
  }
  return parts.join(" / ") || "なし";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// -----------------------------------------------------------------------------
// 共通フォームヘルパー
// -----------------------------------------------------------------------------
function row(...children) {
  const d = document.createElement("div");
  d.className = "form-row";
  for (const c of children) if (c) d.appendChild(c);
  return d;
}
function labeled(text, control) {
  const l = document.createElement("label");
  l.className = "field";
  const s = document.createElement("span");
  s.textContent = text;
  l.appendChild(s);
  l.appendChild(control);
  return l;
}
function numberInput(value, opts = {}) {
  const i = document.createElement("input");
  i.type = "number";
  i.inputMode = "decimal";
  i.step = opts.step || "any";
  if (opts.min != null) i.min = opts.min;
  if (opts.max != null) i.max = opts.max;
  i.value = value;
  return i;
}
function selectInput(options) {
  const s = document.createElement("select");
  for (const o of options) {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    s.appendChild(opt);
  }
  return s;
}
function actionButton(text, handler, cls) {
  const b = document.createElement("button");
  b.type = "button";
  if (cls) b.className = cls;
  b.textContent = text;
  b.addEventListener("click", handler);
  return b;
}
function noteP(text) {
  const p = document.createElement("p");
  p.className = "loading";
  p.textContent = text;
  return p;
}
async function queue(btn, kind, payload, okMsg) {
  btn.disabled = true;
  try {
    await addOrder(nationId, kind, payload);
    flash(okMsg || (orderLabel(kind) + " を予約しました。"), "ok");
  } catch (err) {
    flash("予約に失敗しました: " + err.message, "err");
  } finally {
    btn.disabled = false;
  }
}
let flashTimer = null;
function flash(msg, kind) {
  let el = document.getElementById("flash");
  if (!el) {
    el = document.createElement("div");
    el.id = "flash";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = "flash show " + (kind || "");
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { el.className = "flash " + (kind || ""); }, 2600);
}

function ownStateOptions() {
  return ownStatesList().map((s) => ({ value: s.name, label: s.name }));
}

// 地図からステートを選ぶコントロール。選択中の名前表示＋「地図で選ぶ」ボタン。
function statePickerControl() {
  const wrap = document.createElement("div");
  wrap.className = "state-picker";
  const nameEl = document.createElement("span");
  nameEl.className = "picked-state-name";
  const btn = actionButton("地図で選ぶ", () => switchTab("map"), "secondary");
  const refresh = () => {
    nameEl.textContent = pickedStateName || "（地図でステートをタップ）";
    nameEl.classList.toggle("empty", !pickedStateName);
  };
  refresh();
  wrap.appendChild(nameEl);
  wrap.appendChild(btn);
  return { wrap, refresh };
}

// -----------------------------------------------------------------------------
// 予約一覧
// -----------------------------------------------------------------------------
const ORDER_CONTAINERS = ["domestic-orders", "statepolicy-orders", "economy-orders", "research-orders"];
function renderAllPendingOrders() {
  for (const id of ORDER_CONTAINERS) renderPendingOrders(id);
}
function renderPendingOrders(containerId) {
  const box = document.getElementById(containerId);
  if (!box) return;
  if (!latestOrders.length) {
    box.innerHTML = '<p class="loading">予約はありません。操作はターン処理時にまとめて反映されます。</p>';
    return;
  }
  box.innerHTML = "";
  for (const o of latestOrders) {
    const item = document.createElement("div");
    item.className = "order-item";
    const main = document.createElement("div");
    main.className = "order-main";
    const lbl = document.createElement("span");
    lbl.className = "order-kind";
    lbl.textContent = orderLabel(o.kind);
    const desc = document.createElement("span");
    desc.className = "order-desc";
    desc.textContent = describeOrder(o);
    main.appendChild(lbl);
    main.appendChild(desc);
    const cancel = actionButton("取消", async () => {
      try { await cancelOrder(nationId, o.id); }
      catch (err) { flash("取消に失敗: " + err.message, "err"); }
    }, "secondary order-cancel");
    item.appendChild(main);
    item.appendChild(cancel);
    box.appendChild(item);
  }
}

// -----------------------------------------------------------------------------
// 内政タブ
// -----------------------------------------------------------------------------
function renderDomestic() {
  // 税率
  const taxBox = document.getElementById("tax-control");
  taxBox.innerHTML = "";
  const taxInput = numberInput(nation.stats.taxRate ?? 0, { step: "0.01", min: 0, max: 1 });
  const taxBtn = actionButton("税率変更を予約", () => {
    let r = parseFloat(taxInput.value);
    if (!isFinite(r)) r = 0;
    r = Math.max(0, Math.min(1, r));
    queue(taxBtn, "setTaxRate", { rate: r });
  });
  taxBox.appendChild(row(labeled("税率 (0.00〜1.00)", taxInput), taxBtn));
  taxBox.appendChild(noteP("税率が高いほど統治レベルが下がり経済力が伸びにくくなります。変更には政治力を消費します。"));

  // 経済体制（戦時経済への移行/解除）
  const isWar = nation.ideology === "戦時経済";
  const ideoLabel = document.createElement("div");
  ideoLabel.className = "field-value cost-preview";
  ideoLabel.textContent = "現在の経済体制: " + (nation.ideology || "未設定");
  const warBtn = actionButton(
    isWar ? "戦時経済を解除（無料）" : "戦時経済に移行（政治力250）",
    () => queue(warBtn, "switchWarEconomy", { on: !isWar }),
    isWar ? "secondary" : undefined
  );
  taxBox.appendChild(row(ideoLabel, warBtn));
  taxBox.appendChild(noteP(isWar
    ? "解除すると元の経済体制に戻ります（無料）。戦時経済は軍需工場が効率↑・民需工場が効率↓、徴兵コストが下がります。"
    : "政治力250を消費して戦時経済へ移行します。解除は無料で元の体制に戻ります。"));

  // 徴兵
  const conBox = document.getElementById("conscript-control");
  conBox.innerHTML = "";
  const conInput = numberInput(100, { step: "1", min: 1 });
  const conCost = document.createElement("div");
  conCost.className = "field-value cost-preview";
  const updateCon = () => {
    const n = Math.max(0, parseInt(conInput.value) || 0);
    conCost.textContent = `国庫 ${(n * CONFIG.conscriptCostPerUnit).toLocaleString()} / 人口 -${(n * CONFIG.conscriptPopPerUnit).toLocaleString()}`;
  };
  conInput.addEventListener("input", updateCon);
  updateCon();
  const conBtn = actionButton("徴兵を予約", () => {
    const amount = Math.max(1, parseInt(conInput.value) || 1);
    queue(conBtn, "conscript", { amount });
  });
  conBox.appendChild(row(labeled("徴兵数（予備兵）", conInput), conCost, conBtn));
  conBox.appendChild(noteP("国庫と人口を消費して予備兵を積み立てます。動員・戦闘は戦争システム側です。"));

  renderAnnex();
  renderPendingOrders("domestic-orders");
}

// 編入: 地図でタップした「未所属で自国に隣接し他国に隣接しない」ステートを政治力で編入
function annexInfo(stateName) {
  const s = statesData[stateName];
  if (!s) return { ok: false, reason: "ステートが見つかりません" };
  if (s.country) return { ok: false, reason: "既に所属があります" };
  const neighbors = adjacency[stateName] || [];
  let adjOwn = false, adjOther = false;
  for (const nb of neighbors) {
    const ns = statesData[nb];
    if (!ns || !ns.country) continue;
    if (ns.country === nation.id) adjOwn = true; else adjOther = true;
  }
  if (!adjOwn) return { ok: false, reason: "自国領に隣接していません" };
  if (adjOther) return { ok: false, reason: "他国に隣接しているため編入できません" };
  return { ok: true, reason: "" };
}

function renderAnnex() {
  const box = document.getElementById("annex-control");
  box.innerHTML = "";
  const nameEl = document.createElement("div");
  nameEl.className = "field-value cost-preview";
  const infoEl = document.createElement("div");
  infoEl.className = "field-value cost-preview";
  const pickBtn = actionButton("地図で選ぶ", () => switchTab("map"), "secondary");
  const annexBtn = actionButton("編入を予約", () => {
    if (!lastTappedStateName) { switchTab("map"); flash("地図で編入したいステートをタップしてください。", "err"); return; }
    const info = annexInfo(lastTappedStateName);
    if (!info.ok) { flash("編入不可: " + info.reason, "err"); return; }
    queue(annexBtn, "annexState", { state: lastTappedStateName });
  });
  const refresh = () => {
    const own = ownStatesList().length;
    const cost = annexCost(own);
    nameEl.textContent = "対象: " + (lastTappedStateName || "（地図でタップ）");
    if (!lastTappedStateName) { infoEl.textContent = "未選択"; infoEl.className = "field-value cost-preview"; return; }
    const info = annexInfo(lastTappedStateName);
    infoEl.textContent = info.ok ? ("編入可能 / 政治力 " + Math.round(cost)) : ("編入不可: " + info.reason);
    infoEl.className = "field-value cost-preview " + (info.ok ? "ok-text" : "err-text");
  };
  policyUpdaters.annex = refresh;
  refresh();
  box.appendChild(row(nameEl, pickBtn));
  box.appendChild(row(infoEl, annexBtn));
  box.appendChild(noteP("未所属で、自国領に隣接し、他国に隣接していないステートだけを政治力で編入できます。コストはステート数が多いほど指数的に増えます。"));
}

// -----------------------------------------------------------------------------
// 産業タブ
// -----------------------------------------------------------------------------
// -----------------------------------------------------------------------------
// ステート政策タブ（ステート選択 → 投資・建設・解体・産業集計を1ページで）
// -----------------------------------------------------------------------------
function renderStatePolicy() {
  renderStateCards();
  renderSpSelected();
  renderSpInvest();
  renderSpIndustry();
  renderSpSummary();
  renderPendingOrders("statepolicy-orders");
  // 地図タップ・カードタップどちらでも同じ更新関数で再描画
  policyUpdaters.statepolicy = () => {
    renderStateCards();
    renderSpSelected();
    renderSpInvest();
    renderSpIndustry();
    renderSpSummary();
  };
}

function renderStateCards() {
  const box = document.getElementById("state-cards");
  if (!box) return;
  box.innerHTML = "";
  const own = ownStatesList();
  if (!own.length) { box.appendChild(noteP("自国領がありません。")); return; }
  for (const s of own) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "state-card" + (s.name === pickedStateName ? " active" : "");
    card.addEventListener("click", () => pickState(s.name));
    const sw = document.createElement("span");
    sw.className = "state-card-color";
    sw.style.background = nation.color || "#5aa9ff";
    const head = document.createElement("div");
    head.className = "state-card-name";
    head.textContent = s.name;
    const stats = document.createElement("div");
    stats.className = "state-card-stats";
    stats.textContent =
      `経済 ${fmt(Number(s.economy) || 0)} / 開発 ${fmt(Number(s.development) || 0)} / インフラ ${fmt(Number(s.infrastructure) || 0)} / 人口 ${fmt(Number(s.population) || 0)}`;
    card.appendChild(sw);
    card.appendChild(head);
    card.appendChild(stats);
    box.appendChild(card);
  }
}

function renderSpSelected() {
  const box = document.getElementById("sp-selected");
  if (!box) return;
  box.innerHTML = "";
  const s = pickedStateName ? statesData[pickedStateName] : null;
  if (!s) { box.appendChild(noteP("カードをタップ、または地図タブで自国領をタップしてください。")); return; }
  const head = document.createElement("h3");
  head.className = "state-info-name";
  head.textContent = pickedStateName;
  box.appendChild(head);
  const grid = document.createElement("div");
  grid.className = "field-grid";
  const fields = [
    ["経済力", s.economy], ["開発度", s.development], ["インフラ", s.infrastructure],
    ["統治レベル", s.governance], ["人口", s.population], ["生活水準", s.livingStandard]
  ];
  for (const [lbl, v] of fields) grid.appendChild(roField(lbl, fmt(Number(v) || 0)));
  box.appendChild(grid);
  // 資源の埋蔵（有無のみ）
  const resHead = document.createElement("h4"); resHead.className = "subhead"; resHead.textContent = "資源の埋蔵（有無）";
  box.appendChild(resHead);
  const resGrid = document.createElement("div"); resGrid.className = "field-grid";
  const resList = [["fertility", "肥沃度"], ["metal", "金属"], ["oil", "石油"], ["coal", "石炭"], ["rareMineral", "重要鉱物"]];
  for (const [k, lbl] of resList) {
    const has = Number(s.resources && s.resources[k]) > 0;
    resGrid.appendChild(roField(lbl, has ? "あり" : "なし"));
  }
  box.appendChild(resGrid);
}

function renderSpInvest() {
  const box = document.getElementById("sp-invest");
  if (!box) return;
  box.innerHTML = "";
  if (!pickedStateName) { box.appendChild(noteP("ステート未選択")); return; }
  const typeSel = selectInput([
    { value: "investDevelopment", label: "開発度（国庫）" },
    { value: "investInfrastructure", label: "インフラ（国庫）" },
    { value: "investGovernance", label: "統治レベル（政治力）" }
  ]);
  const amtInput = numberInput(1, { step: "1", min: 1 });
  const costEl = document.createElement("div");
  costEl.className = "field-value cost-preview";
  const update = () => {
    const s = statesData[pickedStateName];
    const kindKey = typeSel.value.replace("invest", "").toLowerCase();
    const cur = s ? Number(s[kindKey]) || 0 : 0;
    const c = investCost(kindKey, cur) * (parseInt(amtInput.value) || 1);
    costEl.textContent = "概算コスト: " + c.toLocaleString() + (kindKey === "governance" ? " 政治力" : " 国庫");
  };
  typeSel.addEventListener("change", update);
  amtInput.addEventListener("input", update);
  update();
  const invBtn = actionButton("投資を予約", () => {
    const amount = Math.max(1, parseInt(amtInput.value) || 1);
    queue(invBtn, typeSel.value, { state: pickedStateName, amount });
  });
  box.appendChild(row(labeled("投資先", typeSel), labeled("段階数", amtInput)));
  box.appendChild(row(costEl, invBtn));
  box.appendChild(noteP("コストは現在のレベルが+1上がるごとに増えます。"));
}

function renderSpIndustry() {
  const box = document.getElementById("sp-industry");
  if (!box) return;
  box.innerHTML = "";
  if (!pickedStateName) { box.appendChild(noteP("ステート未選択")); return; }
  const indSel = selectInput(INDUSTRY_FIELDS.map((f) => ({ value: f.key, label: f.label })));
  const cntInput = numberInput(1, { step: "1", min: 1 });
  const costEl = document.createElement("div"); costEl.className = "field-value cost-preview";
  const checkEl = document.createElement("div"); checkEl.className = "field-value cost-preview";
  const update = () => {
    const count = Math.max(1, parseInt(cntInput.value) || 1);
    const c = buildCost(indSel.value, count);
    let txt = "国庫 " + c.treasury.toLocaleString();
    if (c.parts) txt += " / 部品 " + c.parts;
    if (c.machinery) txt += " / 機械 " + c.machinery;
    costEl.textContent = txt;
    const s = statesData[pickedStateName];
    const res = canBuildIndustry(indSel.value, s, nation, count);
    checkEl.textContent = res.ok ? "建設可能（ターン処理時に最終判定）" : ("建設不可: " + res.reason);
    checkEl.className = "field-value cost-preview " + (res.ok ? "ok-text" : "err-text");
  };
  indSel.addEventListener("change", update);
  cntInput.addEventListener("input", update);
  update();
  const buildBtn = actionButton("建設を予約", () => {
    const count = Math.max(1, parseInt(cntInput.value) || 1);
    queue(buildBtn, "buildIndustry", { state: pickedStateName, industry: indSel.value, count });
  });
  const demoBtn = actionButton("解体を予約", () => {
    const count = Math.max(1, parseInt(cntInput.value) || 1);
    queue(demoBtn, "demolishIndustry", { state: pickedStateName, industry: indSel.value, count });
  }, "secondary");
  box.appendChild(row(labeled("産業", indSel), labeled("数", cntInput)));
  box.appendChild(row(costEl));
  box.appendChild(row(checkEl));
  box.appendChild(row(buildBtn, demoBtn));
  box.appendChild(noteP("建設可否は鉱山・農場系の埋蔵量と、民間産業のイデオロギー制限のみ。人口・開発度・インフラは稼働効率に影響します。"));
}

function renderSpSummary() {
  const box = document.getElementById("sp-summary");
  if (!box) return;
  box.innerHTML = "";
  if (!pickedStateName) { box.appendChild(noteP("ステート未選択")); return; }
  const s = statesData[pickedStateName] || {};
  const inds = s.industries || {};
  const grid = document.createElement("div");
  grid.className = "field-grid";
  for (const f of INDUSTRY_FIELDS) grid.appendChild(roField(f.label, fmt(Number(inds[f.key]) || 0)));
  box.appendChild(grid);
}

// -----------------------------------------------------------------------------
// 経済 / 貿易タブ
// -----------------------------------------------------------------------------
function renderEconomy() {
  const own = ownStatesList();
  const turn = computeTurn(nation, own, world);

  // 景気
  const trendBox = document.getElementById("economy-trend");
  trendBox.innerHTML = "";
  const tg = document.createElement("div");
  tg.className = "field-grid";
  tg.appendChild(roField("国家別景気", fmt(nation.stats.economyTrend)));
  tg.appendChild(roField("世界景気", fmt(world ? world.value : 10) + (world && world.trend ? `（${world.trend}）` : "")));
  tg.appendChild(roField("経済力産出（試算）", fmt(turn.economyOutput)));
  tg.appendChild(roField("経済減衰（不景気）", fmt(turn.economyDecay)));
  tg.appendChild(roField("純経済（試算）", fmt(turn.netEconomy)));
  trendBox.appendChild(tg);
  if (turn.economyDecay > 0) {
    trendBox.appendChild(noteP("景気が悪く民間産業が経済減衰を出しています。イデオロギーにより減衰量は変わります（計画経済は出しません）。"));
  }
  if (history.length > 1) {
    const wSeries = [{ label: "世界景気", color: "#7be0c7", points: history.map((h) => Number(h.worldValue) || 0) }];
    trendBox.appendChild(lineChart(wSeries, { }));
    trendBox.appendChild(chartLegend([{ label: "世界景気の推移", color: "#7be0c7" }]));
  } else {
    trendBox.appendChild(noteP("世界景気の推移グラフはターンが進むと表示されます。"));
  }

  // 資源収支
  const balBox = document.getElementById("economy-balance");
  balBox.innerHTML = "";
  // 在庫
  const stockHead = document.createElement("h4");
  stockHead.className = "subhead";
  stockHead.textContent = "資源在庫";
  balBox.appendChild(stockHead);
  const stockGrid = document.createElement("div");
  stockGrid.className = "field-grid";
  const stock = nation.stockpile || {};
  for (const r of FLOW_RESOURCES) stockGrid.appendChild(roField(r.label, fmt(Number(stock[r.key]) || 0)));
  balBox.appendChild(stockGrid);

  const flowHead = document.createElement("h4");
  flowHead.className = "subhead";
  flowHead.textContent = "毎ターンの収支（試算）";
  balBox.appendChild(flowHead);
  const table = document.createElement("table");
  table.className = "data-table";
  table.innerHTML = "<thead><tr><th>資源</th><th>産出</th><th>消費</th><th>余剰</th></tr></thead>";
  const tb = document.createElement("tbody");
  for (const r of FLOW_RESOURCES) {
    const tr = document.createElement("tr");
    const sur = turn.surplus[r.key] || 0;
    tr.innerHTML =
      `<td>${r.label}</td><td>${fmt(turn.production[r.key] || 0)}</td>` +
      `<td>${fmt(turn.consumption[r.key] || 0)}</td>` +
      `<td class="${sur < 0 ? "neg" : "pos"}">${fmt(sur)}</td>`;
    tb.appendChild(tr);
  }
  table.appendChild(tb);
  balBox.appendChild(table);
  if (turn.deficits.length) {
    balBox.appendChild(noteP("不足している資源があります。消費が満たされないと統治レベルが減少します。"));
  }

  // 市場
  renderMarket();
  renderPendingOrders("economy-orders");
}

function renderMarket() {
  const box = document.getElementById("market-control");
  box.innerHTML = "";

  // 価格統計
  const priceGrid = document.createElement("div");
  priceGrid.className = "field-grid";
  for (const r of MARKET_RESOURCES) {
    priceGrid.appendChild(roField(r.label + " 価格", fmt(market.prices[r.key] || 0)));
  }
  box.appendChild(priceGrid);

  // オファー作成
  const sideSel = selectInput([{ value: "sell", label: "売り" }, { value: "buy", label: "買い" }]);
  const resSel = selectInput(MARKET_RESOURCES.map((r) => ({ value: r.key, label: r.label })));
  const amtInput = numberInput(10, { step: "1", min: 1 });
  const priceInput = numberInput(1, { step: "any", min: 0 });
  const offerBtn = actionButton("オファーを予約", () => {
    const amount = Math.max(1, parseInt(amtInput.value) || 1);
    const price = Math.max(0, parseFloat(priceInput.value) || 0);
    queue(offerBtn, "tradeOffer", { side: sideSel.value, resource: resSel.value, amount, price });
  });
  const offHead = document.createElement("h4");
  offHead.className = "subhead";
  offHead.textContent = "オファーを出す（相対取引）";
  box.appendChild(offHead);
  box.appendChild(row(labeled("種別", sideSel), labeled("資源", resSel), labeled("数量", amtInput), labeled("単価", priceInput)));
  box.appendChild(row(offerBtn));

  // 既存オファー一覧
  const listHead = document.createElement("h4");
  listHead.className = "subhead";
  listHead.textContent = "取引板";
  box.appendChild(listHead);
  const offers = Array.isArray(market.offers) ? market.offers : [];
  if (!offers.length) {
    box.appendChild(noteP("現在オファーはありません。"));
  } else {
    for (const off of offers.slice(0, 40)) {
      const by = nationsById[off.by];
      const item = document.createElement("div");
      item.className = "order-item";
      const main = document.createElement("div");
      main.className = "order-main";
      const k = document.createElement("span");
      k.className = "order-kind";
      k.textContent = off.side === "buy" ? "買い" : "売り";
      const d = document.createElement("span");
      d.className = "order-desc";
      const resLabel = (MARKET_RESOURCES.find((r) => r.key === off.resource) || {}).label || off.resource;
      d.textContent = `${resLabel} ${fmt(off.amount)} @ ${fmt(off.price)}　by ${by ? by.name : (off.by || "?")}`;
      main.appendChild(k); main.appendChild(d);
      item.appendChild(main);
      if (off.by === nation.id) {
        item.appendChild(actionButton("取消予約", () => {
          queue(item, "tradeCancel", { offerId: off.id });
        }, "secondary order-cancel"));
      } else {
        item.appendChild(actionButton("承認予約", () => {
          queue(item, "tradeAccept", { offerId: off.id });
        }, "order-cancel"));
      }
      box.appendChild(item);
    }
  }
}

// -----------------------------------------------------------------------------
// 研究タブ
// -----------------------------------------------------------------------------
function renderResearch() {
  const ctrl = document.getElementById("research-control");
  ctrl.innerHTML = "";
  const own = ownStatesList();
  const universities = own.reduce((s, st) => s + (Number(st.industries && st.industries.university) || 0), 0);
  const turn = computeTurn(nation, own, world);

  const grid = document.createElement("div");
  grid.className = "field-grid";
  grid.appendChild(roField("産業技術力", fmt(nation.research.tracks.industrial)));
  grid.appendChild(roField("軍事技術力", fmt(nation.research.tracks.military)));
  grid.appendChild(roField("大学設置数", fmt(universities)));
  grid.appendChild(roField("研究速度/ターン", fmt(turn.researchOutput)));
  ctrl.appendChild(grid);

  // 配分
  const indInput = numberInput(Math.round((nation.research.allocation.industrial || 0) * 100), { step: "1", min: 0, max: 100 });
  const allocNote = document.createElement("div");
  allocNote.className = "field-value cost-preview";
  const updateAlloc = () => {
    let ind = Math.max(0, Math.min(100, parseInt(indInput.value) || 0));
    allocNote.textContent = `産業 ${ind}% / 軍事 ${100 - ind}%`;
  };
  indInput.addEventListener("input", updateAlloc);
  updateAlloc();
  const allocBtn = actionButton("研究配分を予約", () => {
    let ind = Math.max(0, Math.min(100, parseInt(indInput.value) || 0)) / 100;
    queue(allocBtn, "setResearchAllocation", { industrial: ind, military: 1 - ind });
  });
  const aHead = document.createElement("h4");
  aHead.className = "subhead";
  aHead.textContent = "研究配分（産業 / 軍事 = 合計100%）";
  ctrl.appendChild(aHead);
  ctrl.appendChild(row(labeled("産業への配分(%)", indInput), allocNote, allocBtn));
  ctrl.appendChild(noteP("研究は数値の積み上げです。大学は統治レベルと開発度に強く影響され、莫大な国庫維持費がかかります。"));

  renderResearchReport(own);
  renderPendingOrders("research-orders");
}

function renderResearchReport(own) {
  const box = document.getElementById("research-report");
  box.innerHTML = "";
  const derived = computeDerivedStats(nation.id, statesData);
  const turn = computeTurn(nation, own, world);

  // 1) 世界各国の合計経済 比較（棒）
  const econHead = document.createElement("h4");
  econHead.className = "subhead";
  econHead.textContent = "各国の合計経済力";
  box.appendChild(econHead);
  const econData = Object.values(nationsById)
    .map((n) => ({ label: n.name, value: n.totalEconomy, color: n.id === nation.id ? "#5aa9ff" : "#3a4866" }))
    .sort((a, b) => b.value - a.value);
  if (econData.length) box.appendChild(barChart(econData, { max: 10 }));
  else box.appendChild(noteP("データがありません。"));

  // 2) 自国の国庫の収入/消費（円）
  const flowHead = document.createElement("h4");
  flowHead.className = "subhead";
  flowHead.textContent = "国庫の内訳（試算）";
  box.appendChild(flowHead);
  const income = turn.economyOutput * (Number(nation.stats.taxRate) || 0);
  const upkeep = turn.universityUpkeep;
  box.appendChild(pieChart([
    { label: "税収", value: Math.max(0, income) },
    { label: "大学維持", value: Math.max(0, upkeep) }
  ]));

  // 3) 資源収支（棒・余剰）
  const resHead = document.createElement("h4");
  resHead.className = "subhead";
  resHead.textContent = "資源の収支（余剰）";
  box.appendChild(resHead);
  const resData = FLOW_RESOURCES.map((r) => ({
    label: r.label, value: turn.surplus[r.key] || 0,
    color: (turn.surplus[r.key] || 0) < 0 ? "#f87171" : "#7be0c7"
  }));
  box.appendChild(barChart(resData, { max: 10 }));

  // 4) 経済力の推移（折れ線・履歴）
  if (history.length > 1) {
    const trendHead = document.createElement("h4");
    trendHead.className = "subhead";
    trendHead.textContent = "経済力の推移";
    box.appendChild(trendHead);
    const series = [{
      label: nationLabel(nation), color: "#5aa9ff",
      points: history.map((h) => {
        const rec = h.nations && h.nations[nation.id];
        return rec ? (Number(rec.totalEconomy) || 0) : 0;
      })
    }];
    box.appendChild(lineChart(series, { zeroBase: true }));
  }
}

init();
