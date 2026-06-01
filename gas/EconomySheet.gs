/**
 * Aster Stella - 経済計算のスプレッドシート数式化（入力_国家／計算_経済／係数_経済）
 *
 * 「経済の毎ターン計算」をスプレッドシートのセル数式で行い、運営が数式を調整できるようにする。
 * 計算式は Economy.gs の econFormulas_ を忠実にミラーする（同じ結果になるよう生成）。
 *
 *   入力_国家 … GAS が毎ターン各国の入力値を書き込む（1国1行）
 *   計算_経済 … 入力_国家＋係数_経済 を参照するセル数式（運営が編集可）
 *   係数_経済 … 調整用の係数（項目／値／説明）
 *
 * 安全のため既定は OFF（設定シート「経済計算をシートで行う」）。運営がシート結果を検証後に ON。
 * OFF の間は Economy.gs の JSミラーが使われる（挙動は同一）。
 *
 * Code.gs/Economy.gs と同じグローバル（FLOW_KEYS, ECON_INPUT_FIELDS, ECON_OUTPUT_FIELDS, CONFIG_ 等）を共有。
 */

var COEF_SHEET_ = "係数_経済";
var ECON_IN_SHEET_ = "入力_国家";
var ECON_OUT_SHEET_ = "計算_経済";

// 資源の日本語名（ヘッダー可読性のため）
var RES_JP_ = {
  consumerGoods: "民需", militaryGoods: "軍需", metal: "金属", heavyGoods: "工業製品",
  oil: "石油", coal: "石炭", food: "食料", parts: "部品", machinery: "機械", rareMineral: "重要鉱物"
};

// 入力スカラ列の日本語ヘッダー
var ECON_IN_LABELS_ = {
  nationId: "国家ID", nationName: "国名", taxRate: "税率", worldValue: "世界景気",
  stateCount: "ステート数", totalPop: "合計人口", totalDev: "合計開発度", avgGov: "平均統治",
  civCount: "民間産業数", upkeep: "大学維持費", economyOutput: "経済産出(生)", economyDecay: "経済減衰(生)",
  researchOutput: "研究産出(生)", currentEconomySum: "現経済合計", currentTreasury: "現国庫",
  currentPP: "現政治力", currentTrend: "現景気", ideoTax: "税率倍率", ppMult: "政治力倍率",
  popIdeo: "人口成長倍率", worldDamp: "景気減衰倍率", researchMult: "研究倍率",
  allocIndustrial: "研究配分(産)", allocMilitary: "研究配分(軍)", trackIndustrial: "研究蓄積(産)",
  trackMilitary: "研究蓄積(軍)", tradeVolume: "貿易総額", expandProb: "民間拡大確率"
};
// 出力スカラ列の日本語ヘッダー
var ECON_OUT_LABELS_ = {
  nationId: "国家ID", satisfyRatio: "充足率", deficits: "不足種数", taxIncome: "税収",
  treasuryDelta: "国庫増減", ppDelta: "政治力増減", researchIndustrialAdd: "研究加算(産)",
  researchMilitaryAdd: "研究加算(軍)", economyGrowthRate: "経済成長率", economyAddPerState: "経済加算/州",
  newTotalEconomy: "新経済合計", popGrowth: "人口成長率", governanceDelta: "統治増減",
  newTrend: "新景気", netEconomy: "純経済"
};

// 係数（数式が参照する調整値）。default は CONFIG_ から、無いものは定数。
function econCoefDefs_() {
  var c = CONFIG_();
  return [
    { key: "taxBase", label: "税収係数", value: c.taxBase, note: "税収 = 純経済×統治×イデオ税率×税率×この値" },
    { key: "stateUpkeepBase", label: "ステート維持費基数", value: c.stateUpkeepBase, note: "国庫維持費 = 基数×(ステート数^指数)" },
    { key: "stateUpkeepExp", label: "ステート維持費指数", value: c.stateUpkeepExp, note: "" },
    { key: "statePpUpkeepBase", label: "政治力維持費基数", value: c.statePpUpkeepBase, note: "政治力維持費 = 基数×(ステート数^指数)" },
    { key: "statePpUpkeepExp", label: "政治力維持費指数", value: c.statePpUpkeepExp, note: "" },
    { key: "ppIncomeBase", label: "政治力収入基数", value: c.ppIncomeBase, note: "政治力収入 = 基数×政治力倍率" },
    { key: "passiveGrowthPerTrend", label: "景気あたり自然成長", value: c.passiveGrowthPerTrend, note: "景気>=0 のとき 景気×この値 を経済成長率に加算" },
    { key: "popGrowthMax", label: "人口成長率の上限", value: c.popGrowthMax, note: "" },
    { key: "deficitGovernancePenalty", label: "不足の統治ペナルティ", value: c.deficitGovernancePenalty, note: "統治増減 = -税率 - 不足種数×この値×0.1" },
    { key: "economyGrowthPerSatisfy", label: "充足あたり経済成長", value: 0.02, note: "経済成長率 = 充足率×この値 + 自然成長" },
    { key: "economyAddFactor", label: "純経済の州還元率", value: 0.01, note: "経済加算/州 = 純経済/州数×この値" },
    { key: "taxPenaltyPerRate", label: "税率の人口ペナルティ", value: 0.3, note: "人口成長 ×(1-税率×この値)" },
    { key: "govDebuffDiv", label: "統治デバフ除数", value: 50, note: "統治デバフ = clamp(平均統治/この値, 下限, 上限)" },
    { key: "govDebuffMin", label: "統治デバフ下限", value: 0.2, note: "" },
    { key: "govDebuffMax", label: "統治デバフ上限", value: 1.2, note: "" },
    { key: "worldBase", label: "景気の基準値", value: 10, note: "経済産出 ×(1+(世界景気-この値)/100)" },
    { key: "trendBaseInfluence", label: "景気追従(基礎)", value: 0.1, note: "景気の引き寄せ = (基礎+貿易係数×影響)×景気減衰倍率" },
    { key: "trendTradeInfluence", label: "景気追従(貿易)", value: 0.6, note: "" },
    { key: "popSatisfyHalf", label: "人口成長の充足基準", value: 0.5, note: "人口成長 = min(上限, (充足率/2)×上限/この値)×…" }
  ];
}

// ---- 列文字（A1）。0始まり index → 列文字（AA等にも対応）----
function colA1_(i) {
  var s = ""; i = i + 1;
  while (i > 0) { var m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
  return s;
}

function econInputCols_() { return ECON_INPUT_FIELDS.concat(econFlowCols_("prod_"), econFlowCols_("cons_"), econFlowCols_("stock_")); }
function econOutputCols_() { return ECON_OUTPUT_FIELDS.concat(econFlowCols_("newStock_")); }

// field 名 → 入力_国家 の列文字
function inColMap_() {
  var cols = econInputCols_(), m = {};
  for (var i = 0; i < cols.length; i++) m[cols[i]] = colA1_(i);
  return m;
}
// field 名 → 計算_経済 の列文字
function outColMap_() {
  var cols = econOutputCols_(), m = {};
  for (var i = 0; i < cols.length; i++) m[cols[i]] = colA1_(i);
  return m;
}
// 係数 key → 係数_経済 の行番号（1始まり, 見出し1行）
function coefRowMap_() {
  var defs = econCoefDefs_(), m = {};
  for (var i = 0; i < defs.length; i++) m[defs[i].key] = i + 2; // 行2から
  return m;
}

// ---- セットアップ ----
function setupEconomySheets_() {
  // 係数_経済
  var coef = ss_().getSheetByName(COEF_SHEET_);
  if (!coef) coef = ss_().insertSheet(COEF_SHEET_);
  if (coef.getLastRow() === 0) {
    coef.getRange(1, 1, 1, 3).setValues([["項目", "値", "説明"]]).setFontWeight("bold").setBackground("#fce5cd");
    coef.setFrozenRows(1);
    var defs = econCoefDefs_();
    var rows = defs.map(function (d) { return [d.label + "（" + d.key + "）", d.value, d.note]; });
    coef.getRange(2, 1, rows.length, 3).setValues(rows);
    coef.setColumnWidth(1, 220); coef.setColumnWidth(3, 420);
  }

  // 入力_国家（ヘッダーのみ。データは runTurn が書く）
  var inSh = ss_().getSheetByName(ECON_IN_SHEET_);
  if (!inSh) inSh = ss_().insertSheet(ECON_IN_SHEET_);
  if (inSh.getLastRow() === 0) {
    var inCols = econInputCols_();
    var inHead = inCols.map(econColHeader_);
    inSh.getRange(1, 1, 1, inHead.length).setValues([inHead]).setFontWeight("bold").setBackground("#d0e0e3");
    inSh.setFrozenRows(1);
  }

  // 計算_経済（ヘッダーのみ。数式は writeNationInputs_ が行数に合わせて流し込む）
  var outSh = ss_().getSheetByName(ECON_OUT_SHEET_);
  if (!outSh) outSh = ss_().insertSheet(ECON_OUT_SHEET_);
  if (outSh.getLastRow() === 0) {
    var outCols = econOutputCols_();
    var outHead = outCols.map(econColHeader_);
    outSh.getRange(1, 1, 1, outHead.length).setValues([outHead]).setFontWeight("bold").setBackground("#d9d2e9");
    outSh.setFrozenRows(1);
  }
  return "setupEconomySheets_ 完了";
}

// 列キー → 日本語ヘッダー
function econColHeader_(key) {
  if (ECON_IN_LABELS_[key]) return ECON_IN_LABELS_[key];
  if (ECON_OUT_LABELS_[key]) return ECON_OUT_LABELS_[key];
  var m = /^(prod_|cons_|stock_|newStock_)(.+)$/.exec(key);
  if (m) {
    var pre = { prod_: "産出_", cons_: "消費_", stock_: "在庫_", newStock_: "新在庫_" }[m[1]];
    return pre + (RES_JP_[m[2]] || m[2]);
  }
  return key;
}

// ---- 入力書き出し＋数式流し込み ----
function writeNationInputs_(inputs) {
  if (!ss_().getSheetByName(ECON_IN_SHEET_) || !ss_().getSheetByName(ECON_OUT_SHEET_) || !ss_().getSheetByName(COEF_SHEET_)) {
    setupEconomySheets_();
  }
  var inSh = ss_().getSheetByName(ECON_IN_SHEET_);
  var outSh = ss_().getSheetByName(ECON_OUT_SHEET_);
  var inCols = econInputCols_();
  var ids = Object.keys(inputs).sort();
  var N = ids.length;

  // 既存データ行をクリア
  clearDataRows_(inSh, inCols.length);
  clearDataRows_(outSh, econOutputCols_().length);
  if (N === 0) return;

  // 入力行
  var inData = ids.map(function (nid) {
    var inp = inputs[nid];
    return inCols.map(function (col) { return econInputValue_(inp, col); });
  });
  inSh.getRange(2, 1, N, inCols.length).setValues(inData);

  // 計算_経済 の数式（行ごと）
  var outCols = econOutputCols_();
  var formulas = [];
  for (var r = 0; r < N; r++) {
    var rowNum = r + 2;
    formulas.push(outCols.map(function (f) { return econFormulaA1_(f, rowNum); }));
  }
  outSh.getRange(2, 1, N, outCols.length).setFormulas(formulas);
}

function clearDataRows_(sh, nCols) {
  var last = sh.getLastRow();
  if (last >= 2) sh.getRange(2, 1, last - 1, Math.max(nCols, sh.getLastColumn())).clearContent();
}

function econInputValue_(inp, col) {
  var m = /^(prod_|cons_|stock_)(.+)$/.exec(col);
  if (m) {
    var bucket = { prod_: "production", cons_: "consumption", stock_: "stock" }[m[1]];
    return Number((inp[bucket] || {})[m[2]]) || 0;
  }
  var v = inp[col];
  return (v == null) ? "" : v;
}

// ---- 出力読み取り ----
function readEconomyOutputs_() {
  var outSh = ss_().getSheetByName(ECON_OUT_SHEET_);
  var out = {};
  if (!outSh) return out;
  var last = outSh.getLastRow();
  if (last < 2) return out;
  var cols = econOutputCols_();
  var vals = outSh.getRange(2, 1, last - 1, cols.length).getValues();
  var idIdx = cols.indexOf("nationId");
  for (var i = 0; i < vals.length; i++) {
    var row = vals[i];
    var nid = String(row[idIdx]);
    if (!nid) continue;
    var o = { newStock: {} };
    for (var c = 0; c < cols.length; c++) {
      var key = cols[c];
      var mm = /^newStock_(.+)$/.exec(key);
      if (mm) o.newStock[mm[1]] = Number(row[c]) || 0;
      else if (key !== "nationId") o[key] = Number(row[c]) || 0;
      else o.nationId = nid;
    }
    out[nid] = o;
  }
  return out;
}

// ---- 設定: 経済計算をシートで行うか ----
function econUseSheet_() {
  var st = ss_().getSheetByName(SETTINGS_SHEET_);
  if (!st) return false;
  var rows = st.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (rows[i][0] === "経済計算をシートで行う") return String(rows[i][1] || "OFF").toUpperCase() === "ON";
  }
  return false;
}
function ensureEconFlagSetting_() {
  var st = ss_().getSheetByName(SETTINGS_SHEET_);
  if (!st) return;
  var rows = st.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) if (rows[i][0] === "経済計算をシートで行う") return;
  st.appendRow(["経済計算をシートで行う", "OFF", "ON で経済の毎ターン計算を『計算_経済』シートの数式で行う（運営が検証後に有効化）。OFF はGAS内蔵式。"]);
}

// ============================================================
// 数式生成（econFormulas_ を忠実にミラー）
// ============================================================
function econFormulaA1_(field, r) {
  var I = inColMap_(), O = outColMap_(), C = coefRowMap_();
  function inp(f) { return ECON_IN_SHEET_ + "!" + I[f] + r; }
  function self(f) { return ECON_OUT_SHEET_ + "!" + O[f] + r; }
  function coef(k) { return COEF_SHEET_ + "!$B$" + C[k]; }
  function inC(f) { return ECON_IN_SHEET_ + "!" + I[f] + r; }
  // 需要のある資源数（消費>0）と、そのうち満たせた資源数（在庫+産出>=消費）を、資源ごとの項の和で表す。
  function demandCountExpr() {
    return "(" + FLOW_KEYS.map(function (k) { return "IF(" + inC("cons_" + k) + ">0,1,0)"; }).join("+") + ")";
  }
  function satisfiedCountExpr() {
    return "(" + FLOW_KEYS.map(function (k) {
      return "IF(AND(" + inC("cons_" + k) + ">0,(" + inC("stock_" + k) + "+" + inC("prod_" + k) + ")>=" + inC("cons_" + k) + "),1,0)";
    }).join("+") + ")";
  }

  switch (field) {
    case "nationId": return "=" + inp("nationId");
    case "satisfyRatio":
      return "=IF(" + demandCountExpr() + ">0," + satisfiedCountExpr() + "/" + demandCountExpr() + ",1)";
    case "deficits":
      return "=" + demandCountExpr() + "-" + satisfiedCountExpr();
    case "netEconomy":
      return "=" + inp("economyOutput") + "*(1+(" + inp("worldValue") + "-" + coef("worldBase") + ")/100)-" + inp("economyDecay");
    case "taxIncome":
      return "=" + self("netEconomy") + "*MAX(" + coef("govDebuffMin") + ",MIN(" + coef("govDebuffMax") + "," + inp("avgGov") + "/" + coef("govDebuffDiv") + "))*" + inp("ideoTax") + "*" + inp("taxRate") + "*" + coef("taxBase");
    case "treasuryDelta":
      return "=" + self("taxIncome") + "-" + inp("upkeep") + "-" + coef("stateUpkeepBase") + "*POWER(" + inp("stateCount") + "," + coef("stateUpkeepExp") + ")";
    case "ppDelta":
      return "=" + coef("ppIncomeBase") + "*" + inp("ppMult") + "-" + coef("statePpUpkeepBase") + "*POWER(" + inp("stateCount") + "," + coef("statePpUpkeepExp") + ")";
    case "researchIndustrialAdd":
      return "=" + inp("researchOutput") + "*" + inp("researchMult") + "*" + inp("allocIndustrial");
    case "researchMilitaryAdd":
      return "=" + inp("researchOutput") + "*" + inp("researchMult") + "*" + inp("allocMilitary");
    case "economyGrowthRate":
      return "=" + self("satisfyRatio") + "*" + coef("economyGrowthPerSatisfy") + "+IF(" + inp("currentTrend") + ">=0," + inp("currentTrend") + "*" + coef("passiveGrowthPerTrend") + ",0)";
    case "economyAddPerState":
      return "=" + self("netEconomy") + "/MAX(1," + inp("stateCount") + ")*" + coef("economyAddFactor");
    case "newTotalEconomy":
      return "=MAX(0," + inp("currentEconomySum") + "*(1+" + self("economyGrowthRate") + ")+" + inp("stateCount") + "*" + self("economyAddPerState") + ")";
    case "popGrowth":
      return "=MIN(" + coef("popGrowthMax") + ",(" + self("satisfyRatio") + "/2)*" + coef("popGrowthMax") + "/" + coef("popSatisfyHalf") + ")*(1-" + inp("taxRate") + "*" + coef("taxPenaltyPerRate") + ")*" + inp("popIdeo");
    case "governanceDelta":
      return "=-(" + inp("taxRate") + ")*1-" + self("deficits") + "*" + coef("deficitGovernancePenalty") + "*0.1";
    case "newTrend":
      return "=" + inp("currentTrend") + "*(1-(" + coef("trendBaseInfluence") + "+" + coef("trendTradeInfluence") + "*IF(" + self("newTotalEconomy") + ">0,MIN(1," + inp("tradeVolume") + "/" + self("newTotalEconomy") + "),0))*" + inp("worldDamp") + ")+"
        + inp("worldValue") + "*((" + coef("trendBaseInfluence") + "+" + coef("trendTradeInfluence") + "*IF(" + self("newTotalEconomy") + ">0,MIN(1," + inp("tradeVolume") + "/" + self("newTotalEconomy") + "),0))*" + inp("worldDamp") + ")";
    default:
      var m = /^newStock_(.+)$/.exec(field);
      if (m) {
        var k = m[1];
        return "=MAX(0," + ECON_IN_SHEET_ + "!" + I["stock_" + k] + r + "+" + ECON_IN_SHEET_ + "!" + I["prod_" + k] + r + "-" + ECON_IN_SHEET_ + "!" + I["cons_" + k] + r + ")";
      }
      return "";
  }
}
