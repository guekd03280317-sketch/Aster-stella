/**
 * Aster Stella - スプレッドシート連携（予約・設定）
 *
 * 処理基盤のスプレッドシート移行（計画: golden-imagining-mccarthy）。
 * 予約(orders)を Firebase ではなくスプレッドシートに保存し、GAS がそれを読んで処理する。
 * Code.gs と同じグローバルスコープを共有（GASは全 .gs を連結）。SPREADSHEET_ID は Code.gs 定義。
 *
 * シート（既存バックアップブック内に作成・日本語・高可読性）:
 *   予約       … プレイヤーの未処理予約（doPost で追記、runTurn が処理）
 *   予約履歴   … 処理済み予約の退避（監査・肥大化防止）
 *   設定       … ターン処理の間隔など運営設定
 *
 * 主な公開関数:
 *   setupSheets_()                       … 上記シートを生成（運営が1回実行。setupTriggers と同様）
 *   appendOrderRow_(order)               … 予約を1行追記（doPost submitOrder から）
 *   readPendingOrders_()                 … 未処理の予約を配列で取得（runTurn / listOrders）
 *   listOrdersForNation_(nationId)       … 指定国の未処理予約（クライアント表示用）
 *   markOrderRow_(rowIndex, status, memo)… 行の状態を更新
 *   archiveProcessedOrders_()            … 処理済/失敗/取消の行を「予約履歴」へ退避
 *   cancelOrderInSheet_(nationId, oid)   … 予約を取消（未処理→取消）
 *   readSchedule_() / writeSchedule_(o)  … 「設定」シートの読み書き
 */

var ORDER_SHEET_ = "予約";
var ORDER_ARCHIVE_SHEET_ = "予約履歴";
var SETTINGS_SHEET_ = "設定";

// 「予約」シートの列（順序＝列番号）。可読性のため日本語ヘッダー。
var ORDER_HEADERS_ = ["予約ID", "受付時刻", "国家ID", "国名", "種別", "内容", "payload(JSON)", "状態", "処理時刻", "結果メモ"];
var OCOL_ = { id: 0, at: 1, nationId: 2, nationName: 3, kind: 4, desc: 5, payload: 6, status: 7, processedAt: 8, memo: 9 };
var ORDER_STATUS_ = { pending: "未処理", done: "処理済", failed: "失敗", canceled: "取消" };

function ss_() { return SpreadsheetApp.openById(SPREADSHEET_ID); }

function nowStr_() {
  return Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy-MM-dd HH:mm:ss");
}

// ヘッダー付きでシートを取得（無ければ作成）。見やすく整形。
function getOrCreateSheet_(name, headers) {
  var ss = ss_();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
  }
  if (headers && sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.getRange(1, 1, 1, headers.length).setFontWeight("bold").setBackground("#cfe2f3");
    sh.setFrozenRows(1);
  }
  return sh;
}

// ============================================================
// セットアップ（運営が1回実行）
// ============================================================
function setupSheets_() {
  getOrCreateSheet_(ORDER_SHEET_, ORDER_HEADERS_);
  getOrCreateSheet_(ORDER_ARCHIVE_SHEET_, ORDER_HEADERS_);

  // 設定シート（項目／値／説明）
  var st = ss_().getSheetByName(SETTINGS_SHEET_);
  if (!st) {
    st = ss_().insertSheet(SETTINGS_SHEET_);
    st.getRange(1, 1, 1, 3).setValues([["項目", "値", "説明"]]);
    st.getRange(1, 1, 1, 3).setFontWeight("bold").setBackground("#d9ead3");
    st.setFrozenRows(1);
    st.getRange(2, 1, 3, 3).setValues([
      ["実行間隔(分)", 360, "ターン処理(runTurn)を自動実行する間隔。turnDispatcher_ が参照。"],
      ["最終実行時刻", "", "最後に runTurn を実行した時刻（自動更新）。"],
      ["自動実行", "ON", "ON で間隔ごとに自動実行。OFF で手動のみ。"]
    ]);
    st.setColumnWidth(3, 420);
  }

  // 経済計算シート（入力_国家／計算_経済／係数_経済）と設定フラグ
  try { if (typeof setupEconomySheets_ === "function") setupEconomySheets_(); } catch (e) {}
  try { if (typeof ensureEconFlagSetting_ === "function") ensureEconFlagSetting_(); } catch (e2) {}
  // 戦争係数シート
  try { if (typeof setupWarCoefSheet_ === "function") setupWarCoefSheet_(); } catch (e3) {}

  return "setupSheets_ 完了";
}

// メニューからも実行できるよう公開名も用意
function setupSheets() { return setupSheets_(); }

// ============================================================
// 予約の入出力
// ============================================================

// order = { id, at, nationId, nationName, kind, desc, payload(obj) }
function appendOrderRow_(order) {
  var sh = getOrCreateSheet_(ORDER_SHEET_, ORDER_HEADERS_);
  var row = [];
  row[OCOL_.id] = order.id || ("ord_" + Date.now().toString(36) + "_" + Math.floor(Math.random() * 1e6).toString(36));
  row[OCOL_.at] = order.at || nowStr_();
  row[OCOL_.nationId] = order.nationId || "";
  row[OCOL_.nationName] = order.nationName || "";
  row[OCOL_.kind] = order.kind || "";
  row[OCOL_.desc] = order.desc || orderSummary_(order.kind, order.payload || {});
  row[OCOL_.payload] = JSON.stringify(order.payload || {});
  row[OCOL_.status] = ORDER_STATUS_.pending;
  row[OCOL_.processedAt] = "";
  row[OCOL_.memo] = "";
  sh.appendRow(row);
  return row[OCOL_.id];
}

// 未処理の予約をすべて返す。{ rowIndex, id, nationId, kind, payload }
function readPendingOrders_() {
  var sh = getOrCreateSheet_(ORDER_SHEET_, ORDER_HEADERS_);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var values = sh.getRange(2, 1, last - 1, ORDER_HEADERS_.length).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var v = values[i];
    if (v[OCOL_.status] !== ORDER_STATUS_.pending) continue;
    out.push({
      rowIndex: i + 2, // 実シート行番号
      id: String(v[OCOL_.id]),
      nationId: String(v[OCOL_.nationId]),
      kind: String(v[OCOL_.kind]),
      payload: parseJson_(v[OCOL_.payload]),
      at: v[OCOL_.at]
    });
  }
  // 受付時刻の昇順（追記順なので概ね保持。明示ソートはしない=行順）
  return out;
}

// 指定国の未処理予約（クライアント表示用に最小限の形で返す）
function listOrdersForNation_(nationId) {
  var all = readPendingOrders_();
  var out = [];
  for (var i = 0; i < all.length; i++) {
    if (all[i].nationId !== String(nationId)) continue;
    out.push({ id: all[i].id, kind: all[i].kind, payload: all[i].payload, at: all[i].at });
  }
  return out;
}

function markOrderRow_(rowIndex, status, memo) {
  var sh = getOrCreateSheet_(ORDER_SHEET_, ORDER_HEADERS_);
  sh.getRange(rowIndex, OCOL_.status + 1).setValue(status);
  sh.getRange(rowIndex, OCOL_.processedAt + 1).setValue(nowStr_());
  if (memo != null) sh.getRange(rowIndex, OCOL_.memo + 1).setValue(memo);
}

// 予約を取消（未処理のものだけ）。本人(nationId)の予約に限る。
function cancelOrderInSheet_(nationId, orderId) {
  var sh = getOrCreateSheet_(ORDER_SHEET_, ORDER_HEADERS_);
  var last = sh.getLastRow();
  if (last < 2) return false;
  var values = sh.getRange(2, 1, last - 1, ORDER_HEADERS_.length).getValues();
  for (var i = 0; i < values.length; i++) {
    var v = values[i];
    if (String(v[OCOL_.id]) === String(orderId) && String(v[OCOL_.nationId]) === String(nationId) && v[OCOL_.status] === ORDER_STATUS_.pending) {
      markOrderRow_(i + 2, ORDER_STATUS_.canceled, "本人が取消");
      return true;
    }
  }
  return false;
}

// 処理済/失敗/取消の行を「予約履歴」へ移して「予約」から削除（下の行から消す）。
function archiveProcessedOrders_() {
  var sh = getOrCreateSheet_(ORDER_SHEET_, ORDER_HEADERS_);
  var arch = getOrCreateSheet_(ORDER_ARCHIVE_SHEET_, ORDER_HEADERS_);
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var values = sh.getRange(2, 1, last - 1, ORDER_HEADERS_.length).getValues();
  var moved = 0;
  // 退避（まとめて append）
  var toMove = [];
  var deleteRows = [];
  for (var i = 0; i < values.length; i++) {
    if (values[i][OCOL_.status] !== ORDER_STATUS_.pending) {
      toMove.push(values[i]);
      deleteRows.push(i + 2);
    }
  }
  if (toMove.length) {
    arch.getRange(arch.getLastRow() + 1, 1, toMove.length, ORDER_HEADERS_.length).setValues(toMove);
    // 下から削除（行番号ズレ防止）
    for (var j = deleteRows.length - 1; j >= 0; j--) { sh.deleteRow(deleteRows[j]); moved++; }
  }
  return moved;
}

// ============================================================
// 設定（ターン処理タイミング）
// ============================================================
function readSchedule_() {
  var st = ss_().getSheetByName(SETTINGS_SHEET_);
  var def = { intervalMin: 360, lastRunAt: "", autoRun: true };
  if (!st) return def;
  var rows = st.getDataRange().getValues();
  var map = {};
  for (var i = 1; i < rows.length; i++) { if (rows[i][0]) map[rows[i][0]] = rows[i][1]; }
  return {
    intervalMin: Number(map["実行間隔(分)"]) || def.intervalMin,
    lastRunAt: map["最終実行時刻"] || "",
    autoRun: String(map["自動実行"] || "ON").toUpperCase() !== "OFF"
  };
}

function writeSchedule_(obj) {
  var st = ss_().getSheetByName(SETTINGS_SHEET_);
  if (!st) { setupSheets_(); st = ss_().getSheetByName(SETTINGS_SHEET_); }
  var rows = st.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    var key = rows[i][0];
    if (key === "実行間隔(分)" && obj.intervalMin != null) st.getRange(i + 1, 2).setValue(Number(obj.intervalMin));
    if (key === "最終実行時刻" && obj.lastRunAt != null) st.getRange(i + 1, 2).setValue(obj.lastRunAt);
    if (key === "自動実行" && obj.autoRun != null) st.getRange(i + 1, 2).setValue(obj.autoRun ? "ON" : "OFF");
  }
}

// ============================================================
// 補助
// ============================================================
function parseJson_(s) {
  if (s == null || s === "") return {};
  if (typeof s === "object") return s;
  try { return JSON.parse(s); } catch (e) { return {}; }
}

// 予約の人が読める要約（「内容」列）。詳細はクライアントの describeOrder と概ね一致。
function orderSummary_(kind, p) {
  p = p || {};
  switch (kind) {
    case "setTaxRate": return "税率を " + p.rate + " に変更";
    case "investDevelopment": return p.state + " の開発度に投資 +" + p.amount;
    case "investInfrastructure": return p.state + " のインフラに投資 +" + p.amount;
    case "investGovernance": return p.state + " の統治レベルに投資 +" + p.amount;
    case "conscript": return "予備兵を " + p.amount + " 徴兵";
    case "buildIndustry": return p.state + " に " + p.industry + " を " + p.count + " 建設";
    case "demolishIndustry": return p.state + " の " + p.industry + " を " + p.count + " 解体";
    case "setResearchAllocation": return "研究配分を変更";
    case "switchWarEconomy": return p.on ? "戦時経済へ移行" : "戦時経済を解除";
    case "annexState": return p.state + " を編入";
    case "sendTransfer": return (p.toName || p.to) + " へ送付";
    case "createArmy": return "軍を編成: " + (p.name || "新編軍");
    case "mobilize": return p.state + " で " + p.kind + " を " + p.amount + " 動員";
    case "assignTroops": return (p.armyName || p.armyId) + " へ " + p.kind + " " + p.amount + " 配備";
    case "demobilize": return (p.armyName || p.armyId) + " の " + p.kind + " " + p.amount + " 復員";
    case "moveArmy": return (p.armyName || p.armyId) + " 移動";
    case "attackArmy": return (p.armyName || p.armyId) + " 進撃";
    case "defendArmy": return (p.armyName || p.armyId) + " 防衛配置";
    case "setDoctrine": return "教義を " + p.doctrine + " に変更";
    case "declareWar": return (p.targetName || p.targetNationId) + " へ宣戦";
    case "proposePeace": return "講和提案 " + p.warId;
    case "acceptPeace": return "講和承認 " + p.warId;
    default: return kind;
  }
}
