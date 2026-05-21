// Aster Stella - 管理者ページ
//
// 役割:
//   - 地図表示（iOS のぼやけ対策込み）
//   - ステートをタップして選択 → ステータスを編集
//   - 資源のランダム配置（仕様は random-placement.js を参照）
//   - 表示モードによる地図のヒートマップ表示
//   - Firebase Realtime Database への保存/読込

import { db, ref, set, get } from "./firebase-config.js";
import { requireAdminAuth } from "./admin-auth.js";
import {
  BASIC_FIELDS,
  INDUSTRY_FIELDS,
  RESOURCE_FIELDS,
  DISPLAY_MODES,
  defaultState,
  normalizeState,
  getByPath
} from "./state-schema.js";
import { normalizeNation, nationLabel } from "./nation-schema.js";
import { placeResources } from "./random-placement.js";
import { attachPanZoom } from "./map-pan-zoom.js";

const SVG_URL = "MapChart_Map.svg";
const ADJACENCY_URL = "aster_stella_map.json";
const DB_PATH_STATES = "aster_stella/states";
const DB_PATH_NATIONS = "aster_stella/nations";

const COLOR_SELECTED_STROKE = "#5aa9ff";
const STROKE_WIDTH_SELECTED = "2.5";
const COLOR_EMPTY = "#1d2738";

const mapContainer = document.getElementById("map-container");
const mapStatus = document.getElementById("map-status");
const fbStatus = document.getElementById("fb-status");
const randomStatus = document.getElementById("random-status");
const selectedNameEl = document.getElementById("selected-name");
const formContainer = document.getElementById("state-form");
const displayModeSelect = document.getElementById("display-mode");

let mapSvg = null;
const elById = new Map();                 // ステート名 -> path 要素
const originalFills = new Map();          // path -> 元の fill
const originalStrokes = new Map();        // path -> {stroke, width}
let adjacency = {};                        // { stateName: [neighbors] }
let statesData = {};                       // { stateName: state object }
let nations = {};                          // { nationId: nation }（任意。なくても動く）
let selectedName = null;
let currentMode = "default";
let panZoom = null;                        // パン/ズーム コントローラ

// -----------------------------------------------------------------------------
// ステータス表示
// -----------------------------------------------------------------------------
function setStatus(el, msg, kind) {
  el.textContent = msg;
  el.className = "status" + (kind ? " " + kind : "");
}

// -----------------------------------------------------------------------------
// 地図とデータの読み込み
// -----------------------------------------------------------------------------
async function init() {
  populateDisplayModes();
  await loadMap();
  await loadAdjacency();
  await loadNationsSilently();
  ensureStateEntries();
  setStatus(
    mapStatus,
    elById.size + " ステートを読み込みました。タップで選択 / 「資源をランダム配置」で初期化できます。",
    ""
  );
}

async function loadNationsSilently() {
  // 国家データは任意。失敗しても致命的ではないので静かに無視する。
  try {
    const snap = await get(ref(db, DB_PATH_NATIONS));
    if (snap.exists()) {
      const raw = snap.val() || {};
      const out = {};
      for (const id of Object.keys(raw)) {
        const n = normalizeNation(raw[id]);
        if (!n.id) n.id = id;
        out[n.id] = n;
      }
      nations = out;
    }
  } catch (e) { /* noop */ }
}

function populateDisplayModes() {
  for (const m of DISPLAY_MODES) {
    const opt = document.createElement("option");
    opt.value = m.value;
    opt.textContent = m.label;
    displayModeSelect.appendChild(opt);
  }
  displayModeSelect.value = currentMode;
}

async function loadMap() {
  try {
    const res = await fetch(SVG_URL);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const text = await res.text();

    const doc = new DOMParser().parseFromString(text, "image/svg+xml");
    if (doc.querySelector("parsererror")) {
      throw new Error("SVGの解析に失敗しました");
    }
    const svg = document.importNode(doc.documentElement, true);

    // iOS Safari のぼやけ対策
    svg.removeAttribute("width");
    svg.removeAttribute("height");
    // 元 SVG は xMinYMin 指定で左上寄せ。コンテナを縦長にしたいので強制的に中央寄せ。
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

    mapContainer.innerHTML = "";
    mapContainer.appendChild(svg);
    mapSvg = svg;

    // パン/ズームを有効化（viewBox 直接書き換え方式 / iOS でもぼやけない）
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
      '<p class="loading">地図を読み込めませんでした。<br>' +
      "ローカルサーバー経由で開いてください。<br>" +
      "詳細: " + err.message + "</p>";
    setStatus(mapStatus, "地図の読み込みに失敗しました。", "err");
  }
}

async function loadAdjacency() {
  try {
    const res = await fetch(ADJACENCY_URL);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    adjacency = (data && data.adjacency) ? data.adjacency : {};
  } catch (err) {
    adjacency = {};
    setStatus(
      mapStatus,
      "接続関係(" + ADJACENCY_URL + ")を読み込めませんでした。石油配置の隣接判定が無効になります。",
      "err"
    );
  }
}

function ensureStateEntries() {
  for (const name of elById.keys()) {
    if (!statesData[name]) statesData[name] = defaultState();
  }
}

// -----------------------------------------------------------------------------
// フォーム描画
// -----------------------------------------------------------------------------
function renderForm() {
  if (!selectedName) {
    formContainer.innerHTML = '<p class="loading">地図のステートをタップしてください。</p>';
    return;
  }
  const data = statesData[selectedName];
  formContainer.innerHTML = "";

  const sections = [
    { title: "基本情報", fields: BASIC_FIELDS, group: null },
    { title: "産業（設置数）", fields: INDUSTRY_FIELDS, group: "industries" },
    { title: "資源（埋蔵量）", fields: RESOURCE_FIELDS, group: "resources" }
  ];

  for (const sec of sections) {
    const wrap = document.createElement("section");
    wrap.className = "form-section";
    const h3 = document.createElement("h3");
    h3.textContent = sec.title;
    wrap.appendChild(h3);

    const grid = document.createElement("div");
    grid.className = "field-grid";

    for (const f of sec.fields) {
      const label = document.createElement("label");
      label.className = "field";
      const span = document.createElement("span");
      span.textContent = f.label;
      const type = f.type || "number";

      // 所属国家フィールドは、国家データが読み込まれていればプルダウンにする
      let input;
      if (!sec.group && f.key === "country" && Object.keys(nations).length > 0) {
        input = document.createElement("select");
        const noneOpt = document.createElement("option");
        noneOpt.value = "";
        noneOpt.textContent = "（未所属）";
        input.appendChild(noneOpt);
        const ids = Object.keys(nations).sort((a, b) =>
          nationLabel(nations[a]).localeCompare(nationLabel(nations[b]), "ja")
        );
        let matched = false;
        for (const id of ids) {
          const opt = document.createElement("option");
          opt.value = id;
          opt.textContent = nationLabel(nations[id]);
          if (data.country === id) { opt.selected = true; matched = true; }
          input.appendChild(opt);
        }
        // 既存値が国家IDに一致しない場合、自由入力として保持する選択肢を出す
        if (data.country && !matched) {
          const legacy = document.createElement("option");
          legacy.value = data.country;
          legacy.textContent = "（旧データ: " + data.country + "）";
          legacy.selected = true;
          input.appendChild(legacy);
        }
        input.addEventListener("change", () => {
          data.country = input.value;
          applyDisplayMode();
        });
      } else {
        input = document.createElement("input");
        input.type = type;
        const value = sec.group ? data[sec.group][f.key] : data[f.key];
        input.value = (value !== undefined && value !== null) ? value : (type === "number" ? 0 : "");
        if (type === "number") {
          input.step = "any";
          input.inputMode = "decimal";
        }
        input.addEventListener("input", () => {
          const v = type === "number" ? parseFloat(input.value || "0") : input.value;
          if (sec.group) {
            data[sec.group][f.key] = (type === "number") ? (isFinite(v) ? v : 0) : v;
          } else {
            data[f.key] = (type === "number") ? (isFinite(v) ? v : 0) : v;
          }
          applyDisplayMode();
        });
      }
      label.appendChild(span);
      label.appendChild(input);
      grid.appendChild(label);
    }
    wrap.appendChild(grid);
    formContainer.appendChild(wrap);
  }
}

// -----------------------------------------------------------------------------
// 地図の色（表示モード）
// -----------------------------------------------------------------------------
function resetFills() {
  originalFills.forEach((fill, p) => {
    if (fill === null) p.removeAttribute("fill");
    else p.setAttribute("fill", fill);
  });
}

function applyDisplayMode() {
  const mode = DISPLAY_MODES.find(m => m.value === currentMode) || DISPLAY_MODES[0];

  if (mode.kind === "default") {
    resetFills();
  } else if (mode.kind === "number") {
    // 値の範囲を取得（最小は0扱い、最大は実値）
    let max = 0;
    for (const name of elById.keys()) {
      const v = Number(getByPath(statesData[name], mode.path));
      if (isFinite(v) && v > max) max = v;
    }
    for (const [name, p] of elById) {
      const v = Number(getByPath(statesData[name], mode.path)) || 0;
      const color = numberToColor(v, max);
      p.setAttribute("fill", color);
    }
  } else if (mode.kind === "category") {
    for (const [name, p] of elById) {
      const v = String(getByPath(statesData[name], mode.path) || "");
      if (!v) { p.setAttribute("fill", COLOR_EMPTY); continue; }
      // country モードで該当する国家データがあれば、その国家色を使う
      const isCountry = mode.path.length === 1 && mode.path[0] === "country";
      if (isCountry && nations[v] && nations[v].color) {
        p.setAttribute("fill", nations[v].color);
      } else {
        p.setAttribute("fill", categoryColor(v));
      }
    }
  }
  // 選択中のステートのハイライトは保つ
  refreshSelectionStroke();
}

function numberToColor(value, max) {
  if (!isFinite(value) || max <= 0) return COLOR_EMPTY;
  const ratio = Math.max(0, Math.min(1, value / max));
  // 暗いベース -> 明るいアクセント青へ補間（ダークモード向け）
  const start = [29, 39, 56];      // #1d2738
  const end   = [123, 224, 199];   // #7be0c7（アクセント2）
  const r = Math.round(start[0] + (end[0] - start[0]) * ratio);
  const g = Math.round(start[1] + (end[1] - start[1]) * ratio);
  const b = Math.round(start[2] + (end[2] - start[2]) * ratio);
  return "rgb(" + r + "," + g + "," + b + ")";
}

function categoryColor(s) {
  // 文字列からハッシュを作って HSL に変換（ダークモード向けに彩度高め・明度低め）
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  const hue = h % 360;
  return "hsl(" + hue + ", 58%, 55%)";
}

// -----------------------------------------------------------------------------
// 選択
// -----------------------------------------------------------------------------
function refreshSelectionStroke() {
  originalStrokes.forEach((orig, p) => {
    if (orig.stroke === null) p.removeAttribute("stroke"); else p.setAttribute("stroke", orig.stroke);
    if (orig.width === null) p.removeAttribute("stroke-width"); else p.setAttribute("stroke-width", orig.width);
  });
  if (selectedName) {
    const sel = elById.get(selectedName);
    if (sel) {
      sel.setAttribute("stroke", COLOR_SELECTED_STROKE);
      sel.setAttribute("stroke-width", STROKE_WIDTH_SELECTED);
      // 選択を最前面に持ってくる
      sel.parentNode.appendChild(sel);
    }
  }
}

function select(name) {
  if (!elById.has(name)) return;
  selectedName = name;
  selectedNameEl.textContent = name;
  refreshSelectionStroke();
  renderForm();
}

// -----------------------------------------------------------------------------
// ランダム配置
// -----------------------------------------------------------------------------
function doRandomPlacement() {
  ensureStateEntries();
  const oilSpotCount = parseInt(document.getElementById("oil-spot-count").value || "3", 10);
  const oilLowProb = (parseFloat(document.getElementById("oil-low-prob").value || "5") || 0) / 100;
  const btn = document.getElementById("btn-random");
  btn.disabled = true;
  setStatus(randomStatus, "配置中...", "");
  requestAnimationFrame(() => {
    try {
      const result = placeResources(statesData, adjacency, { oilSpotCount, oilLowProb });
      setStatus(
        randomStatus,
        "資源をランダム配置しました。\n油田スポット: " +
          (result.oilSpots.length ? result.oilSpots.join(", ") : "（なし）"),
        "ok"
      );
      applyDisplayMode();
      if (selectedName) renderForm();
    } catch (err) {
      setStatus(randomStatus, "配置に失敗しました: " + err.message, "err");
    } finally {
      btn.disabled = false;
    }
  });
}

// -----------------------------------------------------------------------------
// Firebase 保存・読込
// -----------------------------------------------------------------------------
async function saveAllToFirebase() {
  const btn = document.getElementById("btn-fb-save");
  btn.disabled = true;
  setStatus(fbStatus, "Firebaseに保存中...", "");
  try {
    await set(ref(db, DB_PATH_STATES), statesData);
    setStatus(fbStatus, "Firebaseに保存しました（" + DB_PATH_STATES + "）。", "ok");
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

async function loadAllFromFirebase() {
  const btn = document.getElementById("btn-fb-load");
  btn.disabled = true;
  setStatus(fbStatus, "Firebaseから読込中...", "");
  try {
    await loadNationsSilently();
    const snap = await get(ref(db, DB_PATH_STATES));
    if (!snap.exists()) {
      setStatus(fbStatus, DB_PATH_STATES + " にデータがありません。", "err");
      return;
    }
    const data = snap.val() || {};
    statesData = {};
    for (const name of elById.keys()) {
      statesData[name] = normalizeState(data[name]);
    }
    for (const name of Object.keys(data)) {
      if (!statesData[name]) statesData[name] = normalizeState(data[name]);
    }
    if (selectedName) renderForm();
    applyDisplayMode();
    setStatus(fbStatus, "Firebaseから読み込みました。", "ok");
  } catch (err) {
    setStatus(fbStatus, "読込に失敗しました: " + err.message, "err");
  } finally {
    btn.disabled = false;
  }
}

function downloadJson() {
  const blob = new Blob([JSON.stringify(statesData, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "aster_stella_states.json";
  a.click();
  URL.revokeObjectURL(url);
  setStatus(fbStatus, "JSONをダウンロードしました。", "ok");
}

function resetAll() {
  if (!confirm("全ステートのステータスを初期値に戻します。よろしいですか？")) return;
  statesData = {};
  ensureStateEntries();
  if (selectedName) renderForm();
  applyDisplayMode();
  setStatus(fbStatus, "全データを初期化しました（Firebaseには未反映）。", "ok");
}

// -----------------------------------------------------------------------------
// イベント
// -----------------------------------------------------------------------------
mapContainer.addEventListener("click", (e) => {
  const p = e.target.closest("path");
  if (!p || !elById.has(p.id)) return;
  select(p.id);
});

displayModeSelect.addEventListener("change", () => {
  currentMode = displayModeSelect.value;
  applyDisplayMode();
});

document.getElementById("btn-random").addEventListener("click", doRandomPlacement);
document.getElementById("btn-fb-save").addEventListener("click", saveAllToFirebase);
document.getElementById("btn-fb-load").addEventListener("click", loadAllFromFirebase);
document.getElementById("btn-download").addEventListener("click", downloadJson);
document.getElementById("btn-reset-all").addEventListener("click", resetAll);

document.getElementById("btn-zoom-in").addEventListener("click", () => panZoom && panZoom.zoomIn());
document.getElementById("btn-zoom-out").addEventListener("click", () => panZoom && panZoom.zoomOut());
document.getElementById("btn-zoom-reset").addEventListener("click", () => panZoom && panZoom.reset());

requireAdminAuth().then(init);
