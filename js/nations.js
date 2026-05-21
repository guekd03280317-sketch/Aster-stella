// Aster Stella - 国家管理ページ
//
// 役割:
//   - 国家の新規作成（建国）・編集・削除
//   - 地図のステートを国家に編入 / 編入解除 / 首都指定
//   - 国家ごとの色で地図を塗る
//   - Firebase Realtime Database への保存/読込
//
// 保存先:
//   aster_stella/nations            : { [nationId]: nation }
//   aster_stella/states             : { [stateName]: state }（既存。country フィールドに nationId を入れる）

import { db, ref, set, get } from "./firebase-config.js";
import { requireAdminAuth } from "./admin-auth.js";
import {
  NATION_BASIC_FIELDS,
  NATION_CREDENTIAL_FIELDS,
  NATION_STAT_FIELDS,
  NATION_DERIVED_FIELDS,
  NATION_COMPUTED_FIELDS,
  defaultNation,
  normalizeNation,
  nextDefaultColor,
  nationLabel,
  computeDerivedStats,
  computeNationComputed
} from "./nation-schema.js";
import { INDUSTRY_FIELDS, defaultState, normalizeState } from "./state-schema.js";
import { attachPanZoom } from "./map-pan-zoom.js";

const SVG_URL = "MapChart_Map.svg";
const DB_PATH_NATIONS = "aster_stella/nations";
const DB_PATH_STATES = "aster_stella/states";

const COLOR_NO_COUNTRY = "#1d2738";
const COLOR_CAPITAL_STROKE = "#f5f7fa";
const STROKE_WIDTH_CAPITAL = "2.5";

const mapContainer = document.getElementById("map-container");
const mapStatus = document.getElementById("map-status");
const fbStatus = document.getElementById("fb-status");
const clickModeSelect = document.getElementById("click-mode");
const nationListEl = document.getElementById("nation-list");
const formContainer = document.getElementById("nation-form");
const selectedNameEl = document.getElementById("selected-nation-name");

let mapSvg = null;
const elById = new Map();
const originalFills = new Map();
const originalStrokes = new Map();
let panZoom = null;

let nations = {};        // { nationId: nation }
let statesData = {};     // { stateName: state }  ※ country フィールドに nationId
let selectedNationId = null;

// -----------------------------------------------------------------------------
// 状態表示
// -----------------------------------------------------------------------------
function setStatus(el, msg, kind) {
  el.textContent = msg;
  el.className = "status" + (kind ? " " + kind : "");
}

// -----------------------------------------------------------------------------
// 初期化
// -----------------------------------------------------------------------------
async function init() {
  await loadMap();
  ensureStateEntries();
  renderNationList();
  renderForm();
  applyMapColors();
  setStatus(
    mapStatus,
    elById.size + " ステートを読み込みました。先にFirebaseから既存データを読み込むことを推奨します。",
    ""
  );
}

async function loadMap() {
  try {
    const res = await fetch(SVG_URL);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const text = await res.text();
    const doc = new DOMParser().parseFromString(text, "image/svg+xml");
    if (doc.querySelector("parsererror")) throw new Error("SVGの解析に失敗しました");
    const svg = document.importNode(doc.documentElement, true);

    svg.removeAttribute("width");
    svg.removeAttribute("height");
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    mapContainer.innerHTML = "";
    mapContainer.appendChild(svg);
    mapSvg = svg;
    panZoom = attachPanZoom(svg);

    elById.clear();
    originalFills.clear();
    originalStrokes.clear();
    svg.querySelectorAll("#map > path").forEach((p) => {
      if (!p.id || p.id.startsWith("pattern")) return;
      elById.set(p.id, p);
      originalFills.set(p, p.getAttribute("fill"));
      originalStrokes.set(p, {
        stroke: p.getAttribute("stroke"),
        width: p.getAttribute("stroke-width")
      });
    });
  } catch (err) {
    mapContainer.innerHTML =
      '<p class="loading">地図を読み込めませんでした。<br>ローカルサーバー経由で開いてください。<br>詳細: ' +
      err.message + "</p>";
    setStatus(mapStatus, "地図の読み込みに失敗しました。", "err");
  }
}

function ensureStateEntries() {
  for (const name of elById.keys()) {
    if (!statesData[name]) statesData[name] = defaultState();
  }
}

// -----------------------------------------------------------------------------
// 国家リスト描画
// -----------------------------------------------------------------------------
function renderNationList() {
  const ids = Object.keys(nations);
  if (ids.length === 0) {
    nationListEl.innerHTML = '<p class="loading">まだ国家がありません。「新規建国」で作成してください。</p>';
    return;
  }
  nationListEl.innerHTML = "";

  for (const id of ids) {
    const n = nations[id];
    const item = document.createElement("button");
    item.type = "button";
    item.className = "nation-item" + (id === selectedNationId ? " active" : "");
    item.dataset.id = id;

    const swatch = document.createElement("span");
    swatch.className = "nation-swatch";
    swatch.style.background = n.color || "#888";

    const labelWrap = document.createElement("span");
    labelWrap.className = "nation-label";
    const main = document.createElement("strong");
    main.textContent = n.name || "（無名）";
    const sub = document.createElement("small");
    const owned = countOwnedStates(id);
    sub.textContent = owned + " ステート";
    labelWrap.appendChild(main);
    labelWrap.appendChild(sub);

    item.appendChild(swatch);
    item.appendChild(labelWrap);
    item.addEventListener("click", () => selectNation(id));
    nationListEl.appendChild(item);
  }
}

function countOwnedStates(nationId) {
  let c = 0;
  for (const name of Object.keys(statesData)) {
    if (statesData[name].country === nationId) c++;
  }
  return c;
}

// -----------------------------------------------------------------------------
// 編集フォーム
// -----------------------------------------------------------------------------
function renderForm() {
  if (!selectedNationId || !nations[selectedNationId]) {
    formContainer.innerHTML =
      '<p class="loading">左の国家一覧から選択するか、「新規建国」で作成してください。</p>';
    selectedNameEl.textContent = "（未選択）";
    return;
  }
  const n = nations[selectedNationId];
  selectedNameEl.textContent = nationLabel(n);
  formContainer.innerHTML = "";

  // 基本情報
  const basicSec = makeSection("基本情報");
  const basicGrid = document.createElement("div");
  basicGrid.className = "field-grid";
  for (const f of NATION_BASIC_FIELDS) {
    basicGrid.appendChild(makeField(f, n));
  }
  basicSec.appendChild(basicGrid);
  formContainer.appendChild(basicSec);

  // 認証情報（playerサイドのログイン用パスワード）
  const credSec = makeSection("認証情報（playerサイドのログイン用）");
  const credGrid = document.createElement("div");
  credGrid.className = "field-grid";
  for (const f of NATION_CREDENTIAL_FIELDS) {
    credGrid.appendChild(makeField(f, n));
  }
  credSec.appendChild(credGrid);
  const credNote = document.createElement("p");
  credNote.className = "loading";
  credNote.textContent =
    "未設定の国家にはplayerサイドからログインできません。設定後は「Firebaseに保存」を忘れずに。";
  credSec.appendChild(credNote);
  formContainer.appendChild(credSec);

  // ステート由来のステータス（領土から自動集計）
  const derived = computeDerivedStats(n.id, statesData);
  const derivedSec = makeSection("ステート由来のステータス（領土から自動集計）");
  const derivedGrid = document.createElement("div");
  derivedGrid.className = "field-grid";
  for (const f of NATION_DERIVED_FIELDS) {
    derivedGrid.appendChild(makeReadonlyField(f.label, formatNumber(derived[f.key])));
  }
  derivedSec.appendChild(derivedGrid);

  // 各種産業の設置数
  const indHead = document.createElement("h4");
  indHead.className = "subhead";
  indHead.textContent = "各種産業の設置数";
  derivedSec.appendChild(indHead);
  const indGrid = document.createElement("div");
  indGrid.className = "field-grid";
  for (const f of INDUSTRY_FIELDS) {
    indGrid.appendChild(makeReadonlyField(f.label, formatNumber(derived.industries[f.key])));
  }
  derivedSec.appendChild(indGrid);
  formContainer.appendChild(derivedSec);

  // 国家ステータス（操作可能）
  const statSec = makeSection("国家ステータス");
  const statGrid = document.createElement("div");
  statGrid.className = "field-grid";
  for (const f of NATION_STAT_FIELDS) {
    statGrid.appendChild(makeField({ ...f, type: "number" }, n.stats, {
      onChange: (key) => {
        if (key === "reserveTroops" || key === "mobilizedTroops") updateComputedSection();
      }
    }));
  }
  statSec.appendChild(statGrid);

  // 計算で求めるステータス
  const compHead = document.createElement("h4");
  compHead.className = "subhead";
  compHead.textContent = "計算で求めるステータス";
  statSec.appendChild(compHead);
  const compGrid = document.createElement("div");
  compGrid.className = "field-grid";
  compGrid.id = "computed-stats-grid";
  renderComputedGrid(compGrid, n, derived);
  statSec.appendChild(compGrid);
  formContainer.appendChild(statSec);

  // 領土サマリ
  const territorySec = makeSection("領土");
  const ownedNames = Object.keys(statesData)
    .filter(name => statesData[name].country === n.id)
    .sort();
  const summary = document.createElement("p");
  summary.className = "territory-summary";
  if (ownedNames.length === 0) {
    summary.textContent = "（未編入）地図のクリック動作を「建国モード」にしてステートをタップしてください。";
  } else {
    summary.textContent = ownedNames.length + " ステート: " + ownedNames.slice(0, 30).join(", ") +
      (ownedNames.length > 30 ? " ... ほか" + (ownedNames.length - 30) : "");
  }
  territorySec.appendChild(summary);
  formContainer.appendChild(territorySec);
}

function renderComputedGrid(grid, nation, derived) {
  grid.innerHTML = "";
  const computed = computeNationComputed(nation, derived);
  for (const f of NATION_COMPUTED_FIELDS) {
    grid.appendChild(makeReadonlyField(f.label, formatNumber(computed[f.key])));
  }
}

function updateComputedSection() {
  const grid = document.getElementById("computed-stats-grid");
  if (!grid) return;
  const n = nations[selectedNationId];
  if (!n) return;
  const derived = computeDerivedStats(n.id, statesData);
  renderComputedGrid(grid, n, derived);
}

function makeSection(title) {
  const sec = document.createElement("section");
  sec.className = "form-section";
  const h = document.createElement("h3");
  h.textContent = title;
  sec.appendChild(h);
  return sec;
}

function makeField(f, target, opts = {}) {
  const label = document.createElement("label");
  label.className = "field";
  const span = document.createElement("span");
  span.textContent = f.label;
  label.appendChild(span);

  const type = f.type || "number";
  let input;
  let toggleBtn = null;

  if (type === "select") {
    input = document.createElement("select");
    const cur = target[f.key] || "";
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "（未選択）";
    input.appendChild(empty);
    const options = [...(f.options || [])];
    // 保存済みの値が定義済み選択肢に無い場合はその他として残す（データ消失防止）
    if (cur && !options.includes(cur)) {
      const opt = document.createElement("option");
      opt.value = cur;
      opt.textContent = cur + "（その他）";
      input.appendChild(opt);
    }
    for (const o of options) {
      const opt = document.createElement("option");
      opt.value = o;
      opt.textContent = o;
      input.appendChild(opt);
    }
    input.value = cur;
  } else {
    input = document.createElement("input");
    if (type === "color") input.type = "color";
    else if (type === "number") input.type = "number";
    else if (type === "password") {
      input.type = "password";
      input.autocomplete = "new-password";
    } else input.type = "text";
    const value = target[f.key];
    input.value = (value !== undefined && value !== null && value !== "")
      ? value
      : (type === "number" ? 0 : (type === "color" ? "#888888" : ""));
    if (type === "number") {
      input.step = "any";
      input.inputMode = "decimal";
    }
    if (type === "password") {
      input.placeholder = "（未設定）";
      toggleBtn = document.createElement("button");
      toggleBtn.type = "button";
      toggleBtn.className = "field-toggle";
      toggleBtn.textContent = "表示";
      toggleBtn.addEventListener("click", () => {
        if (input.type === "password") {
          input.type = "text";
          toggleBtn.textContent = "隠す";
        } else {
          input.type = "password";
          toggleBtn.textContent = "表示";
        }
      });
    }
  }

  const handler = () => {
    if (type === "number") {
      const v = parseFloat(input.value || "0");
      target[f.key] = isFinite(v) ? v : 0;
    } else {
      target[f.key] = input.value;
    }
    if (f.key === "name" || f.key === "color") {
      renderNationList();
      applyMapColors();
      if (f.key === "name") {
        selectedNameEl.textContent = nationLabel(nations[selectedNationId]);
      }
    }
    if (opts.onChange) opts.onChange(f.key);
  };
  input.addEventListener("input", handler);
  if (type === "select") input.addEventListener("change", handler);

  if (toggleBtn) {
    const row = document.createElement("div");
    row.className = "field-row";
    row.appendChild(input);
    row.appendChild(toggleBtn);
    label.appendChild(row);
  } else {
    label.appendChild(input);
  }
  return label;
}

function makeReadonlyField(labelText, valueText) {
  const wrap = document.createElement("div");
  wrap.className = "field readonly";
  const span = document.createElement("span");
  span.textContent = labelText;
  wrap.appendChild(span);
  const val = document.createElement("div");
  val.className = "field-value";
  val.textContent = valueText;
  wrap.appendChild(val);
  return wrap;
}

function formatNumber(v) {
  if (typeof v !== "number" || !isFinite(v)) return "0";
  if (Number.isInteger(v)) return v.toLocaleString();
  return v.toFixed(2);
}

function selectNation(id) {
  if (!nations[id]) return;
  selectedNationId = id;
  renderNationList();
  renderForm();
  applyMapColors();
}

// -----------------------------------------------------------------------------
// 地図の色
// -----------------------------------------------------------------------------
function applyMapColors() {
  for (const [name, p] of elById) {
    const cid = statesData[name] && statesData[name].country;
    const n = cid ? nations[cid] : null;
    p.setAttribute("fill", n ? (n.color || COLOR_NO_COUNTRY) : COLOR_NO_COUNTRY);
  }
  refreshOutlines();
}

function refreshOutlines() {
  originalStrokes.forEach((orig, p) => {
    if (orig.stroke === null) p.removeAttribute("stroke"); else p.setAttribute("stroke", orig.stroke);
    if (orig.width === null) p.removeAttribute("stroke-width"); else p.setAttribute("stroke-width", orig.width);
  });
  for (const id of Object.keys(nations)) {
    const cap = nations[id].capital;
    if (cap && elById.has(cap)) {
      const el = elById.get(cap);
      el.setAttribute("stroke", COLOR_CAPITAL_STROKE);
      el.setAttribute("stroke-width", STROKE_WIDTH_CAPITAL);
      el.parentNode.appendChild(el);
    }
  }
}

// -----------------------------------------------------------------------------
// 建国操作
// -----------------------------------------------------------------------------
function createNation() {
  const existingColors = Object.values(nations).map(n => n.color);
  const n = defaultNation({ color: nextDefaultColor(existingColors) });
  const baseName = "新しい国家";
  let candidate = baseName;
  let i = 1;
  const taken = new Set(Object.values(nations).map(x => x.name));
  while (taken.has(candidate)) {
    i++;
    candidate = baseName + " " + i;
  }
  n.name = candidate;
  nations[n.id] = n;
  selectedNationId = n.id;
  renderNationList();
  renderForm();
  applyMapColors();
}

function deleteNation() {
  if (!selectedNationId || !nations[selectedNationId]) return;
  const name = nationLabel(nations[selectedNationId]);
  if (!confirm(name + " を削除します。所属していたステートは未所属に戻ります。よろしいですか？")) return;
  const id = selectedNationId;
  for (const sn of Object.keys(statesData)) {
    if (statesData[sn].country === id) statesData[sn].country = "";
  }
  delete nations[id];
  selectedNationId = null;
  renderNationList();
  renderForm();
  applyMapColors();
}

// -----------------------------------------------------------------------------
// 地図クリックの処理
// -----------------------------------------------------------------------------
function onMapClick(stateName) {
  const mode = clickModeSelect.value;
  if (mode === "select") {
    showStateInfo(stateName);
    return;
  }
  if (mode === "assign") {
    if (!selectedNationId) {
      setStatus(mapStatus, "編入する国家を先に選択してください。", "err");
      return;
    }
    statesData[stateName].country = selectedNationId;
    applyMapColors();
    renderNationList();
    renderForm();
    setStatus(mapStatus, stateName + " を " + nationLabel(nations[selectedNationId]) + " に編入しました。", "ok");
    return;
  }
  if (mode === "release") {
    statesData[stateName].country = "";
    applyMapColors();
    renderNationList();
    renderForm();
    setStatus(mapStatus, stateName + " を未所属に戻しました。", "ok");
    return;
  }
  if (mode === "capital") {
    if (!selectedNationId) {
      setStatus(mapStatus, "首都を設定する国家を先に選択してください。", "err");
      return;
    }
    const n = nations[selectedNationId];
    if (statesData[stateName].country !== n.id) {
      statesData[stateName].country = n.id;
    }
    n.capital = stateName;
    applyMapColors();
    renderNationList();
    renderForm();
    setStatus(mapStatus, stateName + " を " + nationLabel(n) + " の首都にしました。", "ok");
  }
}

function showStateInfo(stateName) {
  const s = statesData[stateName];
  if (!s) return;
  const cid = s.country;
  const n = cid ? nations[cid] : null;
  setStatus(
    mapStatus,
    stateName + " / 所属: " + (n ? nationLabel(n) : "未所属"),
    ""
  );
}

// -----------------------------------------------------------------------------
// Firebase
// -----------------------------------------------------------------------------
async function saveAll() {
  const btn = document.getElementById("btn-fb-save");
  btn.disabled = true;
  setStatus(fbStatus, "Firebaseに保存中...", "");
  try {
    await set(ref(db, DB_PATH_NATIONS), nations);
    await set(ref(db, DB_PATH_STATES), statesData);
    setStatus(fbStatus, "国家データとステート所属を保存しました。", "ok");
  } catch (err) {
    setStatus(
      fbStatus,
      "保存に失敗しました: " + err.message +
        "\nRealtime Database のルールで書き込みが許可されているか確認してください。",
      "err"
    );
  } finally {
    btn.disabled = false;
  }
}

async function loadAll() {
  const btn = document.getElementById("btn-fb-load");
  btn.disabled = true;
  setStatus(fbStatus, "Firebaseから読込中...", "");
  try {
    const [nationsSnap, statesSnap] = await Promise.all([
      get(ref(db, DB_PATH_NATIONS)),
      get(ref(db, DB_PATH_STATES))
    ]);
    const nationsRaw = nationsSnap.exists() ? (nationsSnap.val() || {}) : {};
    const statesRaw = statesSnap.exists() ? (statesSnap.val() || {}) : {};

    nations = {};
    for (const id of Object.keys(nationsRaw)) {
      const n = normalizeNation(nationsRaw[id]);
      if (!n.id) n.id = id;
      nations[n.id] = n;
    }

    statesData = {};
    for (const name of elById.keys()) {
      statesData[name] = normalizeState(statesRaw[name]);
    }
    for (const name of Object.keys(statesRaw)) {
      if (!statesData[name]) statesData[name] = normalizeState(statesRaw[name]);
    }

    for (const name of Object.keys(statesData)) {
      const c = statesData[name].country;
      if (c && !nations[c]) statesData[name].country = "";
    }

    if (selectedNationId && !nations[selectedNationId]) selectedNationId = null;
    renderNationList();
    renderForm();
    applyMapColors();
    setStatus(fbStatus, "国家 " + Object.keys(nations).length + " 件、ステート " + Object.keys(statesData).length + " 件を読み込みました。", "ok");
  } catch (err) {
    setStatus(fbStatus, "読込に失敗しました: " + err.message, "err");
  } finally {
    btn.disabled = false;
  }
}

function downloadJson() {
  const payload = { nations, states: statesData };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "aster_stella_nations.json";
  a.click();
  URL.revokeObjectURL(url);
  setStatus(fbStatus, "JSONをダウンロードしました。", "ok");
}

// -----------------------------------------------------------------------------
// イベント
// -----------------------------------------------------------------------------
mapContainer.addEventListener("click", (e) => {
  const p = e.target.closest("path");
  if (!p || !elById.has(p.id)) return;
  onMapClick(p.id);
});

document.getElementById("btn-new-nation").addEventListener("click", createNation);
document.getElementById("btn-delete-nation").addEventListener("click", deleteNation);
document.getElementById("btn-fb-save").addEventListener("click", saveAll);
document.getElementById("btn-fb-load").addEventListener("click", loadAll);
document.getElementById("btn-download").addEventListener("click", downloadJson);

document.getElementById("btn-zoom-in").addEventListener("click", () => panZoom && panZoom.zoomIn());
document.getElementById("btn-zoom-out").addEventListener("click", () => panZoom && panZoom.zoomOut());
document.getElementById("btn-zoom-reset").addEventListener("click", () => panZoom && panZoom.reset());

requireAdminAuth().then(init);
