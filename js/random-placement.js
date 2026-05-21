// Aster Stella - 資源のランダム配置
//
// 仕様（作ってほしいもの.txt より）:
//   肥沃度:   全ステート 50~100
//   金属資源: 50%で埋蔵。埋蔵分の 80%=1-10, 10%=20-50, 10%=50-100
//   石炭資源: 金属と同じ
//   石油資源: スポット3か所=100、1-hop=90、2-hop=50-80、その他は低確率で1-10
//   重要鉱物: 10%=80-100, 30%=1-10, それ以外=0

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function rollMetalLike() {
  if (Math.random() >= 0.5) return 0;
  const r = Math.random();
  if (r < 0.8) return randInt(1, 10);
  if (r < 0.9) return randInt(20, 50);
  return randInt(50, 100);
}

/**
 * すべてのステートの resources を上書きする。
 * @param {Object<string, object>} states     ステート名 -> 正規化済みステート
 * @param {Object<string, string[]>} adjacency 接続関係
 * @param {{oilSpotCount?:number, oilLowProb?:number}} opts
 * @returns {{oilSpots: string[]}}
 */
export function placeResources(states, adjacency, opts = {}) {
  const oilSpotCount = Math.max(0, Math.floor(opts.oilSpotCount ?? 3));
  const oilLowProb = clamp01(opts.oilLowProb ?? 0.05);

  const names = Object.keys(states);

  // 肥沃度（全ステート 50-100）
  for (const n of names) states[n].resources.fertility = randInt(50, 100);

  // 金属 / 炭田（同じ分布）
  for (const n of names) states[n].resources.metal = rollMetalLike();
  for (const n of names) states[n].resources.coal = rollMetalLike();

  // 重要鉱物
  for (const n of names) {
    const r = Math.random();
    if (r < 0.10) states[n].resources.rareMineral = randInt(80, 100);
    else if (r < 0.40) states[n].resources.rareMineral = randInt(1, 10);
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
  for (const s of spots) oilLevel.set(s, 100);
  for (const s of spots) {
    for (const n of (adjacency[s] || [])) {
      const prev = oilLevel.get(n) ?? -Infinity;
      if (90 > prev) oilLevel.set(n, 90);
    }
  }
  for (const s of spots) {
    for (const n1 of (adjacency[s] || [])) {
      for (const n2 of (adjacency[n1] || [])) {
        if (oilLevel.has(n2)) continue; // スポット/1-hop は触らない
        oilLevel.set(n2, randInt(50, 80));
      }
    }
  }

  for (const n of names) {
    if (oilLevel.has(n)) {
      states[n].resources.oil = oilLevel.get(n);
    } else if (Math.random() < oilLowProb) {
      states[n].resources.oil = randInt(1, 10);
    }
  }

  return { oilSpots: spots };
}

function clamp01(v) {
  if (typeof v !== "number" || !isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}
