// Aster Stella - メインスクリプト
//
// 役割:
//   - MapChart_Map.svg を読み込んで表示（iOS のぼやけ対策込み）
//   - ボタンで各ステートの接続関係を計算して JSON 化
//   - ステートをタップすると隣接ステートを色分け表示
//   - JSON のダウンロード / Firebase への保存・読込

import { db, ref, set, get } from "./firebase-config.js";
import { computeAdjacency } from "./adjacency.js";
import { attachPanZoom } from "./map-pan-zoom.js";
import { requireAdminAuth } from "./admin-auth.js";

const SVG_URL = "MapChart_Map.svg";
const DB_PATH = "aster_stella/map";

const COLOR_SELECTED = "#5aa9ff";
const COLOR_NEIGHBOR = "#f6ad55";

const mapContainer = document.getElementById("map-container");
const statusEl = document.getElementById("status");
const fbStatusEl = document.getElementById("fb-status");
const jsonOutput = document.getElementById("json-output");
const thresholdInput = document.getElementById("threshold");
const sampleStepInput = document.getElementById("sampleStep");

let mapSvg = null;                   // 注入した <svg id="wrapper">
const originalFills = new Map();     // path -> 元の fill 値
const elById = new Map();            // ステート名 -> path 要素
let lastResult = null;               // 直近の computeAdjacency 結果
let panZoom = null;                  // パン/ズーム コントローラ

function setStatus(el, msg, kind) {
  el.textContent = msg;
  el.className = "status" + (kind ? " " + kind : "");
}

// --- 地図の読み込み ---
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

    // iOS Safari のぼやけ対策:
    // 固定の width/height 属性を外し、viewBox からベクター拡大させる。
    svg.removeAttribute("width");
    svg.removeAttribute("height");
    // 元 SVG は xMinYMin 指定で左上寄せ。コンテナを縦長にしたいので強制的に中央寄せ。
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

    mapContainer.innerHTML = "";
    mapContainer.appendChild(svg);
    mapSvg = svg;

    // パン/ズームを有効化（viewBox 直接書き換え方式 / iOS でもぼやけない）
    panZoom = attachPanZoom(svg);

    // ステート path を index 化（pattern などは除外）
    elById.clear();
    originalFills.clear();
    svg.querySelectorAll("#map > path").forEach((p) => {
      if (!p.id || p.id.startsWith("pattern")) return;
      elById.set(p.id, p);
      originalFills.set(p, p.getAttribute("fill"));
    });

    setStatus(
      statusEl,
      elById.size + " ステートを読み込みました。「接続関係をJSONにする」を押してください。",
      ""
    );
  } catch (err) {
    mapContainer.innerHTML =
      '<p class="loading">地図を読み込めませんでした。<br>' +
      "ローカルサーバー経由で開いてください（README参照）。<br>" +
      "詳細: " + err.message + "</p>";
    setStatus(statusEl, "地図の読み込みに失敗しました。", "err");
  }
}

// --- 接続関係の生成 ---
function generate() {
  if (!mapSvg) {
    setStatus(statusEl, "地図がまだ読み込まれていません。", "err");
    return;
  }
  const threshold = parseFloat(thresholdInput.value) || 1.5;
  const sampleStep = parseFloat(sampleStepInput.value) || 1.0;

  const btn = document.getElementById("btn-generate");
  btn.disabled = true;
  setStatus(statusEl, "計算中...", "");

  // 「計算中」を描画させてから重い同期処理に入る
  requestAnimationFrame(() => {
    try {
      const result = computeAdjacency(mapSvg, { threshold, sampleStep });
      lastResult = result;
      jsonOutput.value = JSON.stringify(result, null, 2);

      const isolated = Object.entries(result.adjacency)
        .filter(([, neighbors]) => neighbors.length === 0)
        .map(([name]) => name);

      let msg =
        result.meta.stateCount + " ステート / 接続 " +
        result.meta.connectionCount + " 件 を生成しました。";
      if (isolated.length) {
        msg += "\n隣接なし（" + isolated.length + "件）: " +
          isolated.slice(0, 20).join(", ") +
          (isolated.length > 20 ? " ..." : "");
      }
      if (isolated.length > result.meta.stateCount * 0.15) {
        msg += "\n離島以外で隣接なしが多い場合は、判定距離を大きくして再生成してください。";
      }
      setStatus(statusEl, msg, "ok");
    } catch (err) {
      setStatus(statusEl, "計算に失敗しました: " + err.message, "err");
    } finally {
      btn.disabled = false;
    }
  });
}

// --- 地図の色 ---
function resetColors() {
  originalFills.forEach((fill, p) => {
    if (fill === null) p.removeAttribute("fill");
    else p.setAttribute("fill", fill);
  });
}

function highlight(name) {
  resetColors();
  const el = elById.get(name);
  if (el) el.setAttribute("fill", COLOR_SELECTED);

  const neighbors = (lastResult && lastResult.adjacency[name]) || null;
  if (neighbors) {
    neighbors.forEach((n) => {
      const ne = elById.get(n);
      if (ne) ne.setAttribute("fill", COLOR_NEIGHBOR);
    });
    setStatus(
      statusEl,
      name + " の隣接（" + neighbors.length + "）: " +
        (neighbors.join(", ") || "なし"),
      ""
    );
  } else {
    setStatus(
      statusEl,
      name + " を選択しました。隣接表示には先に「接続関係をJSONにする」を押してください。",
      ""
    );
  }
}

// --- JSON ダウンロード ---
function download() {
  const text = jsonOutput.value.trim();
  if (!text) {
    setStatus(fbStatusEl, "ダウンロードするデータがありません。", "err");
    return;
  }
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "aster_stella_map.json";
  a.click();
  URL.revokeObjectURL(url);
  setStatus(fbStatusEl, "JSONをダウンロードしました。", "ok");
}

// --- Firebase 保存 ---
async function saveToFirebase() {
  const text = jsonOutput.value.trim();
  if (!text) {
    setStatus(fbStatusEl, "保存するデータがありません。", "err");
    return;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    setStatus(fbStatusEl, "JSONの形式が正しくありません: " + err.message, "err");
    return;
  }
  const btn = document.getElementById("btn-save");
  btn.disabled = true;
  setStatus(fbStatusEl, "Firebaseに保存中...", "");
  try {
    await set(ref(db, DB_PATH), data);
    setStatus(fbStatusEl, "Firebaseに保存しました（" + DB_PATH + "）。", "ok");
  } catch (err) {
    setStatus(
      fbStatusEl,
      "保存に失敗しました: " + err.message +
        "\nRealtime Database のルールで書き込みが許可されているか確認してください。",
      "err"
    );
  } finally {
    btn.disabled = false;
  }
}

// --- Firebase 読込 ---
async function loadFromFirebase() {
  const btn = document.getElementById("btn-load");
  btn.disabled = true;
  setStatus(fbStatusEl, "Firebaseから読込中...", "");
  try {
    const snap = await get(ref(db, DB_PATH));
    if (!snap.exists()) {
      setStatus(fbStatusEl, DB_PATH + " にデータがありません。", "err");
      return;
    }
    const data = snap.val();
    jsonOutput.value = JSON.stringify(data, null, 2);
    if (data && data.adjacency) lastResult = data;
    setStatus(fbStatusEl, "Firebaseから読み込みました。", "ok");
  } catch (err) {
    setStatus(fbStatusEl, "読込に失敗しました: " + err.message, "err");
  } finally {
    btn.disabled = false;
  }
}

// --- イベント登録 ---
mapContainer.addEventListener("click", (e) => {
  const p = e.target.closest("path");
  if (!p || !elById.has(p.id)) return;
  highlight(p.id);
});

document.getElementById("btn-generate").addEventListener("click", generate);
document.getElementById("btn-reset-colors").addEventListener("click", () => {
  resetColors();
  setStatus(statusEl, "地図の色をリセットしました。", "");
});
document.getElementById("btn-download").addEventListener("click", download);
document.getElementById("btn-save").addEventListener("click", saveToFirebase);
document.getElementById("btn-load").addEventListener("click", loadFromFirebase);

document.getElementById("btn-zoom-in").addEventListener("click", () => panZoom && panZoom.zoomIn());
document.getElementById("btn-zoom-out").addEventListener("click", () => panZoom && panZoom.zoomOut());
document.getElementById("btn-zoom-reset").addEventListener("click", () => panZoom && panZoom.reset());

requireAdminAuth().then(loadMap);
