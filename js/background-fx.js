// Aster Stella - 全ページ共通の背景アニメーション
//
// body の後ろに固定の canvas を置き、控えめな星空＋ネビュラを描く。
// メインUIの邪魔にならないよう密度・彩度・速度を低めにしてある。
// prefers-reduced-motion を尊重する。

(function () {
  "use strict";
  // すでに別ページ（splash.html など）で独自アニメがある場合は二重起動しない
  if (document.getElementById("bg-fx-canvas")) return;

  const prefersReduced = window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const canvas = document.createElement("canvas");
  canvas.id = "bg-fx-canvas";
  Object.assign(canvas.style, {
    position: "fixed", inset: "0", width: "100%", height: "100%",
    pointerEvents: "none", zIndex: "-1", display: "block"
  });
  // 既に body がある段階で実行（モジュールは defer 相当）
  if (document.body) document.body.appendChild(canvas);
  else document.addEventListener("DOMContentLoaded", () => document.body.appendChild(canvas));

  const ctx = canvas.getContext("2d", { alpha: true });
  let W = 0, H = 0, DPR = 1;
  let stars = [], nebulae = [];

  function rand(a, b) { return a + Math.random() * (b - a); }

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.floor(W * DPR);
    canvas.height = Math.floor(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    const small = W < 720;
    const starCount = small ? 60 : 110;
    stars = [];
    for (let i = 0; i < starCount; i++) {
      stars.push({
        x: Math.random() * W,
        y: Math.random() * H,
        r: rand(0.3, 1.4),
        a: rand(0.25, 0.7),
        phase: Math.random() * Math.PI * 2,
        tw: rand(0.4, 1.4),
        vx: rand(-0.01, 0.01),
        vy: rand(-0.01, 0.01)
      });
    }
    nebulae = [];
    const nebCount = small ? 2 : 4;
    const palette = [[90, 169, 255], [123, 224, 199], [192, 132, 252], [246, 173, 85]];
    for (let i = 0; i < nebCount; i++) {
      const col = palette[i % palette.length];
      nebulae.push({
        x: rand(0, W), y: rand(0, H),
        r: rand(220, 420),
        col,
        vx: rand(-0.04, 0.04), vy: rand(-0.03, 0.03),
        phase: Math.random() * Math.PI * 2,
        ps: rand(0.0006, 0.0012)
      });
    }
  }

  function drawFrame(now) {
    const t = now * 0.001;

    // 透明クリア（背景色は body 側のグラデを活かす）
    ctx.clearRect(0, 0, W, H);

    // ネビュラ
    ctx.globalCompositeOperation = "lighter";
    for (const n of nebulae) {
      n.phase += n.ps;
      const pulse = 0.55 + 0.45 * Math.sin(n.phase);
      n.x += n.vx; n.y += n.vy;
      if (n.x < -n.r) n.x = W + n.r;
      if (n.x > W + n.r) n.x = -n.r;
      if (n.y < -n.r) n.y = H + n.r;
      if (n.y > H + n.r) n.y = -n.r;
      const g = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, n.r);
      const [r, gC, b] = n.col;
      g.addColorStop(0, `rgba(${r},${gC},${b},${0.07 * pulse})`);
      g.addColorStop(0.5, `rgba(${r},${gC},${b},${0.03 * pulse})`);
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";

    // 星（瞬き）
    for (const s of stars) {
      s.x += s.vx; s.y += s.vy;
      if (s.x < 0) s.x += W; if (s.x > W) s.x -= W;
      if (s.y < 0) s.y += H; if (s.y > H) s.y -= H;
      const a = s.a * (0.5 + 0.5 * Math.sin(t * s.tw + s.phase));
      ctx.globalAlpha = a;
      ctx.fillStyle = "#dff2ff";
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    raf = requestAnimationFrame(drawFrame);
  }

  function staticFrame() {
    // 動かないモード: ネビュラと星を一度だけ薄く描く
    ctx.clearRect(0, 0, W, H);
    for (const n of nebulae) {
      const g = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, n.r);
      const [r, gC, b] = n.col;
      g.addColorStop(0, `rgba(${r},${gC},${b},0.04)`);
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2); ctx.fill();
    }
    for (const s of stars) {
      ctx.globalAlpha = s.a;
      ctx.fillStyle = "#dff2ff";
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  let raf = null;
  function start() {
    resize();
    if (prefersReduced) { staticFrame(); return; }
    raf = requestAnimationFrame(drawFrame);
  }

  window.addEventListener("resize", () => {
    if (raf) cancelAnimationFrame(raf);
    resize();
    if (prefersReduced) staticFrame();
    else raf = requestAnimationFrame(drawFrame);
  });
  // タブ非表示時はフレーム停止（電池/CPU節約）
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { if (raf) cancelAnimationFrame(raf); raf = null; }
    else if (!raf && !prefersReduced) raf = requestAnimationFrame(drawFrame);
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
