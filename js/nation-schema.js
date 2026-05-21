// Aster Stella - 国家のスキーマ
//
// 国家ごとのステータス定義。作ってほしいもの.txt に準拠。
//   - ステート由来のステータス   : 領土から自動集計（編集不可）
//   - 操作可能ステータス         : 国家単位で直接編集
//   - 計算で求めるステータス     : 上記から算出（編集不可）

import { INDUSTRY_FIELDS } from "./state-schema.js";

// 経済イデオロギー（プルダウン候補）
export const ECONOMIC_IDEOLOGIES = [
  "純粋資本主義", "計画経済", "福祉経済", "企業統治経済", "戦時経済"
];
// 政治体制イデオロギー（プルダウン候補）
export const POLITICAL_IDEOLOGIES = [
  "自由民主主義", "社会民主主義", "共産主義", "絶対君主主義", "軍事独裁"
];

// 基本情報
export const NATION_BASIC_FIELDS = [
  { key: "name",       label: "正式国名",         type: "text" },
  { key: "color",      label: "国家色",           type: "color" },
  { key: "capital",    label: "首都ステート",     type: "text" },
  { key: "ideology",   label: "経済イデオロギー", type: "select", options: ECONOMIC_IDEOLOGIES },
  { key: "government", label: "政治体制",         type: "select", options: POLITICAL_IDEOLOGIES }
];

// 認証情報（playerサイドのログインで使用）
// パスワードは平文保存。共同プレイ用途のため強い秘匿性は要求しない。
export const NATION_CREDENTIAL_FIELDS = [
  { key: "password", label: "ログインパスワード", type: "password" }
];

// ステート由来のステータス（領土から自動集計・編集不可）
export const NATION_DERIVED_FIELDS = [
  { key: "totalStates",       label: "合計ステート数" },
  { key: "totalEconomy",      label: "合計経済力" },
  { key: "avgGovernance",     label: "平均統治レベル" },
  { key: "avgInfrastructure", label: "平均インフラレベル" },
  { key: "totalDevelopment",  label: "合計開発度" },
  { key: "totalPopulation",   label: "合計人口" },
  { key: "avgLivingStandard", label: "平均生活水準" }
];

// 国家単位で操作可能なステータス（計算で求めるものは除く）
export const NATION_STAT_FIELDS = [
  { key: "treasury",        label: "国庫" },
  { key: "politicalPower",  label: "政治力" },
  { key: "militaryTech",    label: "軍事技術力" },
  { key: "industrialTech",  label: "産業技術力" },
  { key: "taxRate",         label: "税率" },
  { key: "economyTrend",    label: "国家別景気" },
  { key: "reserveTroops",   label: "予備兵" },
  { key: "mobilizedTroops", label: "動員兵" }
];

// 計算で求めるステータス（編集不可）
//   prestige     = 合計経済力*合計開発度 + 合計人口*平均生活水準 + 資源産出量 + 貿易収支(後で設定)
//   totalTroops  = 予備兵 + 動員兵
export const NATION_COMPUTED_FIELDS = [
  { key: "prestige",    label: "威信" },
  { key: "totalTroops", label: "合計兵力" }
];

// playerサイドで増えるキーのデフォルト。
// これらは管理者ページ(nations.js)が nations 全体を再保存しても消えないよう、
// normalizeNation で必ず保持する。
//   research  : 研究トラック・投入配分・完了アップグレード
//   treaties  : 条約（非戦争部分）
//   logs      : 直近の出来事ログ（GASやUIが追記、直近100件に丸める）
//   orders    : 予約された操作キュー（GASが一定時刻に一斉処理する）
export function defaultResearch() {
  return {
    tracks: { industrial: 0, military: 0 },
    allocation: { industrial: 0.5, military: 0.5 },
    upgrades: {}
  };
}

// 国家の資源在庫（流通資源10種）。毎ターンの余剰を貯め、貿易・建設で増減する。
export const STOCKPILE_KEYS = [
  "consumerGoods", "militaryGoods", "metal", "heavyGoods", "oil",
  "coal", "food", "parts", "machinery", "rareMineral"
];

export function defaultStockpile() {
  const s = {};
  for (const k of STOCKPILE_KEYS) s[k] = 0;
  return s;
}

function normalizeStockpile(input) {
  const s = defaultStockpile();
  if (input && typeof input === "object") {
    for (const k of STOCKPILE_KEYS) {
      const v = Number(input[k]);
      if (isFinite(v)) s[k] = v;
    }
  }
  return s;
}

function normalizeResearch(input) {
  const r = defaultResearch();
  if (!input || typeof input !== "object") return r;
  if (input.tracks && typeof input.tracks === "object") {
    r.tracks.industrial = toNum(input.tracks.industrial);
    r.tracks.military = toNum(input.tracks.military);
  }
  if (input.allocation && typeof input.allocation === "object") {
    let ind = toNum(input.allocation.industrial);
    let mil = toNum(input.allocation.military);
    const sum = ind + mil;
    if (sum > 0) { ind /= sum; mil /= sum; } else { ind = 0.5; mil = 0.5; }
    r.allocation = { industrial: ind, military: mil };
  }
  if (input.upgrades && typeof input.upgrades === "object") {
    for (const k of Object.keys(input.upgrades)) r.upgrades[k] = input.upgrades[k];
  }
  return r;
}

const DEFAULT_PALETTE = [
  "#c0392b", "#2980b9", "#27ae60", "#8e44ad", "#d35400",
  "#16a085", "#2c3e50", "#7f8c8d", "#e67e22", "#1abc9c",
  "#9b59b6", "#34495e", "#f39c12", "#e74c3c", "#3498db"
];

export function nextDefaultColor(existingColors) {
  const used = new Set((existingColors || []).map(s => (s || "").toLowerCase()));
  for (const c of DEFAULT_PALETTE) {
    if (!used.has(c.toLowerCase())) return c;
  }
  const h = Math.floor(Math.random() * 360);
  const s = 55 + Math.floor(Math.random() * 20);
  const l = 40 + Math.floor(Math.random() * 15);
  return hslToHex(h, s, l);
}

function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => {
    const v = l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    return Math.round(255 * v).toString(16).padStart(2, "0");
  };
  return "#" + f(0) + f(8) + f(4);
}

export function newNationId() {
  return "nat_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

export function defaultNation(opts = {}) {
  const n = { id: opts.id || newNationId() };
  for (const f of NATION_BASIC_FIELDS) {
    if (f.type === "color") n[f.key] = opts.color || "#888888";
    else n[f.key] = "";
  }
  for (const f of NATION_CREDENTIAL_FIELDS) n[f.key] = "";
  n.stats = {};
  for (const f of NATION_STAT_FIELDS) n.stats[f.key] = 0;
  n.research = defaultResearch();
  n.stockpile = defaultStockpile();
  n.prevIdeology = "";
  n.treaties = [];
  n.logs = [];
  n.orders = {};
  return n;
}

export function normalizeNation(input) {
  const base = defaultNation({ id: input && input.id });
  if (!input || typeof input !== "object") return base;
  if (typeof input.id === "string" && input.id) base.id = input.id;
  for (const f of NATION_BASIC_FIELDS) {
    if (input[f.key] === undefined || input[f.key] === null) continue;
    base[f.key] = String(input[f.key]);
  }
  for (const f of NATION_CREDENTIAL_FIELDS) {
    if (input[f.key] === undefined || input[f.key] === null) continue;
    base[f.key] = String(input[f.key]);
  }
  if (input.stats && typeof input.stats === "object") {
    for (const f of NATION_STAT_FIELDS) {
      const v = Number(input.stats[f.key]);
      if (isFinite(v)) base.stats[f.key] = v;
    }
  }
  // playerサイドのキーを保持（管理者保存で消さないため）
  base.research = normalizeResearch(input.research);
  base.stockpile = normalizeStockpile(input.stockpile);
  base.prevIdeology = typeof input.prevIdeology === "string" ? input.prevIdeology : "";
  base.treaties = Array.isArray(input.treaties) ? input.treaties.slice() : [];
  base.logs = Array.isArray(input.logs) ? input.logs.slice(-100) : [];
  // orders は id をキーにしたオブジェクト（append-only キュー）。
  // 配列まるごと上書きすると予約が競合で消えるため、子ノード単位で読み書きする。
  // 旧データが配列だった場合も id キーのオブジェクトへ寄せて保持する。
  base.orders = normalizeOrders(input.orders);
  return base;
}

function normalizeOrders(input) {
  const out = {};
  if (!input) return out;
  if (Array.isArray(input)) {
    for (const o of input) {
      if (o && typeof o === "object" && o.id) out[o.id] = o;
    }
  } else if (typeof input === "object") {
    for (const k of Object.keys(input)) {
      const o = input[k];
      if (o && typeof o === "object") out[k] = o;
    }
  }
  return out;
}

export function nationLabel(nation) {
  if (!nation) return "（未所属）";
  return nation.name || nation.id;
}

function toNum(v) { const n = Number(v); return isFinite(n) ? n : 0; }

// ステート由来のステータスを領土から集計
export function computeDerivedStats(nationId, statesData) {
  const industries = {};
  for (const f of INDUSTRY_FIELDS) industries[f.key] = 0;

  let count = 0;
  let totalEconomy = 0;
  let totalDevelopment = 0;
  let totalPopulation = 0;
  let governanceSum = 0;
  let infrastructureSum = 0;
  let livingStandardSum = 0;
  let resourceOutput = 0;

  for (const name of Object.keys(statesData || {})) {
    const s = statesData[name];
    if (!s || s.country !== nationId) continue;
    count++;
    totalEconomy      += toNum(s.economy);
    totalDevelopment  += toNum(s.development);
    totalPopulation   += toNum(s.population);
    governanceSum     += toNum(s.governance);
    infrastructureSum += toNum(s.infrastructure);
    livingStandardSum += toNum(s.livingStandard);
    if (s.industries) {
      for (const f of INDUSTRY_FIELDS) industries[f.key] += toNum(s.industries[f.key]);
    }
    if (s.resources) {
      for (const k of Object.keys(s.resources)) resourceOutput += toNum(s.resources[k]);
    }
  }
  const n = count || 1;
  return {
    totalStates: count,
    totalEconomy,
    avgGovernance: count ? governanceSum / n : 0,
    avgInfrastructure: count ? infrastructureSum / n : 0,
    totalDevelopment,
    totalPopulation,
    avgLivingStandard: count ? livingStandardSum / n : 0,
    industries,
    resourceOutput
  };
}

// 計算で求めるステータス
export function computeNationComputed(nation, derived) {
  const tradeBalance = 0; // 後で設定
  const prestige =
    (derived.totalEconomy * derived.totalDevelopment) +
    (derived.totalPopulation * derived.avgLivingStandard) +
    derived.resourceOutput +
    tradeBalance;
  const totalTroops = toNum(nation.stats.reserveTroops) + toNum(nation.stats.mobilizedTroops);
  return { prestige, totalTroops };
}
