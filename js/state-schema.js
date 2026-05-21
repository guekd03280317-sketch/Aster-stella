// Aster Stella - ステートのステータススキーマ
//
// 各ステートが持つフィールドの定義。
// UI のラベル、デフォルト値、保存形式の正規化を一箇所にまとめる。

// 基本情報（経済力・統治レベルなどの数値、所属国家などの文字列）
export const BASIC_FIELDS = [
  { key: "country",        label: "所属国家",       type: "text" },
  { key: "specialState",   label: "特殊状態",       type: "text" },
  { key: "economy",        label: "経済力",         type: "number" },
  { key: "governance",     label: "統治レベル",     type: "number" },
  { key: "infrastructure", label: "インフラレベル", type: "number" },
  { key: "development",    label: "開発度",         type: "number" },
  { key: "population",     label: "人口",           type: "number" },
  { key: "livingStandard", label: "生活水準",       type: "number" }
];

// 産業（設置数）
export const INDUSTRY_FIELDS = [
  { key: "civilian",         label: "民間産業" },
  { key: "consumerFactory",  label: "民需工場" },
  { key: "militaryFactory",  label: "軍需工場" },
  { key: "metalMine",        label: "金属鉱山" },
  { key: "heavyChemical",    label: "重化学工業" },
  { key: "oilField",         label: "油田" },
  { key: "coalField",        label: "炭田" },
  { key: "farm",             label: "農場" },
  { key: "partsFactory",     label: "部品工場" },
  { key: "machineryFactory", label: "機械工場" },
  { key: "rareMineralMine",  label: "重要鉱物鉱山" },
  { key: "university",       label: "大学" }
];

// 資源（埋蔵量）
export const RESOURCE_FIELDS = [
  { key: "fertility",   label: "肥沃度（農場）" },
  { key: "metal",       label: "金属資源（金属鉱山）" },
  { key: "oil",         label: "石油資源（油田）" },
  { key: "coal",        label: "石炭資源（炭田）" },
  { key: "rareMineral", label: "重要鉱物資源（重要鉱物鉱山）" }
];

// 1ステート分のデフォルト値
export function defaultState() {
  const s = {};
  for (const f of BASIC_FIELDS) {
    s[f.key] = f.type === "number" ? 0 : "";
  }
  s.industries = {};
  for (const f of INDUSTRY_FIELDS) s.industries[f.key] = 0;
  s.resources = {};
  for (const f of RESOURCE_FIELDS) s.resources[f.key] = 0;
  return s;
}

// 既存データを欠損補完しつつ正規化する
export function normalizeState(input) {
  const base = defaultState();
  if (!input || typeof input !== "object") return base;
  for (const f of BASIC_FIELDS) {
    if (input[f.key] !== undefined && input[f.key] !== null) {
      base[f.key] = input[f.key];
    }
  }
  if (input.industries && typeof input.industries === "object") {
    for (const f of INDUSTRY_FIELDS) {
      const v = input.industries[f.key];
      if (typeof v === "number") base.industries[f.key] = v;
    }
  }
  if (input.resources && typeof input.resources === "object") {
    for (const f of RESOURCE_FIELDS) {
      const v = input.resources[f.key];
      if (typeof v === "number") base.resources[f.key] = v;
    }
  }
  return base;
}

// 表示モード（地図のヒートマップ用）
// 値ベース or 文字列ベース（国家）を判定するために型を持たせる。
export const DISPLAY_MODES = [
  { value: "default", label: "単色（デフォルト）", kind: "default" },
  { value: "country", label: "所属国家",            kind: "category", path: ["country"] },
  ...BASIC_FIELDS
    .filter(f => f.type === "number")
    .map(f => ({ value: "basic:" + f.key, label: f.label, kind: "number", path: [f.key] })),
  ...INDUSTRY_FIELDS.map(f => ({
    value: "industry:" + f.key,
    label: "産業: " + f.label,
    kind: "number",
    path: ["industries", f.key]
  })),
  ...RESOURCE_FIELDS.map(f => ({
    value: "resource:" + f.key,
    label: "資源: " + f.label,
    kind: "number",
    path: ["resources", f.key]
  }))
];

export function getByPath(obj, path) {
  let cur = obj;
  for (const k of path) {
    if (cur == null) return undefined;
    cur = cur[k];
  }
  return cur;
}
