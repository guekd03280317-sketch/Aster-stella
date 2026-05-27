/****************************************************************************
 * Aster Stella - GAS ターン処理エンジン
 *
 * 役割:
 *   - 一定時刻に runTurn() を実行し、全国家の予約(orders)を一斉処理する
 *   - 産業稼働・資源生産消費・税収・研究・人口増減・世界景気ルーレットを反映
 *   - ログ追記、市場価格の統計更新、履歴(history)の追加
 *   - 毎日 backupToSheets() でスプレッドシートに全データをバックアップ
 *   - doGet/doPost で「データを吐き出すAPI」「値を入力するAPI」を提供
 *
 * 設定方法:
 *   1. このファイルを Apps Script プロジェクトに貼り付ける
 *   2. スクリプトプロパティに DATABASE_URL / API_KEY を設定（setupProperties で雛形作成）
 *   3. setupTriggers() を一度実行して時間トリガーを作成
 *   4. ウェブアプリとしてデプロイすると doGet/doPost が使える
 *
 * 競合対策:
 *   予約は nations/{id}/orders/{orderId} に1件ずつ入っている。
 *   処理したキーだけを個別に DELETE する（処理中に増えた予約は別キーなので消えない）。
 *   国家の集計値は PATCH（merge）で書き、orders ノードには触れない。
 ****************************************************************************/

// ====== 設定 ======
var SPREADSHEET_ID = "1w39uOQnB_xlbdggIa5QnjrGjAKVMbsM3m2mXy9UVmsI";
var ROOT = "aster_stella";
var HISTORY_MAX = 120; // 履歴の保持件数

function props_() { return PropertiesService.getScriptProperties(); }
function dbUrl_() {
  var u = props_().getProperty("DATABASE_URL");
  if (!u) throw new Error("スクリプトプロパティ DATABASE_URL が未設定です。setupProperties を実行してください。");
  return u.replace(/\/$/, "");
}
function apiKey_() { return props_().getProperty("API_KEY") || ""; }

function setupProperties() {
  var p = props_();
  if (!p.getProperty("DATABASE_URL")) {
    p.setProperty("DATABASE_URL", "https://asteroides-a5ee1-default-rtdb.asia-southeast1.firebasedatabase.app");
  }
  if (!p.getProperty("API_KEY")) {
    p.setProperty("API_KEY", Utilities.getUuid());
  }
  Logger.log("DATABASE_URL=" + p.getProperty("DATABASE_URL"));
  Logger.log("API_KEY=" + p.getProperty("API_KEY"));
}

function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger("runTurn").timeBased().everyHours(6).create();      // ターン進行
  ScriptApp.newTrigger("backupToSheets").timeBased().everyDays(1).atHour(3).create(); // 日次バックアップ
}

// ====== Firebase REST ======
function fbGet_(path) {
  var res = UrlFetchApp.fetch(dbUrl_() + "/" + path + ".json", { muteHttpExceptions: true });
  var t = res.getContentText();
  if (!t || t === "null") return null;
  return JSON.parse(t);
}
function fbPut_(path, obj) {
  UrlFetchApp.fetch(dbUrl_() + "/" + path + ".json", {
    method: "put", contentType: "application/json",
    payload: JSON.stringify(obj), muteHttpExceptions: true
  });
}
function fbPatch_(path, obj) {
  UrlFetchApp.fetch(dbUrl_() + "/" + path + ".json", {
    method: "patch", contentType: "application/json",
    payload: JSON.stringify(obj), muteHttpExceptions: true
  });
}
function fbDelete_(path) {
  UrlFetchApp.fetch(dbUrl_() + "/" + path + ".json", { method: "delete", muteHttpExceptions: true });
}

// ====== 経済モデル（js/economy.js のミラー。片方を変えたら両方を合わせる）======
var INDUSTRY_RULES = {
  civilian:        { out: "economy",       base: 100, pop: 10, inputs: { consumerGoods: 1 }, techBonus: { threshold: 30, extra: { rareMineral: 1 }, mult: 1.5 }, special: "civilian" },
  consumerFactory: { out: "consumerGoods", base: 10,  pop: 25, inputs: { parts: 5 }, altInput: [{ res: "coal", amount: 10 }, { res: "oil", amount: 1 }], techBonus: { threshold: 40, extra: { rareMineral: 10 }, mult: 3 } },
  militaryFactory: { out: "militaryGoods", base: 8,   pop: 25, inputs: { parts: 5, heavyGoods: 10 }, altInput: [{ res: "coal", amount: 75 }, { res: "oil", amount: 5 }] },
  metalMine:       { out: "metal",         base: 20,  pop: 10, reserve: "metal" },
  heavyChemical:   { out: "heavyGoods",    base: 10,  pop: 50, inputs: { oil: 25, metal: 50, machinery: 5 }, techBonus: { threshold: 25, extra: { rareMineral: 25 }, mult: 3 } },
  oilField:        { out: "oil",           base: 20,  pop: 20, reserve: "oil" },
  coalField:       { out: "coal",          base: 30,  pop: 10, reserve: "coal" },
  farm:            { out: "food",          base: 20,  pop: 5,  reserve: "fertility" },
  partsFactory:    { out: "parts",         base: 15,  pop: 15, inputs: { metal: 10 }, altInput: [{ res: "coal", amount: 10 }, { res: "oil", amount: 1 }], techBonus: { threshold: 30, extra: { rareMineral: 5 }, mult: 2 } },
  machineryFactory:{ out: "machinery",     base: 10,  pop: 25, inputs: { oil: 5, parts: 15 }, techBonus: { threshold: 35, extra: { rareMineral: 10 }, mult: 2 } },
  rareMineralMine: { out: "rareMineral",   base: 10,  pop: 25, reserve: "rareMineral" },
  university:      { out: "research",      base: 5,   pop: 20, upkeep: 200, special: "university" }
};
var FLOW_KEYS = ["consumerGoods","militaryGoods","metal","heavyGoods","oil","coal","food","parts","machinery","rareMineral"];

// 民間産業のイデオロギー別パラメータ（仕様「特筆」より）
var CIVILIAN_IDEOLOGY = {
  "純粋資本主義":  { canBuild: false, autoExpand: 0.25, outputMult: 1.2, decayMult: 2.5 },
  "計画経済":      { canBuild: true,  autoExpand: 0.0,  outputMult: 0.6, decayMult: 0.0 },
  "福祉経済":      { canBuild: false, autoExpand: 0.07, outputMult: 0.9, decayMult: 1.0 },
  "企業統治経済":  { canBuild: true,  autoExpand: 0.10, outputMult: 1.0, decayMult: 1.0 },
  "戦時経済":      { canBuild: true,  autoExpand: 0.05, outputMult: 0.9, decayMult: 1.2 }
};
function civIdeo_(eco) { return CIVILIAN_IDEOLOGY[eco] || { canBuild: false, autoExpand: 0.08, outputMult: 1.0, decayMult: 1.0 }; }

// 建設コスト（国庫 + 在庫の部品/機械）
var BUILD_COSTS = {
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

function CONFIG_() {
  // Config シートがあれば上書き値を読む
  var c = {
    taxBase: 1.0, investDevBase: 100, investInfraBase: 100, investGovBase: 5,
    taxChangePP: 10, conscriptCostPerUnit: 2, conscriptPopPerUnit: 1,
    researchUniBase: 5, popGrowthMax: 0.05, deficitGovernancePenalty: 2,
    civilianDecayBase: 30, civilianExpandPopPer: 200, popPerCivilian: 50,
    ppIncomeBase: 10, randomness: 0.1,
    passiveGrowthPerTrend: 0.001,
    stateUpkeepBase: 10, stateUpkeepExp: 1.6,
    statePpUpkeepBase: 0.5, statePpUpkeepExp: 1.4,
    annexBasePP: 50, annexExp: 1.5
  };
  try {
    var sh = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName("Config");
    if (sh) {
      var rows = sh.getDataRange().getValues();
      for (var i = 1; i < rows.length; i++) {
        var k = rows[i][0], v = rows[i][1];
        if (k && v !== "" && c.hasOwnProperty(k)) c[k] = Number(v);
      }
    }
  } catch (e) {}
  return c;
}

function rnd_(cfg) { return 1 + (Math.random() * 2 - 1) * cfg.randomness; }

function perCapita_(tech, totalDev, pop) {
  var fuel = pop > 0 ? totalDev / pop : 0;
  var c = { consumerGoods: 0, food: 0, fuel: 0, heavyGoods: 0, rareMineral: 0, parts: 0 };
  if (tech < 5) c.food = 5;
  else if (tech < 10) { c.consumerGoods = 1; c.food = 8; }
  else if (tech < 15) { c.consumerGoods = 2; c.food = 10; }
  else if (tech < 20) { c.consumerGoods = 2; c.food = 10; c.fuel = fuel; }
  else if (tech < 25) { c.consumerGoods = 3; c.food = 10; c.fuel = fuel; c.heavyGoods = 1; }
  else if (tech < 30) { c.consumerGoods = 5; c.food = 10; c.fuel = fuel; c.heavyGoods = 3; }
  else if (tech < 40) { c.consumerGoods = 8; c.food = 10; c.fuel = fuel * 2; c.heavyGoods = 5; }
  else if (tech < 50) { c.consumerGoods = 15; c.food = 10; c.fuel = fuel * 2; c.heavyGoods = 10; c.rareMineral = 5; }
  else if (tech < 60) { c.consumerGoods = 20; c.food = 10; c.fuel = fuel * 2; c.heavyGoods = 10; c.rareMineral = 10; }
  else { c.consumerGoods = 25; c.food = 15; c.fuel = fuel * 2; c.heavyGoods = 15; c.rareMineral = 10; c.parts = 20; }
  return c;
}
function reserveEff_(r) { r = Number(r) || 0; if (r <= 0) return 0; return 0.5 + Math.min(1.5, r / 50); }
function techEff_(tech) { return 1 + (Number(tech) || 0) / 200; }
var FACTORY_KEYS = { consumerFactory: 1, militaryFactory: 1, partsFactory: 1, machineryFactory: 1, heavyChemical: 1 };
function ideoMult_(key, eco, gov) {
  var m = 1;
  if (key === "farm") { if (eco === "純粋資本主義") m *= 0.8; if (eco === "計画経済") m *= 1.2; if (gov === "共産主義") m *= 1.2; }
  if (key === "consumerFactory" && eco === "戦時経済") m *= 0.8;
  if (key === "militaryFactory") { if (eco === "戦時経済") m *= 1.3; if (gov === "軍事独裁") m *= 1.3; }
  if (FACTORY_KEYS[key] && eco === "企業統治経済") m *= 1.15;
  return m;
}
// イデオロギー全体効果（要素一覧10章）
var ECO_EFFECTS = {
  "純粋資本主義": { tax: 0.9, popGrowth: 1.0, research: 1.0, conscriptCost: 1.0, worldDamp: 1.0 },
  "計画経済":     { tax: 1.0, popGrowth: 1.0, research: 1.0, conscriptCost: 1.0, worldDamp: 0.5 },
  "福祉経済":     { tax: 1.1, popGrowth: 1.2, research: 1.0, conscriptCost: 1.1, worldDamp: 1.0 },
  "企業統治経済": { tax: 1.0, popGrowth: 1.0, research: 1.0, conscriptCost: 1.0, worldDamp: 1.0 },
  "戦時経済":     { tax: 1.0, popGrowth: 0.9, research: 1.0, conscriptCost: 0.7, worldDamp: 1.0 }
};
var POL_EFFECTS = {
  "自由民主主義": { tax: 1.0,  popGrowth: 1.0,  research: 1.2, ppIncome: 1.2, conscriptCost: 1.0, civExpand: 1.0 },
  "社会民主主義": { tax: 1.05, popGrowth: 1.15, research: 1.0, ppIncome: 1.0, conscriptCost: 1.0, civExpand: 1.0 },
  "共産主義":     { tax: 1.0,  popGrowth: 1.0,  research: 1.0, ppIncome: 1.0, conscriptCost: 1.0, civExpand: 0.4 },
  "絶対君主主義": { tax: 1.1,  popGrowth: 1.0,  research: 0.8, ppIncome: 1.3, conscriptCost: 1.0, civExpand: 1.0 },
  "軍事独裁":     { tax: 1.0,  popGrowth: 1.0,  research: 0.8, ppIncome: 1.0, conscriptCost: 0.7, civExpand: 1.0 }
};
function ecoEff_(eco) { return ECO_EFFECTS[eco] || { tax: 1, popGrowth: 1, research: 1, conscriptCost: 1, worldDamp: 1 }; }
function polEff_(gov) { return POL_EFFECTS[gov] || { tax: 1, popGrowth: 1, research: 1, ppIncome: 1, conscriptCost: 1, civExpand: 1 }; }
// ステート効率（人口充足・インフラ規模・開発度）。建設可否ではなく効率に影響。
function stateEff_(st) {
  var inds = st.industries || {}, count = 0, popDemand = 0, k;
  for (k in INDUSTRY_RULES) { var c = Number(inds[k]) || 0; count += c; popDemand += (INDUSTRY_RULES[k].pop || 0) * c; }
  var pop = Number(st.population) || 0;
  var staffing = popDemand > 0 ? Math.min(1, pop / popDemand) : 1;
  var infra = count > 0 ? Math.min(1, (Number(st.infrastructure) || 0) / count) : 1;
  var dev = 0.5 + Math.min(1.0, (Number(st.development) || 0) / 100);
  return staffing * infra * dev;
}
function univResearch_(govLevel, devLevel, base) {
  return base * ((Number(govLevel) || 0) / 50) * ((Number(devLevel) || 0) / 50);
}
function ensureStock_(n) {
  if (!n.stockpile) n.stockpile = {};
  FLOW_KEYS.forEach(function (k) { if (typeof n.stockpile[k] !== "number") n.stockpile[k] = 0; });
  return n.stockpile;
}
// 建設可否。ゲートは埋蔵量（鉱山・農場系）と民間産業のイデオロギー制限のみ。
// 人口/開発度/インフラは建設可否ではなく効率(stateEff_)に影響する。
function canBuild_(key, st, n, count) {
  var rule = INDUSTRY_RULES[key];
  if (!rule) return { ok: false, reason: "unknown" };
  if (key === "civilian" && !civIdeo_(n.ideology).canBuild) return { ok: false, reason: "ideology" };
  if (rule.reserve && (Number(st.resources && st.resources[rule.reserve]) || 0) <= 0) return { ok: false, reason: "reserve" };
  return { ok: true, reason: "" };
}

// ====== 世界景気ルーレット ======
function defaultWorld_() {
  return { value: 10, trend: "通常", probs: { "恐慌": 5, "不景気": 10, "不況": 20, "通常": 30, "好況": 20, "好景気": 10, "超好景気": 5 } };
}
var TREND_DELTA = {
  "恐慌": [-30, -5], "不景気": [-10, 0], "不況": [-10, 5], "通常": [-5, 5],
  "好況": [-5, 10], "好景気": [0, 10], "超好景気": [-30, 5]
};
function pickTrend_(probs) {
  var total = 0, k;
  for (k in probs) total += probs[k];
  var r = Math.random() * total, acc = 0;
  for (k in probs) { acc += probs[k]; if (r <= acc) return k; }
  return "通常";
}
function adjustProbs_(probs, picked) {
  function move(down, up, capUp) {
    if (probs[down] - 1 < 0) return;
    if (capUp != null && probs[up] + 1 > capUp) return;
    probs[down] -= 1; probs[up] += 1;
  }
  if (picked === "恐慌") move("恐慌", "超好景気", 10);
  else if (picked === "不景気") move("不景気", "好景気", 20);
  else if (picked === "不況") move("不況", "好況", 40);
  else if (picked === "好況") move("好況", "不況", 40);
  else if (picked === "好景気") move("好景気", "不景気", 20);
  else if (picked === "超好景気") move("超好景気", "恐慌", 10);
}
function stepWorld_(world) {
  if (!world || !world.probs) world = defaultWorld_();
  if (Math.random() < 0.25) {
    var picked = pickTrend_(world.probs);
    world.trend = picked;
    adjustProbs_(world.probs, picked);
  }
  var d = TREND_DELTA[world.trend] || [-5, 5];
  var delta = d[0] + Math.random() * (d[1] - d[0]);
  world.value = Math.max(0, (Number(world.value) || 10) + delta);
  return world;
}

// ====== ターン処理本体 ======
function runTurn() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { Logger.log("ロック取得失敗。スキップ。"); return; }
  try {
    var cfg = CONFIG_();
    var nations = fbGet_(ROOT + "/nations") || {};
    var states = fbGet_(ROOT + "/states") || {};
    var world = stepWorld_(fbGet_(ROOT + "/world") || defaultWorld_());
    var market = fbGet_(ROOT + "/market") || { prices: {}, offers: [] };
    if (!market.offers) market.offers = [];
    var mapData = fbGet_(ROOT + "/map") || {};
    var adjacency = mapData.adjacency || {};
    var proposals = fbGet_(ROOT + "/tradeProposals") || {};

    var processedOrderPaths = []; // 後で個別 DELETE するキー
    var tradeVolumeByNation = {};
    var ctx = { adjacency: adjacency, proposals: proposals, cfg: cfg, tradeVol: tradeVolumeByNation };

    // --- 各国の予約を処理 ---
    Object.keys(nations).forEach(function (nid) {
      var n = nations[nid];
      if (!n.stats) n.stats = {};
      if (!n.research) n.research = { tracks: { industrial: 0, military: 0 }, allocation: { industrial: 0.5, military: 0.5 }, upgrades: {} };
      if (!n.logs) n.logs = [];
      var orders = n.orders || {};
      Object.keys(orders).forEach(function (oid) {
        var o = orders[oid];
        if (!o || !o.kind) return;
        try {
          processOrder_(o, n, nid, nations, states, market, cfg, tradeVolumeByNation, ctx);
        } catch (e) {
          n.logs.push({ at: Date.now(), kind: "turn", text: "予約処理エラー: " + o.kind });
        }
        processedOrderPaths.push(ROOT + "/nations/" + nid + "/orders/" + oid);
      });
    });

    // 取引提案の状態変化を書き戻す
    fbPut_(ROOT + "/tradeProposals", proposals);

    // --- 経済（産業稼働・税収・研究・人口） ---
    Object.keys(nations).forEach(function (nid) {
      applyEconomy_(nations[nid], nid, states, world, cfg, tradeVolumeByNation[nid] || 0);
    });

    // --- 市場価格の統計更新（成立価格の指数移動平均的な更新） ---
    updateMarketPrices_(market);

    // --- 書き戻し ---
    Object.keys(nations).forEach(function (nid) {
      var n = nations[nid];
      n.logs = (n.logs || []).slice(-100);
      // orders には触れない（処理済みキーだけ後で個別削除）
      fbPatch_(ROOT + "/nations/" + nid, {
        stats: n.stats, research: n.research, logs: n.logs, stockpile: ensureStock_(n),
        ideology: n.ideology || "", prevIdeology: n.prevIdeology || ""
      });
    });
    fbPut_(ROOT + "/states", states);
    fbPut_(ROOT + "/world", world);
    fbPut_(ROOT + "/market", market);

    // 処理済み予約だけ削除
    processedOrderPaths.forEach(function (p) { fbDelete_(p); });

    // 履歴を追加
    appendHistory_(nations, world);
  } finally {
    lock.releaseLock();
  }
}

function ownStates_(nid, states) {
  var arr = [];
  Object.keys(states).forEach(function (name) {
    if (states[name] && states[name].country === nid) arr.push({ name: name, s: states[name] });
  });
  return arr;
}

// メールを相手の受信箱に配信する（append-only キー）。
function deliverMail_(toId, mail) {
  var key = "ml_" + Date.now().toString(36) + "_" + Math.floor(Math.random() * 1e6).toString(36);
  mail.at = Date.now();
  fbPut_(ROOT + "/nations/" + toId + "/mail/" + key, mail);
}

function processOrder_(o, n, nid, nations, states, market, cfg, tradeVol, ctx) {
  var p = o.payload || {};
  var kind = o.kind;
  if (kind === "setTaxRate") {
    if ((n.stats.politicalPower || 0) >= cfg.taxChangePP) {
      n.stats.politicalPower -= cfg.taxChangePP;
      n.stats.taxRate = Math.max(0, Math.min(1, Number(p.rate) || 0));
      n.logs.push({ at: Date.now(), kind: "policy", text: "税率を " + n.stats.taxRate.toFixed(2) + " に変更" });
    }
  } else if (kind === "investDevelopment" || kind === "investInfrastructure" || kind === "investGovernance") {
    var st = states[p.state];
    if (!st || st.country !== nid) return;
    var field = kind === "investDevelopment" ? "development" : (kind === "investInfrastructure" ? "infrastructure" : "governance");
    var amount = Math.max(1, parseInt(p.amount) || 1);
    for (var i = 0; i < amount; i++) {
      var cur = Number(st[field]) || 0;
      var base = field === "development" ? cfg.investDevBase : (field === "infrastructure" ? cfg.investInfraBase : cfg.investGovBase);
      var cost = base * (cur + 1);
      if (field === "governance") {
        if ((n.stats.politicalPower || 0) < cost) break;
        n.stats.politicalPower -= cost;
      } else {
        if ((n.stats.treasury || 0) < cost) break;
        n.stats.treasury -= cost;
      }
      st[field] = cur + 1;
    }
    n.logs.push({ at: Date.now(), kind: "policy", text: p.state + " の" + field + "に投資" });
  } else if (kind === "conscript") {
    var amt = Math.max(1, parseInt(p.amount) || 1);
    var conMult = ecoEff_(n.ideology).conscriptCost * polEff_(n.government).conscriptCost;
    var cost2 = amt * cfg.conscriptCostPerUnit * conMult;
    var popCost = amt * cfg.conscriptPopPerUnit;
    if ((n.stats.treasury || 0) >= cost2) {
      n.stats.treasury -= cost2;
      n.stats.reserveTroops = (n.stats.reserveTroops || 0) + amt;
      reducePopulation_(nid, states, popCost);
      n.logs.push({ at: Date.now(), kind: "policy", text: "予備兵を " + amt + " 徴兵" });
    }
  } else if (kind === "switchWarEconomy") {
    if (p.on) {
      if (n.ideology !== "戦時経済" && (n.stats.politicalPower || 0) >= 250) {
        n.stats.politicalPower -= 250;
        n.prevIdeology = n.ideology || "";
        n.ideology = "戦時経済";
        n.logs.push({ at: Date.now(), kind: "policy", text: "戦時経済へ移行（政治力250消費）" });
      }
    } else {
      if (n.ideology === "戦時経済") {
        n.ideology = n.prevIdeology || "";
        n.prevIdeology = "";
        n.logs.push({ at: Date.now(), kind: "policy", text: "戦時経済を解除（元の経済体制へ）" });
      }
    }
  } else if (kind === "buildIndustry") {
    var bs = states[p.state];
    if (!bs || bs.country !== nid) return;
    if (!bs.industries) bs.industries = {};
    var cnt = Math.max(1, parseInt(p.count) || 1);
    var chk = canBuild_(p.industry, bs, n, cnt);
    if (!chk.ok) { n.logs.push({ at: Date.now(), kind: "build", text: "建設不可(" + chk.reason + "): " + p.industry + " @ " + p.state }); return; }
    var bc = BUILD_COSTS[p.industry] || { treasury: 500, parts: 0, machinery: 0 };
    var needT = bc.treasury * cnt, needP = bc.parts * cnt, needM = bc.machinery * cnt;
    var stock = ensureStock_(n);
    if ((n.stats.treasury || 0) < needT || stock.parts < needP || stock.machinery < needM) {
      n.logs.push({ at: Date.now(), kind: "build", text: "建設資金/資材不足: " + p.industry + " @ " + p.state }); return;
    }
    n.stats.treasury -= needT; stock.parts -= needP; stock.machinery -= needM;
    bs.industries[p.industry] = (Number(bs.industries[p.industry]) || 0) + cnt;
    n.logs.push({ at: Date.now(), kind: "build", text: p.state + " に " + p.industry + " を " + cnt + " 建設" });
  } else if (kind === "demolishIndustry") {
    var ds = states[p.state];
    if (!ds || ds.country !== nid || !ds.industries) return;
    var dc = Math.max(1, parseInt(p.count) || 1);
    ds.industries[p.industry] = Math.max(0, (Number(ds.industries[p.industry]) || 0) - dc);
    n.logs.push({ at: Date.now(), kind: "build", text: p.state + " の " + p.industry + " を解体" });
  } else if (kind === "setResearchAllocation") {
    var ind = Math.max(0, Math.min(1, Number(p.industrial) || 0));
    n.research.allocation = { industrial: ind, military: 1 - ind };
    n.logs.push({ at: Date.now(), kind: "research", text: "研究配分を変更（産業 " + Math.round(ind * 100) + "%）" });
  } else if (kind === "tradeOffer") {
    market.offers.push({
      id: o.id, by: nid, side: p.side, resource: p.resource,
      amount: Number(p.amount) || 0, price: Number(p.price) || 0, at: o.at || Date.now()
    });
    n.logs.push({ at: Date.now(), kind: "trade", text: (p.side === "buy" ? "買い" : "売り") + "オファー: " + p.resource + " " + p.amount });
  } else if (kind === "tradeCancel") {
    market.offers = market.offers.filter(function (off) { return !(off.id === p.offerId && off.by === nid); });
  } else if (kind === "tradeAccept") {
    settleTrade_(p.offerId, nid, n, nations, market, tradeVol);
  } else if (kind === "annexState") {
    annexState_(p.state, n, nid, states, ctx.adjacency, cfg);
  } else if (kind === "sendTransfer") {
    sendTransfer_(p, n, nid, nations);
  } else if (kind === "acceptTrade") {
    acceptTrade_(p.proposalId, n, nid, nations, ctx.proposals);
  }
}

// 編入: 未所属で、自国領に隣接し、他国に隣接していないステートを政治力で編入する。
function annexState_(stateName, n, nid, states, adjacency, cfg) {
  var st = states[stateName];
  if (!st) return;
  if (st.country) { n.logs.push({ at: Date.now(), kind: "policy", text: "編入失敗(所属あり): " + stateName }); return; }
  var neighbors = adjacency[stateName] || [];
  var adjOwn = false, adjOther = false;
  for (var i = 0; i < neighbors.length; i++) {
    var ns = states[neighbors[i]];
    if (!ns || !ns.country) continue;
    if (ns.country === nid) adjOwn = true;
    else adjOther = true;
  }
  if (!adjOwn) { n.logs.push({ at: Date.now(), kind: "policy", text: "編入失敗(自国に隣接せず): " + stateName }); return; }
  if (adjOther) { n.logs.push({ at: Date.now(), kind: "policy", text: "編入失敗(他国に隣接): " + stateName }); return; }
  // コスト = 基礎 × (現ステート数+1)^指数
  var sc = 0;
  Object.keys(states).forEach(function (k) { if (states[k] && states[k].country === nid) sc++; });
  var cost = cfg.annexBasePP * Math.pow(sc + 1, cfg.annexExp);
  if ((n.stats.politicalPower || 0) < cost) { n.logs.push({ at: Date.now(), kind: "policy", text: "編入失敗(政治力不足): " + stateName }); return; }
  n.stats.politicalPower -= cost;
  st.country = nid;
  n.logs.push({ at: Date.now(), kind: "policy", text: stateName + " を編入（政治力 " + Math.round(cost) + " 消費）" });
}

// 送金・物資送付: 自国の国庫/在庫から相手へ移す。足りなければ送れる分だけ。
function sendTransfer_(p, n, nid, nations) {
  var to = nations[p.to];
  if (!to || p.to === nid) return;
  if (!to.stats) to.stats = {};
  var stockFrom = ensureStock_(n), stockTo = ensureStock_(to);
  var sentParts = [];
  var money = Math.max(0, Number(p.money) || 0);
  if (money > 0) {
    var amt = Math.min(money, n.stats.treasury || 0);
    if (amt > 0) { n.stats.treasury -= amt; to.stats.treasury = (to.stats.treasury || 0) + amt; sentParts.push("国庫" + Math.round(amt)); }
  }
  if (p.resources) {
    Object.keys(p.resources).forEach(function (k) {
      var want = Math.max(0, Number(p.resources[k]) || 0);
      var give = Math.min(want, stockFrom[k] || 0);
      if (give > 0) { stockFrom[k] -= give; stockTo[k] = (stockTo[k] || 0) + give; sentParts.push(k + Math.round(give)); }
    });
  }
  if (!sentParts.length) { n.logs.push({ at: Date.now(), kind: "diplo", text: "送付失敗(残高不足): " + (to.name || p.to) }); return; }
  n.logs.push({ at: Date.now(), kind: "diplo", text: (to.name || p.to) + " へ送付: " + sentParts.join(" / ") });
  deliverMail_(p.to, { from: nid, fromName: n.name || nid, subject: "送付を受領しました", body: (n.name || nid) + " から受け取りました: " + sentParts.join(" / "), read: false });
}

// 取引提案の承認: 提案者の give と承認者の want を交換（双方の残高を確認）。
function acceptTrade_(pid, n, nid, nations, proposals) {
  var pr = proposals[pid];
  if (!pr || pr.status !== "open") return;
  if (pr.to && pr.to !== nid) return;
  var proposer = nations[pr.from];
  if (!proposer) return;
  var give = pr.give || {}, want = pr.want || {};
  var pStock = ensureStock_(proposer), aStock = ensureStock_(n);
  // 残高チェック
  if ((proposer.stats.treasury || 0) < (Number(give.money) || 0)) { pr.status = "failed"; return; }
  if ((n.stats.treasury || 0) < (Number(want.money) || 0)) { pr.status = "failed"; return; }
  var ok = true;
  if (give.resources) Object.keys(give.resources).forEach(function (k) { if ((pStock[k] || 0) < (Number(give.resources[k]) || 0)) ok = false; });
  if (want.resources) Object.keys(want.resources).forEach(function (k) { if ((aStock[k] || 0) < (Number(want.resources[k]) || 0)) ok = false; });
  if (!ok) { pr.status = "failed"; return; }
  // 交換実行: proposer→accepter(give), accepter→proposer(want)
  var gm = Number(give.money) || 0, wm = Number(want.money) || 0;
  proposer.stats.treasury -= gm; n.stats.treasury = (n.stats.treasury || 0) + gm;
  n.stats.treasury -= wm; proposer.stats.treasury += wm;
  if (give.resources) Object.keys(give.resources).forEach(function (k) { var v = Number(give.resources[k]) || 0; pStock[k] -= v; aStock[k] = (aStock[k] || 0) + v; });
  if (want.resources) Object.keys(want.resources).forEach(function (k) { var v = Number(want.resources[k]) || 0; aStock[k] -= v; pStock[k] = (pStock[k] || 0) + v; });
  pr.status = "done";
  var msg = "取引が成立しました（" + (proposer.name || pr.from) + " ⇄ " + (n.name || nid) + "）";
  n.logs.push({ at: Date.now(), kind: "trade", text: msg });
  if (!proposer.logs) proposer.logs = [];
  proposer.logs.push({ at: Date.now(), kind: "trade", text: msg });
  deliverMail_(pr.from, { from: nid, fromName: n.name || nid, subject: "取引が成立しました", body: (n.name || nid) + " があなたの取引提案を承認しました。", read: false });
}

function reducePopulation_(nid, states, amount) {
  var own = ownStates_(nid, states);
  var total = own.reduce(function (s, o) { return s + (Number(o.s.population) || 0); }, 0);
  if (total <= 0) return;
  own.forEach(function (o) {
    var share = (Number(o.s.population) || 0) / total;
    o.s.population = Math.max(0, (Number(o.s.population) || 0) - amount * share);
  });
}

function settleTrade_(offerId, accepterNid, accepterN, nations, market, tradeVol) {
  var idx = -1;
  for (var i = 0; i < market.offers.length; i++) if (market.offers[i].id === offerId) { idx = i; break; }
  if (idx < 0) return;
  var off = market.offers[idx];
  if (off.by === accepterNid) return; // 自分のオファーは承認しない
  var maker = nations[off.by];
  if (!maker) return;
  var amount = Number(off.amount) || 0;
  var value = amount * (Number(off.price) || 0);
  // off.side は出し手の立場。sell なら出し手が売り手、承認側が買い手。buy はその逆。
  var sellerN = off.side === "sell" ? maker : accepterN;
  var buyerN = off.side === "sell" ? accepterN : maker;
  var sellerStock = ensureStock_(sellerN), buyerStock = ensureStock_(buyerN);
  if ((sellerStock[off.resource] || 0) < amount) {            // 売り手の在庫不足
    accepterN.logs.push({ at: Date.now(), kind: "trade", text: "取引不成立(在庫不足): " + off.resource }); return;
  }
  if ((buyerN.stats.treasury || 0) < value) {                 // 買い手の資金不足
    accepterN.logs.push({ at: Date.now(), kind: "trade", text: "取引不成立(資金不足): " + off.resource }); return;
  }
  sellerStock[off.resource] -= amount;
  buyerStock[off.resource] = (buyerStock[off.resource] || 0) + amount;
  buyerN.stats.treasury -= value;
  sellerN.stats.treasury = (sellerN.stats.treasury || 0) + value;
  tradeVol[off.by] = (tradeVol[off.by] || 0) + value;
  tradeVol[accepterNid] = (tradeVol[accepterNid] || 0) + value;
  market.offers.splice(idx, 1);
  var msg = "取引成立: " + off.resource + " " + amount + " @ " + off.price;
  accepterN.logs.push({ at: Date.now(), kind: "trade", text: msg });
  if (!maker.logs) maker.logs = [];
  maker.logs.push({ at: Date.now(), kind: "trade", text: msg });
  market._lastTrades = market._lastTrades || {};
  market._lastTrades[off.resource] = Number(off.price) || 0;
}

function applyEconomy_(n, nid, states, world, cfg, tradeVolume) {
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
  var totalPop = 0, totalDev = 0, totalEconomy = 0, govSum = 0, count = 0;

  own.forEach(function (o) { totalPop += Number(o.s.population) || 0; totalDev += Number(o.s.development) || 0; });

  own.forEach(function (o) {
    var s = o.s, inds = s.industries || {};
    var se = stateEff_(s); // 人口充足・インフラ・開発度の効率係数
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

  // 在庫を使って消費を賄う。available = 在庫 + 生産。充足できなければ不足。
  var satisfiedCount = 0, demandCount = 0, deficits = [];
  FLOW_KEYS.forEach(function (k) {
    var available = (stock[k] || 0) + production[k];
    var demand = consumption[k];
    if (demand > 0) { demandCount++; if (available >= demand) satisfiedCount++; else deficits.push(k); }
    var leftover = available - demand;
    stock[k] = leftover > 0 ? leftover : 0;
  });
  var satisfyRatio = demandCount > 0 ? satisfiedCount / demandCount : 1;

  // 世界景気を反映 + 民間産業の経済減衰
  var worldVal = Number(world.value) || 10;
  economyOutput *= (1 + (worldVal - 10) / 100);
  var netEconomy = economyOutput - economyDecay;

  // 税収（純経済 × 統治デバフ × イデオロギー補正 × 税率）
  own.forEach(function (o) { govSum += Number(o.s.governance) || 0; count++; });
  var avgGov = count ? govSum / count : 0;
  var govDebuff = Math.max(0.2, Math.min(1.2, avgGov / 50));
  var ideoTax = ecoEff_(eco).tax * polEff_(gov).tax;
  var taxIncome = netEconomy * govDebuff * ideoTax * (Number(n.stats.taxRate) || 0) * cfg.taxBase;
  n.stats.treasury = (n.stats.treasury || 0) + taxIncome - upkeep;

  // 政治力の毎ターン収入（政体補正）
  n.stats.politicalPower = (Number(n.stats.politicalPower) || 0) + cfg.ppIncomeBase * polEff_(gov).ppIncome;

  // ステート数による維持費（指数的に逓増。国庫と政治力を消費）
  var sc = own.length;
  var upT = cfg.stateUpkeepBase * Math.pow(sc, cfg.stateUpkeepExp);
  var upP = cfg.statePpUpkeepBase * Math.pow(sc, cfg.statePpUpkeepExp);
  n.stats.treasury = (n.stats.treasury || 0) - upT;
  n.stats.politicalPower = (Number(n.stats.politicalPower) || 0) - upP;

  // 研究（大学からの研究ポイントを配分。イデオロギー補正）
  researchOutput *= ecoEff_(eco).research * polEff_(gov).research;
  var alloc = n.research.allocation || { industrial: 0.5, military: 0.5 };
  n.research.tracks.industrial = (n.research.tracks.industrial || 0) + researchOutput * (alloc.industrial || 0);
  n.research.tracks.military = (n.research.tracks.military || 0) + researchOutput * (alloc.military || 0);
  rollResearchUpgrade_(n);

  // 経済力をステートに反映（消費された資源＝充足率に比例して発展。純経済で増減）
  // 景気が0以上なら何もしなくても自然増加する。
  var passive = trend >= 0 ? trend * cfg.passiveGrowthPerTrend : 0;
  own.forEach(function (o) {
    var growth = satisfyRatio * 0.02 + passive;
    o.s.economy = (Number(o.s.economy) || 0) * (1 + growth) + (netEconomy / Math.max(1, own.length)) * 0.01;
    if (o.s.economy < 0) o.s.economy = 0;
    totalEconomy += o.s.economy;
  });

  // 人口増減（満たされている割合/2 だけ増加。税率が高いと抑制。イデオロギー補正）
  var taxPenalty = 1 - (Number(n.stats.taxRate) || 0) * 0.3;
  var popIdeo = ecoEff_(eco).popGrowth * polEff_(gov).popGrowth;
  var popGrowth = Math.min(cfg.popGrowthMax, (satisfyRatio / 2) * cfg.popGrowthMax / 0.5) * taxPenalty * popIdeo;
  own.forEach(function (o) { o.s.population = (Number(o.s.population) || 0) * (1 + popGrowth); });

  // 統治レベル: 税率が高い・消費不足で低下
  own.forEach(function (o) {
    var dg = -(Number(n.stats.taxRate) || 0) * 1 - deficits.length * cfg.deficitGovernancePenalty * 0.1;
    o.s.governance = Math.max(0, (Number(o.s.governance) || 0) + dg);
  });

  // 民間産業の自然拡大（人口に余力があり民需が満たされているとき確率で+1。政体で抑制）
  var expandProb = civ.autoExpand * polEff_(gov).civExpand;
  autoExpandCivilian_(n, own, expandProb, satisfyRatio, totalPop, civCount, cfg);

  // 国家別景気: 世界景気へ寄せる。貿易総額/経済力 が大きいほど強く影響。計画経済は変動を受けにくい
  var influence = totalEconomy > 0 ? Math.min(1, tradeVolume / totalEconomy) : 0;
  var pull = (0.1 + 0.6 * influence) * ecoEff_(eco).worldDamp;
  n.stats.economyTrend = (Number(n.stats.economyTrend) || 10) * (1 - pull) + worldVal * pull;

  n.stats.totalEconomy = totalEconomy;
  n.stats.totalPopulation = totalPop;

  n.logs.push({ at: Date.now(), kind: "turn", text: "ターン処理: 税収 " + Math.round(taxIncome) + " / 充足率 " + Math.round(satisfyRatio * 100) + "%" + (economyDecay > 0 ? " / 経済減衰 " + Math.round(economyDecay) : "") + (deficits.length ? " / 不足 " + deficits.length + "種" : "") });
}

// 民間産業の自然拡大。計画経済(expandProb=0)は拡大しない。純粋資本主義は確率が高い。
function autoExpandCivilian_(n, own, expandProb, satisfyRatio, totalPop, civCount, cfg) {
  if (expandProb <= 0 || !own.length) return;
  if (satisfyRatio < 0.9) return;                 // 民需含め概ね満たされていること
  var capacity = totalPop / cfg.popPerCivilian;    // 支えられる民間産業数の目安
  if (civCount >= capacity) return;                // 人口余力がない
  if (Math.random() >= expandProb) return;
  var best = null;
  own.forEach(function (o) { if (!best || (Number(o.s.population) || 0) > (Number(best.s.population) || 0)) best = o; });
  if (best) {
    if (!best.s.industries) best.s.industries = {};
    best.s.industries.civilian = (Number(best.s.industries.civilian) || 0) + 1;
    n.logs.push({ at: Date.now(), kind: "turn", text: "民間産業が自然拡大（" + best.name + "）" });
  }
}

function rollResearchUpgrade_(n) {
  ["industrial", "military"].forEach(function (track) {
    var statKey = track === "industrial" ? "industrialTech" : "militaryTech";
    var points = n.research.tracks[track] || 0;
    var nextCost = ((n.stats[statKey] || 0) + 1) * 100;
    if (points >= nextCost) {
      var chance = Math.min(0.9, points / nextCost - 1 + 0.3);
      if (Math.random() < chance) {
        n.stats[statKey] = (n.stats[statKey] || 0) + 1;
        n.research.tracks[track] -= nextCost;
        n.logs.push({ at: Date.now(), kind: "research", text: statKey + " が " + n.stats[statKey] + " に上昇" });
      }
    }
  });
}

function updateMarketPrices_(market) {
  if (!market.prices) market.prices = {};
  var last = market._lastTrades || {};
  ["metal", "oil", "coal", "rareMineral", "food"].forEach(function (k) {
    var cur = Number(market.prices[k]) || 0;
    if (last[k] != null) market.prices[k] = cur * 0.7 + last[k] * 0.3; // 指数移動平均
  });
  delete market._lastTrades;
}

function appendHistory_(nations, world) {
  var hist = fbGet_(ROOT + "/history") || [];
  if (!Array.isArray(hist)) hist = [];
  var snap = { at: Date.now(), worldValue: world.value, worldTrend: world.trend, nations: {} };
  Object.keys(nations).forEach(function (nid) {
    var n = nations[nid];
    snap.nations[nid] = {
      totalEconomy: (n.stats && n.stats.totalEconomy) || 0,
      treasury: (n.stats && n.stats.treasury) || 0,
      economyTrend: (n.stats && n.stats.economyTrend) || 0
    };
  });
  hist.push(snap);
  if (hist.length > HISTORY_MAX) hist = hist.slice(hist.length - HISTORY_MAX);
  fbPut_(ROOT + "/history", hist);
}

// ====== Sheets バックアップ ======
function backupToSheets() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var data = {
    nations: fbGet_(ROOT + "/nations") || {},
    states: fbGet_(ROOT + "/states") || {},
    world: fbGet_(ROOT + "/world") || {},
    market: fbGet_(ROOT + "/market") || {}
  };
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");

  // 1) 生データJSONを Backup シートに追記
  var backup = ss.getSheetByName("Backup") || ss.insertSheet("Backup");
  backup.appendRow([stamp, new Date(), JSON.stringify(data).slice(0, 49000)]);

  // 2) 国家サマリを Nations シートに上書き
  var nsheet = ss.getSheetByName("Nations") || ss.insertSheet("Nations");
  nsheet.clear();
  nsheet.appendRow(["nationId", "name", "totalEconomy", "treasury", "politicalPower", "industrialTech", "militaryTech", "taxRate", "economyTrend"]);
  Object.keys(data.nations).forEach(function (nid) {
    var n = data.nations[nid], s = n.stats || {};
    nsheet.appendRow([nid, n.name || "", s.totalEconomy || 0, s.treasury || 0, s.politicalPower || 0, s.industrialTech || 0, s.militaryTech || 0, s.taxRate || 0, s.economyTrend || 0]);
  });
}

// 過去データの読み込み（管理者ページの「過去データ読込」用）。
// 指定日(yyyy-MM-dd)の Backup 行JSONを返す。日付省略で最新。
function getBackup(dateStr) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sh = ss.getSheetByName("Backup");
  if (!sh) return null;
  var rows = sh.getDataRange().getValues();
  for (var i = rows.length - 1; i >= 1; i--) {
    if (!dateStr || rows[i][0] === dateStr) return JSON.parse(rows[i][2]);
  }
  return null;
}

// ====== Web API（吐き出し / 入力） ======
// GET  ?key=APIKEY&path=aster_stella/nations            → そのパスのJSONを返す
// GET  ?key=APIKEY&action=backup&date=yyyy-MM-dd         → バックアップJSONを返す
// POST {key, path, value}                                → そのパスに値を書く（PUT）
function doGet(e) {
  var p = e.parameter || {};
  if (p.key !== apiKey_()) return json_({ error: "unauthorized" });
  if (p.action === "runturn") { runTurn(); return json_({ ok: true, ran: "runTurn" }); }
  if (p.action === "runbackup") { backupToSheets(); return json_({ ok: true, ran: "backupToSheets" }); }
  if (p.action === "backup") return json_(getBackup(p.date) || {});
  if (p.action === "getconfig") return json_(readConfigSheet_());
  if (p.path) return json_(fbGet_(p.path.replace(/^\//, "")) || {});
  return json_({ ok: true, hint: "use ?path= / ?action=runturn|runbackup|backup|getconfig with key" });
}
function doPost(e) {
  var body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ error: "bad json" }); }
  if (!body || body.key !== apiKey_()) return json_({ error: "unauthorized" });
  if (body.action === "setconfig") { writeConfigSheet_(body.config || {}); return json_({ ok: true, set: "config" }); }
  if (!body.path) return json_({ error: "path required" });
  fbPut_(body.path.replace(/^\//, ""), body.value);
  return json_({ ok: true, path: body.path });
}

// Config シート（計算式の調整）を key/value で読み書きする。
function readConfigSheet_() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sh = ss.getSheetByName("Config");
  var defaults = CONFIG_();
  if (!sh) {
    sh = ss.insertSheet("Config");
    sh.appendRow(["key", "value"]);
    Object.keys(defaults).forEach(function (k) { sh.appendRow([k, defaults[k]]); });
    return defaults;
  }
  var rows = sh.getDataRange().getValues(), out = {};
  for (var i = 1; i < rows.length; i++) if (rows[i][0]) out[rows[i][0]] = rows[i][1];
  // 未登録のキーはデフォルトで補完
  Object.keys(defaults).forEach(function (k) { if (!(k in out)) out[k] = defaults[k]; });
  return out;
}
function writeConfigSheet_(config) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sh = ss.getSheetByName("Config") || ss.insertSheet("Config");
  sh.clear();
  sh.appendRow(["key", "value"]);
  Object.keys(config).forEach(function (k) { sh.appendRow([k, config[k]]); });
}
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
