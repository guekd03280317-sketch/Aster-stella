// Aster Stella - 隣接（接続）関係の計算
//
// MapChart 形式の SVG から、各ステートの隣接関係を幾何的に求める。
// このSVGでは各ステートが <svg id="map"> の直下の <path id="ステート名"> になっている。
//
// 手順:
//   1. 各ステートの path 上に一定間隔でサンプル点を取る。
//   2. サンプル点を格子（spatial hash）に登録する。
//   3. 別ステートの点が threshold 以内にあれば「隣接」と判定する。

/**
 * @param {SVGElement} root  地図のSVG（<svg id="wrapper"> でも #map を含む要素なら可）
 * @param {{threshold?: number, sampleStep?: number}} options
 * @returns {{meta: object, adjacency: Object<string,string[]>}}
 */
export function computeAdjacency(root, options = {}) {
  const threshold = options.threshold ?? 1.5;
  const sampleStep = options.sampleStep ?? 1.0;

  // <svg id="map"> 直下の path だけがステート。defs 内の pattern などは除外。
  const paths = Array.from(root.querySelectorAll("#map > path"))
    .filter((p) => p.id && !p.id.startsWith("pattern"));

  if (paths.length === 0) {
    throw new Error("ステートの path が見つかりません（#map > path が0件）");
  }

  // --- 1. 各ステートの輪郭をサンプリング ---
  const states = [];
  const points = []; // { state: number(index), x, y }

  for (const path of paths) {
    const name = path.id;
    let total;
    try {
      total = path.getTotalLength();
    } catch (e) {
      total = 0;
    }
    const stateIndex = states.length;
    states.push(name);

    const ctm = path.getCTM(); // path のローカル座標 -> #map ビューポート座標

    if (!isFinite(total) || total <= 0) {
      // 長さ0でも単点として登録しておく
      const p = safePoint(path, 0);
      if (p) points.push({ state: stateIndex, ...applyMatrix(ctm, p) });
      continue;
    }

    const step = Math.min(sampleStep, total);
    for (let l = 0; l <= total; l += step) {
      const p = safePoint(path, l);
      if (p) points.push({ state: stateIndex, ...applyMatrix(ctm, p) });
    }
    // 終点も必ず含める
    const last = safePoint(path, total);
    if (last) points.push({ state: stateIndex, ...applyMatrix(ctm, last) });
  }

  // --- 2. 格子に登録（セル幅 = threshold）---
  const cell = threshold > 0 ? threshold : 1;
  const grid = new Map();
  const keyOf = (cx, cy) => cx + "," + cy;
  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    const cx = Math.floor(pt.x / cell);
    const cy = Math.floor(pt.y / cell);
    const k = keyOf(cx, cy);
    let bucket = grid.get(k);
    if (!bucket) {
      bucket = [];
      grid.set(k, bucket);
    }
    bucket.push(i);
  }

  // --- 3. 近傍セルを調べて隣接ペアを判定 ---
  const t2 = threshold * threshold;
  const pairs = new Set(); // "a|b"（a < b のインデックス）
  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    const cx = Math.floor(pt.x / cell);
    const cy = Math.floor(pt.y / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = grid.get(keyOf(cx + dx, cy + dy));
        if (!bucket) continue;
        for (const j of bucket) {
          if (j <= i) continue;
          const q = points[j];
          if (q.state === pt.state) continue;
          const ex = q.x - pt.x;
          const ey = q.y - pt.y;
          if (ex * ex + ey * ey <= t2) {
            const a = Math.min(pt.state, q.state);
            const b = Math.max(pt.state, q.state);
            pairs.add(a + "|" + b);
          }
        }
      }
    }
  }

  // --- 隣接マップの組み立て ---
  const adjacency = {};
  const sortedNames = [...states].sort();
  for (const name of sortedNames) adjacency[name] = [];

  for (const pair of pairs) {
    const [ai, bi] = pair.split("|").map(Number);
    const a = states[ai];
    const b = states[bi];
    adjacency[a].push(b);
    adjacency[b].push(a);
  }
  for (const name of Object.keys(adjacency)) {
    adjacency[name] = [...new Set(adjacency[name])].sort();
  }

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      source: "MapChart_Map.svg",
      stateCount: states.length,
      connectionCount: pairs.size,
      sampleCount: points.length,
      threshold,
      sampleStep
    },
    adjacency
  };
}

function safePoint(path, length) {
  try {
    const p = path.getPointAtLength(length);
    if (isFinite(p.x) && isFinite(p.y)) return p;
  } catch (e) {
    /* noop */
  }
  return null;
}

function applyMatrix(m, p) {
  if (!m) return { x: p.x, y: p.y };
  return {
    x: m.a * p.x + m.c * p.y + m.e,
    y: m.b * p.x + m.d * p.y + m.f
  };
}
