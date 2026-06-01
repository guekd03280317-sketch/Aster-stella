/**
 * Aster Stella - 戦争システム（GASバックエンド）
 *
 * js/war-schema.js + js/military.js の計算式を GAS 側にミラーしたもの（§0「計算式は2か所で同期」）。
 * Code.gs と同じグローバルスコープを共有する（GASは全 .gs を連結）。
 *
 * 公開関数（Code.gs の runTurn から呼ぶ）:
 *   WAR_CONFIG_()                              … チューニング定数（config/war で上書き可）
 *   processWarOrder_(o,n,nid,nations,states,ctx)… 軍事系の予約処理
 *   applyMilitary_(n,nid,states,adjacency,cfg) … 補給・資源消費・充足率
 *   simulateWar_(nations,states,adjacency,wars,cfg) … 時間ループ・戦闘・占領・撤退/降伏・warScore・講和
 *
 * 章番号は 戦争システム仕様書.md を指す。
 */

// 戦争系の予約 kind（processOrder_ からの委譲判定に使う）
var WAR_ORDER_KINDS_ = {
  createArmy: 1, mobilize: 1, assignTroops: 1, demobilize: 1,
  moveArmy: 1, attackArmy: 1, defendArmy: 1, setDoctrine: 1,
  declareWar: 1, proposePeace: 1, acceptPeace: 1
};

// ============================================================
// CONFIG（§13）— js/war-schema.js の WAR_CONFIG_DEFAULTS に一致
// ============================================================
function WAR_CONFIG_() {
  var c = {
    supplyBaseCost: 1.0, supplyInfraFactor: 0.05, supplyOccupiedInfraMult: 0.5,
    supplyWeights: { food: 0.30, militaryGoods: 0.30, fuel: 0.20, parts: 0.10, machinery: 0.10 },
    fuelTiers: { none: 0, coal: 10, oil: 15 }, oilExpBase: 1.15,
    rareMineralMinLevel: 30, machineryMinLevel: 10,
    apMax: 50, apCostOwn: 5, apCostOccupied: 10, apCostEnemy: 20, moveApBase: 10, combatApBase: 1,
    atkPerSoldierTechDiv: 5, moraleMax: 100, moraleRegen: 5, moraleLossPerDeath: 1,
    penetrationPenalty: 0.25, militaryGoodsPerTroopPerRound: 0.005,
    declareWarPP: 200, warScoreWin: 100, scoreOccupy: 5, scoreOccupyHomeland: 10,
    scoreCapital: 30, scoreArmyDestroyed: 3,
    annihilationDebuff: 0.7, annihilationMaxRounds: 30, forcedAnnihilationNoCap: true, surrenderAtMorale: 0,
    battleRoundsPerTick: 1, battleMaxRounds: 30
  };
  // config/war による上書き（Firebase。後方互換）
  try {
    var ov = fbGet_(ROOT + "/config/war");
    if (ov && typeof ov === "object") { for (var k in ov) { if (c.hasOwnProperty(k)) c[k] = ov[k]; } }
  } catch (e) {}
  // 「係数_戦争」シートによる上書き（運営がシートで調整。スカラ値のみ）。シートが優先。
  try {
    var sv = readWarCoefSheet_();
    for (var k2 in sv) { if (c.hasOwnProperty(k2) && typeof c[k2] === "number") c[k2] = sv[k2]; }
  } catch (e2) {}
  return c;
}

var WAR_COEF_SHEET_ = "係数_戦争";

// 「係数_戦争」シートを読む（項目（key）／値）。スカラ値の上書き用。
function readWarCoefSheet_() {
  var sh = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(WAR_COEF_SHEET_);
  if (!sh) return {};
  var rows = sh.getDataRange().getValues(), out = {};
  for (var i = 1; i < rows.length; i++) {
    var label = String(rows[i][0] || "");
    var m = /（([a-zA-Z]+)）\s*$/.exec(label); // 「ラベル（key）」から key を取り出す
    var key = m ? m[1] : label;
    var v = Number(rows[i][1]);
    if (key && isFinite(v)) out[key] = v;
  }
  return out;
}

// 「係数_戦争」シートを生成（運営編集用）。WAR_CONFIG_ のスカラ既定値を「ラベル（key）／値／説明」で並べる。
function setupWarCoefSheet_() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sh = ss.getSheetByName(WAR_COEF_SHEET_);
  if (!sh) sh = ss.insertSheet(WAR_COEF_SHEET_);
  if (sh.getLastRow() > 0) return "係数_戦争 既存";
  sh.getRange(1, 1, 1, 3).setValues([["項目", "値", "説明"]]).setFontWeight("bold").setBackground("#f4cccc");
  sh.setFrozenRows(1);
  var labels = {
    apMax: "AP最大", apCostOwn: "移動AP(自国)", apCostOccupied: "移動AP(占領地)", apCostEnemy: "移動AP(敵領)",
    moraleMax: "士気最大", moraleRegen: "士気回復/ターン", moraleLossPerDeath: "士気減/戦死",
    penetrationPenalty: "貫徹不足の攻撃倍率", militaryGoodsPerTroopPerRound: "戦闘1単位の軍需/兵",
    declareWarPP: "宣戦の政治力", warScoreWin: "勝利スコア", scoreOccupy: "占領スコア",
    scoreCapital: "首都占領スコア", scoreArmyDestroyed: "軍撃破スコア",
    annihilationDebuff: "殲滅戦デバフ", annihilationMaxRounds: "殲滅戦上限R", surrenderAtMorale: "降伏士気",
    supplyBaseCost: "補給基礎コスト", supplyInfraFactor: "インフラ補給係数",
    rareMineralMinLevel: "重要鉱物の必要技術", machineryMinLevel: "機械消費の必要技術",
    atPerSoldierTechDiv: "攻撃力の技術除数", oilExpBase: "石油指数係数"
  };
  var c = WAR_CONFIG_();
  var rows = [];
  for (var k in c) {
    if (typeof c[k] !== "number") continue; // スカラのみ（supplyWeights等のオブジェクトは除外）
    var lbl = (labels[k] || k) + "（" + k + "）";
    rows.push([lbl, c[k], ""]);
  }
  sh.getRange(2, 1, rows.length, 3).setValues(rows);
  sh.setColumnWidth(1, 240);
  return "係数_戦争 作成";
}

// 累進防御力（1兵, §ヘッダー）: <10→2,<20→4,<30→10,<40→12, 以降+5毎+1
function defPerSoldier_(tech) {
  var t = Math.max(0, Number(tech) || 0);
  if (t < 10) return 2;
  if (t < 20) return 4;
  if (t < 30) return 10;
  if (t < 40) return 12;
  return 12 + Math.floor((t - 40) / 5);
}
function attackPerSoldier_(tech, cfg) { return Math.max(0, Number(tech) || 0) / (cfg.atkPerSoldierTechDiv || 5); }
function fuelTier_(tech, cfg) {
  var t = Math.max(0, Number(tech) || 0);
  if (t >= cfg.fuelTiers.oil) return "oil";
  if (t >= cfg.fuelTiers.coal) return "coal";
  return "none";
}
function fuelToResource_(amt, tech, cfg) {
  amt = Number(amt) || 0;
  var tier = fuelTier_(tech, cfg);
  if (tier === "none" || amt <= 0) return { oil: 0, coal: 0 };
  if (tier === "coal") return { oil: 0, coal: amt };
  var factor = Math.pow(cfg.oilExpBase, Math.max(0, (Number(tech) || 0) - cfg.fuelTiers.oil));
  return { oil: amt * factor, coal: 0 };
}

// ============================================================
// 特殊兵カタログ（§4）— js/war-schema.js の SPECIAL_UNITS に一致
// ============================================================
var WAR_UNITS_ = {
  // 歩兵系
  lightInfantry: { category: "infantry", reqLevel: 0, res: { pct: { food: 0.10 } }, stat: { moveAp: -0.20 } },
  scout: { category: "infantry", reqLevel: 0, res: { flat: { food: 50 } }, tags: { revealAdjacentEnemy: 1 } },
  heavyInfantry: { category: "infantry", reqLevel: 3, res: { pct: { food: 0.10, militaryGoods: 0.05 } }, stat: { apCost: 0.10, defense: 0.10 } },
  elite: { category: "infantry", reqLevel: 5, res: { pct: { food: 0.10, militaryGoods: 0.25, other: 0.05 } }, stat: { all: 0.10 }, tags: { halveArtilleryVsInfantry: 1 } },
  skirmisher: { category: "infantry", reqLevel: 10, res: { pct: { militaryGoods: 0.10, machinery: 0.05 } }, tags: { halveArtilleryVsInfantry: 1 } },
  guard: { category: "infantry", reqLevel: 0, tags: { capitalAura: 1 } },
  modernInfantry: { category: "infantry", reqLevel: 30, res: { pct: { food: 0.10, militaryGoods: 0.10, rareMineral: 0.50 } }, stat: { all: 0.50 }, tags: { noMoveApCost: 1 } },
  // 騎兵系
  lightCavalry: { category: "cavalry", reqLevel: 5, res: { pct: { food: 0.25 } }, tags: { cavApHalfIfPureCav: 1 } },
  heavyCavalry: { category: "cavalry", reqLevel: 8, res: { pct: { food: 0.25, militaryGoods: 0.10 } }, stat: { defense: 0.10 } },
  dragoon: { category: "cavalry", reqLevel: 10, res: { pct: { food: 0.25, militaryGoods: 0.25, machinery: 0.10 } }, tags: { cavMoveApHalfIfPureCav: 1 } },
  warElephant: { category: "cavalry", reqLevel: 10, res: { pct: { food: 0.25 } }, tags: { onContactEnemyApMinus5: 1, moralePerTurnMinus1: 1 } },
  // 火砲系
  fieldGun: { category: "artillery", reqLevel: 5, res: { pct: { militaryGoods: 0.15, machinery: 0.25 } }, stat: { attack: 0.30, moveAp: 1.00 }, penetrationFlat: 3 },
  lightFieldGun: { category: "artillery", reqLevel: 5, res: { pct: { food: 0.10, militaryGoods: 0.10, machinery: 0.10 } }, stat: { attack: 0.10, moveAp: 0.25 } },
  howitzer: { category: "artillery", reqLevel: 10, res: { pct: { militaryGoods: 0.15, machinery: 0.20 } }, stat: { attack: 0.10, moveAp: 1.00 }, tags: { extraVsInfantry025: 1 } },
  cannon: { category: "artillery", reqLevel: 13, res: { pct: { militaryGoods: 0.15, machinery: 0.10 } }, stat: { attack: 0.10, moveAp: 0.75 } },
  heavyArtillery: { category: "artillery", reqLevel: 15, res: { pct: { militaryGoods: 0.20, machinery: 0.20 } }, stat: { attack: 0.40, moveAp: 0.50 }, penetrationFlat: 5 },
  atGun: { category: "artillery", reqLevel: 15, res: { pct: { militaryGoods: 0.20, machinery: 0.20 } }, stat: { attack: 0.20, moveAp: 0.50 }, penetrationFlat: 15 },
  rocketArtillery: { category: "artillery", reqLevel: 25, res: { pct: { militaryGoods: 0.30, machinery: 0.10, fuel: 0.50 } }, stat: { attack: 0.75, moveAp: 0.25 } },
  // 車両系
  earlyArmoredCar: { category: "vehicle", reqLevel: 10, res: { pct: { militaryGoods: 0.15, machinery: 0.20, fuel: 0.25 } }, stat: { attack: 0.05, breakthrough: 0.10 }, armor: 2 },
  earlyTank: { category: "vehicle", reqLevel: 13, res: { pct: { militaryGoods: 0.20, machinery: 0.25, fuel: 0.50 } }, stat: { attack: 0.20, breakthrough: 0.25 }, armor: 3 },
  apc: { category: "vehicle", reqLevel: 15, res: { pct: { militaryGoods: 0.10, machinery: 0.20, fuel: 0.50 } }, stat: { breakthrough: 0.10, moveAp: -0.50 }, armor: 2 },
  armoredCar: { category: "vehicle", reqLevel: 15, res: { pct: { militaryGoods: 0.30, machinery: 0.25, fuel: 0.50 } }, stat: { attack: 0.20, breakthrough: 0.25 }, armor: 4 },
  lightTank: { category: "vehicle", reqLevel: 15, res: { pct: { militaryGoods: 0.45, machinery: 0.50, fuel: 0.50 } }, stat: { attack: 0.30, breakthrough: 0.30, moveAp: -0.75 }, armor: 5 },
  infantryTank: { category: "vehicle", reqLevel: 15, res: { pct: { militaryGoods: 0.50, machinery: 0.50, fuel: 0.75 } }, stat: { attack: 0.10, breakthrough: 0.10 }, armor: 10, tags: { grantArmorToInfantry5: 1 } },
  mediumTank: { category: "vehicle", reqLevel: 20, res: { pct: { militaryGoods: 0.75, machinery: 0.75, fuel: 1.00 } }, stat: { attack: 0.50, breakthrough: 1.00 }, armor: 13 },
  tankDestroyer: { category: "vehicle", reqLevel: 20, res: { pct: { militaryGoods: 1.00, machinery: 0.75, fuel: 1.00 } }, stat: { attack: 0.20, breakthrough: 1.00 }, armor: 10, penetrationFlat: 20 },
  spg: { category: "vehicle", reqLevel: 20, res: { pct: { militaryGoods: 0.50, machinery: 0.30, fuel: 0.50 } }, stat: { attack: 0.40 }, armor: 5, penetrationFlat: 10, tags: { artilleryVsInfantry: 1 } },
  spRocket: { category: "vehicle", reqLevel: 30, res: { pct: { militaryGoods: 1.00, machinery: 1.00, fuel: 1.25 } }, stat: { attack: 1.00 }, armor: 2, tags: { onContactEnemyApMinus5: 1, moralePerTurnMinus1: 1, artilleryVsInfantry: 1 } },
  heavyTank: { category: "vehicle", reqLevel: 25, res: { pct: { militaryGoods: 1.25, machinery: 1.00, fuel: 1.50 } }, stat: { attack: 0.75, breakthrough: 0.50 }, armor: 20, penetrationFlat: 15 },
  superHeavyTank: { category: "vehicle", reqLevel: 30, res: { pct: { militaryGoods: 2.00, machinery: 3.00, fuel: 2.50 } }, stat: { attack: 1.25, breakthrough: 2.50, moveAp: 0.50 }, armor: 20, penetrationFlat: 20, tags: { onContactEnemyApMinus5: 1, moralePerTurnMinus1: 1 } },
  modernTank: { category: "vehicle", reqLevel: 30, res: { pct: { militaryGoods: 1.50, machinery: 2.00, fuel: 1.00 } }, stat: { attack: 1.00, breakthrough: 1.00 }, armor: 20, penetrationFlat: 20 }
};

function canField_(kind, tech) {
  if (kind === "line") return true;
  var u = WAR_UNITS_[kind];
  return u ? (Number(tech) || 0) >= (u.reqLevel || 0) : false;
}

// 状況別の消費倍率（§3.2）
var WAR_UPKEEP_MODE_ = {
  idle: { food: 1.0, militaryGoods: 0.3, fuel: 0.0, machinery: 0.2, parts: 0.0, consumerGoods: 0.5 },
  moving: { food: 1.0, militaryGoods: 0.1, fuel: 1.0, machinery: 0.1, parts: 0.0, consumerGoods: 0.5 },
  defend: { food: 1.0, militaryGoods: 0.5, fuel: 0.2, machinery: 0.3, parts: 0.5, consumerGoods: 0.5 },
  battling: { food: 1.2, militaryGoods: 3.0, fuel: 1.0, machinery: 1.5, parts: 1.0, consumerGoods: 0.6 },
  retreating: { food: 1.0, militaryGoods: 0.3, fuel: 1.2, machinery: 0.5, parts: 0.3, consumerGoods: 0.5 },
  annihilating: { food: 0.5, militaryGoods: 2.0, fuel: 0.5, machinery: 0.3, parts: 0.8, consumerGoods: 0.5 }
};
var WAR_BASE_UPKEEP_ = { food: 1.0, militaryGoods: 0.5, fuel: 0.5, machinery: 0.3, parts: 0.2, consumerGoods: 0.2, rareMineral: 0.1 };

// ============================================================
// military ツリーの最低限の正規化
// ============================================================
function ensureMilitary_(n) {
  if (!n.military || typeof n.military !== "object") n.military = {};
  var m = n.military;
  if (!m.armies || typeof m.armies !== "object") m.armies = {};
  if (!m.mobilizedPool || typeof m.mobilizedPool !== "object") m.mobilizedPool = { line: 0 };
  if (!m.reserveByState || typeof m.reserveByState !== "object") m.reserveByState = {};
  if (!m.generals || typeof m.generals !== "object") m.generals = {};
  if (!m.doctrine) m.doctrine = "balanced";
  // 各軍の欠損補完
  Object.keys(m.armies).forEach(function (id) {
    var a = m.armies[id]; if (!a) { delete m.armies[id]; return; }
    a.id = a.id || id;
    if (!a.composition || typeof a.composition !== "object") a.composition = { line: 0 };
    if (a.mode == null) a.mode = "idle";
    if (a.ap == null) a.ap = 50;
    if (a.morale == null) a.morale = 100;
    if (a.supplyLevel == null) a.supplyLevel = 1.0;
  });
  return m;
}
function armyTroops_(a) {
  if (!a || !a.composition) return 0;
  var t = 0; for (var k in a.composition) t += Number(a.composition[k]) || 0; return t;
}

// 構成からプロファイル集計（§8.3 / military.js computeArmyProfile と同方針）
function computeProfile_(army, tech) {
  var comp = (army && army.composition) || {};
  var troops = armyTroops_(army);
  var lineCount = Number(comp.line) || 0;
  var specialTroops = 0;
  var cat = { infantry: 0, cavalry: 0, artillery: 0, vehicle: 0 };
  var acc = { attack: 0, defense: 0, breakthrough: 0, moveAp: 0, apCost: 0 };
  var armorW = 0, armorWt = 0, penetration = 1;
  var tags = {};
  for (var k in comp) {
    var count = Number(comp[k]) || 0; if (count <= 0 || k === "line") continue;
    var u = WAR_UNITS_[k]; if (!u) continue;
    specialTroops += count; cat[u.category] += count;
    var frac = troops > 0 ? count / troops : 0;
    var st = u.stat || {};
    var all = Number(st.all) || 0;
    acc.attack += ((Number(st.attack) || 0) + all) * frac;
    acc.defense += ((Number(st.defense) || 0) + all) * frac;
    acc.breakthrough += ((Number(st.breakthrough) || 0) + all) * frac;
    acc.moveAp += (Number(st.moveAp) || 0) * frac;
    acc.apCost += (Number(st.apCost) || 0) * frac;
    var armorVal = (u.armor != null) ? u.armor : 1;
    armorW += armorVal * count; armorWt += count;
    if (u.penetrationFlat) penetration = Math.max(penetration, u.penetrationFlat);
    if (u.tags) for (var tg in u.tags) tags[tg] = 1;
  }
  var armor = armorWt > 0 ? (armorW / armorWt) : 1;
  var pureVehicle = specialTroops > 0 && cat.vehicle === specialTroops;
  var pureCavalry = specialTroops > 0 && cat.cavalry === specialTroops;
  var hasInfantryComponent = (cat.infantry > 0) || (lineCount > 0) || (specialTroops === 0);
  var breakthroughMult = 1 + acc.breakthrough;
  var moveApMult = 1 + acc.moveAp, apCostMult = 1 + acc.apCost;
  if (pureVehicle) { breakthroughMult += 0.50; moveApMult *= 0.50; apCostMult *= 0.75; }
  if (pureCavalry) { if (tags.cavApHalfIfPureCav) apCostMult *= 0.50; if (tags.cavMoveApHalfIfPureCav) moveApMult *= 0.50; }
  if (tags.noMoveApCost) moveApMult = 0;
  return {
    troops: troops, attackMult: 1 + acc.attack, defenseMult: 1 + acc.defense,
    breakthroughMult: breakthroughMult, armor: armor, penetration: penetration,
    moveApMult: Math.max(0, moveApMult), apCostMult: Math.max(0, apCostMult),
    cat: cat, tags: tags, hasInfantryComponent: hasInfantryComponent
  };
}

// 軍の資源需要（§3）
function armyDemand_(army, tech, mode, cfg) {
  var comp = (army && army.composition) || {};
  var modeMul = WAR_UPKEEP_MODE_[mode] || WAR_UPKEEP_MODE_.idle;
  var out = { consumerGoods: 0, militaryGoods: 0, oil: 0, coal: 0, food: 0, parts: 0, machinery: 0, rareMineral: 0 };
  var fuelTotal = 0;
  var techMilMult = 1 + Math.max(0, Number(tech) || 0) * 0.02;
  for (var k in comp) {
    var count = Number(comp[k]) || 0; if (count <= 0) continue;
    var u = (k === "line") ? null : WAR_UNITS_[k];
    var pct = (u && u.res && u.res.pct) || {};
    var flat = (u && u.res && u.res.flat) || {};
    var otherPct = Number(pct.other) || 0;
    function demand(catKey) {
      var b = Number(WAR_BASE_UPKEEP_[catKey]) || 0;
      var mm = Number(modeMul[catKey]) || 0;
      var own = Number(pct[catKey]) || 0;
      var oth = (pct[catKey] === undefined) ? otherPct : 0;
      return b * mm * count * (1 + own + oth);
    }
    out.food += demand("food");
    out.consumerGoods += demand("consumerGoods");
    out.parts += demand("parts");
    out.militaryGoods += demand("militaryGoods") * techMilMult;
    if ((Number(tech) || 0) >= cfg.machineryMinLevel) out.machinery += demand("machinery");
    if ((Number(tech) || 0) >= cfg.rareMineralMinLevel) out.rareMineral += (Number(WAR_BASE_UPKEEP_.rareMineral) || 0) * count * (1 + (Number(pct.rareMineral) || 0) + otherPct);
    fuelTotal += (Number(WAR_BASE_UPKEEP_.fuel) || 0) * (Number(modeMul.fuel) || 0) * count * (1 + (Number(pct.fuel) || 0) + (pct.fuel === undefined ? otherPct : 0));
    for (var fk in flat) { if (fk === "fuel") fuelTotal += Number(flat[fk]) || 0; else if (out[fk] !== undefined) out[fk] += Number(flat[fk]) || 0; }
  }
  var fr = fuelToResource_(fuelTotal, tech, cfg);
  out.oil += fr.oil; out.coal += fr.coal;
  for (var ok in out) if (out[ok] < 0) out[ok] = 0;
  return out;
}

// ============================================================
// 予約処理（§5.2）
// ============================================================
function processWarOrder_(o, n, nid, nations, states, ctx) {
  var p = o.payload || {};
  var kind = o.kind;
  var cfg = WAR_CONFIG_();
  var m = ensureMilitary_(n);
  var tech = (n.stats && n.stats.militaryTech) || 0;

  if (kind === "createArmy") {
    var id = p.id || ("army_" + Date.now().toString(36) + "_" + Math.floor(Math.random() * 1e6).toString(36));
    if (!m.armies[id]) {
      m.armies[id] = { id: id, name: p.name || "新編軍", location: p.state || (n.capital || ""), composition: { line: 0 }, mode: "idle", ap: cfg.apMax, morale: cfg.moraleMax, supplyLevel: 1.0, generalId: null, activeOrderId: null };
      n.logs.push({ at: Date.now(), kind: "war", text: "軍を編成: " + m.armies[id].name });
    }

  } else if (kind === "mobilize") {
    var amt = Math.max(1, parseInt(p.amount) || 1);
    var uk = p.kind || "line";
    if (!canField_(uk, tech)) { n.logs.push({ at: Date.now(), kind: "war", text: "動員失敗(技術不足): " + uk }); return; }
    var avail = Number(m.reserveByState[p.state]) || 0;
    if (avail < amt) amt = avail;
    if (amt <= 0) { n.logs.push({ at: Date.now(), kind: "war", text: "動員失敗(予備兵不足): " + p.state }); return; }
    m.reserveByState[p.state] = avail - amt;
    m.mobilizedPool[uk] = (Number(m.mobilizedPool[uk]) || 0) + amt;
    if (n.stats) n.stats.reserveTroops = Math.max(0, (Number(n.stats.reserveTroops) || 0) - amt);
    n.logs.push({ at: Date.now(), kind: "war", text: "動員: " + uk + " " + amt + "（" + p.state + "）" });

  } else if (kind === "assignTroops") {
    var a = m.armies[p.armyId]; if (!a) return;
    var uk2 = p.kind || "line";
    var amt2 = Math.max(1, parseInt(p.amount) || 1);
    var pool = Number(m.mobilizedPool[uk2]) || 0;
    if (pool < amt2) amt2 = pool;
    if (amt2 <= 0) { n.logs.push({ at: Date.now(), kind: "war", text: "配備失敗(プール不足): " + uk2 }); return; }
    m.mobilizedPool[uk2] = pool - amt2;
    a.composition[uk2] = (Number(a.composition[uk2]) || 0) + amt2;
    n.logs.push({ at: Date.now(), kind: "war", text: "配備: " + uk2 + " " + amt2 + " → " + (a.name || a.id) });

  } else if (kind === "demobilize") {
    var a3 = m.armies[p.armyId]; if (!a3) return;
    var uk3 = p.kind || "line";
    var amt3 = Math.max(1, parseInt(p.amount) || 1);
    var have = Number(a3.composition[uk3]) || 0;
    if (have < amt3) amt3 = have;
    if (amt3 <= 0) return;
    a3.composition[uk3] = have - amt3;
    var loc = a3.location || n.capital || "";
    m.reserveByState[loc] = (Number(m.reserveByState[loc]) || 0) + amt3;
    if (n.stats) n.stats.reserveTroops = (Number(n.stats.reserveTroops) || 0) + amt3;

  } else if (kind === "moveArmy" || kind === "attackArmy") {
    var a4 = m.armies[p.armyId]; if (!a4) return;
    a4._order = { path: (p.path || []).slice(), startTime: Math.max(0, Math.min(45, parseInt(p.startTime) || 0)), engage: (kind === "attackArmy") };
    a4.mode = "moving";

  } else if (kind === "defendArmy") {
    var a5 = m.armies[p.armyId]; if (!a5) return;
    a5.mode = "defend"; a5._order = null;

  } else if (kind === "setDoctrine") {
    if (cfg && p.doctrine) m.doctrine = String(p.doctrine);

  } else if (kind === "declareWar") {
    declareWar_(n, nid, p, nations, cfg);

  } else if (kind === "proposePeace" || kind === "acceptPeace") {
    // 講和フラグは wars 側に積む。簡易: ctx.peace に記録して simulateWar_ で解決。
    if (!ctx._peace) ctx._peace = [];
    ctx._peace.push({ by: nid, kind: kind, warId: p.warId, terms: p.terms || null });
  }
}

function declareWar_(n, nid, p, nations, cfg) {
  var pp = (n.stats && n.stats.politicalPower) || 0;
  if (pp < cfg.declareWarPP) { n.logs.push({ at: Date.now(), kind: "war", text: "宣戦失敗(政治力不足)" }); return; }
  if (!p.targetNationId || !nations[p.targetNationId]) return;
  n.stats.politicalPower = pp - cfg.declareWarPP;
  var wars = fbGet_(ROOT + "/wars") || {};
  var wid = "war_" + Date.now().toString(36) + "_" + Math.floor(Math.random() * 1e6).toString(36);
  wars[wid] = {
    id: wid, attacker: { id: nid, co: [] }, defender: { id: p.targetNationId, co: [] },
    startedAt: Date.now(), goals: p.goals || [], warScore: 0, status: "active"
  };
  fbPut_(ROOT + "/wars", wars);
  n.logs.push({ at: Date.now(), kind: "war", text: "宣戦布告 → " + (nations[p.targetNationId].name || p.targetNationId) });
  deliverMail_(p.targetNationId, { from: nid, kind: "war", subject: "宣戦布告", body: (n.name || nid) + " が宣戦布告しました。" });
}

// ============================================================
// 補給・資源消費・充足率（§2 / §3）
// ============================================================
function applyMilitary_(n, nid, states, adjacency, cfg) {
  var m = ensureMilitary_(n);
  var tech = (n.stats && n.stats.militaryTech) || 0;
  var stock = ensureStock_(n);
  var armyIds = Object.keys(m.armies);
  if (!armyIds.length) return;

  // 1) 全軍の需要を集計
  var needs = {};
  var perArmyDemand = {};
  armyIds.forEach(function (id) {
    var a = m.armies[id];
    var mode = a.mode || "idle";
    var d = armyDemand_(a, tech, mode, cfg);
    perArmyDemand[id] = d;
    for (var k in d) needs[k] = (needs[k] || 0) + d[k];
  });

  // 2) 国家在庫に対する充足比 ratio[k] と在庫の減算
  var ratio = {};
  for (var k2 in needs) {
    var sup = Number(stock[k2]) || 0;
    var need = needs[k2];
    ratio[k2] = need > 0 ? Math.min(1, sup / need) : 1;
    stock[k2] = Math.max(0, sup - Math.min(sup, need));
  }
  n.stockpile = stock;

  // 3) 各軍の supplyLevel（補給経路効率 × 在庫充足の加重）
  var capital = n.capital || "";
  armyIds.forEach(function (id) {
    var a = m.armies[id];
    var route = warSupplyPath_(capital, a.location, adjacency, states, nid, cfg);
    var eff = route ? routeEff_(route.hops) : 0;
    var lvl = supplyLevelFromRatio_(perArmyDemand[id], ratio, eff, cfg);
    a.supplyLevel = lvl;
    // 補給切れ(孤立)は士気を毎ターン削る（§3.4）
    if (!route) a.morale = clampM_((a.morale || 0) - 5, cfg);
  });
}

function supplyLevelFromRatio_(demand, ratio, eff, cfg) {
  var w = cfg.supplyWeights;
  var catKeys = { food: ["food"], militaryGoods: ["militaryGoods"], fuel: ["oil", "coal"], parts: ["parts"], machinery: ["machinery"] };
  var num = 0, den = 0;
  for (var cat in w) {
    var keys = catKeys[cat] || [cat];
    var catDemand = 0, rw = 0;
    for (var i = 0; i < keys.length; i++) {
      var d = Number(demand[keys[i]]) || 0;
      var r = ratio[keys[i]] != null ? ratio[keys[i]] : 1;
      catDemand += d; rw += d * r;
    }
    if (catDemand <= 0) continue;
    num += w[cat] * (rw / catDemand); den += w[cat];
  }
  var base = den > 0 ? num / den : 1;
  return clamp01_(base * clamp01_(eff));
}
function routeEff_(hops) { return clamp01_(1 / (1 + 0.10 * Math.max(0, hops))); }

// 補給経路 BFS（自国/同盟/占領を通行可。敵領は遮断, §2.2）
function warSupplyPath_(capital, target, adjacency, states, nid, cfg) {
  if (!capital || !target) return null;
  if (capital === target) return { path: [capital], hops: 0 };
  function passable(name) {
    var s = states[name]; if (!s) return false;
    if (s.country === nid) return true;
    var sp = s.specialState || "";
    return sp.indexOf("occupied:" + nid) >= 0;
  }
  var visited = {}; visited[capital] = 1;
  var queue = [[capital]];
  while (queue.length) {
    var path = queue.shift();
    var last = path[path.length - 1];
    var nbs = adjacency[last] || [];
    for (var i = 0; i < nbs.length; i++) {
      var nb = nbs[i]; if (visited[nb]) continue;
      var isTarget = nb === target;
      if (!isTarget && !passable(nb)) { visited[nb] = 1; continue; }
      var next = path.concat(nb);
      if (isTarget) return { path: next, hops: next.length - 1 };
      visited[nb] = 1; queue.push(next);
    }
  }
  return null;
}

// ============================================================
// 戦闘シミュレーション（§7 / §8）
// ============================================================
function simulateWar_(nations, states, adjacency, wars, cfg) {
  // AP を毎ターン回復（補給で上限変動, §6.1）
  Object.keys(nations).forEach(function (nid) {
    var m = nations[nid].military; if (!m || !m.armies) return;
    Object.keys(m.armies).forEach(function (id) {
      var a = m.armies[id];
      a.ap = (cfg.apMax) * (0.4 + 0.6 * clamp01_(a.supplyLevel == null ? 1 : a.supplyLevel));
      // 士気回復（補給で変動）
      a.morale = clampM_((a.morale == null ? cfg.moraleMax : a.morale) + cfg.moraleRegen * clamp01_(a.supplyLevel == null ? 1 : a.supplyLevel), cfg);
    });
  });

  // 時間ループ（§7.1）。各 t で startTime<=t の移動命令を1ホップ進める。
  for (var t = 0; t <= 45; t++) {
    Object.keys(nations).forEach(function (nid) {
      var m = nations[nid].military; if (!m || !m.armies) return;
      Object.keys(m.armies).forEach(function (id) {
        var a = m.armies[id];
        if (!a._order || a._order.startTime > t) return;
        if (a.mode === "surrendered" || armyTroops_(a) <= 0) { a._order = null; return; }
        advanceArmyOneHop_(a, nid, nations, states, adjacency, wars, cfg);
      });
    });
  }

  // ターン後始末: warScore による自動講和、占領の整理
  Object.keys(wars).forEach(function (wid) {
    var w = wars[wid]; if (!w || w.status !== "active") return;
    if (w.warScore >= cfg.warScoreWin) endWar_(w, "attacker", states, nations, cfg);
    else if (w.warScore <= -cfg.warScoreWin) endWar_(w, "defender", states, nations, cfg);
  });

  // 一時フィールドの掃除
  Object.keys(nations).forEach(function (nid) {
    var m = nations[nid].military; if (!m || !m.armies) return;
    Object.keys(m.armies).forEach(function (id) {
      var a = m.armies[id];
      if (armyTroops_(a) <= 0 && a.mode !== "surrendered") { delete m.armies[id]; return; }
      delete a._order;
      if (a.mode === "moving") a.mode = "idle";
    });
  });
}

function advanceArmyOneHop_(a, nid, nations, states, adjacency, wars, cfg) {
  var path = a._order.path || [];
  // 現在地のインデックス
  var idx = path.indexOf(a.location);
  var nextIdx = (idx >= 0 ? idx : 0) + 1;
  if (nextIdx >= path.length) { a._order = null; if (a.mode === "moving") a.mode = "idle"; return; }
  var dest = path[nextIdx];
  if (!(adjacency[a.location] || []).length || (adjacency[a.location] || []).indexOf(dest) < 0) { a._order = null; return; }

  // 移動 AP コスト（領土種別 × 兵種補正）
  var prof = computeProfile_(a, (nations[nid].stats && nations[nid].stats.militaryTech) || 0);
  var territory = territoryType_(dest, states, nid);
  var apCost = (territory === "own" ? cfg.apCostOwn : territory === "occupied" ? cfg.apCostOccupied : cfg.apCostEnemy) * prof.moveApMult;
  if (a.ap < apCost) { return; } // AP不足。次tickで再挑戦
  a.ap -= apCost;

  // 目的地の敵軍を探す
  var enemies = enemyArmiesAt_(dest, nid, nations, wars);
  if (enemies.length > 0) {
    a.location = a.location; // 留まって戦闘（県境で会敵, §8.1）
    resolveBattle_(a, nid, enemies, dest, nations, states, adjacency, wars, cfg);
    return;
  }

  // 敵軍なし → 移動＆（敵/中立なら）占領
  a.location = dest;
  if (territory !== "own") {
    occupyState_(dest, nid, states, nations, wars, cfg);
  }
  if (a.mode === "moving" && nextIdx >= path.length - 1) { a.mode = "idle"; a._order = null; }
}

function territoryType_(name, states, nid) {
  var s = states[name];
  if (!s || !s.country) return "enemy"; // 中立は敵扱い（占領可能）
  if (s.country === nid) return "own";
  var sp = s.specialState || "";
  if (sp.indexOf("occupied:" + nid) >= 0) return "occupied";
  return "enemy";
}

function enemyArmiesAt_(name, nid, nations, wars) {
  var out = [];
  Object.keys(nations).forEach(function (onid) {
    if (onid === nid) return;
    if (!areEnemies_(nid, onid, wars)) return;
    var m = nations[onid].military; if (!m || !m.armies) return;
    Object.keys(m.armies).forEach(function (id) {
      var a = m.armies[id];
      if (a.location === name && armyTroops_(a) > 0 && a.mode !== "surrendered") out.push({ army: a, nid: onid });
    });
  });
  return out;
}

function areEnemies_(a, b, wars) {
  for (var wid in wars) {
    var w = wars[wid]; if (!w || w.status !== "active") continue;
    var atk = [w.attacker.id].concat(w.attacker.co || []);
    var def = [w.defender.id].concat(w.defender.co || []);
    if ((atk.indexOf(a) >= 0 && def.indexOf(b) >= 0) || (atk.indexOf(b) >= 0 && def.indexOf(a) >= 0)) return true;
  }
  return false;
}

// 1戦闘を複数ラウンド解決（§8.2 を反復）
function resolveBattle_(attacker, attNid, enemies, loc, nations, states, adjacency, wars, cfg) {
  var attTech = (nations[attNid].stats && nations[attNid].stats.militaryTech) || 0;
  var isDefensiveLoc = (territoryType_(loc, states, attNid) !== "own"); // 攻撃側にとって敵領=守備側が防衛戦
  var maxR = cfg.battleMaxRounds || 30;
  for (var r = 0; r < maxR; r++) {
    if (armyTroops_(attacker) <= 0) break;
    // 生存している守備側を集約（先頭1つと殴り合う簡易モデル）
    var live = enemies.filter(function (e) { return armyTroops_(e.army) > 0 && e.army.mode !== "surrendered"; });
    if (!live.length) break;
    var defE = live[0];
    var defNid = defE.nid;
    var defTech = (nations[defNid].stats && nations[defNid].stats.militaryTech) || 0;

    var attSide = { army: attacker, tech: attTech, mgRatio: clampMG_(attacker.supplyLevel), ctx: { supplyLevel: attacker.supplyLevel, doctrineKey: nations[attNid].military.doctrine, atCapitalOrAdjacent: false } };
    var defSide = { army: defE.army, tech: defTech, mgRatio: clampMG_(defE.army.supplyLevel), ctx: { supplyLevel: defE.army.supplyLevel, doctrineKey: nations[defNid].military.doctrine, isDefensive: true, mode: defE.army.mode, atCapitalOrAdjacent: false } };

    var res = combatRoundGas_(attSide, defSide, cfg);
    applyDeaths_(attacker, res.aDeaths);
    applyDeaths_(defE.army, res.dDeaths);
    attacker.morale = clampM_(attacker.morale - res.aDeaths * cfg.moraleLossPerDeath, cfg);
    defE.army.morale = clampM_(defE.army.morale - res.dDeaths * cfg.moraleLossPerDeath, cfg);
    attacker.ap = Math.max(0, attacker.ap - cfg.combatApBase - res.aDeaths);
    defE.army.ap = Math.max(0, defE.army.ap - cfg.combatApBase - res.dDeaths);
    // 軍需消費
    drainMG_(nations[attNid], res.militaryGoodsUsed / 2);
    drainMG_(nations[defNid], res.militaryGoodsUsed / 2);

    attacker.mode = "battling"; defE.army.mode = "battling";

    // 撤退/降伏判定
    var defDecision = retreatDecisionGas_(defE.army, hasEscape_(defE.army, defNid, states, adjacency, nations, wars), cfg);
    if (defDecision === "surrender" || armyTroops_(defE.army) <= 0) { surrenderArmy_(defE.army, defNid, attNid, wars, nations); continue; }
    if (defDecision === "retreat") { retreatArmy_(defE.army, defNid, states, adjacency, nations, wars); continue; }
    if (defDecision === "annihilate") { defE.army.mode = "annihilating"; }

    var attDecision = retreatDecisionGas_(attacker, hasEscape_(attacker, attNid, states, adjacency, nations, wars), cfg);
    if (attDecision === "surrender" || armyTroops_(attacker) <= 0) { surrenderArmy_(attacker, attNid, defNid, wars, nations); break; }
    if (attDecision === "retreat") { retreatArmy_(attacker, attNid, states, adjacency, nations, wars); break; }
    if (attDecision === "annihilate") { attacker.mode = "annihilating"; }
  }
  // 攻撃側が生き残り、守備が消えていれば占領
  var remain = enemies.filter(function (e) { return armyTroops_(e.army) > 0 && e.army.mode !== "surrendered"; });
  if (armyTroops_(attacker) > 0 && !remain.length) {
    attacker.location = loc;
    occupyState_(loc, attNid, states, nations, wars, cfg);
    if (attacker.mode === "annihilating" || attacker.mode === "battling") attacker.mode = "idle";
  }
}

function combatRoundGas_(att, def, cfg) {
  var aProf = computeProfile_(att.army, att.tech);
  var dProf = computeProfile_(def.army, def.tech);
  var dDeaths = damageGas_(att, def, aProf, dProf, cfg);
  var aDeaths = damageGas_(def, att, dProf, aProf, cfg);
  var mg = (armyTroops_(att.army) + armyTroops_(def.army)) * cfg.militaryGoodsPerTroopPerRound;
  return { aDeaths: Math.min(armyTroops_(att.army), aDeaths), dDeaths: Math.min(armyTroops_(def.army), dDeaths), militaryGoodsUsed: mg };
}
function damageGas_(att, def, attProf, defProf, cfg) {
  var attTroops = armyTroops_(att.army); if (attTroops <= 0) return 0;
  var power = attTroops * attackPerSoldier_(att.tech, cfg) * atkBonusGas_(attProf, att.ctx, defProf, cfg);
  if (attProf.penetration < defProf.armor) power *= cfg.penetrationPenalty;
  power *= clamp01_(att.mgRatio == null ? 1 : att.mgRatio);
  var defDur = Math.max(0.1, defPerSoldier_(def.tech) * defBonusGas_(defProf, def.ctx, cfg));
  return Math.floor(power / defDur);
}
function atkBonusGas_(att, ctx, enemyProf, cfg) {
  var doc = doctrine_(ctx.doctrineKey);
  var b = 1.0;
  b *= (0.5 + 0.5 * clamp01_(ctx.supplyLevel == null ? 1 : ctx.supplyLevel));
  b *= att.attackMult;
  b *= artilleryFactorGas_(att, enemyProf);
  b *= doc.atk;
  if (att.tags.capitalAura) b *= ctx.atCapitalOrAdjacent ? 1.25 : 0.5;
  if (ctx.annihilation) b *= cfg.annihilationDebuff;
  return b;
}
function defBonusGas_(def, ctx, cfg) {
  var doc = doctrine_(ctx.doctrineKey);
  var b = 1.0;
  b *= (0.6 + 0.4 * clamp01_(ctx.supplyLevel == null ? 1 : ctx.supplyLevel));
  b *= def.defenseMult;
  if (ctx.isDefensive) b *= 1.5;
  if (ctx.mode === "defend") b *= 1.4;
  b *= doc.def;
  if (def.tags.capitalAura) b *= ctx.atCapitalOrAdjacent ? 1.25 : 0.5;
  if (ctx.annihilation) b *= cfg.annihilationDebuff;
  return b;
}
function artilleryFactorGas_(att, def) {
  var hasArt = att.cat.artillery > 0 || att.tags.artilleryVsInfantry;
  if (!hasArt || !def.hasInfantryComponent) return 1;
  var buff = 0.50;
  if (att.tags.extraVsInfantry025) buff += 0.25;
  if (def.tags.halveArtilleryVsInfantry) buff *= 0.5;
  return 1 + buff;
}
function doctrine_(key) {
  var D = { balanced: { atk: 1.0, def: 1.0 }, attack: { atk: 1.15, def: 0.95 }, defense: { atk: 0.95, def: 1.15 }, blitz: { atk: 1.25, def: 0.9 }, total: { atk: 1.05, def: 1.05 } };
  return D[key] || D.balanced;
}

// 死亡数を構成へ比例配分
function applyDeaths_(army, deaths) {
  deaths = Math.floor(deaths); if (deaths <= 0) return;
  var total = armyTroops_(army); if (total <= 0) return;
  var remaining = deaths;
  var keys = Object.keys(army.composition);
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i]; var c = Number(army.composition[k]) || 0; if (c <= 0) continue;
    var loss = Math.min(c, Math.round(deaths * (c / total)));
    army.composition[k] = c - loss; remaining -= loss;
  }
  // 端数を先頭から削る
  for (var j = 0; j < keys.length && remaining > 0; j++) {
    var k2 = keys[j]; var c2 = Number(army.composition[k2]) || 0;
    var d2 = Math.min(c2, remaining); army.composition[k2] = c2 - d2; remaining -= d2;
  }
}

function retreatDecisionGas_(army, hasEscape, cfg) {
  var apOut = (Number(army.ap) || 0) <= 0;
  var p = clamp01_((cfg.moraleMax - (Number(army.morale) || 0)) / cfg.moraleMax);
  var wantRetreat = apOut || (Math.random() < p);
  if (army.mode === "annihilating") {
    if ((Number(army.morale) || 0) <= cfg.surrenderAtMorale) return "surrender";
    if (hasEscape && wantRetreat) return "retreat";
    return "annihilate";
  }
  if (!wantRetreat) return "stay";
  return hasEscape ? "retreat" : "annihilate";
}

function hasEscape_(army, nid, states, adjacency, nations, wars) {
  var nbs = adjacency[army.location] || [];
  for (var i = 0; i < nbs.length; i++) {
    var nb = nbs[i];
    var tt = territoryType_(nb, states, nid);
    if (tt === "own" || tt === "occupied") {
      if (enemyArmiesAt_(nb, nid, nations, wars).length === 0) return true;
    }
  }
  return false;
}

function retreatArmy_(army, nid, states, adjacency, nations, wars) {
  var nbs = adjacency[army.location] || [];
  for (var i = 0; i < nbs.length; i++) {
    var nb = nbs[i];
    var tt = territoryType_(nb, states, nid);
    if ((tt === "own" || tt === "occupied") && enemyArmiesAt_(nb, nid, nations, wars).length === 0) {
      army.location = nb; army.mode = "retreating"; army._order = null; return;
    }
  }
  army.mode = "annihilating"; // 逃げ場なし
}

function surrenderArmy_(army, nid, winnerNid, wars, nations) {
  army.mode = "surrendered";
  army.composition = { line: 0 };
  // warScore: 軍壊滅相当
  addWarScore_(wars, winnerNid, nid, "armyDestroyed", null);
  nations[nid].logs.push({ at: Date.now(), kind: "war", text: (army.name || army.id) + " が降伏しました" });
}

function occupyState_(name, nid, states, nations, wars, cfg) {
  var s = states[name]; if (!s) return;
  var prevOwner = s.country || null;
  s.specialState = "occupied:" + nid;
  // warScore
  var isCapital = prevOwner && nations[prevOwner] && nations[prevOwner].capital === name;
  if (isCapital) addWarScore_(wars, nid, prevOwner, "capital", name);
  else addWarScore_(wars, nid, prevOwner, "occupy", name);
  if (nations[nid] && nations[nid].logs) nations[nid].logs.push({ at: Date.now(), kind: "war", text: name + " を占領" + (isCapital ? "（首都！）" : "") });
}

function addWarScore_(wars, beneficiaryNid, victimNid, type, stateName) {
  var cfg = WAR_CONFIG_();
  for (var wid in wars) {
    var w = wars[wid]; if (!w || w.status !== "active") continue;
    var atk = [w.attacker.id].concat(w.attacker.co || []);
    var def = [w.defender.id].concat(w.defender.co || []);
    var sign = 0;
    if (atk.indexOf(beneficiaryNid) >= 0 && (victimNid == null || def.indexOf(victimNid) >= 0)) sign = +1;
    else if (def.indexOf(beneficiaryNid) >= 0 && (victimNid == null || atk.indexOf(victimNid) >= 0)) sign = -1;
    if (sign === 0) continue;
    var pts = type === "capital" ? cfg.scoreCapital : type === "armyDestroyed" ? cfg.scoreArmyDestroyed : cfg.scoreOccupy;
    w.warScore = Math.max(-100, Math.min(100, (w.warScore || 0) + sign * pts));
  }
}

function endWar_(w, winner, states, nations, cfg) {
  w.status = "ended";
  w.endedAt = Date.now();
  var winnerNid = winner === "attacker" ? w.attacker.id : w.defender.id;
  // 攻撃側勝利: goals のステートを attacker へ割譲
  if (winner === "attacker" && w.goals && w.goals.length) {
    for (var i = 0; i < w.goals.length; i++) {
      var name = w.goals[i]; var s = states[name];
      if (s) { s.country = w.attacker.id; s.specialState = ""; }
    }
  }
  // 占領タグの整理（勝者の占領は確定、敗者の占領は解除）
  Object.keys(states).forEach(function (name) {
    var s = states[name]; var sp = s.specialState || "";
    if (sp.indexOf("occupied:") === 0) {
      var occ = sp.split(":")[1];
      if (winner === "defender") { if (occ === w.attacker.id) s.specialState = ""; }
    }
  });
  if (nations[winnerNid]) nations[winnerNid].logs.push({ at: Date.now(), kind: "war", text: "戦争終結: 勝利（warScore " + w.warScore + "）" });
}

function drainMG_(n, amt) {
  var st = ensureStock_(n);
  st.militaryGoods = Math.max(0, (Number(st.militaryGoods) || 0) - (Number(amt) || 0));
  n.stockpile = st;
}

// ---- 小ヘルパー ----
function clamp01_(v) { v = Number(v); return v < 0 ? 0 : v > 1 ? 1 : (isFinite(v) ? v : 0); }
function clampM_(v, cfg) { var max = (cfg && cfg.moraleMax) || 100; v = Number(v) || 0; return v < 0 ? 0 : v > max ? max : v; }
function clampMG_(supply) { var s = Number(supply); if (!isFinite(s)) s = 1; return 0.5 + 0.5 * clamp01_(s); }
