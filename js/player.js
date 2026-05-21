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

import { db, ref, get } from "./firebase-config.js";
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
  buildCost, canBuildIndustry, civilianIdeology
} from "./economy.js";
import { barChart, pieChart, lineChart, chartLegend } from "./charts.js";

const PICKED_STROKE = "#ffd166";
const PICKED_STROKE_W = "2.5";

const SVG_URL = "MapChart_Map.svg";
const COLOR_NO_COUNTRY = "#1d2738";
const HEAT_LOW = [29, 39, 56];     // #1d2738
const HEAT_HIGH = [90, 169, 255];  // #5aa9ff
const PRESENCE_YES = "#7be0c7";
const FADE_OTHER = "#10151f";

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
const policyUpdaters = {};  // { domestic, industry } 選択ステート反映の更新関数

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
  renderIndustry();
  renderEconomy();
  renderResearch();
  await loadMaps();
  setupTabs();
  setupSettings();

  // 予約の変化を購読して各タブの予約一覧を更新
  subscribeOrders(nationId, (orders) => {
    latestOrders = orders;
    renderAllPendingOrders();
  });
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
  const [nationSnap, statesSnap, nationsSnap, worldSnap, marketSnap, historySnap] = await Promise.all([
    get(ref(db, `aster_stella/nations/${nationId}`)),
    get(ref(db, "aster_stella/states")),
    get(ref(db, "aster_stella/nations")),
    get(ref(db, "aster_stella/world")),
    get(ref(db, "aster_stella/market")),
    get(ref(db, "aster_stella/history"))
  ]);
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
      id, name: n.name || id, color: n.color || COLOR_NO_COUNTRY,
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
  sw.style.background = color || COLOR_NO_COUNTRY;
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
    p.setAttribute("fill", own ? (nation.color || "#5aa9ff") : FADE_OTHER);
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
      p.setAttribute("fill", FADE_OTHER);
      continue;
    }
    let fill = COLOR_NO_COUNTRY;
    if (!s) {
      fill = COLOR_NO_COUNTRY;
    } else if (mode.kind === "category") {
      const n = s.country ? nationsById[s.country] : null;
      fill = n ? n.color : COLOR_NO_COUNTRY;
    } else if (mode.kind === "number") {
      const v = Number(getByPath(s, mode.path)) || 0;
      fill = heat((v - min) / (max - min));
    } else if (mode.kind === "presence") {
      const v = Number(getByPath(s, mode.path)) || 0;
      fill = v > 0 ? PRESENCE_YES : COLOR_NO_COUNTRY;
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
  const c = HEAT_LOW.map((lo, i) => Math.round(lo + (HEAT_HIGH[i] - lo) * t));
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
  if (policyUpdaters.domestic) policyUpdaters.domestic();
  if (policyUpdaters.industry) policyUpdaters.industry();
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
    if (statesData[p.id] && statesData[p.id].country === nation.id) pickState(p.id);
  });

  displayModeSelect.addEventListener("change", () => {
    selectedMode = displayModeSelect.value;
    applyMapColors();
  });
  highlightChk.addEventListener("change", () => {
    highlightOwn = highlightChk.checked;
    applyMapColors();
  });

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
const ORDER_CONTAINERS = ["domestic-orders", "industry-orders", "economy-orders", "research-orders"];
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

  // 投資（対象ステートは地図タップで選ぶ）
  const invBox = document.getElementById("invest-control");
  invBox.innerHTML = "";
  const states = ownStatesList();
  if (!states.length) {
    invBox.appendChild(noteP("自国領がありません。"));
  } else {
    const picker = statePickerControl();
    const typeSel = selectInput([
      { value: "investDevelopment", label: "開発度（国庫）" },
      { value: "investInfrastructure", label: "インフラ（国庫）" },
      { value: "investGovernance", label: "統治レベル（政治力）" }
    ]);
    const amtInput = numberInput(1, { step: "1", min: 1 });
    const costEl = document.createElement("div");
    costEl.className = "field-value cost-preview";
    const updateCost = () => {
      const s = pickedStateName ? statesData[pickedStateName] : null;
      const kindKey = typeSel.value.replace("invest", "").toLowerCase();
      const cur = s ? Number(s[kindKey]) || 0 : 0;
      if (!s) { costEl.textContent = "ステート未選択"; return; }
      const c = investCost(kindKey, cur) * (parseInt(amtInput.value) || 1);
      costEl.textContent = "概算コスト: " + c.toLocaleString() + (kindKey === "governance" ? " 政治力" : " 国庫");
    };
    typeSel.addEventListener("change", updateCost);
    amtInput.addEventListener("input", updateCost);
    updateCost();
    policyUpdaters.domestic = () => { picker.refresh(); updateCost(); };
    const invBtn = actionButton("投資を予約", () => {
      if (!pickedStateName) { switchTab("map"); flash("地図でステートをタップして選択してください。", "err"); return; }
      const amount = Math.max(1, parseInt(amtInput.value) || 1);
      queue(invBtn, typeSel.value, { state: pickedStateName, amount });
    });
    invBox.appendChild(labeled("対象ステート", picker.wrap));
    invBox.appendChild(row(labeled("投資先", typeSel), labeled("段階数", amtInput)));
    invBox.appendChild(row(costEl, invBtn));
    invBox.appendChild(noteP("対象ステートは地図タブで自国領をタップして選びます。投資コストは現在のレベルが高いほど上がります。"));
  }

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

  renderPendingOrders("domestic-orders");
}

// -----------------------------------------------------------------------------
// 産業タブ
// -----------------------------------------------------------------------------
function renderIndustry() {
  const ctrl = document.getElementById("industry-control");
  ctrl.innerHTML = "";
  const states = ownStatesList();
  if (!states.length) {
    ctrl.appendChild(noteP("自国領がありません。"));
  } else {
    const picker = statePickerControl();
    const indSel = selectInput(INDUSTRY_FIELDS.map((f) => ({ value: f.key, label: f.label })));
    const cntInput = numberInput(1, { step: "1", min: 1 });
    const costEl = document.createElement("div");
    costEl.className = "field-value cost-preview";
    const checkEl = document.createElement("div");
    checkEl.className = "field-value cost-preview";
    const buildBtn = actionButton("建設を予約", () => {
      if (!pickedStateName) { switchTab("map"); flash("地図でステートをタップして選択してください。", "err"); return; }
      const count = Math.max(1, parseInt(cntInput.value) || 1);
      queue(buildBtn, "buildIndustry", { state: pickedStateName, industry: indSel.value, count });
    });
    const demoBtn = actionButton("解体を予約", () => {
      if (!pickedStateName) { switchTab("map"); flash("地図でステートをタップして選択してください。", "err"); return; }
      const count = Math.max(1, parseInt(cntInput.value) || 1);
      queue(demoBtn, "demolishIndustry", { state: pickedStateName, industry: indSel.value, count });
    }, "secondary");
    const updateBuild = () => {
      const count = Math.max(1, parseInt(cntInput.value) || 1);
      const c = buildCost(indSel.value, count);
      let txt = "国庫 " + c.treasury.toLocaleString();
      if (c.parts) txt += " / 部品 " + c.parts;
      if (c.machinery) txt += " / 機械 " + c.machinery;
      costEl.textContent = txt;
      const s = pickedStateName ? statesData[pickedStateName] : null;
      if (!s) { checkEl.textContent = "ステート未選択"; checkEl.className = "field-value cost-preview"; buildBtn.disabled = false; return; }
      const res = canBuildIndustry(indSel.value, s, nation, count);
      checkEl.textContent = res.ok ? "建設可能（ターン処理時に最終判定）" : ("建設不可: " + res.reason);
      checkEl.className = "field-value cost-preview " + (res.ok ? "ok-text" : "err-text");
    };
    indSel.addEventListener("change", updateBuild);
    cntInput.addEventListener("input", updateBuild);
    updateBuild();
    policyUpdaters.industry = () => { picker.refresh(); updateBuild(); };
    ctrl.appendChild(labeled("対象ステート", picker.wrap));
    ctrl.appendChild(row(labeled("産業", indSel), labeled("数", cntInput)));
    ctrl.appendChild(row(costEl));
    ctrl.appendChild(row(checkEl));
    ctrl.appendChild(row(buildBtn, demoBtn));
    ctrl.appendChild(noteP("対象ステートは地図タブで自国領をタップして選びます。建設可否は鉱山・農場系の埋蔵量と、民間産業のイデオロギー制限のみ。人口・開発度・インフラは建設の可否ではなく稼働効率に影響します。民間産業は計画経済/企業統治経済/戦時経済のみ建設でき、それ以外では自然拡大します。解体は国庫の戻りなし。"));
  }

  // 集計表
  const sum = document.getElementById("industry-summary");
  sum.innerHTML = "";
  const totals = {};
  for (const f of INDUSTRY_FIELDS) totals[f.key] = 0;
  for (const s of states) {
    for (const f of INDUSTRY_FIELDS) totals[f.key] += Number(s.industries && s.industries[f.key]) || 0;
  }
  const grid = document.createElement("div");
  grid.className = "field-grid";
  for (const f of INDUSTRY_FIELDS) grid.appendChild(roField(f.label, fmt(totals[f.key])));
  sum.appendChild(grid);

  renderPendingOrders("industry-orders");
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
