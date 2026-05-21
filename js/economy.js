// Aster Stella - 共有経済モデル
//
// 仕様書「最後に詳細」に忠実に、産業の消費/生産、民間産業の特殊挙動、
// 大学の統治/開発依存、人口あたり消費、世界景気の影響、建設可否/コストを定義する。
// player側（経済タブのプレビュー）と GAS（実際のターン処理）で同じ式を使う。
//
// 注意: GAS(Apps Script)はESモジュールを読めないため、gas/Code.gs 側に同じ定数/式を複製している。
//       片方を変えたら両方を合わせること。

// 流通資源（生産・消費・貿易・在庫の対象）
export const FLOW_RESOURCES = [
  { key: "consumerGoods", label: "民需資源" },
  { key: "militaryGoods", label: "軍需資源" },
  { key: "metal",         label: "金属資源" },
  { key: "heavyGoods",    label: "工業製品" },
  { key: "oil",           label: "石油燃料" },
  { key: "coal",          label: "石炭燃料" },
  { key: "food",          label: "食料資源" },
  { key: "parts",         label: "工業部品" },
  { key: "machinery",     label: "機械製品" },
  { key: "rareMineral",   label: "重要鉱物資源" }
];

// 産業ごとの基準ルール。
//   out      : 生産する資源キー（civilian は経済力、university は研究）
//   base     : 基準生産量（効率係数を掛ける前）
//   pop      : 1施設あたりの人口消費
//   inputs   : 固定消費 { 資源: 量 }
//   altInput : どちらか一方を消費 [{res, amount}, ...]（先頭優先で在庫のある方）
//   techBonus: { threshold, extra:{res:amount}, mult } 産業技術力が閾値以上で追加消費＆生産倍率
//   reserve  : 必要な埋蔵資源キー（鉱山・農場）
export const INDUSTRY_RULES = {
  civilian: {
    label: "民間産業", out: "economy", base: 100, pop: 10,
    inputs: { consumerGoods: 1 },
    techBonus: { threshold: 30, extra: { rareMineral: 1 }, mult: 1.5 },
    special: "civilian"
  },
  consumerFactory: {
    label: "民需工場", out: "consumerGoods", base: 10, pop: 25,
    inputs: { parts: 5 }, altInput: [{ res: "coal", amount: 10 }, { res: "oil", amount: 1 }],
    techBonus: { threshold: 40, extra: { rareMineral: 10 }, mult: 3 }
  },
  militaryFactory: {
    label: "軍需工場", out: "militaryGoods", base: 8, pop: 25,
    inputs: { parts: 5, heavyGoods: 10 }, altInput: [{ res: "coal", amount: 75 }, { res: "oil", amount: 5 }]
  },
  metalMine: {
    label: "金属鉱山", out: "metal", base: 20, pop: 10, reserve: "metal"
  },
  heavyChemical: {
    label: "重化学工業", out: "heavyGoods", base: 10, pop: 50,
    inputs: { oil: 25, metal: 50, machinery: 5 },
    techBonus: { threshold: 25, extra: { rareMineral: 25 }, mult: 3 }
  },
  oilField: {
    label: "油田", out: "oil", base: 20, pop: 20, reserve: "oil"
  },
  coalField: {
    label: "炭田", out: "coal", base: 30, pop: 10, reserve: "coal"
  },
  farm: {
    label: "農場", out: "food", base: 20, pop: 5, reserve: "fertility"
  },
  partsFactory: {
    label: "部品工場", out: "parts", base: 15, pop: 15,
    inputs: { metal: 10 }, altInput: [{ res: "coal", amount: 10 }, { res: "oil", amount: 1 }],
    techBonus: { threshold: 30, extra: { rareMineral: 5 }, mult: 2 }
  },
  machineryFactory: {
    label: "機械工場", out: "machinery", base: 10, pop: 25,
    inputs: { oil: 5, parts: 15 },
    techBonus: { threshold: 35, extra: { rareMineral: 10 }, mult: 2 }
  },
  rareMineralMine: {
    label: "重要鉱物鉱山", out: "rareMineral", base: 10, pop: 25, reserve: "rareMineral"
  },
  university: {
    label: "大学", out: "research", base: 5, pop: 20, upkeep: 200, special: "university"
  }
};

// 民間産業のイデオロギー別パラメータ（仕様「特筆」より）。
//   canBuild   : 国(プレイヤー)が建設できるか（計画経済/企業統治経済/戦時経済のみ可）
//   autoExpand : 人口・民需が足りるとき1ターンに自然拡大する確率（計画経済は0）
//   outputMult : 経済力出力の倍率（計画経済は効果が薄い）
//   decayMult  : 不景気時の経済減衰の倍率（計画経済は0＝吐き出さない、純粋資本主義は最も酷い）
export const CIVILIAN_IDEOLOGY = {
  "純粋資本主義":  { canBuild: false, autoExpand: 0.25, outputMult: 1.2, decayMult: 2.5 },
  "計画経済":      { canBuild: true,  autoExpand: 0.0,  outputMult: 0.6, decayMult: 0.0 },
  "福祉経済":      { canBuild: false, autoExpand: 0.07, outputMult: 0.9, decayMult: 1.0 },
  "企業統治経済":  { canBuild: true,  autoExpand: 0.10, outputMult: 1.0, decayMult: 1.0 },
  "戦時経済":      { canBuild: true,  autoExpand: 0.05, outputMult: 0.9, decayMult: 1.2 }
};
export function civilianIdeology(eco) {
  return CIVILIAN_IDEOLOGY[eco] || { canBuild: false, autoExpand: 0.08, outputMult: 1.0, decayMult: 1.0 };
}

// チューニング用定数（GAS Config シートで上書き想定）
export const CONFIG = {
  taxBase: 1.0,
  investDevBase: 100,
  investInfraBase: 100,
  investGovBase: 5,
  taxChangePP: 10,
  conscriptCostPerUnit: 2,
  conscriptPopPerUnit: 1,
  researchUniBase: 5,        // 大学1棟あたり研究基準値
  popGrowthMax: 0.05,
  deficitGovernancePenalty: 2,
  civilianDecayBase: 30,     // 民間産業1棟・景気-1あたりの経済減衰
  civilianExpandPopPer: 200, // 民間産業1棟が自然拡大するのに必要な余剰人口の目安
  randomness: 0.1,
  popPerCivilian: 50         // 民間産業1棟あたりの想定人口（自然拡大の余力判定用）
};

// 産業ごとの建設コスト。treasury(国庫)に加えて、必要に応じて在庫の parts/machinery を消費する。
export const BUILD_COSTS = {
  civilian:         { treasury: 300,  parts: 0,  machinery: 0 },
  consumerFactory:  { treasury: 500,  parts: 20, machinery: 0 },
  militaryFactory:  { treasury: 800,  parts: 20, machinery: 5 },
  metalMine:        { treasury: 400,  parts: 0,  machinery: 0 },
  heavyChemical:    { treasury: 1000, parts: 0,  machinery: 10 },
  oilField:         { treasury: 400,  parts: 0,  machinery: 0 },
  coalField:        { treasury: 400,  parts: 0,  machinery: 0 },
  farm:             { treasury: 300,  parts: 0,  machinery: 0 },
  partsFactory:     { treasury: 500,  parts: 0,  machinery: 5 },
  machineryFactory: { treasury: 800,  parts: 20, machinery: 0 },
  rareMineralMine:  { treasury: 600,  parts: 0,  machinery: 0 },
  university:       { treasury: 2000, parts: 0,  machinery: 0 }
};
export function buildCost(industryKey, count) {
  const c = BUILD_COSTS[industryKey] || { treasury: 500, parts: 0, machinery: 0 };
  const n = Math.max(1, count || 1);
  return { treasury: c.treasury * n, parts: c.parts * n, machinery: c.machinery * n };
}

// 産業技術力に応じた 10人口あたりの消費（仕様「最後に詳細」の表）。
export function perCapitaConsumption(industrialTech, totalDevelopment, population) {
  const t = Number(industrialTech) || 0;
  const fuelUnit = population > 0 ? (Number(totalDevelopment) || 0) / population : 0;
  const c = { consumerGoods: 0, food: 0, fuel: 0, heavyGoods: 0, rareMineral: 0, parts: 0 };
  if (t < 5)       { c.food = 5; }
  else if (t < 10) { c.consumerGoods = 1; c.food = 8; }
  else if (t < 15) { c.consumerGoods = 2; c.food = 10; }
  else if (t < 20) { c.consumerGoods = 2; c.food = 10; c.fuel = fuelUnit; }
  else if (t < 25) { c.consumerGoods = 3; c.food = 10; c.fuel = fuelUnit; c.heavyGoods = 1; }
  else if (t < 30) { c.consumerGoods = 5; c.food = 10; c.fuel = fuelUnit; c.heavyGoods = 3; }
  else if (t < 40) { c.consumerGoods = 8; c.food = 10; c.fuel = fuelUnit * 2; c.heavyGoods = 5; }
  else if (t < 50) { c.consumerGoods = 15; c.food = 10; c.fuel = fuelUnit * 2; c.heavyGoods = 10; c.rareMineral = 5; }
  else if (t < 60) { c.consumerGoods = 20; c.food = 10; c.fuel = fuelUnit * 2; c.heavyGoods = 10; c.rareMineral = 10; }
  else             { c.consumerGoods = 25; c.food = 15; c.fuel = fuelUnit * 2; c.heavyGoods = 15; c.rareMineral = 10; c.parts = 20; }
  return c;
}

// 鉱山系の埋蔵量による効率係数（埋蔵が多いほど効率が上がる）。
export function reserveEfficiency(reserveAmount) {
  const r = Number(reserveAmount) || 0;
  if (r <= 0) return 0;
  return 0.5 + Math.min(1.5, r / 50);
}

// 工場系（イデオロギー効率ボーナスの対象）
const FACTORY_KEYS = {
  consumerFactory: 1, militaryFactory: 1, partsFactory: 1, machineryFactory: 1, heavyChemical: 1
};

// イデオロギーによる産業効率補正（民間産業以外）。経済＋政体の両方。
export function ideologyMultiplier(industryKey, economicIdeology, government) {
  let m = 1;
  if (industryKey === "farm") {
    if (economicIdeology === "純粋資本主義") m *= 0.8;
    if (economicIdeology === "計画経済") m *= 1.2;
    if (government === "共産主義") m *= 1.2;
  }
  if (industryKey === "consumerFactory" && economicIdeology === "戦時経済") m *= 0.8;
  if (industryKey === "militaryFactory") {
    if (economicIdeology === "戦時経済") m *= 1.3;
    if (government === "軍事独裁") m *= 1.3;
  }
  if (FACTORY_KEYS[industryKey] && economicIdeology === "企業統治経済") m *= 1.15;
  return m;
}

// イデオロギー全体効果テーブル（要素一覧 10章）。値は倍率。1.0が基準。
export const ECO_EFFECTS = {
  "純粋資本主義": { tax: 0.9, popGrowth: 1.0, research: 1.0, conscriptCost: 1.0, worldDamp: 1.0 },
  "計画経済":     { tax: 1.0, popGrowth: 1.0, research: 1.0, conscriptCost: 1.0, worldDamp: 0.5 },
  "福祉経済":     { tax: 1.1, popGrowth: 1.2, research: 1.0, conscriptCost: 1.1, worldDamp: 1.0 },
  "企業統治経済": { tax: 1.0, popGrowth: 1.0, research: 1.0, conscriptCost: 1.0, worldDamp: 1.0 },
  "戦時経済":     { tax: 1.0, popGrowth: 0.9, research: 1.0, conscriptCost: 0.7, worldDamp: 1.0 }
};
export const POL_EFFECTS = {
  "自由民主主義": { tax: 1.0,  popGrowth: 1.0,  research: 1.2, ppIncome: 1.2, conscriptCost: 1.0, civExpand: 1.0 },
  "社会民主主義": { tax: 1.05, popGrowth: 1.15, research: 1.0, ppIncome: 1.0, conscriptCost: 1.0, civExpand: 1.0 },
  "共産主義":     { tax: 1.0,  popGrowth: 1.0,  research: 1.0, ppIncome: 1.0, conscriptCost: 1.0, civExpand: 0.4 },
  "絶対君主主義": { tax: 1.1,  popGrowth: 1.0,  research: 0.8, ppIncome: 1.3, conscriptCost: 1.0, civExpand: 1.0 },
  "軍事独裁":     { tax: 1.0,  popGrowth: 1.0,  research: 0.8, ppIncome: 1.0, conscriptCost: 0.7, civExpand: 1.0 }
};
const ECO_DEFAULT = { tax: 1, popGrowth: 1, research: 1, conscriptCost: 1, worldDamp: 1 };
const POL_DEFAULT = { tax: 1, popGrowth: 1, research: 1, ppIncome: 1, conscriptCost: 1, civExpand: 1 };
export function ecoEff(eco) { return ECO_EFFECTS[eco] || ECO_DEFAULT; }
export function polEff(gov) { return POL_EFFECTS[gov] || POL_DEFAULT; }

// ステートの効率係数（人口の充足・インフラ規模・開発度）。出力に掛ける。
// これらは建設の可否ではなく「効率」に影響する。
export function stateEfficiency(state) {
  const inds = state.industries || {};
  let count = 0, popDemand = 0;
  for (const k of Object.keys(INDUSTRY_RULES)) {
    const c = Number(inds[k]) || 0;
    count += c;
    popDemand += (INDUSTRY_RULES[k].pop || 0) * c;
  }
  const pop = Number(state.population) || 0;
  const staffing = popDemand > 0 ? Math.min(1, pop / popDemand) : 1;       // 人口が足りているか
  const infra = count > 0 ? Math.min(1, (Number(state.infrastructure) || 0) / count) : 1; // インフラが規模に見合うか
  const dev = 0.5 + Math.min(1.0, (Number(state.development) || 0) / 100);  // 開発度（0.5〜1.5）
  return { staffing, infra, dev, mult: staffing * infra * dev, count, popDemand };
}

// 産業技術力による全体効率（高いほど上がる）。
export function techEfficiency(industrialTech) {
  return 1 + (Number(industrialTech) || 0) / 200;
}

// 大学の研究効率: 統治レベルと開発度に「異常に」左右される（積で効く）。
export function universityResearch(stateGovernance, stateDevelopment, base) {
  const g = (Number(stateGovernance) || 0) / 50;
  const d = (Number(stateDevelopment) || 0) / 50;
  return (base || CONFIG.researchUniBase) * g * d;
}

// 建設可否の判定。
// ゲートは「埋蔵量（鉱山・農場系）」と「民間産業のイデオロギー制限」のみ。
// 人口・開発度・インフラは建設の可否ではなく効率（stateEfficiency）に影響する。
// 戻り値: { ok:boolean, reason:string }
export function canBuildIndustry(industryKey, state, nation, count) {
  const rule = INDUSTRY_RULES[industryKey];
  if (!rule) return { ok: false, reason: "不明な産業" };

  // 民間産業はイデオロギー制限（計画経済/企業統治経済/戦時経済のみ建設可）
  if (industryKey === "civilian" && !civilianIdeology(nation.ideology).canBuild) {
    return { ok: false, reason: "民間産業はこのイデオロギーでは建設不可（自然拡大します）" };
  }
  // 埋蔵が必要な産業は埋蔵量がなければ建設不可
  if (rule.reserve) {
    const reserve = Number(state.resources && state.resources[rule.reserve]) || 0;
    if (reserve <= 0) return { ok: false, reason: "このステートに必要な埋蔵資源がありません" };
  }
  return { ok: true, reason: "" };
}

// 集計済みの自国産業数・資源埋蔵・ステータスから、1ターンの収支を試算する。
// states: 自国ステートの配列（normalizeState 済み）
export function computeTurn(nation, ownStates, world) {
  const tech = Number(nation.stats.industrialTech) || 0;
  const eco = nation.ideology || "";
  const gov = nation.government || "";
  const trend = Number(nation.stats.economyTrend);
  const economyTrend = isFinite(trend) ? trend : 10;
  const techEff = techEfficiency(tech);
  const civIdeo = civilianIdeology(eco);

  const production = {};
  const consumption = {};
  for (const r of FLOW_RESOURCES) { production[r.key] = 0; consumption[r.key] = 0; }
  let economyOutput = 0;
  let economyDecay = 0;
  let researchOutput = 0;
  let popUsed = 0;
  let universityUpkeep = 0;
  let civilianCount = 0;

  let totalPopulation = 0;
  let totalDevelopment = 0;
  for (const s of ownStates) {
    totalPopulation += Number(s.population) || 0;
    totalDevelopment += Number(s.development) || 0;
  }

  for (const s of ownStates) {
    const inds = s.industries || {};
    const sEff = stateEfficiency(s); // 人口充足・インフラ・開発度の効率係数
    for (const key of Object.keys(INDUSTRY_RULES)) {
      const count = Number(inds[key]) || 0;
      if (count <= 0) continue;
      const rule = INDUSTRY_RULES[key];
      popUsed += rule.pop * count;

      let mult = techEff * sEff.mult;
      if (rule.special !== "civilian") mult *= ideologyMultiplier(key, eco, gov);
      if (rule.reserve) mult *= reserveEfficiency((s.resources && s.resources[rule.reserve]) || 0);
      if (rule.techBonus && tech >= rule.techBonus.threshold) {
        mult *= rule.techBonus.mult;
        if (rule.techBonus.extra) {
          for (const k of Object.keys(rule.techBonus.extra)) {
            consumption[k] = (consumption[k] || 0) + rule.techBonus.extra[k] * count;
          }
        }
      }
      if (rule.inputs) {
        for (const k of Object.keys(rule.inputs)) {
          consumption[k] = (consumption[k] || 0) + rule.inputs[k] * count;
        }
      }
      if (rule.altInput && rule.altInput.length) {
        const pick = rule.altInput[0];
        consumption[pick.res] = (consumption[pick.res] || 0) + pick.amount * count;
      }

      if (rule.special === "civilian") {
        civilianCount += count;
        economyOutput += rule.base * count * mult * civIdeo.outputMult;
        // 不景気（景気<10）のとき経済減衰を吐き出す
        if (economyTrend < 10) {
          economyDecay += CONFIG.civilianDecayBase * count * (10 - economyTrend) / 10 * civIdeo.decayMult;
        }
      } else if (rule.special === "university") {
        researchOutput += universityResearch(s.governance, s.development, rule.base) * count * techEff;
        universityUpkeep += rule.upkeep * count;
      } else if (rule.out === "research") {
        researchOutput += rule.base * count * mult;
      } else {
        production[rule.out] = (production[rule.out] || 0) + rule.base * count * mult;
      }
    }
  }

  // 人口あたり消費
  const pc = perCapitaConsumption(tech, totalDevelopment, totalPopulation);
  const units = totalPopulation / 10;
  consumption.consumerGoods += pc.consumerGoods * units;
  consumption.food += pc.food * units;
  consumption.heavyGoods += pc.heavyGoods * units;
  consumption.rareMineral += pc.rareMineral * units;
  consumption.parts += pc.parts * units;
  consumption.coal += pc.fuel * units; // 燃料は石炭優先

  const surplus = {};
  const deficits = [];
  for (const r of FLOW_RESOURCES) {
    surplus[r.key] = (production[r.key] || 0) - (consumption[r.key] || 0);
    if (surplus[r.key] < 0) deficits.push(r.key);
  }

  // イデオロギーによる研究補正
  researchOutput *= ecoEff(eco).research * polEff(gov).research;

  const worldTrend = world && isFinite(Number(world.value)) ? Number(world.value) : 10;
  const trendFactor = 1 + (worldTrend - 10) / 100;
  const netEconomy = economyOutput * trendFactor - economyDecay;

  return {
    production, consumption, surplus,
    economyOutput, economyDecay, netEconomy, researchOutput,
    popUsed, universityUpkeep, civilianCount,
    deficits, totalPopulation, totalDevelopment, trendFactor
  };
}

// 投資コスト（開発度/インフラは現在値+1に比例）
export function investCost(kind, currentLevel) {
  const lv = (Number(currentLevel) || 0) + 1;
  if (kind === "development") return CONFIG.investDevBase * lv;
  if (kind === "infrastructure") return CONFIG.investInfraBase * lv;
  if (kind === "governance") return CONFIG.investGovBase * lv;
  return 0;
}
