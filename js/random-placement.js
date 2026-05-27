// Aster Stella - 資源のランダム配置
//
// 仕様（作ってほしいもの.txt より）:
//   肥沃度:   全ステート 50~100
//   金属資源: 50%で埋蔵。埋蔵分の 80%=1-10, 10%=20-50, 10%=50-100
//   石炭資源: 金属と同じ
//   石油資源: スポット3か所=100、1-hop=90、2-hop=50-80、その他は低確率で1-10
//   重要鉱物: 10%=80-100, 30%=1-10, それ以外=0

// 運営が調整できる配分設定のデフォルト。aster_stella/config/resourceDist で上書き可能。
export const DEFAULT_DIST = {
  fertilityMin: 50, fertilityMax: 100,
  metalProb: 0.5, metalLowMin: 1, metalLowMax: 10, metalMidMin: 20, metalMidMax: 50, metalHighMin: 50, metalHighMax: 100,
  metalLowShare: 0.8, metalMidShare: 0.1, // 残りが high
  rareHighProb: 0.10, rareLowProb: 0.30, rareHighMin: 80, rareHighMax: 100, rareLowMin: 1, rareLowMax: 10,
  oilSpotCount: 3, oilSpotLevel: 100, oilHop1: 90, oilHop2Min: 50, oilHop2Max: 80, oilLowProb: 0.05, oilLowMin: 1, oilLowMax: 10
};

function mergeDist(d) {
  const out = {};
  for (const k of Object.keys(DEFAULT_DIST)) {
    const v = d && d[k];
    out[k] = (typeof v === "number" && isFinite(v)) ? v : DEFAULT_DIST[k];
  }
  return out;
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function rollMetalLike(d) {
  if (Math.random() >= d.metalProb) return 0;
  const r = Math.random();
  if (r < d.metalLowShare) return randInt(d.metalLowMin, d.metalLowMax);
  if (r < d.metalLowShare + d.metalMidShare) return randInt(d.metalMidMin, d.metalMidMax);
  return randInt(d.metalHighMin, d.metalHighMax);
}

/**
 * すべてのステートの resources を上書きする。
 * @param {Object<string, object>} states     ステート名 -> 正規化済みステート
 * @param {Object<string, string[]>} adjacency 接続関係
 * @param {{oilSpotCount?:number, oilLowProb?:number}} opts
 * @returns {{oilSpots: string[]}}
 */
export function placeResources(states, adjacency, opts = {}) {
  const d = mergeDist(opts.dist);
  const oilSpotCount = Math.max(0, Math.floor(opts.oilSpotCount ?? d.oilSpotCount));
  const oilLowProb = clamp01(opts.oilLowProb ?? d.oilLowProb);

  const names = Object.keys(states);

  // 肥沃度
  for (const n of names) states[n].resources.fertility = randInt(d.fertilityMin, d.fertilityMax);

  // 金属 / 炭田（同じ分布）
  for (const n of names) states[n].resources.metal = rollMetalLike(d);
  for (const n of names) states[n].resources.coal = rollMetalLike(d);

  // 重要鉱物
  for (const n of names) {
    const r = Math.random();
    if (r < d.rareHighProb) states[n].resources.rareMineral = randInt(d.rareHighMin, d.rareHighMax);
    else if (r < d.rareHighProb + d.rareLowProb) states[n].resources.rareMineral = randInt(d.rareLowMin, d.rareLowMax);
    else states[n].resources.rareMineral = 0;
  }

  // 石油: 一旦 0 にしてからスポット/隣接で塗っていく
  for (const n of names) states[n].resources.oil = 0;

  // adjacency 側にしか登場しないステートを含めて、有効な選択肢を作る
  const candidatePool = names.filter(n => Array.isArray(adjacency[n]));
  const pool = candidatePool.length > 0 ? candidatePool : names;

  const spots = [];
  if (pool.length > 0 && oilSpotCount > 0) {
    const seen = new Set();
    const safety = Math.min(oilSpotCount, pool.length);
    while (spots.length < safety) {
      const pick = pool[Math.floor(Math.random() * pool.length)];
      if (!seen.has(pick)) { seen.add(pick); spots.push(pick); }
    }
  }

  // oilLevel: スポット > 1-hop > 2-hop で重ね塗りし、最大値を採用
  const oilLevel = new Map();
  for (const s of spots) oilLevel.set(s, d.oilSpotLevel);
  for (const s of spots) {
    for (const n of (adjacency[s] || [])) {
      const prev = oilLevel.get(n) ?? -Infinity;
      if (d.oilHop1 > prev) oilLevel.set(n, d.oilHop1);
    }
  }
  for (const s of spots) {
    for (const n1 of (adjacency[s] || [])) {
      for (const n2 of (adjacency[n1] || [])) {
        if (oilLevel.has(n2)) continue; // スポット/1-hop は触らない
        oilLevel.set(n2, randInt(d.oilHop2Min, d.oilHop2Max));
      }
    }
  }

  for (const n of names) {
    if (oilLevel.has(n)) {
      states[n].resources.oil = oilLevel.get(n);
    } else if (Math.random() < oilLowProb) {
      states[n].resources.oil = randInt(d.oilLowMin, d.oilLowMax);
    }
  }

  return { oilSpots: spots };
}

function clamp01(v) {
  if (typeof v !== "number" || !isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}
