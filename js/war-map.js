// Aster Stella - 戦争地図の演出レイヤー（§23 / §24）
//
// 地図SVG（viewBox方式・iOSぼやけ対策）の前面に <canvas> を重ね、
// 軍駒・進撃矢印・選択ハイライト・戦闘エフェクトを描く。
//   - 地図のパン/ズーム（viewBox変更）に毎フレーム追従する（map-pan-zoom.js は無改造で流用）。
//   - canvas は既定で pointer-events:none。地図のクリック/パン/ピンチは下の SVG が処理する。
//   - 範囲選択（投げ縄/矩形, §23.2）のときだけ canvas が pointer を奪う。
//
// 重い盤面解決はしない。描画と当たり判定だけ。

function dpr() { return (typeof window !== "undefined" && window.devicePixelRatio) || 1; }
function prefersReducedMotion() {
  try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (_) { return false; }
}

// container: position:relative なラッパ（中に svg が入っている）
// svg: 地図SVG（#map > path に state名idが付いている）
export function createWarMap(svg, container, opts = {}) {
  const canvas = document.createElement("canvas");
  canvas.className = "war-fx-canvas";
  canvas.style.position = "absolute";
  canvas.style.left = "0";
  canvas.style.top = "0";
  canvas.style.pointerEvents = "none";
  container.appendChild(canvas);
  const ctx = canvas.getContext("2d");

  let armies = [];     // [{ id, state, troops, color, mode, supply, morale, selected }]
  let arrows = [];     // [{ from(state), to(state), color, dashed, seq, startTime }]
  let pulses = [];     // 一時的な戦闘エフェクト [{x,y,t0,kind,color}]
  const centroidCache = new Map(); // state -> {x,y} in SVG coords
  let selectMode = false;
  let onSelectCb = null;
  let fxEnabled = opts.fxEnabled !== false && !prefersReducedMotion();

  // ---- 座標変換: SVG座標 → container内のCSSピクセル ----
  function transform() {
    const rect = svg.getBoundingClientRect();
    const crect = container.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    const offX = rect.left - crect.left;
    const offY = rect.top - crect.top;
    return { rect, vb, offX, offY };
  }
  function toScreen(p, tf) {
    const t = tf || transform();
    if (!t.vb || t.vb.width === 0) return { x: 0, y: 0 };
    return {
      x: (p.x - t.vb.x) / t.vb.width * t.rect.width + t.offX,
      y: (p.y - t.vb.y) / t.vb.height * t.rect.height + t.offY
    };
  }
  function screenToSvg(clientX, clientY) {
    const rect = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    const sx = (clientX - rect.left) / rect.width;
    const sy = (clientY - rect.top) / rect.height;
    return { x: vb.x + sx * vb.width, y: vb.y + sy * vb.height };
  }

  function centroid(state) {
    if (centroidCache.has(state)) return centroidCache.get(state);
    const el = svg.querySelector("#map > #" + cssEscape(state)) || findPathById(svg, state);
    let c = null;
    if (el) {
      try { const b = el.getBBox(); if (b.width > 0 || b.height > 0) c = { x: b.x + b.width / 2, y: b.y + b.height / 2 }; } catch (_) { c = null; }
    }
    // 非表示タブでは getBBox が 0 を返す。有効な値が取れたときだけキャッシュし、
    // タブが表示された後に再計算できるようにする。
    if (c) centroidCache.set(state, c);
    return c;
  }

  // ---- リサイズ ----
  function resize() {
    const crect = container.getBoundingClientRect();
    const ratio = dpr();
    canvas.width = Math.max(1, Math.round(crect.width * ratio));
    canvas.height = Math.max(1, Math.round(crect.height * ratio));
    canvas.style.width = crect.width + "px";
    canvas.style.height = crect.height + "px";
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  // ---- 描画 ----
  let lastKey = "";
  function viewKey(tf) {
    return [tf.rect.width, tf.rect.height, tf.vb.x, tf.vb.y, tf.vb.width, tf.offX, tf.offY].join(",");
  }

  function draw(now) {
    const tf = transform();
    const crect = container.getBoundingClientRect();
    ctx.clearRect(0, 0, crect.width, crect.height);

    // 進撃矢印
    const dash = fxEnabled ? (now / 40) % 16 : 0;
    for (const a of arrows) {
      const cf = centroid(a.from), ct = centroid(a.to);
      if (!cf || !ct) continue;
      drawArrow(toScreen(cf, tf), toScreen(ct, tf), a, dash);
    }

    // 軍駒
    for (const army of armies) {
      const c = centroid(army.state);
      if (!c) continue;
      drawToken(toScreen(c, tf), army);
    }

    // 戦闘パルス
    if (fxEnabled) {
      pulses = pulses.filter(p => now - p.t0 < 700);
      for (const p of pulses) {
        const c = centroid(p.state);
        if (!c) continue;
        drawPulse(toScreen(c, tf), p, now);
      }
    }
  }

  function drawArrow(p0, p1, a, dash) {
    const dx = p1.x - p0.x, dy = p1.y - p0.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    // 駒に被らないよう端を少し詰める
    const pad = 14;
    const s = { x: p0.x + ux * pad, y: p0.y + uy * pad };
    const e = { x: p1.x - ux * pad, y: p1.y - uy * pad };
    ctx.save();
    ctx.strokeStyle = a.color || "#ff5a5a";
    ctx.fillStyle = a.color || "#ff5a5a";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    if (a.dashed) { ctx.setLineDash([8, 6]); ctx.lineDashOffset = -dash; }
    ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(e.x, e.y); ctx.stroke();
    ctx.setLineDash([]);
    // やじり
    const ah = 9;
    const ang = Math.atan2(uy, ux);
    ctx.beginPath();
    ctx.moveTo(e.x, e.y);
    ctx.lineTo(e.x - ah * Math.cos(ang - 0.4), e.y - ah * Math.sin(ang - 0.4));
    ctx.lineTo(e.x - ah * Math.cos(ang + 0.4), e.y - ah * Math.sin(ang + 0.4));
    ctx.closePath(); ctx.fill();
    // 順序/startTime バッジ
    if (a.seq != null || a.startTime != null) {
      const mid = { x: (s.x + e.x) / 2, y: (s.y + e.y) / 2 };
      const txt = (a.seq != null ? "#" + a.seq : "") + (a.startTime != null ? " t" + a.startTime : "");
      badge(mid.x, mid.y, txt.trim(), a.color || "#ff5a5a");
    }
    ctx.restore();
  }

  function drawToken(p, army) {
    const r = Math.max(7, Math.min(18, 6 + Math.sqrt(army.troops || 1) * 0.5));
    ctx.save();
    // 補給リング（緑→赤）
    const sup = clamp01(army.supply == null ? 1 : army.supply);
    const ringColor = supplyColor(sup);
    ctx.beginPath(); ctx.arc(p.x, p.y, r + 3, 0, Math.PI * 2);
    ctx.strokeStyle = ringColor; ctx.lineWidth = 3; ctx.stroke();
    // 本体
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = army.color || "#5aa9ff";
    ctx.globalAlpha = 0.92; ctx.fill(); ctx.globalAlpha = 1;
    ctx.lineWidth = army.selected ? 3 : 1.5;
    ctx.strokeStyle = army.selected ? "#ffd166" : "rgba(0,0,0,0.5)";
    ctx.stroke();
    // モード記号
    const sym = modeSymbol(army.mode);
    if (sym) {
      ctx.fillStyle = "#fff"; ctx.font = "bold " + Math.round(r) + "px sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(sym, p.x, p.y + 0.5);
    }
    // 兵力ラベル
    ctx.fillStyle = "#dfe8f5"; ctx.font = "10px sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    ctx.fillText(shortNum(army.troops), p.x, p.y + r + 2);
    // 士気バー
    if (army.morale != null) {
      const w = r * 2, mh = 2.5;
      const mx = p.x - r, my = p.y - r - 6;
      ctx.fillStyle = "rgba(0,0,0,0.5)"; ctx.fillRect(mx, my, w, mh);
      ctx.fillStyle = "#7be0c7"; ctx.fillRect(mx, my, w * clamp01(army.morale / 100), mh);
    }
    ctx.restore();
  }

  function drawPulse(p, pulse, now) {
    const k = (now - pulse.t0) / 700;
    ctx.save();
    ctx.globalAlpha = 1 - k;
    ctx.strokeStyle = pulse.color || "#ffb454";
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(p.x, p.y, 8 + k * 26, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }

  function badge(x, y, txt, color) {
    ctx.save();
    ctx.font = "bold 10px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const w = ctx.measureText(txt).width + 8;
    ctx.fillStyle = "rgba(12,18,28,0.85)";
    roundRect(x - w / 2, y - 8, w, 16, 4); ctx.fill();
    ctx.strokeStyle = color; ctx.lineWidth = 1; roundRect(x - w / 2, y - 8, w, 16, 4); ctx.stroke();
    ctx.fillStyle = "#fff"; ctx.fillText(txt, x, y + 0.5);
    ctx.restore();
  }
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  // ---- アニメーションループ（必要時のみ）----
  let rafId = null;
  function loop(now) {
    const tf = transform();
    const key = viewKey(tf);
    const animating = fxEnabled && (arrows.some(a => a.dashed) || pulses.length > 0);
    if (key !== lastKey || animating || dirty) {
      lastKey = key; dirty = false;
      draw(now || performance.now());
    }
    rafId = requestAnimationFrame(loop);
  }
  let dirty = true;
  function kick() { dirty = true; }

  // ---- 範囲選択（§23.2）----
  let lasso = null;
  function onPointerDown(e) {
    if (!selectMode) return;
    canvas.setPointerCapture(e.pointerId);
    const crect = container.getBoundingClientRect();
    lasso = { x0: e.clientX - crect.left, y0: e.clientY - crect.top, x1: e.clientX - crect.left, y1: e.clientY - crect.top };
  }
  function onPointerMove(e) {
    if (!lasso) return;
    const crect = container.getBoundingClientRect();
    lasso.x1 = e.clientX - crect.left; lasso.y1 = e.clientY - crect.top;
    kick();
    drawWithLasso();
  }
  function onPointerUp(e) {
    if (!lasso) return;
    const tf = transform();
    const x0 = Math.min(lasso.x0, lasso.x1), x1 = Math.max(lasso.x0, lasso.x1);
    const y0 = Math.min(lasso.y0, lasso.y1), y1 = Math.max(lasso.y0, lasso.y1);
    const hit = [];
    for (const army of armies) {
      const c = centroid(army.state); if (!c) continue;
      const s = toScreen(c, tf);
      if (s.x >= x0 && s.x <= x1 && s.y >= y0 && s.y <= y1) hit.push(army.id);
    }
    lasso = null; kick();
    if (onSelectCb) onSelectCb(hit, { additive: e.shiftKey });
  }
  function drawWithLasso() {
    draw(performance.now());
    if (!lasso) return;
    const x = Math.min(lasso.x0, lasso.x1), y = Math.min(lasso.y0, lasso.y1);
    const w = Math.abs(lasso.x1 - lasso.x0), h = Math.abs(lasso.y1 - lasso.y0);
    ctx.save();
    ctx.fillStyle = "rgba(255,209,102,0.15)"; ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = "#ffd166"; ctx.setLineDash([6, 4]); ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);

  const ro = (typeof ResizeObserver !== "undefined") ? new ResizeObserver(() => { resize(); kick(); }) : null;
  if (ro) ro.observe(container);
  resize();
  rafId = requestAnimationFrame(loop);

  // ---- 公開API ----
  return {
    setArmies(list) { armies = list || []; kick(); },
    setArrows(list) { arrows = list || []; kick(); },
    addPulse(state, kind, color) { pulses.push({ state, kind, color, t0: performance.now() }); kick(); },
    setSelectMode(on) {
      selectMode = !!on;
      canvas.style.pointerEvents = selectMode ? "auto" : "none";
      canvas.style.cursor = selectMode ? "crosshair" : "default";
    },
    onSelect(cb) { onSelectCb = cb; },
    setFxEnabled(on) { fxEnabled = !!on && !prefersReducedMotion(); kick(); },
    // クリック位置(clientX,clientY)に近い軍を返す（state選択と軍選択の振り分け用）
    hitTestArmy(clientX, clientY) {
      const tf = transform();
      const crect = container.getBoundingClientRect();
      const px = clientX - crect.left, py = clientY - crect.top;
      let best = null, bestD = 22; // しきい値(px)
      for (const army of armies) {
        const c = centroid(army.state); if (!c) continue;
        const s = toScreen(c, tf);
        const d = Math.hypot(s.x - px, s.y - py);
        if (d < bestD) { bestD = d; best = army.id; }
      }
      return best;
    },
    invalidateCentroids() { centroidCache.clear(); kick(); },
    redraw: kick,
    destroy() {
      if (rafId) cancelAnimationFrame(rafId);
      if (ro) ro.disconnect();
      canvas.remove();
    }
  };
}

// ---- 補助 ----
function clamp01(v) { v = Number(v); return v < 0 ? 0 : v > 1 ? 1 : (isFinite(v) ? v : 0); }
function supplyColor(s) {
  // 0.9+ 緑 / 0.6+ 黄 / 0.3+ 橙 / それ未満 赤（§10.3）
  if (s >= 0.9) return "#3fb950";
  if (s >= 0.6) return "#d2c238";
  if (s >= 0.3) return "#e08a3c";
  return "#e5484d";
}
function modeSymbol(mode) {
  switch (mode) {
    case "defend": return "⛨";      // 盾
    case "battling": return "⚔";    // 剣
    case "moving": return "→";      // →
    case "retreating": return "↩";  // ↩
    case "annihilating": return "☠";// 髑髏
    case "surrendered": return "⚑"; // 旗
    default: return "";
  }
}
function shortNum(n) {
  n = Number(n) || 0;
  if (n >= 10000) return (n / 1000).toFixed(0) + "k";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}
function cssEscape(s) {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(s);
  return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c);
}
function findPathById(svg, id) {
  const paths = svg.querySelectorAll("#map > path");
  for (const p of paths) if (p.id === id) return p;
  return null;
}
