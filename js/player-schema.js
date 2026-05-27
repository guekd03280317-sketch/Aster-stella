// Aster Stella - playerサイドのスキーマ補助
//
// 役割:
//   - 予約操作(order)の種別定義と表示用フォーマッタ
//   - 市場(market)のデフォルトと正規化
//   - ログ(logs)の追記ヘルパー
//
// 予約方式について:
//   プレイヤーの操作は集計済みステータスを直接書き換えず、
//   aster_stella/nations/{id}/orders に「予約」として積む。
//   GASが一定時刻に全国家分を読み込んで一斉処理(ターン進行)する。
//   これにより複数プレイヤーが同時に操作しても上書きで消えない
//   （各国家は自分の orders 配下にだけ書き込むため衝突しない）。

// ---- 予約操作(order)の種別 ----
// kind ごとに UI ラベルと、予約一覧に表示する説明文を定義する。
// payload の中身は各タブが組み立てる。
export const ORDER_KINDS = {
  setTaxRate: {
    label: "税率変更",
    cost: "政治力",
    describe: (p) => `税率を ${fmtRate(p.rate)} に変更`
  },
  investDevelopment: {
    label: "開発度投資",
    cost: "国庫",
    describe: (p) => `${p.state} の開発度に投資（+${num(p.amount)}）`
  },
  investInfrastructure: {
    label: "インフラ投資",
    cost: "国庫",
    describe: (p) => `${p.state} のインフラに投資（+${num(p.amount)}）`
  },
  investGovernance: {
    label: "統治レベル投資",
    cost: "政治力",
    describe: (p) => `${p.state} の統治レベルに投資（+${num(p.amount)}）`
  },
  conscript: {
    label: "予備兵の徴兵",
    cost: "国庫・人口",
    describe: (p) => `予備兵を ${num(p.amount)} 徴兵`
  },
  buildIndustry: {
    label: "産業の建設",
    cost: "国庫ほか",
    describe: (p) => `${p.state} に ${industryLabel(p.industry)} を ${num(p.count)} 建設`
  },
  demolishIndustry: {
    label: "産業の解体",
    cost: "なし（戻りなし）",
    describe: (p) => `${p.state} の ${industryLabel(p.industry)} を ${num(p.count)} 解体`
  },
  setResearchAllocation: {
    label: "研究配分の変更",
    cost: "なし",
    describe: (p) => `研究配分を 産業${pct(p.industrial)} / 軍事${pct(p.military)} に変更`
  },
  switchWarEconomy: {
    label: "戦時経済の切替",
    cost: "移行は政治力250 / 解除は無料",
    describe: (p) => (p.on ? "戦時経済へ移行（政治力250）" : "戦時経済を解除（元の経済体制へ）")
  },
  annexState: {
    label: "ステートの編入",
    cost: "政治力（ステート数で逓増）",
    describe: (p) => `${p.state} を編入`
  },
  sendTransfer: {
    label: "送金・物資の送付",
    cost: "送る分の国庫・在庫",
    describe: (p) => {
      const parts = [];
      if (p.money) parts.push(`国庫 ${num(p.money)}`);
      if (p.resources) {
        for (const k of Object.keys(p.resources)) {
          if (p.resources[k]) parts.push(`${resourceLabel(k)} ${num(p.resources[k])}`);
        }
      }
      return `${p.toName || p.to} へ ${parts.join(" / ") || "（なし）"} を送付`;
    }
  },
  acceptTrade: {
    label: "取引提案の承認",
    cost: "提案条件に従う",
    describe: (p) => `取引提案 ${p.proposalId} を承認`
  },
  tradeOffer: {
    label: "市場オファー",
    cost: "成立時に決済",
    describe: (p) =>
      `${p.side === "buy" ? "買い" : "売り"} ${resourceLabel(p.resource)} ${num(p.amount)} @ ${num(p.price)}`
  },
  tradeAccept: {
    label: "オファー承認",
    cost: "成立時に決済",
    describe: (p) => `オファー ${p.offerId} を承認`
  },
  tradeCancel: {
    label: "オファー取消",
    cost: "なし",
    describe: (p) => `オファー ${p.offerId} を取消`
  }
};

export function orderLabel(kind) {
  return (ORDER_KINDS[kind] && ORDER_KINDS[kind].label) || kind;
}

export function describeOrder(order) {
  if (!order || !order.kind) return "（不明な操作）";
  const def = ORDER_KINDS[order.kind];
  if (def && typeof def.describe === "function") {
    try { return def.describe(order.payload || {}); }
    catch (_) { return def.label; }
  }
  return order.kind;
}

export function newOrderId() {
  return "ord_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6);
}

export function makeOrder(kind, payload) {
  return { id: newOrderId(), at: Date.now(), kind, payload: payload || {}, status: "pending" };
}

// ---- 市場(market) ----
// aster_stella/market に置く。価格と相対取引オファー。
export const MARKET_RESOURCES = [
  { key: "metal",      label: "金属資源" },
  { key: "oil",        label: "石油燃料" },
  { key: "coal",       label: "石炭燃料" },
  { key: "rareMineral",label: "重要鉱物資源" },
  { key: "food",       label: "食料資源" }
];

export function defaultMarket() {
  const prices = {};
  for (const r of MARKET_RESOURCES) prices[r.key] = 0;
  return { prices, offers: [] };
}

export function normalizeMarket(input) {
  const m = defaultMarket();
  if (!input || typeof input !== "object") return m;
  if (input.prices && typeof input.prices === "object") {
    for (const r of MARKET_RESOURCES) {
      const v = Number(input.prices[r.key]);
      if (isFinite(v)) m.prices[r.key] = v;
    }
  }
  if (Array.isArray(input.offers)) m.offers = input.offers.slice();
  return m;
}

// ---- ログ ----
export const LOG_KINDS = ["policy", "build", "trade", "diplo", "research", "login", "turn"];

export function pushLog(logs, kind, text) {
  const arr = Array.isArray(logs) ? logs.slice() : [];
  arr.push({ at: Date.now(), kind, text });
  return arr.slice(-100); // 直近100件に丸める
}

// ---- 表示ヘルパー ----
const INDUSTRY_LABELS = {
  civilian: "民間産業", consumerFactory: "民需工場", militaryFactory: "軍需工場",
  metalMine: "金属鉱山", heavyChemical: "重化学工業", oilField: "油田",
  coalField: "炭田", farm: "農場", partsFactory: "部品工場",
  machineryFactory: "機械工場", rareMineralMine: "重要鉱物鉱山", university: "大学"
};
const RESOURCE_LABELS = {
  consumerGoods: "民需資源", militaryGoods: "軍需資源", metal: "金属資源",
  heavyGoods: "工業製品", oil: "石油燃料", coal: "石炭燃料", food: "食料資源",
  parts: "工業部品", machinery: "機械製品", rareMineral: "重要鉱物資源"
};

function industryLabel(k) { return INDUSTRY_LABELS[k] || k; }
function resourceLabel(k) { return RESOURCE_LABELS[k] || k; }
function num(v) { const n = Number(v); return isFinite(n) ? n.toLocaleString() : "0"; }
function pct(v) { const n = Number(v); return isFinite(n) ? Math.round(n * 100) + "%" : "0%"; }
function fmtRate(v) { const n = Number(v); return isFinite(n) ? n.toFixed(2) : "0.00"; }
