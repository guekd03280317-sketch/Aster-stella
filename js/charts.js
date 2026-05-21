// Aster Stella - 軽量SVGチャート（依存なし）
//
// 棒グラフ / 円グラフ / 折れ線グラフを SVG で描く。
// ダークテーマ・スマホ対応（viewBox でスケール、フォント16px相当）。
// 返り値は SVGElement。呼び出し側がコンテナに append する。

const PALETTE = [
  "#5aa9ff", "#7be0c7", "#f6ad55", "#c084fc", "#f87171",
  "#4ade80", "#38bdf8", "#fbbf24", "#fb7185", "#a3e635"
];

const NS = "http://www.w3.org/2000/svg";

function el(name, attrs) {
  const e = document.createElementNS(NS, name);
  for (const k of Object.keys(attrs || {})) e.setAttribute(k, attrs[k]);
  return e;
}

function fmt(v) {
  const n = Number(v) || 0;
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

// 横棒グラフ。data: [{label, value, color?}]
export function barChart(data, opts = {}) {
  const rows = data.slice(0, opts.max || 12);
  const W = 320, rowH = 28, padL = 96, padR = 44, padT = 8, padB = 8;
  const H = padT + padB + rows.length * rowH;
  const max = Math.max(1, ...rows.map((d) => Math.abs(d.value)));
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart chart-bar", width: "100%" });

  rows.forEach((d, i) => {
    const y = padT + i * rowH;
    const barW = (Math.abs(d.value) / max) * (W - padL - padR);
    svg.appendChild(el("text", { x: padL - 6, y: y + rowH / 2, "text-anchor": "end",
      "dominant-baseline": "middle", class: "chart-label" })).textContent = d.label;
    svg.appendChild(el("rect", { x: padL, y: y + 5, width: Math.max(1, barW), height: rowH - 12,
      rx: 4, fill: d.color || PALETTE[i % PALETTE.length] }));
    svg.appendChild(el("text", { x: padL + barW + 5, y: y + rowH / 2, "text-anchor": "start",
      "dominant-baseline": "middle", class: "chart-value" })).textContent = fmt(d.value);
  });
  return svg;
}

// 円グラフ。data: [{label, value, color?}]
export function pieChart(data, opts = {}) {
  const rows = data.filter((d) => Number(d.value) > 0);
  const total = rows.reduce((s, d) => s + Number(d.value), 0) || 1;
  const W = 320, H = 180, cx = 90, cy = 90, r = 78;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart chart-pie", width: "100%" });

  let a0 = -Math.PI / 2;
  rows.forEach((d, i) => {
    const frac = Number(d.value) / total;
    const a1 = a0 + frac * Math.PI * 2;
    const large = frac > 0.5 ? 1 : 0;
    const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
    const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    const color = d.color || PALETTE[i % PALETTE.length];
    if (rows.length === 1) {
      svg.appendChild(el("circle", { cx, cy, r, fill: color }));
    } else {
      svg.appendChild(el("path", {
        d: `M ${cx} ${cy} L ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z`,
        fill: color, stroke: "#0b1018", "stroke-width": 1
      }));
    }
    // 凡例
    const ly = 16 + i * 20;
    svg.appendChild(el("rect", { x: 196, y: ly - 9, width: 12, height: 12, rx: 2, fill: color }));
    svg.appendChild(el("text", { x: 214, y: ly, class: "chart-label", "dominant-baseline": "middle" }))
      .textContent = `${d.label} ${Math.round(frac * 100)}%`;
    a0 = a1;
  });
  return svg;
}

// 折れ線グラフ。series: [{label, color?, points:[number,...]}], xLabels?: [string,...]
export function lineChart(series, opts = {}) {
  const W = 340, H = 180, padL = 40, padR = 12, padT = 12, padB = 24;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart chart-line", width: "100%" });
  const allVals = series.flatMap((s) => s.points.map(Number));
  let min = Math.min(...allVals), max = Math.max(...allVals);
  if (!isFinite(min)) { min = 0; max = 1; }
  if (min === max) { max = min + 1; }
  if (opts.zeroBase && min > 0) min = 0;
  const n = Math.max(...series.map((s) => s.points.length), 1);
  const px = (i) => padL + (i / Math.max(1, n - 1)) * (W - padL - padR);
  const py = (v) => padT + (1 - (v - min) / (max - min)) * (H - padT - padB);

  // 目盛り
  for (let g = 0; g <= 2; g++) {
    const v = min + (max - min) * (g / 2);
    const y = py(v);
    svg.appendChild(el("line", { x1: padL, y1: y, x2: W - padR, y2: y, class: "chart-grid" }));
    svg.appendChild(el("text", { x: padL - 4, y: y, "text-anchor": "end",
      "dominant-baseline": "middle", class: "chart-axis" })).textContent = fmt(v);
  }
  series.forEach((s, si) => {
    const color = s.color || PALETTE[si % PALETTE.length];
    const d = s.points.map((v, i) => `${i === 0 ? "M" : "L"} ${px(i).toFixed(1)} ${py(Number(v)).toFixed(1)}`).join(" ");
    svg.appendChild(el("path", { d, fill: "none", stroke: color, "stroke-width": 2,
      "stroke-linejoin": "round", "stroke-linecap": "round" }));
  });
  return svg;
}

export function chartLegend(items) {
  const wrap = document.createElement("div");
  wrap.className = "chart-legend";
  items.forEach((it, i) => {
    const span = document.createElement("span");
    span.className = "chart-legend-item";
    const dot = document.createElement("span");
    dot.className = "chart-legend-dot";
    dot.style.background = it.color || PALETTE[i % PALETTE.length];
    span.appendChild(dot);
    span.appendChild(document.createTextNode(it.label));
    wrap.appendChild(span);
  });
  return wrap;
}

export { PALETTE };
