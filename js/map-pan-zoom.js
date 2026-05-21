// Aster Stella - 地図のパン/ズーム
//
// SVG の viewBox を直接書き換えてズーム/パンする方式。
// CSS transform: scale() ではないため、iOS Safari でも輪郭がぼやけずベクター品質を保てる。
//
// 操作:
//   - マウスホイール       : ズーム（カーソル位置を中心に）
//   - マウスドラッグ       : パン
//   - 1本指ドラッグ        : パン
//   - 2本指ピンチ          : ズーム（2本指の中点を中心に）
//   - 外部からの zoomIn/zoomOut/reset : ボタン操作用
//
// クリック/タップは「移動量がしきい値未満のときだけ」発火するように、
// controller.wasDragging() を呼び出し側でチェックする。

/**
 * @param {SVGSVGElement} svg
 * @param {{minScale?: number, maxScale?: number, dragThreshold?: number}} options
 */
export function attachPanZoom(svg, options = {}) {
  const minScale = options.minScale ?? 1;       // 初期サイズより小さくはしない
  const maxScale = options.maxScale ?? 50;
  const dragThreshold = options.dragThreshold ?? 5; // 画面ピクセル

  // 現在の viewBox を取得（無ければ BBox から作る）
  ensureViewBox(svg);
  const vb = svg.viewBox.baseVal;
  const initial = { x: vb.x, y: vb.y, width: vb.width, height: vb.height };

  // ピンチ/ドラッグ中はネイティブのスクロール/ズームに渡さない
  svg.style.touchAction = "none";

  const pointers = new Map(); // pointerId -> {clientX, clientY}
  let dragState = null;       // {startClientX, startClientY, startVbX, startVbY, moved}
  let pinchState = null;      // {startDistance, startCx, startCy, startVb}
  let suppressClick = false;  // 直前のジェスチャがドラッグ/ピンチだったらクリックを抑制

  // ---- ヘルパー ----
  function setViewBox(x, y, w, h) {
    svg.setAttribute("viewBox", x + " " + y + " " + w + " " + h);
  }

  function clampSize(w, h) {
    const minW = initial.width / maxScale;
    const maxW = initial.width / minScale;
    if (w < minW) {
      const r = minW / w;
      w *= r; h *= r;
    } else if (w > maxW) {
      const r = maxW / w;
      w *= r; h *= r;
    }
    return { w, h };
  }

  // 画面座標 (clientX, clientY) → 現在の viewBox 上の SVG 座標
  function clientToSvg(clientX, clientY) {
    const rect = svg.getBoundingClientRect();
    const sx = (clientX - rect.left) / rect.width;
    const sy = (clientY - rect.top) / rect.height;
    return {
      x: vb.x + sx * vb.width,
      y: vb.y + sy * vb.height,
      sx, sy
    };
  }

  // 中心 (clientX, clientY) を保ったまま factor 倍ズーム
  function zoomAt(clientX, clientY, factor) {
    const before = clientToSvg(clientX, clientY);
    const sized = clampSize(vb.width / factor, vb.height / factor);
    const newX = before.x - before.sx * sized.w;
    const newY = before.y - before.sy * sized.h;
    setViewBox(newX, newY, sized.w, sized.h);
  }

  // ---- イベント ----
  // ポインターを掴むのは「ドラッグ/ピンチが確定したあと」だけ。
  // pointerdown の時点で setPointerCapture すると、後続の click イベントの
  // ターゲットが SVG にすり替わってしまい、path のクリックが拾えなくなる。
  function capture(id) {
    try { svg.setPointerCapture(id); } catch (_) { /* noop */ }
  }

  svg.addEventListener("pointerdown", (e) => {
    // 新しいジェスチャの開始時点で、前回の抑制フラグをリセット
    if (pointers.size === 0) suppressClick = false;

    pointers.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });

    if (pointers.size === 1) {
      dragState = {
        startClientX: e.clientX,
        startClientY: e.clientY,
        startVbX: vb.x,
        startVbY: vb.y,
        moved: false
      };
      pinchState = null;
    } else if (pointers.size === 2) {
      const arr = [...pointers.values()];
      const dx = arr[0].clientX - arr[1].clientX;
      const dy = arr[0].clientY - arr[1].clientY;
      pinchState = {
        startDistance: Math.hypot(dx, dy) || 1,
        startCx: (arr[0].clientX + arr[1].clientX) / 2,
        startCy: (arr[0].clientY + arr[1].clientY) / 2,
        startVb: { x: vb.x, y: vb.y, w: vb.width, h: vb.height }
      };
      dragState = null;
      suppressClick = true;
      // ピンチは確定的なジェスチャなので即座に両方を掴む
      for (const id of pointers.keys()) capture(id);
    }
  });

  svg.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });

    if (pointers.size === 1 && dragState) {
      const dx = e.clientX - dragState.startClientX;
      const dy = e.clientY - dragState.startClientY;
      if (!dragState.moved && Math.hypot(dx, dy) > dragThreshold) {
        dragState.moved = true;
        suppressClick = true;
        // ドラッグが確定した時点で初めて掴む（タップは掴まない）
        capture(e.pointerId);
      }
      if (dragState.moved) {
        const rect = svg.getBoundingClientRect();
        const svgDx = dx * (vb.width / rect.width);
        const svgDy = dy * (vb.height / rect.height);
        setViewBox(dragState.startVbX - svgDx, dragState.startVbY - svgDy, vb.width, vb.height);
      }
    } else if (pointers.size === 2 && pinchState) {
      const arr = [...pointers.values()];
      const dx = arr[0].clientX - arr[1].clientX;
      const dy = arr[0].clientY - arr[1].clientY;
      const dist = Math.hypot(dx, dy) || 1;
      const factor = dist / pinchState.startDistance;

      const sized = clampSize(pinchState.startVb.w / factor, pinchState.startVb.h / factor);
      const cx = (arr[0].clientX + arr[1].clientX) / 2;
      const cy = (arr[0].clientY + arr[1].clientY) / 2;

      const rect = svg.getBoundingClientRect();
      // 開始時に「2本指中点」が指していた SVG 座標
      const startSx = (pinchState.startCx - rect.left) / rect.width;
      const startSy = (pinchState.startCy - rect.top) / rect.height;
      const svgCx = pinchState.startVb.x + startSx * pinchState.startVb.w;
      const svgCy = pinchState.startVb.y + startSy * pinchState.startVb.h;
      // 現在の中点画面位置に同じ SVG 座標が来るようオフセット
      const nowSx = (cx - rect.left) / rect.width;
      const nowSy = (cy - rect.top) / rect.height;
      const newX = svgCx - nowSx * sized.w;
      const newY = svgCy - nowSy * sized.h;
      setViewBox(newX, newY, sized.w, sized.h);
    }
  });

  function endPointer(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchState = null;
    if (pointers.size === 0) dragState = null;
  }
  svg.addEventListener("pointerup", endPointer);
  svg.addEventListener("pointercancel", endPointer);
  svg.addEventListener("lostpointercapture", endPointer);

  // クリック抑制（capture phase で止めれば、親要素のクリックハンドラにも届かない）
  svg.addEventListener("click", (e) => {
    if (suppressClick) {
      e.stopPropagation();
      e.preventDefault();
      suppressClick = false;
    }
  }, true);

  // ホイールズーム
  svg.addEventListener("wheel", (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
    zoomAt(e.clientX, e.clientY, factor);
  }, { passive: false });

  // 中心を維持してズーム（ボタン用）
  function zoomCentered(factor) {
    const rect = svg.getBoundingClientRect();
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
  }

  return {
    zoomIn() { zoomCentered(1.4); },
    zoomOut() { zoomCentered(1 / 1.4); },
    reset() {
      setViewBox(initial.x, initial.y, initial.width, initial.height);
    },
    wasDragging() { return suppressClick; }
  };
}

function ensureViewBox(svg) {
  const vb = svg.viewBox && svg.viewBox.baseVal;
  if (vb && (vb.width > 0 || vb.height > 0)) return;
  // 念のため: viewBox が無い場合は BBox から作る
  let bb;
  try { bb = svg.getBBox(); } catch (_) { bb = null; }
  if (bb && bb.width > 0 && bb.height > 0) {
    svg.setAttribute("viewBox", bb.x + " " + bb.y + " " + bb.width + " " + bb.height);
  } else {
    svg.setAttribute("viewBox", "0 0 1000 1000");
  }
}
