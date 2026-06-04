/**
 * Aster Stella - 経済計算の3分割（スプレッドシート数式化のための基盤）
 *
 * 旧 applyEconomy_（Code.gs）の処理を、意味を変えずに3段へ分解する:
 *   econAggregate_(n,nid,states,world,cfg,tradeVol) … ①各ステートの産業集計（反復・乱数）→ 入力行(inputRow)
 *   econFormulas_(inp,cfg)                          … ②国家レベルの経済式 → 出力行(outputRow)  ★スプレッドシート数式のJSミラー
 *   econApply_(n,nid,states,inp,out,cfg)            … ③結果を国家/ステートへ適用（乱数の研究昇格・民間拡大もここ）
 *
 * ②は「計算_経済」シートのセル数式と同じ計算をする。シートが使える時はシート結果を、
 * 使えない/未検証の時は econFormulas_ をフォールバックに使う（runTurn 側で切替）。
 * これにより「経済式を運営がシートで調整」しつつ、計算の正しさを node で検証できる。
 *
 * Code.gs と同じグローバル（INDUSTRY_RULES, FLOW_KEYS, te/ideo/eco/pol ヘルパー等）を共有。
 */

// 入力行・出力行の列順（「入力_国家」「計算_経済」シートと Sheets.gs の数式生成で共有）
var ECON_INPUT_FIELDS = [
  "nationId", "nationName",
  "taxRate", "worldValue", "stateCount", "totalPop", "totalDev", "avgGov", "civCount",
  "upkeep", "economyOutput", "economyDecay", "researchOutput",
  "currentEconomySum", "currentTreasury", "currentPP", "currentTrend",
  "ideoTax", "ppMult", "popIdeo", "worldDamp", "researchMult",
  "allocIndustrial", "allocMilitary", "trackIndustrial", "trackMilitary",
  "tradeVolume", "expandProb"
];
// FLOW_KEYS ごとに prod_/cons_/stock_ を持つ（列はこの順に展開）
function econFlowCols_(prefix) { return FLOW_KEYS.map(function (k) { return prefix + k; }); }

var ECON_OUTPUT_FIELDS = [
  "nationId",
  "satisfyRatio", "deficits", "taxIncome", "treasuryDelta", "ppDelta",
  "researchIndustrialAdd", "researchMilitaryAdd",
  "economyGrowthRate", "economyAddPerState", "newTotalEconomy",
  "popGrowth", "governanceDelta", "newTrend", "netEconomy"
];

// ============================================================
// ① 集計（各ステートの産業を回す。乱数 rnd_ はここ）
// ============================================================
function econAggregate_(n, nid, states, world, cfg, tradeVolume) {
  if (!n.stats) n.stats = {};
  if (!n.research) n.research = { tracks: { industrial: 0, military: 0 }, allocation: { industrial: 0.5, military: 0.5 }, upgrades: {} };
  var stock = ensureStock_(n);
  var own = ownStates_(nid, states);
  var tech = Number(n.stats.industrialTech) || 0;
  var eco = n.ideology || "", gov = n.government || "";
  var te = techEff_(tech);
  var civ = civIdeo_(eco);
  var trend = isFinite(Number(n.stats.economyTrend)) ? Number(n.stats.economyTrend) : 10;

  var production = {}, consumption = {};
  FLOW_KEYS.forEach(function (k) { production[k] = 0; consumption[k] = 0; });
  var economyOutput = 0, economyDecay = 0, researchOutput = 0, upkeep = 0, civCount = 0;
  var totalPop = 0, totalDev = 0, govSum = 0, count = 0, currentEconomySum = 0;

  own.forEach(function (o) { totalPop += Number(o.s.population) || 0; totalDev += Number(o.s.development) || 0; });

  own.forEach(function (o) {
    var s = o.s, inds = s.industries || {};
    var se = stateEff_(s);
    Object.keys(INDUSTRY_RULES).forEach(function (key) {
      var c = Number(inds[key]) || 0;
      if (c <= 0) return;
      var rule = INDUSTRY_RULES[key];
      var mult = te * rnd_(cfg) * se;
      if (rule.special !== "civilian") mult *= ideoMult_(key, eco, gov);
      if (rule.reserve) mult *= reserveEff_(s.resources && s.resources[rule.reserve]);
      if (rule.techBonus && tech >= rule.techBonus.threshold) {
        mult *= rule.techBonus.mult;
        if (rule.techBonus.extra) Object.keys(rule.techBonus.extra).forEach(function (k) { consumption[k] += rule.techBonus.extra[k] * c; });
      }
      if (rule.inputs) Object.keys(rule.inputs).forEach(function (k) { consumption[k] += rule.inputs[k] * c; });
      if (rule.altInput && rule.altInput.length) { var pk = rule.altInput[0]; consumption[pk.res] += pk.amount * c; }
      if (rule.special === "civilian") {
        civCount += c;
        economyOutput += rule.base * c * mult * civ.outputMult;
        if (trend < 10) economyDecay += cfg.civilianDecayBase * c * (10 - trend) / 10 * civ.decayMult;
      } else if (rule.special === "university") {
        researchOutput += univResearch_(s.governance, s.development, cfg.researchUniBase) * c * te;
        upkeep += rule.upkeep * c;
      } else if (rule.out === "research") {
        researchOutput += rule.base * c * mult;
      } else {
        production[rule.out] += rule.base * c * mult;
      }
    });
  });

  // 人口あたり消費
  var pc = perCapita_(tech, totalDev, totalPop), units = totalPop / 10;
  consumption.consumerGoods += pc.consumerGoods * units;
  consumption.food += pc.food * units;
  consumption.heavyGoods += pc.heavyGoods * units;
  consumption.rareMineral += pc.rareMineral * units;
  consumption.parts += pc.parts * units;
  consumption.coal += pc.fuel * units;

  own.forEach(function (o) { govSum += Number(o.s.governance) || 0; count++; currentEconomySum += Number(o.s.economy) || 0; });
  var avgGov = count ? govSum / count : 0;

  var alloc = n.research.allocation || { industrial: 0.5, military: 0.5 };

  return {
    nationId: nid, nationName: n.name || nid,
    taxRate: Number(n.stats.taxRate) || 0,
    worldValue: Number(world.value) || 10,
    stateCount: own.length,
    totalPop: totalPop, totalDev: totalDev, avgGov: avgGov, civCount: civCount,
    upkeep: upkeep, economyOutput: economyOutput, economyDecay: economyDecay, researchOutput: researchOutput,
    currentEconomySum: currentEconomySum,
    currentTreasury: Number(n.stats.treasury) || 0,
    currentPP: Number(n.stats.politicalPower) || 0,
    currentTrend: trend,
    ideoTax: ecoEff_(eco).tax * polEff_(gov).tax,
    ppMult: polEff_(gov).ppIncome,
    popIdeo: ecoEff_(eco).popGrowth * polEff_(gov).popGrowth,
    worldDamp: ecoEff_(eco).worldDamp,
    researchMult: ecoEff_(eco).research * polEff_(gov).research,
    allocIndustrial: alloc.industrial || 0,
    allocMilitary: alloc.military || 0,
    trackIndustrial: Number(n.research.tracks.industrial) || 0,
    trackMilitary: Number(n.research.tracks.military) || 0,
    tradeVolume: Number(tradeVolume) || 0,
    expandProb: civ.autoExpand * polEff_(gov).civExpand,
    production: production, consumption: consumption, stock: cloneFlow_(stock)
  };
}

// ============================================================
// ② 国家レベルの経済式（★「計算_経済」シートのセル数式と同じ計算）
// ============================================================
function econFormulas_(inp, cfg) {
  var newStock = {};
  var satisfiedCount = 0, demandCount = 0, deficits = 0;
  FLOW_KEYS.forEach(function (k) {
    var available = (Number(inp.stock[k]) || 0) + (Number(inp.production[k]) || 0);
    var demand = Number(inp.consumption[k]) || 0;
    if (demand > 0) { demandCount++; if (available >= demand) satisfiedCount++; else deficits++; }
    var leftover = available - demand;
    newStock[k] = leftover > 0 ? leftover : 0;
  });
  var satisfyRatio = demandCount > 0 ? satisfiedCount / demandCount : 1;

  var worldAdj = inp.economyOutput * (1 + (inp.worldValue - 10) / 100);
  var netEconomy = worldAdj - inp.economyDecay;

  var govDebuff = Math.max(0.2, Math.min(1.2, inp.avgGov / 50));
  var taxIncome = netEconomy * govDebuff * inp.ideoTax * inp.taxRate * cfg.taxBase;

  var upT = cfg.stateUpkeepBase * Math.pow(inp.stateCount, cfg.stateUpkeepExp);
  var upP = cfg.statePpUpkeepBase * Math.pow(inp.stateCount, cfg.statePpUpkeepExp);
  var treasuryDelta = taxIncome - inp.upkeep - upT;
  var ppDelta = cfg.ppIncomeBase * inp.ppMult - upP;

  var researchOut = inp.researchOutput * inp.researchMult;
  var researchIndustrialAdd = researchOut * inp.allocIndustrial;
  var researchMilitaryAdd = researchOut * inp.allocMilitary;

  var passive = inp.currentTrend >= 0 ? inp.currentTrend * cfg.passiveGrowthPerTrend : 0;
  var economyGrowthRate = satisfyRatio * 0.02 + passive;
  var economyAddPerState = netEconomy / Math.max(1, inp.stateCount) * 0.01;
  var newTotalEconomy = inp.currentEconomySum * (1 + economyGrowthRate) + inp.stateCount * economyAddPerState;
  if (newTotalEconomy < 0) newTotalEconomy = 0;

  var taxPenalty = 1 - inp.taxRate * 0.3;
  var popGrowth = Math.min(cfg.popGrowthMax, (satisfyRatio / 2) * cfg.popGrowthMax / 0.5) * taxPenalty * inp.popIdeo;

  var governanceDelta = -(inp.taxRate) * 1 - deficits * cfg.deficitGovernancePenalty * 0.1;

  var influence = newTotalEconomy > 0 ? Math.min(1, inp.tradeVolume / newTotalEconomy) : 0;
  var pull = (0.1 + 0.6 * influence) * inp.worldDamp;
  var newTrend = inp.currentTrend * (1 - pull) + inp.worldValue * pull;
  newTrend = Math.max(-100, Math.min(100, newTrend)); // 景気の変域 -100〜100

  return {
    nationId: inp.nationId,
    satisfyRatio: satisfyRatio, deficits: deficits,
    taxIncome: taxIncome, treasuryDelta: treasuryDelta, ppDelta: ppDelta,
    researchIndustrialAdd: researchIndustrialAdd, researchMilitaryAdd: researchMilitaryAdd,
    economyGrowthRate: economyGrowthRate, economyAddPerState: economyAddPerState, newTotalEconomy: newTotalEconomy,
    popGrowth: popGrowth, governanceDelta: governanceDelta, newTrend: newTrend, netEconomy: netEconomy,
    newStock: newStock
  };
}

// ============================================================
// ③ 適用（結果を国家/ステートへ。乱数の研究昇格・民間拡大もここ）
// ============================================================
function econApply_(n, nid, states, inp, out, cfg) {
  // 在庫
  n.stockpile = out.newStock;
  // 国庫・政治力
  n.stats.treasury = (Number(n.stats.treasury) || 0) + out.treasuryDelta;
  n.stats.politicalPower = (Number(n.stats.politicalPower) || 0) + out.ppDelta;
  // 研究
  n.research.tracks.industrial = (Number(n.research.tracks.industrial) || 0) + out.researchIndustrialAdd;
  n.research.tracks.military = (Number(n.research.tracks.military) || 0) + out.researchMilitaryAdd;
  rollResearchUpgrade_(n); // 乱数

  var own = ownStates_(nid, states);
  // ステート経済（一律成長率＋一律加算）
  var totalEconomy = 0;
  own.forEach(function (o) {
    o.s.economy = (Number(o.s.economy) || 0) * (1 + out.economyGrowthRate) + out.economyAddPerState;
    if (o.s.economy < 0) o.s.economy = 0;
    totalEconomy += o.s.economy;
  });
  // 人口
  own.forEach(function (o) { o.s.population = (Number(o.s.population) || 0) * (1 + out.popGrowth); });
  // 統治
  own.forEach(function (o) { o.s.governance = Math.max(0, (Number(o.s.governance) || 0) + out.governanceDelta); });

  n.stats.economyTrend = out.newTrend;
  n.stats.totalEconomy = totalEconomy;
  n.stats.totalPopulation = inp.totalPop; // 旧仕様: 増加前の totalPop を保存

  // 民間産業の自然拡大（乱数）
  autoExpandCivilian_(n, own, inp.expandProb, out.satisfyRatio, inp.totalPop, inp.civCount, cfg);

  n.logs.push({ at: Date.now(), kind: "turn", text: "ターン処理: 税収 " + Math.round(out.taxIncome) + " / 充足率 " + Math.round(out.satisfyRatio * 100) + "%" + (inp.economyDecay > 0 ? " / 経済減衰 " + Math.round(inp.economyDecay) : "") + (out.deficits ? " / 不足 " + out.deficits + "種" : "") });
}

function cloneFlow_(stock) {
  var o = {};
  FLOW_KEYS.forEach(function (k) { o[k] = Number(stock[k]) || 0; });
  return o;
}

// ②の実行: スプレッドシート「計算_経済」が有効ならそれを使い、無ければ JSミラー econFormulas_。
//   inputs: { nid: inputRow }  →  返り値: { nid: outputRow }
function computeEconomyOutputs_(inputs, cfg) {
  // シート経由（運営が「経済計算をシートで行う」をONにしている場合のみ）
  try {
    if (typeof econUseSheet_ === "function" && econUseSheet_()) {
      writeNationInputs_(inputs);
      SpreadsheetApp.flush();
      var sheetOut = readEconomyOutputs_();
      var ok = true;
      Object.keys(inputs).forEach(function (nid) {
        var o = sheetOut[nid];
        if (!o || !isFinite(o.taxIncome) || !isFinite(o.treasuryDelta)) ok = false;
      });
      if (ok) return sheetOut;
      Logger.log("経済シートの出力が不正。JSミラーにフォールバック。");
    }
  } catch (e) {
    Logger.log("経済シート計算エラー（JSミラーにフォールバック）: " + e);
  }
  // フォールバック: JSミラー（econFormulas_）。Config シートの係数で調整可能。
  var out = {};
  Object.keys(inputs).forEach(function (nid) { out[nid] = econFormulas_(inputs[nid], cfg); });
  return out;
}
