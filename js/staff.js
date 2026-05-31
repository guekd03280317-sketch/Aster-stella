// Aster Stella - お手軽参謀本部（自動作戦立案）§22
//
// 「攻略したいステート」と「守りたいステート」を選ぶだけで、
// 手持ちの軍に作戦（攻撃/移動/防衛の予約ドラフト）を自動生成する純関数。
//
// 重要: ここは「予約の下書き生成器」にすぎない。実データは一切変更せず、
//       戦闘判定は GAS(§7) が単一の真実として行う。クライアントが盤面を解決することはしない。
//
// DOM / Firebase 非依存。player の参謀本部UI（プレビュー）と試算で使う。

import { WAR_CONFIG_DEFAULTS, armyTroops } from "./war-schema.js";
import { computeArmyProfile, findSupplyPath } from "./military.js";

function toNum(v) { const n = Number(v); return isFinite(n) ? n : 0; }

// ------------------------------------------------------------
// 敵守備の推定（クライアントは敵軍を直接見られない＝霧。状態から推定）
//   偵察(scout)で可視化済みのステートは reveal[state] の実値を使う。
// ------------------------------------------------------------
function estimateGarrison(stateName, statesData, reveal, cfg) {
  if (reveal && reveal[stateName] != null) return toNum(reveal[stateName]);
  const s = (statesData || {})[stateName] || {};
  // 経済力・人口・開発度から推定（ライブ調整可能な係数）
  const k = (cfg.staff && cfg.staff.garrisonFromEconomy) || 0.15;
  const base = toNum(s.economy) * k + toNum(s.population) * 0.001 + toNum(s.development) * 0.5;
  return Math.max(10, Math.round(base));
}

// ------------------------------------------------------------
// planOperations(input) → 作戦ドラフト
//   input = {
//     nationId, capital, tech,
//     military,                 // nations/{id}/military（normalize済み）
//     statesData, adjacency,
//     allies: [nationId...],
//     reveal: { state: troops },// 偵察で可視化済みの敵兵力（任意）
//     goals: { offensive:[state...], defensive:[state...] },
//     options: { posture: 0..1, risk: "cautious"|"standard"|"bold" },
//     cfg                        // mergeWarConfig 済み（任意）
//   }
//   戻り値 = { drafts, defends, warnings, summary }
//     drafts  : [{ armyId, kind, payload, meta }]   ← orders へ一括登録できる下書き
//     warnings: [{ goal, reason, suggestion }]
// ------------------------------------------------------------
export function planOperations(input) {
  const cfg = input.cfg || WAR_CONFIG_DEFAULTS;
  const staffCfg = cfg.staff || WAR_CONFIG_DEFAULTS.staff;
  const statesData = input.statesData || {};
  const adjacency = input.adjacency || {};
  const military = input.military || { armies: {} };
  const allies = new Set(input.allies || []);
  const nationId = input.nationId;
  const reveal = input.reveal || {};

  const riskMult = { cautious: 1.6, standard: 1.3, bold: 1.05 }[(input.options && input.options.risk)] || staffCfg.safetyFactor || 1.3;
  const waveSpacing = (input.options && input.options.waveSpacing) || staffCfg.waveSpacing || 6;

  // 通行可否（補給線/友軍通行）: 自国 or 同盟 or 占領済み
  const isFriendly = (name) => {
    const owner = (statesData[name] || {}).country;
    if (owner === nationId) return true;
    if (allies.has(owner)) return true;
    const sp = (statesData[name] || {}).specialState || "";
    return sp.indexOf("occupied:" + nationId) >= 0;
  };
  const infraOf = (name) => toNum((statesData[name] || {}).infrastructure);

  // 利用可能な軍（兵がいるもの）。兵力降順。
  const armies = Object.values(military.armies || {})
    .filter(a => armyTroops(a) > 0)
    .map(a => ({ ref: a, troops: armyTroops(a), profile: computeArmyProfile(a, input.tech, cfg), assigned: false }))
    .sort((x, y) => y.troops - x.troops);

  const drafts = [];
  const defends = [];
  const warnings = [];

  // ---- 1. 防衛: 死守目標（首都は自動追加）----
  const defensive = new Set(input.goals && input.goals.defensive ? input.goals.defensive : []);
  if (input.capital) defensive.add(input.capital);
  for (const goal of defensive) {
    // そのステート上 or 最寄りの未割当軍を守備に
    let pick = armies.find(a => !a.assigned && a.ref.location === goal);
    if (!pick) pick = nearestArmy(armies, goal, adjacency, isFriendly, infraOf, cfg);
    if (!pick) {
      warnings.push({ goal, reason: "守備に回せる軍がない", suggestion: `${goal} 付近で動員し配備してください` });
      continue;
    }
    pick.assigned = true;
    if (pick.ref.location === goal) {
      drafts.push({ armyId: pick.ref.id, kind: "defendArmy", payload: { armyId: pick.ref.id }, meta: { role: "defend", goal } });
    } else {
      const route = findSupplyPath(pick.ref.location, goal, adjacency, isFriendly, infraOf, cfg);
      if (route.path) {
        drafts.push({ armyId: pick.ref.id, kind: "moveArmy", payload: { armyId: pick.ref.id, path: route.path, startTime: 0 }, meta: { role: "defend-move", goal } });
        drafts.push({ armyId: pick.ref.id, kind: "defendArmy", payload: { armyId: pick.ref.id }, meta: { role: "defend", goal, after: true } });
      } else {
        warnings.push({ goal, reason: "守備位置まで安全な経路がない", suggestion: "占領で補給路を確保してください" });
        pick.assigned = false;
      }
    }
    defends.push({ armyId: pick.ref.id, goal });
  }

  // ---- 2. 攻勢: 攻略目標（優先度順）----
  const offensive = (input.goals && input.goals.offensive) ? input.goals.offensive.slice() : [];
  let wave = 0;
  for (const goal of offensive) {
    const need = Math.ceil(estimateGarrison(goal, statesData, reveal, cfg) * riskMult);
    // 目標へ「到達でき、必要兵力を満たす最小の軍の組合せ」を貪欲に集める
    const candidates = armies
      .filter(a => !a.assigned)
      .map(a => ({ a, route: findOffensivePath(a.ref.location, goal, adjacency, isFriendly, infraOf, cfg) }))
      .filter(x => x.route && x.route.path)
      .sort((p, q) => p.route.hops - q.route.hops || q.a.troops - p.a.troops);

    if (!candidates.length) {
      warnings.push({ goal, reason: "到達できる軍がいない", suggestion: "前線まで軍を前進させるか、隣接ステートを占領してください" });
      continue;
    }

    let gathered = 0;
    const used = [];
    for (const c of candidates) {
      if (gathered >= need) break;
      c.a.assigned = true;
      used.push(c);
      gathered += c.a.troops;
    }
    // 波状攻撃: startTime を分散
    used.forEach((c, i) => {
      drafts.push({
        armyId: c.a.ref.id, kind: "attackArmy",
        payload: { armyId: c.a.ref.id, path: c.route.path, startTime: Math.min(45, wave * waveSpacing + i) },
        meta: { role: "attack", goal, estNeed: need, troops: c.a.troops }
      });
    });
    if (gathered < need) {
      warnings.push({
        goal,
        reason: `兵力不足（投入 ${gathered} / 推定必要 ${need}）`,
        suggestion: `不足 ${need - gathered} を動員して増援してください`
      });
    }
    wave++;
  }

  const summary = {
    armiesTotal: armies.length,
    armiesAssigned: armies.filter(a => a.assigned).length,
    offensiveGoals: offensive.length,
    defensiveGoals: defensive.size,
    drafts: drafts.length,
    warnings: warnings.length
  };

  return { drafts, defends, warnings, summary };
}

// 最寄りの未割当軍（友軍経路でのホップ最小）
function nearestArmy(armies, target, adjacency, passable, infraOf, cfg) {
  let best = null, bestHops = Infinity;
  for (const a of armies) {
    if (a.assigned) continue;
    const r = findSupplyPath(a.ref.location, target, adjacency, passable, infraOf, cfg);
    if (r.path && r.hops < bestHops) { best = a; bestHops = r.hops; }
  }
  return best;
}

// 攻勢用の経路: 敵領も通れる（攻撃なので）。最短ホップ。
function findOffensivePath(from, to, adjacency, friendly, infraOf, cfg) {
  // passable=常にtrue で全域 BFS（攻撃は敵領を踏破して進む）。
  // タイブレークは findSupplyPath 内のコスト（インフラ）で吸収される。
  return findSupplyPath(from, to, adjacency, () => true, infraOf, cfg);
}
