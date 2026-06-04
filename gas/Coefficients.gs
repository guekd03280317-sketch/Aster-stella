/**
 * Aster Stella - 係数調整シート（運営が幅広い係数をスプレッドシートで調整）
 *
 * 既存の Config / 係数_経済 / 係数_戦争 に加え、ハードコードされていたデータテーブルを
 * シートから上書きできるようにする。runTurn 開始時に applyCoefficientSheets_() を呼び、
 * その実行中だけ メモリ上の グローバル（TREND_DELTA, INDUSTRY_RULES, WAR_UNITS_, BUILD_COSTS）を
 * シート値で上書きする（GASは実行ごとにグローバルを再ロードするので永続汚染しない）。
 *
 *   係数_世界景気  … 景気区分ごとの変動幅（下限/上限）。景気の変動の調整
 *   係数_産業      … 産業ごとの 産出基準(base) / 必要人口(pop)
 *   係数_特殊兵    … 特殊兵ごとの 必要レベル/装甲/貫徹/各ステータス%（特殊兵の力）
 *   係数_建設コスト … 産業ごとの 国庫/部品/機械
 *
 * 資源の配置の係数は既存の ops.html「資源の配分設定」(aster_stella/config/resourceDist) で調整可。
 */

var WORLD_COEF_SHEET_ = "係数_世界景気";
var INDUSTRY_COEF_SHEET_ = "係数_産業";
var UNIT_COEF_SHEET_ = "係数_特殊兵";
var BUILD_COEF_SHEET_ = "係数_建設コスト";

var TRENDS_ORDER_ = ["恐慌", "不景気", "不況", "通常", "好況", "好景気", "超好景気"];

var INDUSTRY_JP_ = {
  civilian: "民間産業", consumerFactory: "民需工場", militaryFactory: "軍需工場", metalMine: "金属鉱山",
  heavyChemical: "重化学工業", oilField: "油田", coalField: "炭田", farm: "農場",
  partsFactory: "部品工場", machineryFactory: "機械工場", rareMineralMine: "重要鉱物鉱山", university: "大学"
};
var UNIT_JP_ = {
  lightInfantry: "軽歩兵", scout: "偵察兵", heavyInfantry: "重装歩兵", elite: "精鋭兵", skirmisher: "散兵",
  guard: "近衛兵", modernInfantry: "現代歩兵", lightCavalry: "軽騎兵", heavyCavalry: "重騎兵", dragoon: "竜騎兵",
  warElephant: "象兵", fieldGun: "野戦砲", lightFieldGun: "軽野砲", howitzer: "榴弾砲", cannon: "カノン砲",
  heavyArtillery: "火砲", atGun: "対戦車砲", rocketArtillery: "ロケット砲", earlyArmoredCar: "初期型装甲車",
  earlyTank: "初期型戦車", apc: "兵員輸送車", armoredCar: "装甲車", lightTank: "軽戦車", infantryTank: "歩兵戦車",
  mediumTank: "中戦車", tankDestroyer: "駆逐戦車", spg: "自走砲", spRocket: "自走ロケット砲",
  heavyTank: "重戦車", superHeavyTank: "超重戦車", modernTank: "現代戦車"
};

// ---- 共通ヘルパー ----
function coefSheet_(name) { return SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(name); }
function coefRows_(name) {
  var sh = coefSheet_(name);
  if (!sh) return null;
  var v = sh.getDataRange().getValues();
  return v.length > 1 ? v.slice(1) : [];
}
function keyFromLabel_(label) { var m = /（([A-Za-z]+)）\s*$/.exec(String(label)); return m ? m[1] : String(label).trim(); }
function numOr_(v, def) { var n = Number(v); return (v !== "" && v != null && isFinite(n)) ? n : def; }
function hasVal_(v) { return v !== "" && v != null && isFinite(Number(v)); }

// ============================================================
// 一括適用（runTurn 開始時に1回）
// ============================================================
function applyCoefficientSheets_() {
  try { applyWorldCoefSheet_(); } catch (e) { Logger.log("係数_世界景気 読み込みエラー: " + e); }
  try { applyIndustryCoefSheet_(); } catch (e2) { Logger.log("係数_産業 読み込みエラー: " + e2); }
  try { applyUnitCoefSheet_(); } catch (e3) { Logger.log("係数_特殊兵 読み込みエラー: " + e3); }
  try { applyBuildCoefSheet_(); } catch (e4) { Logger.log("係数_建設コスト 読み込みエラー: " + e4); }
}

// ============================================================
// セットアップ（各シートを現在の既定値で生成）
// ============================================================
function setupCoefficientSheets_() {
  setupWorldCoefSheet_();
  setupIndustryCoefSheet_();
  setupUnitCoefSheet_();
  setupBuildCoefSheet_();
  return "setupCoefficientSheets_ 完了";
}

// ---- 係数_世界景気（TREND_DELTA: 景気の変動幅）----
function setupWorldCoefSheet_() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sh = ss.getSheetByName(WORLD_COEF_SHEET_);
  if (!sh) sh = ss.insertSheet(WORLD_COEF_SHEET_);
  if (sh.getLastRow() > 0) return;
  sh.getRange(1, 1, 1, 4).setValues([["景気区分", "変動下限", "変動上限", "説明"]]).setFontWeight("bold").setBackground("#cfe2f3");
  sh.setFrozenRows(1);
  var rows = TRENDS_ORDER_.map(function (t) {
    var d = TREND_DELTA[t] || [-5, 5];
    return [t, d[0], d[1], "この景気のとき世界景気が毎ターン[下限,上限]の範囲で変動"];
  });
  sh.getRange(2, 1, rows.length, 4).setValues(rows);
  sh.setColumnWidth(4, 360);
}
function applyWorldCoefSheet_() {
  var rows = coefRows_(WORLD_COEF_SHEET_);
  if (!rows) return;
  for (var i = 0; i < rows.length; i++) {
    var t = String(rows[i][0]);
    if (!TREND_DELTA[t]) continue;
    var lo = numOr_(rows[i][1], TREND_DELTA[t][0]);
    var hi = numOr_(rows[i][2], TREND_DELTA[t][1]);
    TREND_DELTA[t] = [lo, hi];
  }
}

// ---- 係数_産業（INDUSTRY_RULES base/pop）----
function setupIndustryCoefSheet_() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sh = ss.getSheetByName(INDUSTRY_COEF_SHEET_);
  if (!sh) sh = ss.insertSheet(INDUSTRY_COEF_SHEET_);
  if (sh.getLastRow() > 0) return;
  sh.getRange(1, 1, 1, 3).setValues([["産業（key）", "産出基準(base)", "必要人口(pop)"]]).setFontWeight("bold").setBackground("#d9ead3");
  sh.setFrozenRows(1);
  var rows = [];
  for (var k in INDUSTRY_RULES) {
    rows.push([(INDUSTRY_JP_[k] || k) + "（" + k + "）", INDUSTRY_RULES[k].base, INDUSTRY_RULES[k].pop]);
  }
  sh.getRange(2, 1, rows.length, 3).setValues(rows);
  sh.setColumnWidth(1, 200);
}
function applyIndustryCoefSheet_() {
  var rows = coefRows_(INDUSTRY_COEF_SHEET_);
  if (!rows) return;
  for (var i = 0; i < rows.length; i++) {
    var key = keyFromLabel_(rows[i][0]);
    var rule = INDUSTRY_RULES[key];
    if (!rule) continue;
    if (hasVal_(rows[i][1])) rule.base = Number(rows[i][1]);
    if (hasVal_(rows[i][2])) rule.pop = Number(rows[i][2]);
  }
}

// ---- 係数_特殊兵（WAR_UNITS_ の力）----
function setupUnitCoefSheet_() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sh = ss.getSheetByName(UNIT_COEF_SHEET_);
  if (!sh) sh = ss.insertSheet(UNIT_COEF_SHEET_);
  if (sh.getLastRow() > 0) return;
  sh.getRange(1, 1, 1, 9).setValues([["兵種（key）", "必要レベル", "装甲", "貫徹", "攻撃%", "防御%", "突破%", "全体%", "移動AP%"]])
    .setFontWeight("bold").setBackground("#f4cccc");
  sh.setFrozenRows(1);
  var rows = [];
  for (var id in WAR_UNITS_) {
    var u = WAR_UNITS_[id], st = u.stat || {};
    rows.push([
      (UNIT_JP_[id] || id) + "（" + id + "）",
      u.reqLevel != null ? u.reqLevel : 0,
      u.armor != null ? u.armor : "",
      u.penetrationFlat != null ? u.penetrationFlat : "",
      st.attack != null ? st.attack : "",
      st.defense != null ? st.defense : "",
      st.breakthrough != null ? st.breakthrough : "",
      st.all != null ? st.all : "",
      st.moveAp != null ? st.moveAp : ""
    ]);
  }
  sh.getRange(2, 1, rows.length, 9).setValues(rows);
  sh.setColumnWidth(1, 200);
}
function applyUnitCoefSheet_() {
  var rows = coefRows_(UNIT_COEF_SHEET_);
  if (!rows) return;
  for (var i = 0; i < rows.length; i++) {
    var id = keyFromLabel_(rows[i][0]);
    var u = WAR_UNITS_[id];
    if (!u) continue;
    if (hasVal_(rows[i][1])) u.reqLevel = Number(rows[i][1]);
    if (hasVal_(rows[i][2])) u.armor = Number(rows[i][2]);
    if (hasVal_(rows[i][3])) u.penetrationFlat = Number(rows[i][3]);
    if (hasVal_(rows[i][4]) || hasVal_(rows[i][5]) || hasVal_(rows[i][6]) || hasVal_(rows[i][7]) || hasVal_(rows[i][8])) {
      if (!u.stat) u.stat = {};
    }
    if (hasVal_(rows[i][4])) u.stat.attack = Number(rows[i][4]);
    if (hasVal_(rows[i][5])) u.stat.defense = Number(rows[i][5]);
    if (hasVal_(rows[i][6])) u.stat.breakthrough = Number(rows[i][6]);
    if (hasVal_(rows[i][7])) u.stat.all = Number(rows[i][7]);
    if (hasVal_(rows[i][8])) u.stat.moveAp = Number(rows[i][8]);
  }
}

// ---- 係数_建設コスト（BUILD_COSTS）----
function setupBuildCoefSheet_() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sh = ss.getSheetByName(BUILD_COEF_SHEET_);
  if (!sh) sh = ss.insertSheet(BUILD_COEF_SHEET_);
  if (sh.getLastRow() > 0) return;
  sh.getRange(1, 1, 1, 4).setValues([["産業（key）", "国庫", "部品", "機械"]]).setFontWeight("bold").setBackground("#fff2cc");
  sh.setFrozenRows(1);
  var rows = [];
  for (var k in BUILD_COSTS) {
    var b = BUILD_COSTS[k];
    rows.push([(INDUSTRY_JP_[k] || k) + "（" + k + "）", b.treasury || 0, b.parts || 0, b.machinery || 0]);
  }
  sh.getRange(2, 1, rows.length, 4).setValues(rows);
  sh.setColumnWidth(1, 200);
}
function applyBuildCoefSheet_() {
  var rows = coefRows_(BUILD_COEF_SHEET_);
  if (!rows) return;
  for (var i = 0; i < rows.length; i++) {
    var key = keyFromLabel_(rows[i][0]);
    var b = BUILD_COSTS[key];
    if (!b) continue;
    if (hasVal_(rows[i][1])) b.treasury = Number(rows[i][1]);
    if (hasVal_(rows[i][2])) b.parts = Number(rows[i][2]);
    if (hasVal_(rows[i][3])) b.machinery = Number(rows[i][3]);
  }
}
