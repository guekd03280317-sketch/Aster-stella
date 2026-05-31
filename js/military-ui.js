// Aster Stella - 軍事タブ UI（Phase B/C）§10 / §22 / §23
//
// player.js から initMilitaryTab(ctx) で初期化する独立モジュール。
// player.js を肥大化させないため、軍事タブの描画・操作・参謀本部・地図演出をここに集約する。
//
// ctx（player.js が渡す共有アクセサ）:
//   nationId
//   getNation()        -> normalize済み nation（nation.military を含む）
//   getStates()        -> { stateName: state }
//   getAdjacency()     -> { stateName: [neighbor...] }
//   getNationsById()   -> { id: {name,color,...} }
//   getSvgText()       -> 地図SVGテキスト
//   addOrder(kind,payload) -> Promise
//   flash(msg, kind)
//
// 戦闘判定はしない。命令は予約(order)として積むだけ（GAS が解決, §0）。

import { attachPanZoom } from "./map-pan-zoom.js";
import { createWarMap } from "./war-map.js";
import {
  SPECIAL_UNITS_BY_ID, TROOP_KINDS, mergeWarConfig,
  armyTroops, totalReserve, canFieldUnit, newArmyId
} from "./war-schema.js";
import { planOperations } from "./staff.js";

// ---- 小さな DOM ヘルパー（player.js と同等のスタイルクラスを使う）----
function el(tag, cls, txt) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
function row(...kids) { const d = el("div", "form-row"); for (const k of kids) if (k) d.appendChild(k); return d; }
function labeled(text, control) { const l = el("label", "field"); l.appendChild(el("span", null, text)); l.appendChild(control); return l; }
function numInput(v, opts = {}) { const i = el("input"); i.type = "number"; i.inputMode = "numeric"; i.step = opts.step || "1"; if (opts.min != null) i.min = opts.min; if (opts.max != null) i.max = opts.max; i.value = v; return i; }
function textInput(v) { const i = el("input"); i.type = "text"; i.value = v || ""; return i; }
function select(options, value) {
  const s = el("select");
  for (const o of options) { const op = el("option"); op.value = o.value; op.textContent = o.label; s.appendChild(op); }
  if (value != null) s.value = value;
  return s;
}
function button(text, handler, cls) { const b = el("button", cls, text); b.type = "button"; b.addEventListener("click", handler); return b; }
function note(text) { return el("p", "loading", text); }
function bar(label, ratio, color) {
  const wrap = el("div", "mil-bar");
  wrap.appendChild(el("span", "mil-bar-label", label));
  const track = el("div", "mil-bar-track");
  const fill = el("div", "mil-bar-fill");
  fill.style.width = Math.round(clamp01(ratio) * 100) + "%";
  if (color) fill.style.background = color;
  track.appendChild(fill);
  wrap.appendChild(track);
  return wrap;
}
function clamp01(v) { v = Number(v); return v < 0 ? 0 : v > 1 ? 1 : (isFinite(v) ? v : 0); }
function supplyColor(s) { return s >= 0.9 ? "#3fb950" : s >= 0.6 ? "#d2c238" : s >= 0.3 ? "#e08a3c" : "#e5484d"; }

export function initMilitaryTab(ctx) {
  const cfg = mergeWarConfig(ctx.warConfig || null);

  // ---- 状態 ----
  let interaction = "command";    // "command" | "select" | "staff"
  let selectedArmyId = null;      // 命令対象（単一）
  let path = [];                  // 構築中の経路 [stateName...]
  let startTime = 0;
  const groupSel = new Set();     // 複数選択された armyId
  let staffMode = "offensive";    // 参謀の目標タップ種別
  const staffGoals = { offensive: new Set(), defensive: new Set() };
  let staffDrafts = [];           // 直近の立案結果（プレビュー）
  let showSupply = true;

  let warMap = null, milPanZoom = null, milSvg = null;
  const milElById = new Map();

  // ---- 地図セットアップ ----
  function buildMap() {
    const container = document.getElementById("mil-map-container");
    if (!container) return;
    const svgText = ctx.getSvgText();
    if (!svgText) { container.innerHTML = '<p class="loading">地図を読み込めませんでした。</p>'; return; }
    container.innerHTML = "";
    container.style.position = "relative";
    const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
    milSvg = document.importNode(doc.documentElement, true);
    milSvg.removeAttribute("width"); milSvg.removeAttribute("height");
    milSvg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    container.appendChild(milSvg);
    milPanZoom = attachPanZoom(milSvg);
    milElById.clear();
    milSvg.querySelectorAll("#map > path").forEach((p) => { if (p.id && !p.id.startsWith("pattern")) milElById.set(p.id, p); });
    paintMap();

    warMap = createWarMap(milSvg, container, { fxEnabled: true });
    warMap.onSelect((ids, opts) => {
      if (!opts.additive) groupSel.clear();
      for (const id of ids) groupSel.add(id);
      renderOps();
      refreshMapOverlay();
    });

    container.addEventListener("click", onMapClick);
    wireZoom();
  }

  function wireZoom() {
    const z = (id, fn) => { const b = document.getElementById(id); if (b) b.addEventListener("click", fn); };
    z("btn-mil-zoom-in", () => milPanZoom && milPanZoom.zoomIn());
    z("btn-mil-zoom-out", () => milPanZoom && milPanZoom.zoomOut());
    z("btn-mil-zoom-reset", () => milPanZoom && milPanZoom.reset());
  }

  // ステート塗り：所属国家色 + 補給可視化（自国軍の補給が通る=緑寄り）
  function paintMap() {
    const states = ctx.getStates();
    const nationsById = ctx.getNationsById();
    const nation = ctx.getNation();
    const supplied = showSupply ? computeSuppliedSet() : null;
    for (const [name, p] of milElById) {
      const s = states[name];
      let fill = "#1d2738";
      if (s && s.country) {
        const n = nationsById[s.country];
        fill = n ? n.color : "#3a4a63";
        if (s.country !== nation.id) fill = shade(fill, -0.35);
      }
      if (supplied && supplied.has(name)) {
        p.setAttribute("stroke", "#3fb95066"); p.setAttribute("stroke-width", "1.5");
      } else {
        p.removeAttribute("stroke");
      }
      p.setAttribute("fill", fill);
      p.style.cursor = "pointer";
    }
  }

  // 自国軍が駐留 or 補給経路上のステート集合（簡易: 自国領 + 占領 + 軍のいる所）
  function computeSuppliedSet() {
    const nation = ctx.getNation();
    const states = ctx.getStates();
    const set = new Set();
    for (const name of Object.keys(states)) {
      const s = states[name];
      if (s.country === nation.id) set.add(name);
      const sp = s.specialState || "";
      if (sp.indexOf("occupied:" + nation.id) >= 0) set.add(name);
    }
    return set;
  }

  function onMapClick(e) {
    if (interaction === "select") return; // 範囲選択は canvas 側で処理
    if (milPanZoom && milPanZoom.wasDragging()) return;
    const p = e.target.closest("path");
    if (!p || !milElById.has(p.id)) return;
    const state = p.id;

    // 軍駒の近くをタップしたら軍選択を優先
    const hitArmy = warMap && warMap.hitTestArmy(e.clientX, e.clientY);
    if (interaction === "command" && hitArmy) {
      selectArmy(hitArmy);
      return;
    }
    if (interaction === "command") {
      extendPath(state);
    } else if (interaction === "staff") {
      toggleStaffGoal(state);
    }
  }

  // ---- 命令（経路構築）----
  function selectArmy(id) {
    selectedArmyId = id;
    path = [];
    const army = getArmy(id);
    if (army) path = [army.location];
    renderOps();
    refreshMapOverlay();
  }

  function extendPath(state) {
    if (!selectedArmyId) { ctx.flash("先に軍を選んでください（一覧か地図の駒をタップ）。", "err"); return; }
    if (!path.length) { const a = getArmy(selectedArmyId); path = a ? [a.location] : []; }
    const last = path[path.length - 1];
    if (state === last) return;
    // 直前と隣接していること
    const adj = ctx.getAdjacency()[last] || [];
    if (!adj.includes(state)) { ctx.flash(`${last} と ${state} は隣接していません。`, "err"); return; }
    // 既に経路にあれば、そこまで巻き戻す
    const idx = path.indexOf(state);
    if (idx >= 0) path = path.slice(0, idx + 1); else path.push(state);
    renderOps();
    refreshMapOverlay();
  }

  // ---- 地図オーバーレイ（軍駒・矢印）更新 ----
  function refreshMapOverlay() {
    if (!warMap) return;
    const nation = ctx.getNation();
    const nationsById = ctx.getNationsById();
    const armies = Object.values(nation.military.armies || {});
    const tokens = armies.filter(a => armyTroops(a) > 0 || a.location).map(a => ({
      id: a.id, state: a.location, troops: armyTroops(a),
      color: nation.color || "#5aa9ff", mode: a.mode,
      supply: a.supplyLevel, morale: a.morale,
      selected: a.id === selectedArmyId || groupSel.has(a.id)
    }));
    warMap.setArmies(tokens);

    const arrows = [];
    // 命令中の経路
    if (path.length > 1) {
      for (let i = 0; i < path.length - 1; i++) {
        arrows.push({ from: path[i], to: path[i + 1], color: "#ff6a6a", dashed: true, seq: i + 1, startTime });
      }
    }
    // 参謀立案プレビュー
    for (const d of staffDrafts) {
      const pp = d.payload && d.payload.path;
      if (pp && pp.length > 1) {
        const col = d.meta && d.meta.role === "attack" ? "#ff6a6a" : (d.meta && d.meta.role && d.meta.role.indexOf("defend") >= 0 ? "#5aa9ff" : "#cfd8e6");
        for (let i = 0; i < pp.length - 1; i++) arrows.push({ from: pp[i], to: pp[i + 1], color: col, dashed: true, startTime: d.payload.startTime });
      }
    }
    warMap.setArrows(arrows);
  }

  // ---- レンダリング: モードツールバー ----
  function renderToolbar() {
    const box = document.getElementById("mil-toolbar");
    if (!box) return;
    box.innerHTML = "";
    const mk = (key, label) => {
      const b = button(label, () => setInteraction(key), interaction === key ? "mode-btn active" : "mode-btn secondary");
      return b;
    };
    box.appendChild(mk("command", "命令（経路）"));
    box.appendChild(mk("select", "範囲選択"));
    box.appendChild(mk("staff", "参謀本部"));
    const supChk = el("label", "checkbox-row");
    const c = el("input"); c.type = "checkbox"; c.checked = showSupply;
    c.addEventListener("change", () => { showSupply = c.checked; paintMap(); });
    supChk.appendChild(c); supChk.appendChild(document.createTextNode(" 補給表示"));
    box.appendChild(supChk);
  }

  function setInteraction(key) {
    interaction = key;
    if (warMap) warMap.setSelectMode(key === "select");
    renderToolbar();
    renderOps();
    refreshMapOverlay();
  }

  // ---- レンダリング: 作戦パネル ----
  function renderOps() {
    const box = document.getElementById("mil-ops");
    if (!box) return;
    box.innerHTML = "";

    if (interaction === "staff") { renderStaffPanel(box); return; }

    // 複数選択グループの一括命令
    if (interaction === "select" || groupSel.size > 0) {
      box.appendChild(el("h4", "subhead", `複数選択: ${groupSel.size} 軍`));
      if (groupSel.size > 0) {
        const names = [...groupSel].map(id => { const a = getArmy(id); return a ? (a.name || a.id) : id; });
        box.appendChild(note(names.join(" / ")));
        const tgt = el("div", "field-value cost-preview", "目標ステートを地図でタップしてください（全軍が各自の現在地から進撃）。");
        box.appendChild(tgt);
        box.appendChild(row(
          button("選択をクリア", () => { groupSel.clear(); renderOps(); refreshMapOverlay(); }, "secondary"),
          button("全軍 防衛配置", () => groupCommand("defend"), "secondary")
        ));
        // 目標タップを受けるため、command的なタップを許可するヒント
        box.appendChild(note("※ 一括進撃は「命令（経路）」モードで目標をタップ→下のボタンで確定します。"));
      } else {
        box.appendChild(note("地図をドラッグで範囲選択、または駒をタップで複数選択できます。"));
      }
      if (interaction === "select") return;
    }

    // 単一軍の経路命令
    const army = getArmy(selectedArmyId);
    if (!army) { box.appendChild(note("軍を選択してください（下の一覧か、地図の駒をタップ）。")); return; }

    box.appendChild(el("h4", "subhead", `${army.name || army.id}（${army.location || "未配置"} / 兵力 ${armyTroops(army)}）`));

    const pathInfo = el("div", "field-value cost-preview");
    pathInfo.textContent = path.length > 1 ? ("経路: " + path.join(" → ")) : "隣接ステートを順にタップして経路を作ります。";
    box.appendChild(pathInfo);

    const stInput = numInput(startTime, { min: 0, max: 45 });
    stInput.addEventListener("input", () => { startTime = Math.max(0, Math.min(45, parseInt(stInput.value) || 0)); refreshMapOverlay(); });
    box.appendChild(row(labeled("開始時刻 startTime (0〜45)", stInput)));

    box.appendChild(row(
      button("進撃（攻撃）を予約", () => submitMove("attackArmy"), "mode-btn"),
      button("移動を予約", () => submitMove("moveArmy"), "secondary"),
      button("防衛配置", () => submitDefend(army), "secondary"),
      button("経路クリア", () => { const a = getArmy(selectedArmyId); path = a ? [a.location] : []; renderOps(); refreshMapOverlay(); }, "secondary")
    ));
    box.appendChild(note("進撃=交戦許可、移動=非交戦。1部隊1ターン1命令（§6.3）。"));
  }

  async function submitMove(kind) {
    const army = getArmy(selectedArmyId);
    if (!army) return;
    if (path.length < 2) { ctx.flash("移動先までの経路を作ってください。", "err"); return; }
    await ctx.addOrder(kind, { armyId: army.id, armyName: army.name, path: path.slice(), startTime });
    ctx.flash((kind === "attackArmy" ? "進撃" : "移動") + "を予約しました。", "ok");
    path = [army.location];
    refreshMapOverlay();
  }
  async function submitDefend(army) {
    await ctx.addOrder("defendArmy", { armyId: army.id, armyName: army.name });
    ctx.flash("防衛配置を予約しました。", "ok");
  }
  async function groupCommand(kind) {
    if (!groupSel.size) return;
    for (const id of groupSel) {
      const a = getArmy(id); if (!a) continue;
      if (kind === "defend") await ctx.addOrder("defendArmy", { armyId: a.id, armyName: a.name });
    }
    ctx.flash(`${groupSel.size} 軍に一括命令しました。`, "ok");
  }

  // ---- 参謀本部 ----
  function renderStaffPanel(box) {
    box.appendChild(el("h4", "subhead", "目標を選ぶだけで作戦を自動立案（§22）"));
    const modeRow = row(
      button("攻略目標を指定", () => { staffMode = "offensive"; renderOps(); }, staffMode === "offensive" ? "mode-btn active" : "mode-btn secondary"),
      button("死守目標を指定", () => { staffMode = "defensive"; renderOps(); }, staffMode === "defensive" ? "mode-btn active" : "mode-btn secondary")
    );
    box.appendChild(modeRow);
    box.appendChild(note(staffMode === "offensive" ? "地図で奪いたい敵ステートをタップ（赤）。" : "地図で守りたい自国ステートをタップ（青）。首都は自動で死守対象。"));

    const offList = [...staffGoals.offensive];
    const defList = [...staffGoals.defensive];
    box.appendChild(el("div", "field-value", "攻略: " + (offList.join("・") || "（なし）")));
    box.appendChild(el("div", "field-value", "死守: " + (defList.join("・") || "（なし）")));

    const riskSel = select([
      { value: "cautious", label: "慎重（安全係数 高）" },
      { value: "standard", label: "標準" },
      { value: "bold", label: "果敢（少数で攻める）" }
    ], "standard");

    box.appendChild(row(labeled("許容リスク", riskSel),
      button("作戦を立案", () => runStaff(riskSel.value), "mode-btn"),
      button("目標クリア", () => { staffGoals.offensive.clear(); staffGoals.defensive.clear(); staffDrafts = []; paintMap(); renderOps(); refreshMapOverlay(); }, "secondary")
    ));

    if (staffDrafts.length || lastWarnings.length) {
      box.appendChild(el("h4", "subhead", "立案結果（プレビュー）"));
      for (const d of staffDrafts) {
        const t = d.kind === "attackArmy" ? "進撃" : d.kind === "moveArmy" ? "移動" : "防衛";
        const a = getArmy(d.armyId);
        box.appendChild(el("div", "field-value", `・${a ? (a.name || a.id) : d.armyId}：${t} ${d.payload.path ? d.payload.path.join("→") : ""}${d.meta && d.meta.goal ? "（目標 " + d.meta.goal + "）" : ""}`));
      }
      for (const w of lastWarnings) {
        box.appendChild(el("div", "field-value warn", `⚠ ${w.goal}：${w.reason} → ${w.suggestion}`));
      }
      if (staffDrafts.length) {
        box.appendChild(row(
          button(`この作戦を一括予約（${staffDrafts.length}件）`, bulkReserve, "mode-btn"),
          button("破棄", () => { staffDrafts = []; renderOps(); refreshMapOverlay(); }, "secondary")
        ));
      }
    }
  }

  let lastWarnings = [];
  function toggleStaffGoal(state) {
    const nation = ctx.getNation();
    const s = ctx.getStates()[state];
    const owner = s && s.country;
    if (staffMode === "offensive") {
      if (owner === nation.id) { ctx.flash("攻略目標は敵/中立ステートです。", "err"); return; }
      toggleSet(staffGoals.offensive, state);
    } else {
      if (owner !== nation.id) { ctx.flash("死守目標は自国ステートです。", "err"); return; }
      toggleSet(staffGoals.defensive, state);
    }
    paintStaffGoals();
    renderOps();
  }
  function paintStaffGoals() {
    paintMap();
    for (const name of staffGoals.offensive) { const p = milElById.get(name); if (p) { p.setAttribute("stroke", "#ff5a5a"); p.setAttribute("stroke-width", "3"); } }
    for (const name of staffGoals.defensive) { const p = milElById.get(name); if (p) { p.setAttribute("stroke", "#5aa9ff"); p.setAttribute("stroke-width", "3"); } }
  }

  function runStaff(risk) {
    const nation = ctx.getNation();
    const out = planOperations({
      nationId: nation.id, capital: nation.capital, tech: nation.stats.militaryTech,
      military: nation.military, statesData: ctx.getStates(), adjacency: ctx.getAdjacency(),
      allies: alliesOf(nation),
      goals: { offensive: [...staffGoals.offensive], defensive: [...staffGoals.defensive] },
      options: { risk }, cfg
    });
    staffDrafts = out.drafts;
    lastWarnings = out.warnings;
    renderOps();
    refreshMapOverlay();
    ctx.flash(`立案完了：ドラフト ${out.drafts.length}件 / 警告 ${out.warnings.length}件`, out.warnings.length ? "err" : "ok");
  }

  async function bulkReserve() {
    let n = 0;
    for (const d of staffDrafts) {
      try { await ctx.addOrder(d.kind, d.payload); n++; } catch (_) { /* skip */ }
    }
    ctx.flash(`${n} 件の作戦を予約しました。`, "ok");
    staffDrafts = [];
    renderOps();
    refreshMapOverlay();
  }

  // ---- 軍隊一覧 ----
  function renderArmies() {
    const box = document.getElementById("mil-armies");
    if (!box) return;
    box.innerHTML = "";
    const nation = ctx.getNation();
    const armies = Object.values(nation.military.armies || {});

    // 新規編成
    const nameI = textInput("");
    const stSel = select(ownStateOptions(nation), nation.capital || undefined);
    box.appendChild(row(labeled("軍名", nameI), labeled("編成地", stSel),
      button("軍を編成", () => {
        const name = nameI.value.trim() || "新編軍";
        ctx.addOrder("createArmy", { id: newArmyId(), name, state: stSel.value });
        ctx.flash("軍の編成を予約しました。", "ok");
      }, "secondary")));

    if (!armies.length) { box.appendChild(note("まだ軍がありません。動員→配備、または上で編成してください。")); return; }

    for (const a of armies) {
      const card = el("div", "mil-army-card" + (a.id === selectedArmyId ? " selected" : ""));
      const head = el("div", "mil-army-head");
      head.appendChild(el("strong", null, a.name || a.id));
      head.appendChild(el("span", "mil-army-loc", a.location || "未配置"));
      head.appendChild(el("span", "mil-army-mode", modeLabel(a.mode)));
      card.appendChild(head);

      const troops = armyTroops(a);
      const comp = Object.keys(a.composition || {}).filter(k => a.composition[k] > 0)
        .map(k => `${unitName(k)} ${a.composition[k]}`).join(" / ") || "兵なし";
      card.appendChild(el("div", "mil-army-comp", `兵力 ${troops}：${comp}`));

      card.appendChild(bar("AP", (a.ap || 0) / (cfg.apMax || 50), "#7aa2ff"));
      card.appendChild(bar("補給", a.supplyLevel == null ? 1 : a.supplyLevel, supplyColor(a.supplyLevel == null ? 1 : a.supplyLevel)));
      card.appendChild(bar("士気", (a.morale == null ? 100 : a.morale) / 100, "#7be0c7"));

      card.appendChild(row(
        button("この軍に命令", () => { setInteraction("command"); selectArmy(a.id); }, "secondary"),
        button(groupSel.has(a.id) ? "選択解除" : "複数選択に追加", () => { toggleSet(groupSel, a.id); renderArmies(); refreshMapOverlay(); }, "secondary")
      ));
      box.appendChild(card);
    }
  }

  // ---- 動員・配備 ----
  function renderMobilize() {
    const box = document.getElementById("mil-mobilize");
    if (!box) return;
    box.innerHTML = "";
    const nation = ctx.getNation();
    const tech = nation.stats.militaryTech || 0;
    const mil = nation.military;

    // 予備兵の州別
    box.appendChild(el("h4", "subhead", "予備兵（州別）"));
    const reserveStates = Object.keys(mil.reserveByState || {}).filter(s => mil.reserveByState[s] > 0);
    const aggregate = nation.stats.reserveTroops || 0;
    box.appendChild(el("div", "field-value", `合計予備兵: ${aggregate}（州別保管: ${totalReserve(mil)}）`));
    if (totalReserve(mil) < aggregate) {
      box.appendChild(note("※ 州別未配分の予備兵があります。GASのターン処理で州割りされます（§5.4）。"));
    }

    // 動員: state + amount + kind（必要レベルを満たす兵種のみ）
    const fieldable = TROOP_KINDS.filter(k => canFieldUnit(k, tech));
    const stOpts = ownStateOptions(nation);
    const mState = select(stOpts.length ? stOpts : [{ value: "", label: "（自国領なし）" }]);
    const mKind = select(fieldable.map(k => ({ value: k, label: unitName(k) + (k === "line" ? "" : ` (Lv${SPECIAL_UNITS_BY_ID[k].reqLevel})`) })));
    const mAmt = numInput(50, { min: 1 });
    box.appendChild(el("h4", "subhead", "動員（予備兵 → 動員プール）"));
    box.appendChild(row(labeled("州", mState), labeled("兵種", mKind), labeled("人数", mAmt),
      button("動員を予約", () => {
        const amount = Math.max(1, parseInt(mAmt.value) || 1);
        ctx.addOrder("mobilize", { state: mState.value, amount, kind: mKind.value });
        ctx.flash("動員を予約しました。", "ok");
      }, "mode-btn")));

    // 動員プール表示
    const pool = mil.mobilizedPool || {};
    const poolText = Object.keys(pool).filter(k => pool[k] > 0).map(k => `${unitName(k)} ${pool[k]}`).join(" / ") || "（なし）";
    box.appendChild(el("div", "field-value", "動員プール: " + poolText));

    // 配備: pool -> army
    const armies = Object.values(mil.armies || {});
    box.appendChild(el("h4", "subhead", "配備（動員プール → 軍）"));
    if (!armies.length) {
      box.appendChild(note("先に軍を編成してください。"));
    } else {
      const aSel = select(armies.map(a => ({ value: a.id, label: (a.name || a.id) + " @" + (a.location || "?") })));
      const poolKinds = Object.keys(pool).filter(k => pool[k] > 0);
      const kSel = select(poolKinds.length ? poolKinds.map(k => ({ value: k, label: `${unitName(k)} (${pool[k]})` })) : [{ value: "", label: "（プールが空）" }]);
      const aAmt = numInput(10, { min: 1 });
      box.appendChild(row(labeled("配備先の軍", aSel), labeled("兵種", kSel), labeled("人数", aAmt),
        button("配備を予約", () => {
          const army = getArmy(aSel.value);
          ctx.addOrder("assignTroops", { armyId: aSel.value, armyName: army ? army.name : aSel.value, kind: kSel.value, amount: Math.max(1, parseInt(aAmt.value) || 1) });
          ctx.flash("配備を予約しました。", "ok");
        }, "secondary")));
    }

    // 教義
    box.appendChild(el("h4", "subhead", "教義（doctrine）"));
    const docSel = select([
      { value: "balanced", label: "均衡" }, { value: "attack", label: "攻撃重視" },
      { value: "defense", label: "守備重視" }, { value: "blitz", label: "電撃戦" }, { value: "total", label: "総力戦" }
    ], mil.doctrine || "balanced");
    box.appendChild(row(labeled("教義", docSel),
      button("教義変更を予約", () => { ctx.addOrder("setDoctrine", { doctrine: docSel.value }); ctx.flash("教義変更を予約しました。", "ok"); }, "secondary")));
  }

  // ---- ユーティリティ ----
  function getArmy(id) { const m = ctx.getNation().military; return id && m.armies ? m.armies[id] : null; }
  function ownStateOptions(nation) {
    const states = ctx.getStates();
    return Object.keys(states).filter(n => states[n].country === nation.id).sort((a, b) => a.localeCompare(b, "ja")).map(n => ({ value: n, label: n }));
  }
  function alliesOf(nation) {
    const out = [];
    for (const t of (nation.treaties || [])) { if (t && t.type === "alliance" && t.with) out.push(t.with); }
    return out;
  }

  function refresh() {
    renderToolbar();
    paintMap();
    renderOps();
    renderArmies();
    renderMobilize();
    refreshMapOverlay();
  }

  // ---- 初期化 ----
  buildMap();
  renderToolbar();
  renderOps();
  renderArmies();
  renderMobilize();
  refreshMapOverlay();

  return { refresh };
}

// ---- module helpers ----
function toggleSet(set, v) { if (set.has(v)) set.delete(v); else set.add(v); }
function unitName(k) { if (k === "line" || !k) return "通常兵"; const u = SPECIAL_UNITS_BY_ID[k]; return u ? u.name : k; }
function modeLabel(m) {
  return { idle: "待機", defend: "防衛", moving: "移動中", battling: "交戦中", retreating: "撤退中", annihilating: "殲滅戦", surrendered: "降伏" }[m] || "待機";
}
function shade(hex, amt) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return hex;
  let n = parseInt(m[1], 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const f = amt < 0 ? (1 + amt) : 1;
  r = Math.round(r * f); g = Math.round(g * f); b = Math.round(b * f);
  return "#" + [r, g, b].map(x => Math.max(0, Math.min(255, x)).toString(16).padStart(2, "0")).join("");
}
