// Aster Stella - 戦争システムの計算エンジン（純関数）
//
// DOM / Firebase に依存しない計算式のみを置く。
// player側（参謀本部の試算・補給可視化）と GAS側（runTurn の解決）の両方から使い、
// 計算を「単一の真実」にする（§0 設計原則: 計算式は2か所で同期）。
//
// 章番号は 戦争システム仕様書.md を指す。
//
// 特殊兵の補正の合成方針（実装上の取り決め。§18 でCONFIG調整可）:
//   - ステータス%補正は「構成比による加重平均」で軍全体に効く（特殊兵1人で大軍を全部buffしない）。
//     例: line100 + elite5 の attack +10% は +10% × (5/105) ≈ +0.48%。
//   - 装甲 = 特殊兵の兵数加重平均（line除く、未記載は1）。特殊兵ゼロなら1（§4.3）。
//   - 貫徹 = 特殊兵の penetrationFlat の最大（基本1, §ヘッダー）。
//   - 資源%補正は当該兵種の消費に比例適用、flat定数はその兵種が居れば軍に1回加算。

import {
  WAR_CONFIG_DEFAULTS, SPECIAL_UNITS_BY_ID,
  attackPerSoldier, defPerSoldier, fuelDemandToResource, armyTroops
} from "./war-schema.js";

function toNum(v) { const n = Number(v); return isFinite(n) ? n : 0; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ============================================================
// 1. 軍プロファイル（構成からステータス補正を集計）
// ============================================================
//
// army.composition（{kind: count}）と国家の軍事技術力から、戦闘・移動に使う集計値を返す。
//
// 戻り値:
//   troops, specialTroops
//   attackMult, defenseMult, breakthroughMult, moraleMult  … %補正(加重平均, 1.0基準)
//   armor, penetration
//   moveApMult                … 移動AP消費の倍率(1.0基準)
//   apCostMult                … 一般AP消費の倍率
//   tags: Set                 … 軍が持つ特殊挙動（いずれかの兵種が持てば true）
//   categoryFrac: {infantry,cavalry,artillery,vehicle}  … 特殊兵カテゴリの構成比
//   pureVehicle, pureCavalry  … 系統統一フラグ（特殊兵が全部その系統か）
//   hasInfantryComponent      … 歩兵系を含む or 特殊兵なし（火砲の対歩兵判定用）
export function computeArmyProfile(army, tech, cfg = WAR_CONFIG_DEFAULTS) {
  const comp = (army && army.composition) || {};
  const troops = armyTroops(army);
  const kinds = Object.keys(comp).filter(k => toNum(comp[k]) > 0);

  let specialTroops = 0;
  const catCount = { infantry: 0, cavalry: 0, artillery: 0, vehicle: 0 };
  let lineCount = toNum(comp.line);

  // 加重平均用アキュムレータ
  const acc = { attack: 0, defense: 0, breakthrough: 0, morale: 0, moveAp: 0, apCost: 0 };
  let armorWeighted = 0, armorWeight = 0;
  let penetration = 1; // 貫徹の基本値（特殊兵が無ければ1, §ヘッダー）
  const tags = new Set();

  for (const k of kinds) {
    const count = toNum(comp[k]);
    if (k === "line") continue;
    const u = SPECIAL_UNITS_BY_ID[k];
    if (!u) continue;
    specialTroops += count;
    catCount[u.category] += count;

    const frac = troops > 0 ? count / troops : 0;
    const sp = (u.stat && u.stat.pct) || {};
    const all = toNum(sp.all);
    acc.attack       += (toNum(sp.attack)       + all) * frac;
    acc.defense      += (toNum(sp.defense)      + all) * frac;
    acc.breakthrough += (toNum(sp.breakthrough) + all) * frac;
    acc.morale       += (toNum(sp.morale)       + all) * frac;
    acc.moveAp       += toNum(sp.moveAp) * frac;   // 移動AP補正は加重平均（火砲兵同士の平均, §4 火砲系）
    acc.apCost       += toNum(sp.apCost) * frac;

    // 装甲: 特殊兵の兵数加重平均（未記載は1）
    const armorVal = (u.armor != null) ? u.armor : 1;
    armorWeighted += armorVal * count;
    armorWeight += count;

    // 貫徹: 特殊兵の penetrationFlat の最大（§ヘッダー）
    if (u.penetrationFlat) penetration = Math.max(penetration, u.penetrationFlat);

    for (const t of (u.tags || [])) tags.add(t);
  }

  const armor = armorWeight > 0 ? (armorWeighted / armorWeight) : 1;

  // 系統統一判定（特殊兵が居て、全特殊兵が同一カテゴリ）
  const pureVehicle = specialTroops > 0 && catCount.vehicle === specialTroops;
  const pureCavalry = specialTroops > 0 && catCount.cavalry === specialTroops;

  // 歩兵系を含む or 特殊兵なし（火砲の対歩兵判定, §4 火砲系）
  const hasInfantryComponent = (catCount.infantry > 0) || (lineCount > 0) || (specialTroops === 0);

  // 系統統一ボーナス（車両系, §4 車両系）
  let breakthroughMult = 1 + acc.breakthrough;
  let moveApMult = 1 + acc.moveAp;
  let apCostMult = 1 + acc.apCost;
  if (pureVehicle) {
    breakthroughMult += 0.50;
    moveApMult *= 0.50;
    apCostMult *= 0.75;
  }
  // 騎兵系統一（騎兵系以外の特殊兵がいない, §4 騎兵系）→ cav タグの条件成立
  if (pureCavalry) {
    if (tags.has("cavApHalfIfPureCav")) apCostMult *= 0.50;
    if (tags.has("cavMoveApHalfIfPureCav")) moveApMult *= 0.50;
  }
  if (tags.has("noMoveApCost")) moveApMult = 0;

  return {
    troops, specialTroops, lineCount,
    attackMult: 1 + acc.attack,
    defenseMult: 1 + acc.defense,
    breakthroughMult,
    moraleMult: 1 + acc.morale,
    armor, penetration,
    moveApMult: Math.max(0, moveApMult),
    apCostMult: Math.max(0, apCostMult),
    tags,
    catCount, pureVehicle, pureCavalry, hasInfantryComponent
  };
}

// ============================================================
// 2. 資源需要（§3）
// ============================================================
//
// 軍1つが今ターン要求する資源量を {resourceKey: amount} で返す。
//   - perTroopUpkeepBase × mode倍率(upkeepByMode) を基礎に、兵種の資源%/flat補正を適用
//   - fuel は技術段階で oil/coal に振り分け（指数, §3.1）
//   - rareMineral は技術力 >= rareMineralMinLevel の兵のみ
//   - machinery は技術力 >= machineryMinLevel のとき
export function armyResourceDemand(army, tech, mode, cfg = WAR_CONFIG_DEFAULTS) {
  const comp = (army && army.composition) || {};
  const base = cfg.perTroopUpkeepBase || WAR_CONFIG_DEFAULTS.perTroopUpkeepBase;
  const modeMul = (cfg.upkeepByMode && cfg.upkeepByMode[mode]) || cfg.upkeepByMode.idle;
  const out = { consumerGoods: 0, militaryGoods: 0, oil: 0, coal: 0, food: 0, parts: 0, machinery: 0, rareMineral: 0 };

  // fuel カテゴリは一旦集約してから oil/coal へ振り分ける
  let fuelTotal = 0;

  const techMilMult = 1 + Math.max(0, toNum(tech)) * 0.02; // 軍需は技術力に比例して増える（§3.1）

  for (const k of Object.keys(comp)) {
    const count = toNum(comp[k]);
    if (count <= 0) continue;
    const u = (k === "line") ? null : SPECIAL_UNITS_BY_ID[k];
    const pct = (u && u.res && u.res.pct) || {};
    const flat = (u && u.res && u.res.flat) || {};
    const otherPct = toNum(pct.other);

    // カテゴリごとに基礎×mode倍率×(1+兵種%)×count
    const demand = (cat, baseKey, modeKey) => {
      const b = toNum(base[baseKey]);
      const mm = toNum(modeMul[modeKey != null ? modeKey : baseKey]);
      const own = toNum(pct[cat]); // 兵種固有%
      const oth = (pct[cat] === undefined) ? otherPct : 0; // 未指定資源に other%
      return b * mm * count * (1 + own + oth);
    };

    out.food          += demand("food", "food");
    out.consumerGoods += demand("consumerGoods", "consumerGoods");
    out.parts         += demand("parts", "parts");

    // 軍需は技術力比例
    out.militaryGoods += demand("militaryGoods", "militaryGoods") * techMilMult;

    // 機械: 技術力しきい値
    if (toNum(tech) >= (cfg.machineryMinLevel || 10)) {
      out.machinery   += demand("machinery", "machinery");
    }
    // 重要鉱物: 技術力しきい値
    if (toNum(tech) >= (cfg.rareMineralMinLevel || 30)) {
      out.rareMineral += toNum(base.rareMineral) * count * (1 + toNum(pct.rareMineral) + otherPct);
    }
    // 燃料（移動時のみ強め。mode倍率の fuel を使う）
    fuelTotal += toNum(base.fuel) * toNum(modeMul.fuel) * count * (1 + toNum(pct.fuel) + (pct.fuel === undefined ? otherPct : 0));

    // flat 定数（その兵種が居れば1回加算）
    for (const fk of Object.keys(flat)) {
      if (fk === "fuel") fuelTotal += toNum(flat[fk]);
      else if (out[fk] !== undefined) out[fk] += toNum(flat[fk]);
    }
  }

  // fuel → oil/coal（技術段階・指数）
  const fuelRes = fuelDemandToResource(fuelTotal, tech, cfg);
  out.oil += fuelRes.oil;
  out.coal += fuelRes.coal;

  // 端数整理（負を排除）
  for (const k of Object.keys(out)) out[k] = Math.max(0, out[k]);
  return out;
}

// ============================================================
// 3. 補給経路（§2）
// ============================================================
//
// 首都から目標ステートまでの最短経路を BFS で探す。
//   adjacency : { stateName: [neighbor, ...] }
//   passable(name) : そのステートを補給線が通れるか（自国/同盟/占領 かつ 敵占領下でない, §2.2）
//   infraOf(name)  : インフラレベル（タイブレーク・コスト用）
// 戻り値: { path:[...]|null, hops, cost, routeEfficiency }
export function findSupplyPath(capital, target, adjacency, passable, infraOf, cfg = WAR_CONFIG_DEFAULTS) {
  if (!capital || !target) return { path: null, hops: Infinity, cost: Infinity, routeEfficiency: 0 };
  if (capital === target) {
    return { path: [capital], hops: 0, cost: stateSupplyCost(target, infraOf, cfg), routeEfficiency: 1 };
  }
  const adj = adjacency || {};
  const visited = new Set([capital]);
  const queue = [[capital]];
  while (queue.length) {
    const path = queue.shift();
    const last = path[path.length - 1];
    const neighbors = adj[last] || [];
    for (const nb of neighbors) {
      if (visited.has(nb)) continue;
      // 目標自身は通行可否に関係なく到達可（そこに部隊が居る）。中間は passable 必須。
      const isTarget = nb === target;
      if (!isTarget && !(passable ? passable(nb) : true)) { visited.add(nb); continue; }
      const next = path.concat(nb);
      if (isTarget) {
        const cost = pathCost(next, infraOf, cfg);
        const eff = routeEfficiencyFromCost(next.length - 1, cfg);
        return { path: next, hops: next.length - 1, cost, routeEfficiency: eff };
      }
      visited.add(nb);
      queue.push(next);
    }
  }
  return { path: null, hops: Infinity, cost: Infinity, routeEfficiency: 0 };
}

function stateSupplyCost(name, infraOf, cfg) {
  const base = cfg.supplyBaseCost != null ? cfg.supplyBaseCost : 1.0;
  const f = cfg.supplyInfraFactor != null ? cfg.supplyInfraFactor : 0.05;
  const infra = infraOf ? toNum(infraOf(name)) : 0;
  return base / (1 + f * infra);
}
function pathCost(path, infraOf, cfg) {
  let c = 0;
  for (const n of path) c += stateSupplyCost(n, infraOf, cfg);
  return c;
}
// 経路が長いほど効率が落ちる（ホップ数で減衰）。1ホップ=1.0付近、遠方で低下。
function routeEfficiencyFromCost(hops, cfg) {
  return clamp(1 / (1 + 0.10 * Math.max(0, hops)), 0, 1);
}

// ============================================================
// 4. 補給充足率（§3.3）
// ============================================================
//
// 国家在庫(stockpile)に対する需要(needs)の充足比 ratio[k] と、
// 補給経路効率(routeEfficiency)から軍の supplyLevel を出す。
//   weights = cfg.supplyWeights（food/militaryGoods/fuel/parts/machinery）
//   fuel カテゴリは oil+coal をまとめて評価。
export function computeSupplyLevel(demand, ratioByKey, routeEfficiency, cfg = WAR_CONFIG_DEFAULTS) {
  const w = cfg.supplyWeights || WAR_CONFIG_DEFAULTS.supplyWeights;
  // カテゴリ → 実キー
  const catKeys = {
    food: ["food"], militaryGoods: ["militaryGoods"], fuel: ["oil", "coal"],
    parts: ["parts"], machinery: ["machinery"]
  };
  let num = 0, den = 0;
  for (const cat of Object.keys(w)) {
    const keys = catKeys[cat] || [cat];
    // そのカテゴリの需要があるか（需要0のカテゴリは無視, §3.3）
    let catDemand = 0, ratioWeighted = 0;
    for (const k of keys) {
      const d = toNum(demand && demand[k]);
      const r = ratioByKey && ratioByKey[k] != null ? clamp(toNum(ratioByKey[k]), 0, 1) : 1;
      catDemand += d;
      ratioWeighted += d * r;
    }
    if (catDemand <= 0) continue;
    const catRatio = ratioWeighted / catDemand;
    num += w[cat] * catRatio;
    den += w[cat];
  }
  const supplyByStock = den > 0 ? (num / den) : 1;
  return clamp(supplyByStock * clamp(toNum(routeEfficiency), 0, 1), 0, 1);
}

// 補給→AP上限（§3.4）: apMax × (0.4 + 0.6 × supplyLevel)
export function apMaxForSupply(supplyLevel, cfg = WAR_CONFIG_DEFAULTS) {
  const base = cfg.apMax != null ? cfg.apMax : 50;
  return base * (0.4 + 0.6 * clamp(toNum(supplyLevel), 0, 1));
}

// ============================================================
// 5. 戦闘の補正係数（§8.3）
// ============================================================
//
// ctx: {
//   isDefensive, mode, atCapitalOrAdjacent(bool), enemyProfile, supplyLevel, doctrineKey
// }
function supplyFactorAtk(s) { return 0.5 + 0.5 * clamp(toNum(s), 0, 1); }
function supplyFactorDef(s) { return 0.6 + 0.4 * clamp(toNum(s), 0, 1); }

// 火砲の対歩兵バフ（攻撃側 profile, 防御側 profile）→ 倍率
function artilleryFactor(att, def) {
  // 攻撃側が火砲系 or artilleryVsInfantry タグを持つか
  const hasArtillery = att.catCount.artillery > 0 || att.tags.has("artilleryVsInfantry");
  if (!hasArtillery) return 1;
  // 防御側が「歩兵系を含む or 特殊兵を一切持たない」
  if (!def.hasInfantryComponent) return 1;
  let buff = 0.50;
  if (att.tags.has("extraVsInfantry025")) buff += 0.25; // 榴弾砲
  // 防御側に精鋭/散兵がいると半減（重複しない, §4）
  if (def.tags.has("halveArtilleryVsInfantry")) buff *= 0.5;
  return 1 + buff;
}

function capitalAuraFactor(profile, atCapitalOrAdjacent) {
  if (!profile.tags.has("capitalAura")) return 1;
  return atCapitalOrAdjacent ? 1.25 : 0.5; // 近衛兵（§4）
}

export function atkBonus(att, ctx, cfg = WAR_CONFIG_DEFAULTS) {
  const doc = (cfg.doctrines && cfg.doctrines[ctx.doctrineKey]) || cfg.doctrines.balanced;
  let b = 1.0;
  b *= supplyFactorAtk(ctx.supplyLevel);
  b *= att.attackMult;
  b *= artilleryFactor(att, ctx.enemyProfile || emptyProfile());
  b *= doc.atk;
  b *= capitalAuraFactor(att, ctx.atCapitalOrAdjacent);
  if (ctx.annihilation) b *= (cfg.annihilationDebuff != null ? cfg.annihilationDebuff : 0.7);
  return b;
}

export function defBonus(def, ctx, cfg = WAR_CONFIG_DEFAULTS) {
  const doc = (cfg.doctrines && cfg.doctrines[ctx.doctrineKey]) || cfg.doctrines.balanced;
  let b = 1.0;
  b *= supplyFactorDef(ctx.supplyLevel);
  b *= def.defenseMult;
  if (ctx.isDefensive) b *= 1.5;        // 防衛戦（§8.3）
  if (ctx.mode === "defend") b *= 1.4;  // 防衛配置
  b *= doc.def;
  b *= capitalAuraFactor(def, ctx.atCapitalOrAdjacent);
  if (ctx.annihilation) b *= (cfg.annihilationDebuff != null ? cfg.annihilationDebuff : 0.7);
  return b;
}

function emptyProfile() {
  return { catCount: { infantry: 0, cavalry: 0, artillery: 0, vehicle: 0 }, tags: new Set(), hasInfantryComponent: true };
}

// ============================================================
// 6. 戦闘1単位時間（§8.2）
// ============================================================
//
// side = { army, tech, profile, ctx, militaryGoodsRatio }
//   militaryGoodsRatio: その軍の軍需充足（0.5〜1.0）
// 返り値: { aDeaths, dDeaths, militaryGoodsUsed, aPenalized, dPenalized }
//   a = 攻撃側(attacker), d = 防御側(defender) の損失
export function combatRound(attacker, defender, cfg = WAR_CONFIG_DEFAULTS, rng = Math.random) {
  const aProf = attacker.profile || computeArmyProfile(attacker.army, attacker.tech, cfg);
  const dProf = defender.profile || computeArmyProfile(defender.army, defender.tech, cfg);

  const aCtx = Object.assign({}, attacker.ctx, { enemyProfile: dProf });
  const dCtx = Object.assign({}, defender.ctx, { enemyProfile: aProf });

  const dDeaths = resolveDamage(attacker, defender, aProf, dProf, aCtx, dCtx, cfg, rng);
  const aDeaths = resolveDamage(defender, attacker, dProf, aProf, dCtx, aCtx, cfg, rng);

  const aT = armyTroops(attacker.army), dT = armyTroops(defender.army);
  const mgPerTroop = (cfg.combatRound && cfg.combatRound.militaryGoodsPerTroopPerRound) || 0.005;
  const militaryGoodsUsed = (aT + dT) * mgPerTroop;

  return {
    aDeaths: Math.min(aT, aDeaths),
    dDeaths: Math.min(dT, dDeaths),
    militaryGoodsUsed
  };
}

// 攻撃側(att) が 防御側(def) に与える死亡数
function resolveDamage(att, def, attProf, defProf, attCtx, defCtx, cfg, rng) {
  const attTroops = armyTroops(att.army);
  if (attTroops <= 0) return 0;

  let attackPower = attTroops * attackPerSoldier(att.tech, cfg) * atkBonus(attProf, attCtx, cfg);

  // 乱数係数（既定は1.0）
  const dv = cfg.damageVariance || { min: 1, max: 1 };
  if (dv.max > dv.min) attackPower *= (dv.min + rng() * (dv.max - dv.min));

  // 貫徹判定: 攻撃側貫徹 < 防御側装甲 → -75%
  if (attProf.penetration < defProf.armor) {
    attackPower *= (cfg.penetrationPenalty != null ? cfg.penetrationPenalty : 0.25);
  }

  // 軍需充足
  attackPower *= clamp(toNum(att.militaryGoodsRatio != null ? att.militaryGoodsRatio : 1), 0, 1);

  // 防御側1兵の実効耐久
  const defDurPerSoldier = Math.max(0.1, defPerSoldier(def.tech, cfg) * defBonus(defProf, defCtx, cfg));

  return Math.floor(attackPower / defDurPerSoldier);
}

// ============================================================
// 7. 撤退・降伏（§8.5 / §8.5.1）
// ============================================================

// 士気撤退の発生判定: (100 - morale)% で true
export function moraleRetreat(morale, cfg = WAR_CONFIG_DEFAULTS, rng = Math.random) {
  const max = cfg.moraleMax || 100;
  const p = clamp((max - toNum(morale)) / max, 0, 1);
  return rng() < p;
}

// 1ユニットの撤退判定（士気 or AP）。逃げ場の有無で殲滅戦/降伏に分岐。
//   hasEscape: 撤退先が1つ以上あるか
// 返り値: "stay" | "retreat" | "annihilate" | "surrender"
export function retreatDecision(army, hasEscape, cfg = WAR_CONFIG_DEFAULTS, rng = Math.random) {
  const apOut = toNum(army.ap) <= 0;
  const wantRetreat = apOut || moraleRetreat(army.morale, cfg, rng);

  if (army.mode === "annihilating") {
    // 強制殲滅戦中: 士気0で無条件降伏（§8.5.1）
    if (toNum(army.morale) <= (cfg.surrenderAtMorale != null ? cfg.surrenderAtMorale : 0)) return "surrender";
    // 包囲が解けて逃げ場が復活したら通常撤退に戻れる
    if (hasEscape && wantRetreat) return "retreat";
    return "annihilate";
  }
  if (!wantRetreat) return "stay";
  return hasEscape ? "retreat" : "annihilate"; // 逃げ場なし→強制殲滅戦へ
}

// 死亡数から士気の減少を反映（§4: 1兵死亡で-1）。戻り値は新しい morale。
export function applyMoraleLoss(morale, deaths, cfg = WAR_CONFIG_DEFAULTS) {
  const per = cfg.moraleLossPerDeath != null ? cfg.moraleLossPerDeath : 1;
  return clamp(toNum(morale) - toNum(deaths) * per, 0, cfg.moraleMax || 100);
}

// 毎ターンの士気回復（補給で変動, §3.4）。戻り値は新しい morale。
export function applyMoraleRegen(morale, supplyLevel, cfg = WAR_CONFIG_DEFAULTS) {
  const regen = (cfg.moraleRegen != null ? cfg.moraleRegen : 5) * clamp(toNum(supplyLevel), 0, 1);
  return clamp(toNum(morale) + regen, 0, cfg.moraleMax || 100);
}
