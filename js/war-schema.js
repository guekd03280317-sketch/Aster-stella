// Aster Stella - 戦争システムのスキーマ / 単一の真実（war-schema）
//
// 戦争システム仕様書.md の数値・カタログをコードから参照できる構造化データにまとめる。
//   - WAR_CONFIG_DEFAULTS : §13 チューニング定数の既定値（ライブ調整のベース）
//   - SPECIAL_UNITS       : §4 特殊兵カタログ（歩兵/騎兵/火砲/車両系）をデータ化
//   - normalizeMilitary   : §1.1 nations/{id}/military の 0/空 補完
//   - ヘルパー            : defPerSoldier / attackPerSoldier / fuelTierForTech など
//
// 設計原則（§18 ライブチューニング）:
//   戦闘式・特殊兵・撤退/降伏しきい値の数値は極力ここ（→ CONFIG）に集約し、
//   実体は aster_stella/config/war に保存して runTurn が最新を読む。コードに数値を散らさない。
//
// 資源キーは nation-schema.js の STOCKPILE_KEYS に一致させる:
//   consumerGoods / militaryGoods / metal / heavyGoods / oil / coal / food / parts / machinery / rareMineral
//   「fuel（燃料）」は集計上の呼称で、実体は技術段階により oil / coal に振り分ける（§3.1）。

// ============================================================
// 1. CONFIG 既定値（§13）
// ============================================================

export const WAR_CONFIG_DEFAULTS = {
  // --- 補給（§2）---
  supplyBaseCost: 1.0,
  supplyInfraFactor: 0.05,
  supplyOccupiedInfraMult: 0.5,
  supplyWeights: { food: 0.30, militaryGoods: 0.30, fuel: 0.20, parts: 0.10, machinery: 0.10 },

  // --- 燃料段階（軍事技術力しきい値, §3.1）---
  fuelTiers: { none: 0, coal: 10, oil: 15 }, // <10 なし / 10-14 石炭 / 15+ 石油
  oilExpBase: 1.15,                          // 石油消費 = base^(tech - oilTierLevel) 系の指数係数
  rareMineralMinLevel: 30,                   // 重要鉱物資源(rareMineral)を要求し始める技術力
  machineryMinLevel: 10,                     // 機械消費が始まる技術力

  // --- 部隊・AP（§6）---
  apMax: 50,
  apCostOwn: 5,         // 自国領 1ホップ移動の係数（×moveApBase 相当の基準）
  apCostOccupied: 10,   // 占領地
  apCostEnemy: 20,      // 敵領
  moveApBase: 10,       // 移動AP減少の基本値（§6.1）
  combatApBase: 1,      // 戦闘AP減少の基本値（＋死者数）

  // --- ステータス（§8.2, ヘッダー定義）---
  atkPerSoldierTechDiv: 5,   // 1兵の攻撃力 = 軍事技術力 / 5
  // 累進防御力（1兵あたり）: tech<10→2, <20→4, <30→10, <40→12, 以降+5レベルごとに+1
  defPerSoldier: { l10: 2, l20: 4, l30: 10, l40: 12, stepAbove40: 1 },
  moraleMax: 100,
  moraleRegen: 5,            // 毎ターン回復（補給で変動, §3.4）
  moraleLossPerDeath: 1,
  breakthroughBase: 1,       // 突破力の基本値（兵量に依存しない一律値, §ヘッダー）
  penetrationPenalty: 0.25,  // 貫徹 < 装甲 のとき攻撃 ×0.25

  // --- 戦闘1単位時間の消費（§3.5 / §8.2）---
  combatRound: { militaryGoodsPerTroopPerRound: 0.005 },
  damageVariance: { min: 1.0, max: 1.0 }, // 乱数係数（既定は無乱数。ライブ調整で振れ幅を持たせる）

  // --- 状況別の消費倍率（§3.2, mode → 資源カテゴリ倍率）---
  upkeepByMode: {
    idle:        { food: 1.0, militaryGoods: 0.3, fuel: 0.0, machinery: 0.2, parts: 0.0, consumerGoods: 0.5 },
    moving:      { food: 1.0, militaryGoods: 0.1, fuel: 1.0, machinery: 0.1, parts: 0.0, consumerGoods: 0.5 },
    defend:      { food: 1.0, militaryGoods: 0.5, fuel: 0.2, machinery: 0.3, parts: 0.5, consumerGoods: 0.5 },
    battling:    { food: 1.2, militaryGoods: 3.0, fuel: 1.0, machinery: 1.5, parts: 1.0, consumerGoods: 0.6 },
    retreating:  { food: 1.0, militaryGoods: 0.3, fuel: 1.2, machinery: 0.5, parts: 0.3, consumerGoods: 0.5 },
    annihilating:{ food: 0.5, militaryGoods: 2.0, fuel: 0.5, machinery: 0.3, parts: 0.8, consumerGoods: 0.5 }
  },
  perTroopUpkeepBase: { // 兵1あたり毎ターンの基礎レート（mode倍率の前段）
    food: 1.0, militaryGoods: 0.5, fuel: 0.5, machinery: 0.3, parts: 0.2, consumerGoods: 0.2, rareMineral: 0.1
  },

  // --- 動員（§5）---
  conscriptCostPerUnit: 2,
  conscriptPopPerUnit: 1,
  mobilizeInitCost: { militaryGoods: 1 }, // 動員1兵あたりの初期コスト（兵種補正は specialUnits 側）

  // --- 戦争（§9）---
  declareWarPP: 200,
  warScoreWin: 100,
  scoreOccupy: 5,
  scoreOccupyHomeland: 10,
  scoreCapital: 30,
  scoreArmyDestroyed: 3,

  // --- 戦闘イベント（§8.4）---
  battleEventRate: 0.20,
  battleEventRateWithStrategy: 0.35,

  // --- 撤退/殲滅/降伏（§8.5, §8.5.1）---
  annihilationDebuff: 0.7,
  annihilationMaxRounds: 30,    // 逃げ場がある膠着殲滅戦のみ適用
  forcedAnnihilationNoCap: true,// 逃げ場ゼロは上限を外す
  surrenderAtMorale: 0,         // 強制殲滅戦中、士気がこの値で無条件降伏

  // --- 教義（§17）---
  doctrines: {
    balanced: { atk: 1.0,  def: 1.0  },
    attack:   { atk: 1.15, def: 0.95 },
    defense:  { atk: 0.95, def: 1.15 },
    blitz:    { atk: 1.25, def: 0.9  },
    total:    { atk: 1.05, def: 1.05 }
  },

  // --- 参謀本部（§22）---
  staff: { safetyFactor: 1.3, waveSpacing: 6, defendReserveRatio: 0.25 },

  // --- 演出（§19/§24）---
  fx: { enabled: true, playbackSpeed: 1, particleScale: 1.0 }
};

// ============================================================
// 2. 特殊兵カタログ（§4 / ヘッダー定義）
// ============================================================
//
// 各兵種のデータ:
//   id, name, category: "infantry"|"cavalry"|"artillery"|"vehicle"
//   reqLevel        : 必要な軍事技術力
//   res.pct / res.flat : 資源消費の倍率(+0.10=+10%)と定数加算。fuel は技術段階で oil/coal へ。
//                        "other" は res.pct.other で「上記以外の全資源 +x%」を表す。
//   stat.pct        : ステータス補正(+0.10=+10%)。all は全ステータス。
//                     キー: all / attack / defense / breakthrough / morale / moveAp / combatAp / apCost
//                     moveAp は「移動によるAP消費」の増減（負で削減）。
//   penetrationFlat : 貫徹の定数加算
//   armor           : 装甲値（軍全体では平均、§4.3）
//   tags            : エンジンが解釈する特殊挙動フラグ（§下表）
//
// tags 一覧:
//   revealAdjacentEnemy     隣接敵ステートの兵・軍量を可視化（偵察）
//   halveArtilleryVsInfantry 火砲の対歩兵バフを半減（重複しない）
//   capitalAura             首都＆隣接で全能力+25%、それ以外-50%（近衛）
//   noMoveApCost            移動でAPを消費しない
//   cavApHalfIfPureCav      騎兵系以外の特殊兵がいなければAP消費-50%
//   cavMoveApHalfIfPureCav  騎兵系以外の特殊兵がいなければ移動AP-50%
//   onContactEnemyApMinus5  接敵時、相手APを問答無用で5削る
//   moralePerTurnMinus1     毎ターン相手の士気を1削る
//   artilleryVsInfantry     火砲系の対歩兵バフ(+50%)を持つ（自走砲・自走ロケット砲）
//   extraVsInfantry025      対歩兵/無特殊兵へ追加+25%攻撃（榴弾砲）
//   grantArmorToInfantry5   同軍の歩兵系に装甲+5を付与（歩兵戦車）
//   enemyCombatApPlus(n)    相手の戦闘AP消費を +n 倍させる（重戦車系）

export const SPECIAL_UNITS = [
  // ---- 歩兵系 ----
  { id: "lightInfantry", name: "軽歩兵", category: "infantry", reqLevel: 0,
    res: { pct: { food: 0.10 } }, stat: { pct: { moveAp: -0.20 } } },
  { id: "scout", name: "偵察兵", category: "infantry", reqLevel: 0,
    res: { flat: { food: 50 } }, tags: ["revealAdjacentEnemy"] },
  { id: "heavyInfantry", name: "重装歩兵", category: "infantry", reqLevel: 3,
    res: { pct: { food: 0.10, militaryGoods: 0.05 } }, stat: { pct: { apCost: 0.10, defense: 0.10 } } },
  { id: "elite", name: "精鋭兵", category: "infantry", reqLevel: 5,
    res: { pct: { food: 0.10, militaryGoods: 0.25, other: 0.05 } }, stat: { pct: { all: 0.10 } },
    tags: ["halveArtilleryVsInfantry"] },
  { id: "skirmisher", name: "散兵", category: "infantry", reqLevel: 10,
    res: { pct: { militaryGoods: 0.10, machinery: 0.05 } }, tags: ["halveArtilleryVsInfantry"] },
  { id: "guard", name: "近衛兵", category: "infantry", reqLevel: 0,
    tags: ["capitalAura"] },
  { id: "modernInfantry", name: "現代歩兵", category: "infantry", reqLevel: 30,
    res: { pct: { food: 0.10, militaryGoods: 0.10, rareMineral: 0.50 } }, stat: { pct: { all: 0.50 } },
    tags: ["noMoveApCost"] },

  // ---- 騎兵系 ----
  { id: "lightCavalry", name: "軽騎兵", category: "cavalry", reqLevel: 5,
    res: { pct: { food: 0.25 } }, tags: ["cavApHalfIfPureCav"] },
  { id: "heavyCavalry", name: "重騎兵", category: "cavalry", reqLevel: 8,
    res: { pct: { food: 0.25, militaryGoods: 0.10 } }, stat: { pct: { defense: 0.10 } } },
  { id: "dragoon", name: "竜騎兵", category: "cavalry", reqLevel: 10,
    res: { pct: { food: 0.25, militaryGoods: 0.25, machinery: 0.10 } }, tags: ["cavMoveApHalfIfPureCav"] },
  { id: "warElephant", name: "象兵", category: "cavalry", reqLevel: 10,
    res: { pct: { food: 0.25 } }, tags: ["onContactEnemyApMinus5", "moralePerTurnMinus1"] },

  // ---- 火砲系（カテゴリで対歩兵/無特殊兵 +50% 攻撃, §4 火砲系）----
  { id: "fieldGun", name: "野戦砲", category: "artillery", reqLevel: 5,
    res: { pct: { militaryGoods: 0.15, machinery: 0.25 } }, stat: { pct: { attack: 0.30, moveAp: 1.00 } },
    penetrationFlat: 3 },
  { id: "lightFieldGun", name: "軽野砲", category: "artillery", reqLevel: 5,
    res: { pct: { food: 0.10, militaryGoods: 0.10, machinery: 0.10 } }, stat: { pct: { attack: 0.10, moveAp: 0.25 } } },
  { id: "howitzer", name: "榴弾砲", category: "artillery", reqLevel: 10,
    res: { pct: { militaryGoods: 0.15, machinery: 0.20 } }, stat: { pct: { attack: 0.10, moveAp: 1.00 } },
    tags: ["extraVsInfantry025"] },
  { id: "cannon", name: "カノン砲", category: "artillery", reqLevel: 13,
    res: { pct: { militaryGoods: 0.15, machinery: 0.10 } }, stat: { pct: { attack: 0.10, moveAp: 0.75 } } },
  { id: "heavyArtillery", name: "火砲", category: "artillery", reqLevel: 15,
    res: { pct: { militaryGoods: 0.20, machinery: 0.20 } }, stat: { pct: { attack: 0.40, moveAp: 0.50 } },
    penetrationFlat: 5 },
  { id: "atGun", name: "対戦車砲", category: "artillery", reqLevel: 15,
    res: { pct: { militaryGoods: 0.20, machinery: 0.20 } }, stat: { pct: { attack: 0.20, moveAp: 0.50 } },
    penetrationFlat: 15 },
  { id: "rocketArtillery", name: "ロケット砲", category: "artillery", reqLevel: 25,
    res: { pct: { militaryGoods: 0.30, machinery: 0.10, fuel: 0.50 } }, stat: { pct: { attack: 0.75, moveAp: 0.25 } } },

  // ---- 車両系（全車両統一で moveAp-0.50, breakthrough+0.50, combatAp-0.25, §4 車両系）----
  { id: "earlyArmoredCar", name: "初期型装甲車", category: "vehicle", reqLevel: 10,
    res: { pct: { militaryGoods: 0.15, machinery: 0.20, fuel: 0.25 } }, stat: { pct: { attack: 0.05, breakthrough: 0.10 } }, armor: 2 },
  { id: "earlyTank", name: "初期型戦車", category: "vehicle", reqLevel: 13,
    res: { pct: { militaryGoods: 0.20, machinery: 0.25, fuel: 0.50 } }, stat: { pct: { attack: 0.20, breakthrough: 0.25 } }, armor: 3 },
  { id: "apc", name: "兵員輸送車", category: "vehicle", reqLevel: 15,
    res: { pct: { militaryGoods: 0.10, machinery: 0.20, fuel: 0.50 } }, stat: { pct: { breakthrough: 0.10, moveAp: -0.50 } }, armor: 2 },
  { id: "armoredCar", name: "装甲車", category: "vehicle", reqLevel: 15,
    res: { pct: { militaryGoods: 0.30, machinery: 0.25, fuel: 0.50 } }, stat: { pct: { attack: 0.20, breakthrough: 0.25 } }, armor: 4 },
  { id: "lightTank", name: "軽戦車", category: "vehicle", reqLevel: 15,
    res: { pct: { militaryGoods: 0.45, machinery: 0.50, fuel: 0.50 } }, stat: { pct: { attack: 0.30, breakthrough: 0.30, moveAp: -0.75 } }, armor: 5 },
  { id: "infantryTank", name: "歩兵戦車", category: "vehicle", reqLevel: 15,
    res: { pct: { militaryGoods: 0.50, machinery: 0.50, fuel: 0.75 } }, stat: { pct: { attack: 0.10, breakthrough: 0.10 } }, armor: 10,
    tags: ["grantArmorToInfantry5"] },
  { id: "mediumTank", name: "中戦車", category: "vehicle", reqLevel: 20,
    res: { pct: { militaryGoods: 0.75, machinery: 0.75, fuel: 1.00 } }, stat: { pct: { attack: 0.50, breakthrough: 1.00 } }, armor: 13 },
  { id: "tankDestroyer", name: "駆逐戦車", category: "vehicle", reqLevel: 20,
    res: { pct: { militaryGoods: 1.00, machinery: 0.75, fuel: 1.00 } }, stat: { pct: { attack: 0.20, breakthrough: 1.00 } }, armor: 10,
    penetrationFlat: 20 },
  { id: "spg", name: "自走砲", category: "vehicle", reqLevel: 20,
    res: { pct: { militaryGoods: 0.50, machinery: 0.30, fuel: 0.50 } }, stat: { pct: { attack: 0.40 } }, armor: 5,
    penetrationFlat: 10, tags: ["artilleryVsInfantry"] },
  { id: "spRocket", name: "自走ロケット砲", category: "vehicle", reqLevel: 30,
    res: { pct: { militaryGoods: 1.00, machinery: 1.00, fuel: 1.25 } }, stat: { pct: { attack: 1.00 } }, armor: 2,
    tags: ["enemyCombatApPlus0.75", "onContactEnemyApMinus5", "moralePerTurnMinus1", "artilleryVsInfantry"] },
  { id: "heavyTank", name: "重戦車", category: "vehicle", reqLevel: 25,
    res: { pct: { militaryGoods: 1.25, machinery: 1.00, fuel: 1.50 } }, stat: { pct: { attack: 0.75, breakthrough: 0.50 } }, armor: 20,
    penetrationFlat: 15, tags: ["enemyCombatApPlus0.25"] },
  { id: "superHeavyTank", name: "超重戦車", category: "vehicle", reqLevel: 30,
    res: { pct: { militaryGoods: 2.00, machinery: 3.00, fuel: 2.50 } }, stat: { pct: { attack: 1.25, breakthrough: 2.50, moveAp: 0.50 } }, armor: 20,
    penetrationFlat: 20, tags: ["enemyCombatApPlus0.75", "onContactEnemyApMinus5", "moralePerTurnMinus1"] },
  { id: "modernTank", name: "現代戦車", category: "vehicle", reqLevel: 30,
    res: { pct: { militaryGoods: 1.50, machinery: 2.00, fuel: 1.00 } }, stat: { pct: { attack: 1.00, breakthrough: 1.00 } }, armor: 20,
    penetrationFlat: 20 }
];

export const SPECIAL_UNITS_BY_ID = (() => {
  const m = {};
  for (const u of SPECIAL_UNITS) m[u.id] = u;
  return m;
})();

export const UNIT_CATEGORIES = ["infantry", "cavalry", "artillery", "vehicle"];

// composition のキーとして有効な兵種一覧（"line" = 通常兵）。
export const TROOP_KINDS = ["line", ...SPECIAL_UNITS.map(u => u.id)];

// ============================================================
// 3. ステータス計算ヘルパー（ヘッダー定義 §8.2）
// ============================================================

function toNum(v) { const n = Number(v); return isFinite(n) ? n : 0; }

// 1兵あたりの攻撃力 = 軍事技術力 / atkPerSoldierTechDiv
export function attackPerSoldier(tech, cfg = WAR_CONFIG_DEFAULTS) {
  const div = cfg.atkPerSoldierTechDiv || 5;
  return Math.max(0, toNum(tech)) / div;
}

// 1兵あたりの累進防御力（§ヘッダー）
//   tech<10→2, <20→4, <30→10, <40→12, 以降5レベルごとに+1
export function defPerSoldier(tech, cfg = WAR_CONFIG_DEFAULTS) {
  const t = Math.max(0, toNum(tech));
  const d = cfg.defPerSoldier || WAR_CONFIG_DEFAULTS.defPerSoldier;
  if (t < 10) return d.l10;
  if (t < 20) return d.l20;
  if (t < 30) return d.l30;
  if (t < 40) return d.l40;
  return d.l40 + Math.floor((t - 40) / 5) * (d.stepAbove40 ?? 1);
}

// 燃料段階を返す: "none" | "coal" | "oil"
export function fuelTierForTech(tech, cfg = WAR_CONFIG_DEFAULTS) {
  const t = Math.max(0, toNum(tech));
  const ft = cfg.fuelTiers || WAR_CONFIG_DEFAULTS.fuelTiers;
  if (t >= (ft.oil ?? 15)) return "oil";
  if (t >= (ft.coal ?? 10)) return "coal";
  return "none";
}

// 「fuel」カテゴリの消費量を実資源キー(oil/coal)に振り分ける。
//   石油段階では技術力に対して指数関数的に増える（§3.1）。
export function fuelDemandToResource(fuelAmount, tech, cfg = WAR_CONFIG_DEFAULTS) {
  const tier = fuelTierForTech(tech, cfg);
  const amt = toNum(fuelAmount);
  if (tier === "none" || amt <= 0) return { oil: 0, coal: 0 };
  if (tier === "coal") return { oil: 0, coal: amt };
  const base = cfg.oilExpBase || WAR_CONFIG_DEFAULTS.oilExpBase;
  const oilLevel = (cfg.fuelTiers && cfg.fuelTiers.oil) || 15;
  const factor = Math.pow(base, Math.max(0, toNum(tech) - oilLevel));
  return { oil: amt * factor, coal: 0 };
}

// 軍事技術力で動員可能な特殊兵か
export function canFieldUnit(unitId, tech) {
  if (unitId === "line") return true;
  const u = SPECIAL_UNITS_BY_ID[unitId];
  if (!u) return false;
  return toNum(tech) >= (u.reqLevel || 0);
}

// CONFIG の深いマージ（ライブ調整値で既定を上書き）。
export function mergeWarConfig(override) {
  return deepMerge(clone(WAR_CONFIG_DEFAULTS), override || {});
}

function clone(o) { return JSON.parse(JSON.stringify(o)); }
function deepMerge(base, ov) {
  if (!ov || typeof ov !== "object") return base;
  for (const k of Object.keys(ov)) {
    const v = ov[k];
    if (v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object" && !Array.isArray(base[k])) {
      deepMerge(base[k], v);
    } else {
      base[k] = v;
    }
  }
  return base;
}

// ============================================================
// 4. military ツリーの正規化（§1.1）
// ============================================================

export function newArmyId() {
  return "army_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

export function defaultArmy(opts = {}) {
  return {
    id: opts.id || newArmyId(),
    name: opts.name || "新編軍",
    location: opts.location || "",
    composition: { line: 0 },
    mode: "idle",
    ap: WAR_CONFIG_DEFAULTS.apMax,
    morale: WAR_CONFIG_DEFAULTS.moraleMax,
    supplyLevel: 1.0,
    generalId: null,
    activeOrderId: null
  };
}

export function defaultMilitary() {
  return {
    armies: {},
    mobilizedPool: { line: 0 },
    reserveByState: {},
    generals: {},
    doctrine: "balanced"
  };
}

function normalizeComposition(input) {
  const c = { line: 0 };
  if (input && typeof input === "object") {
    for (const k of TROOP_KINDS) {
      const v = Number(input[k]);
      if (isFinite(v) && v > 0) c[k] = Math.floor(v);
    }
  }
  return c;
}

function normalizeArmy(input) {
  const a = defaultArmy({ id: input && input.id });
  if (!input || typeof input !== "object") return a;
  if (typeof input.id === "string" && input.id) a.id = input.id;
  if (typeof input.name === "string") a.name = input.name;
  if (typeof input.location === "string") a.location = input.location;
  a.composition = normalizeComposition(input.composition);
  const validModes = ["idle", "defend", "moving", "battling", "retreating", "annihilating", "surrendered"];
  a.mode = validModes.includes(input.mode) ? input.mode : "idle";
  a.ap = isFinite(Number(input.ap)) ? Number(input.ap) : WAR_CONFIG_DEFAULTS.apMax;
  a.morale = isFinite(Number(input.morale)) ? clamp(Number(input.morale), 0, WAR_CONFIG_DEFAULTS.moraleMax) : WAR_CONFIG_DEFAULTS.moraleMax;
  a.supplyLevel = isFinite(Number(input.supplyLevel)) ? clamp(Number(input.supplyLevel), 0, 1) : 1.0;
  a.generalId = (typeof input.generalId === "string" && input.generalId) ? input.generalId : null;
  a.activeOrderId = (typeof input.activeOrderId === "string" && input.activeOrderId) ? input.activeOrderId : null;
  return a;
}

export function normalizeMilitary(input) {
  const m = defaultMilitary();
  if (!input || typeof input !== "object") return m;

  if (input.armies && typeof input.armies === "object") {
    for (const k of Object.keys(input.armies)) {
      const raw = input.armies[k];
      const a = normalizeArmy(raw);
      // Firebase の子ノードキーを id の単一の真実にする（明示 id が無ければキーを採用）
      if (!(raw && typeof raw === "object" && raw.id)) a.id = k;
      m.armies[a.id] = a;
    }
  }
  if (input.mobilizedPool && typeof input.mobilizedPool === "object") {
    m.mobilizedPool = normalizeComposition(input.mobilizedPool);
  }
  if (input.reserveByState && typeof input.reserveByState === "object") {
    for (const k of Object.keys(input.reserveByState)) {
      const v = Number(input.reserveByState[k]);
      if (isFinite(v) && v !== 0) m.reserveByState[k] = Math.floor(v);
    }
  }
  if (input.generals && typeof input.generals === "object") {
    m.generals = input.generals;
  }
  const validDoctrines = Object.keys(WAR_CONFIG_DEFAULTS.doctrines);
  m.doctrine = validDoctrines.includes(input.doctrine) ? input.doctrine : "balanced";
  return m;
}

// 軍の総兵数
export function armyTroops(army) {
  if (!army || !army.composition) return 0;
  let n = 0;
  for (const k of Object.keys(army.composition)) n += toNum(army.composition[k]);
  return n;
}

// military 全体の予備兵合計（reserveByState の総和）
export function totalReserve(military) {
  if (!military || !military.reserveByState) return 0;
  let n = 0;
  for (const k of Object.keys(military.reserveByState)) n += toNum(military.reserveByState[k]);
  return n;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
