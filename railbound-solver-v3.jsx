import React, { useState, useRef, useMemo, useEffect } from "react";
import {
  TRACKS, T_META, OPPOSITE, DELTA, BASIC_TRACKS, T_TRACKS, pk,
  TUNNEL_COLORS, BARRIER_COLORS, T_SWITCH_PAIRS,
  simulate, forwardReachable, backwardReachable, filterBlanks
} from "./railbound-logic.js";
import { createSolverWorkerUrl } from "./railbound-worker-code.js";
import {
  createProofScopeKey,
  inspectPortfolioCandidate,
  normalizeCandidateSources,
  portfolioSeed,
  workerProofIssue,
} from "./solver/portfolio-evidence.js";
import { createPortfolioState, reducePortfolioEvent } from "./solver/portfolio-state-machine.js";
import { normalizePuzzle } from "./puzzle-io.js";
import PuzzleLibraryDialog from "./PuzzleLibraryDialog.jsx";
import { DEFAULT_GRID_HEIGHT, DEFAULT_GRID_WIDTH, directionGlyphDirection, straightTrackForDirection } from "./editor-helpers.js";

/* ═══════════════ SVG ═══════════════ */
const PP = { N: [0.5, 0], E: [1, 0.5], S: [0.5, 1], W: [0, 0.5] };
function TrackSVG({ type, size, color = "#c8a55a", width = 3 }) {
  const t = TRACKS[type]; if (!t) return null; const meta = T_META[type], drawn = new Set(), segs = [];
  for (const [e, x] of Object.entries(t)) { const k = [e, x].sort().join(""); if (drawn.has(k)) continue; drawn.add(k); segs.push([e, x]); }
  return <g>{segs.map(([a, b], i) => {
    const [ax, ay] = [PP[a][0] * size, PP[a][1] * size], [bx, by] = [PP[b][0] * size, PP[b][1] * size];
    const opp = OPPOSITE[a] === b, isMain = meta ? !opp : true;
    const w = meta ? (isMain ? width : Math.max(1, width * 0.55)) : width;
    const c = meta ? (isMain ? color : color + "99") : color;
    if (opp) return <line key={i} x1={ax} y1={ay} x2={bx} y2={by} stroke={c} strokeWidth={w} strokeLinecap="round" />;
    return <path key={i} d={`M${ax},${ay} Q${size / 2},${size / 2} ${bx},${by}`} stroke={c} strokeWidth={w} fill="none" strokeLinecap="round" />;
  })}{meta && <circle cx={PP[meta.merge][0] * size} cy={PP[meta.merge][1] * size} r={size * 0.06} fill={color} opacity={0.8} />}</g>;
}

const DA = { N: "↑", E: "→", S: "↓", W: "←" };
const CC = ["#c45c3a", "#3a7cc4", "#8c5cbf", "#c4a43a", "#3ac4a4", "#c43a8c"];
const ZERO_CAR_COLOR = "#aeb6c2";
const CL = 52;
/* Bounded window the first winning Worker keeps searching for an optimality
   proof after every loser has been cancelled. */
const BROWSER_PROOF_GRACE_MS = 100;
const TERMINATION_LABELS = {
  "portfolio-first-valid-candidate": "组合首个合法候选，未获最优性证明",
  "portfolio-contract-conflict": "合法候选与完备无解声明冲突，完备性已撤销",
  "portfolio-proof-mismatch": "最优证明成本与权威候选不一致",
  "candidate-unproven-portfolio": "组合内没有 Worker 证明该候选最优",
  "portfolio-incomplete": "搜索未完备",
  "dfs-iteration-budget": "DFS 迭代预算耗尽",
  "candidate-unproven-dfs-budget": "DFS 迭代预算耗尽",
  "candidate-unproven-csp": "CSP 候选未证明",
  "candidate-unproven-early-stop": "搜索提前停止",
  "wall-clock-timeout": "墙钟超时",
};
function terminationLabel(reason) {
  return TERMINATION_LABELS[reason] || reason || "搜索未完备";
}
function isZeroCarCell(c) { return c?.role === "zero" || String(c?.name) === "0"; }
function carColor(c) { return isZeroCarCell(c) ? ZERO_CAR_COLOR : CC[(+c.name - 1) % CC.length]; }
function carLabel(c) { return isZeroCarCell(c) ? "0" : String(c?.name ?? ""); }

/* ═══════════════ Track grouping ═══════════════ */
function classifyTracks() {
  return {
    straights: ["|", "-"],
    curves: ["ES", "SW", "NE", "WN"],
    tees: ["T_NE_S", "T_SW_E", "T_ES_W", "T_WN_S", "T_ES_N", "T_WN_E", "T_NE_W", "T_SW_N"],
  };
}

/* ═══════════════ App ═══════════════ */
export default function App() {
  const [W, setW] = useState(DEFAULT_GRID_WIDTH), [H, setH] = useState(DEFAULT_GRID_HEIGHT);
  const [grid, setGrid] = useState(() => mk(DEFAULT_GRID_WIDTH, DEFAULT_GRID_HEIGHT));
  const [tool, setTool] = useState("blank"), [trkPick, setTrkPick] = useState("-");
  const [carKind, setCarKind] = useState("normal");
  const [tunnelColor, setTunnelColor] = useState(TUNNEL_COLORS[0]);
  const [barrierColor, setBarrierColor] = useState(BARRIER_COLORS[0]), [barrierInitState, setBarrierInitState] = useState("closed");
  const [barrierTrack, setBarrierTrack] = useState("|");
  const [gateMode, setGateMode] = useState("fixed");
  const [tswTriggerTrack, setTswTriggerTrack] = useState("|");
  const [tswitchTrack, setTswitchTrack] = useState("T_NE_S");
  const [autoSwitchTrack, setAutoSwitchTrack] = useState("T_NE_S");
  const [platformCar, setPlatformCar] = useState("1");
  const [maxSt, setMaxSt] = useState(50), [maxTrk, setMaxTrk] = useState(0), [zeroSafetySt, setZeroSafetySt] = useState(3);
  const [sol, setSol] = useState(null), [msg, setMsg] = useState("");
  const [step, setStep] = useState(0), [playing, setPlaying] = useState(false);
  const [reachInfo, setReachInfo] = useState(null), [showReach, setShowReach] = useState(false);
  const [isDragging, setIsDragging] = useState(false), [dragMode, setDragMode] = useState(null);
  const [dirPick, setDirPick] = useState(null);
  const [arrivalOrder, setArrivalOrder] = useState(null);
  const [libraryDialog, setLibraryDialog] = useState(null);
  const tr = useRef(null);
  const workersRef = useRef([]), workerUrlRef = useRef(null), solveRequestRef = useRef(0);
  const proofGraceTimerRef = useRef(null);

  const trackGroups = useMemo(classifyTracks, []);

  useEffect(() => {
    const up = () => { setIsDragging(false); setDragMode(null); };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, []);

  useEffect(() => () => stopW(), []);

  function mk(w, h) { const g = {}; for (let y = 0; y < h; y++)for (let x = 0; x < w; x++)g[pk(x, y)] = { t: "empty" }; return g; }
  function invalidateSolution() { stopW(); setSol(null); setPlaying(false); setReachInfo(null); }
  function resize(nw, nh) { invalidateSolution(); setW(nw); setH(nh); setGrid(p => { const g = {}; for (let y = 0; y < nh; y++)for (let x = 0; x < nw; x++)g[pk(x, y)] = p[pk(x, y)] || { t: "empty" }; return g; }); }
  function nextNormalName(g) {
    const ns = Object.values(g).filter(c => c.t === "car" && !isZeroCarCell(c)).map(c => parseInt(c.name, 10)).filter(Number.isFinite);
    return String(ns.length ? Math.max(...ns) + 1 : 1);
  }
  function nextZeroName(g) {
    const ns = Object.values(g).filter(c => c.t === "car" && isZeroCarCell(c)).map(c => {
      const m = String(c.name).match(/^0\.(\d+)$/);
      return m ? parseInt(m[1], 10) : 0;
    });
    return `0.${ns.length ? Math.max(...ns) + 1 : 1}`;
  }
  function click(x, y) {
    const k = pk(x, y); invalidateSolution(); setMsg("");
    if (["car", "goal", "platform", "tunnel"].includes(tool)) {
      setDirPick({ x, y, tool });
      setMsg(tool === "car" ? "选择车头行驶方向" : tool === "goal" ? "选择火车从哪一侧进入终点" : tool === "tunnel" ? "选择火车从哪一侧进入隧道" : "选择站台指向哪一侧道路");
      return;
    }
    setGrid(p => {
      const g = { ...p };
      if (tool === "empty") g[k] = { t: "empty" };
      else if (tool === "blank") g[k] = { t: "blank" };
      else if (tool === "fixed") {
        if (gateMode === "fixed") g[k] = { t: "fixed", track: trkPick };
        else if (gateMode === "trigger") {
          const allTriggerTracks = [...BASIC_TRACKS, ...T_TRACKS];
          if (p[k]?.t === "trigger" && p[k].color === barrierColor) {
            const seq = allTriggerTracks;
            const next = p[k].track === tswTriggerTrack ? seq[(seq.indexOf(p[k].track) + 1) % seq.length] : tswTriggerTrack;
            g[k] = { ...p[k], track: next };
          } else g[k] = { t: "trigger", color: barrierColor, track: tswTriggerTrack };
        } else if (gateMode === "barrier") {
          if (p[k]?.t === "barrier" && p[k].color === barrierColor) {
            g[k] = { ...p[k], track: barrierTrack, initialState: barrierInitState };
          } else g[k] = { t: "barrier", color: barrierColor, track: barrierTrack, initialState: barrierInitState };
        } else if (gateMode === "tswitch") {
          if (p[k]?.t === "tswitch" && p[k].color === barrierColor) {
            g[k] = { ...p[k], track: T_SWITCH_PAIRS[p[k].track] || p[k].track };
          } else g[k] = { t: "tswitch", color: barrierColor, track: tswitchTrack };
        } else if (gateMode === "autoswitch") {
          if (p[k]?.t === "autoswitch") {
            g[k] = { ...p[k], track: T_SWITCH_PAIRS[p[k].track] || p[k].track };
          } else g[k] = { t: "autoswitch", track: autoSwitchTrack };
        }
      }
      return g;
    });
  }
  function applyPickedDirection(d) {
    if (!dirPick) return;
    const { x, y, tool: pickTool } = dirPick, k = pk(x, y);
    invalidateSolution(); setMsg("");
    setGrid(p => {
      const g = { ...p };
      if (pickTool === "car") {
        if (p[k]?.t === "car") {
          const track = p[k].track === "-" || p[k].track === "|" ? straightTrackForDirection(d) : p[k].track;
          g[k] = { ...p[k], facing: d, track };
        }
        else {
          const underTrack = p[k]?.t === "fixed" ? p[k].track : straightTrackForDirection(d);
          if (carKind === "zero") g[k] = { t: "car", name: nextZeroName(g), role: "zero", facing: d, track: underTrack };
          else g[k] = { t: "car", name: nextNormalName(g), facing: d, track: underTrack };
        }
      } else if (pickTool === "goal") {
        for (const kk of Object.keys(g)) if (g[kk].t === "goal") g[kk] = { t: "empty" };
        g[k] = { t: "goal", entry: d };
      } else if (pickTool === "platform") {
        g[k] = { t: "platform", dir: d, car: String(platformCar) };
      } else if (pickTool === "tunnel") {
        const existing = Object.values(g).filter(c => c.t === "tunnel" && c.color === tunnelColor);
        if (!(p[k]?.t === "tunnel" && p[k].color === tunnelColor) && existing.length >= 2) {
          for (const kk of Object.keys(g)) if (g[kk].t === "tunnel" && g[kk].color === tunnelColor) g[kk] = { t: "empty" };
        }
        g[k] = { t: "tunnel", color: tunnelColor, facing: d };
      }
      return g;
    });
    setDirPick(null);
  }
  function rclick(e, x, y) { e.preventDefault?.(); invalidateSolution(); setDirPick(null); setMsg(""); setGrid(p => ({ ...p, [pk(x, y)]: { t: "empty" } })); }

  function handleDown(e, x, y) {
    if (e.button === 0) { setDragMode('left'); setIsDragging(true); click(x, y); }
    else if (e.button === 2) { setDragMode('right'); setIsDragging(true); rclick(e, x, y); }
  }
  function handleEnter(x, y) {
    if (!isDragging) return;
    if (dragMode === 'left') {
      if (['blank', 'empty'].includes(tool) || (tool === 'fixed' && gateMode === 'fixed')) click(x, y);
    } else if (dragMode === 'right') {
      rclick({}, x, y);
    }
  }

  function doClear() {
    if (confirm("确定要清空全部网格吗？")) {
      invalidateSolution(); setDirPick(null); setArrivalOrder(null); setGrid(() => mk(W, H)); setMsg("已清空");
    }
  }
  function doBlankAll() {
    invalidateSolution(); setDirPick(null);
    setGrid(p => {
      const g = { ...p };
      for (let y = 0; y < H; y++)for (let x = 0; x < W; x++) {
        const k = pk(x, y);
        if (!g[k] || g[k].t === "empty") g[k] = { t: "blank" };
      }
      return g;
    });
    setMsg("所有空地已设为可铺设");
  }

  function updateMaxSteps(value) { invalidateSolution(); setMaxSt(value); setMsg(""); }
  function updateMaxTracks(value) { invalidateSolution(); setMaxTrk(value); setMsg(""); }
  function updateZeroSafetySteps(value) { invalidateSolution(); setZeroSafetySt(value); setMsg(""); }

  function buildP() {
    const fixed = {}, blanks = [], cars = [], tunnelsByColor = {}, triggers = [], barriers = [], tsw_triggers = [], tswitches = [], autoSwitches = [], platforms = []; let goal = null, gE = "W";
    for (let y = 0; y < H; y++)for (let x = 0; x < W; x++) {
      const c = grid[pk(x, y)]; if (!c || c.t === "empty") continue;
      if (c.t === "fixed") fixed[pk(x, y)] = c.track; else if (c.t === "blank") blanks.push([x, y]);
      else if (c.t === "car") {
        // facing → entry: car enters from opposite of where it faces
        const car = { name: c.name, x, y, entry: OPPOSITE[c.facing] };
        if (isZeroCarCell(c)) car.role = "zero";
        cars.push(car);
        fixed[pk(x, y)] = c.track;
      }
      else if (c.t === "goal") { goal = [x, y]; gE = c.entry; }
      else if (c.t === "tunnel") {
        if (!tunnelsByColor[c.color]) tunnelsByColor[c.color] = [];
        tunnelsByColor[c.color].push({ x, y, facing: c.facing });
      }
      else if (c.t === "platform") platforms.push({ x, y, dir: c.dir, car: String(c.car || "1") });
      else if (c.t === "trigger") { fixed[pk(x, y)] = c.track; triggers.push({ x, y, color: c.color }); tsw_triggers.push({ x, y, color: c.color }); }
      else if (c.t === "barrier") { fixed[pk(x, y)] = c.track; barriers.push({ x, y, color: c.color, initialState: c.initialState }); }
      else if (c.t === "tsw_trigger") { fixed[pk(x, y)] = c.track; tsw_triggers.push({ x, y, color: c.color }); }
      else if (c.t === "tswitch") { tswitches.push({ x, y, color: c.color, track: c.track }); }
      else if (c.t === "autoswitch") { autoSwitches.push({ x, y, track: c.track }); }
    }
    if (!goal) { setMsg("请放置终点(G)"); return null; }
    if (!cars.length) { setMsg("请放置起点"); return null; }
    if (!cars.some(c => c.role !== "zero" && String(c.name) !== "0")) { setMsg("请至少放置一辆普通火车"); return null; }
    for (const p of platforms) {
      const d = DELTA[p.dir], tx = p.x + d[0], ty = p.y + d[1], target = grid[pk(tx, ty)];
      if (tx < 0 || tx >= W || ty < 0 || ty >= H || !target || !["fixed", "car", "trigger", "barrier", "tswitch", "autoswitch"].includes(target.t)) {
        setMsg(`站台(${p.x},${p.y}) 必须指向固定道路`);
        return null;
      }
    }
    const incompleteTunnel = Object.entries(tunnelsByColor).find(([, cells]) => cells.length !== 2);
    if (incompleteTunnel) { setMsg(`隧道 ${incompleteTunnel[0]} 必须恰好放置两个端点`); return null; }
    const tunnels = Object.entries(tunnelsByColor).map(([color, cells]) => ({ color, cells }));
    const normalNames = cars.filter(c => c.role !== "zero" && String(c.name) !== "0").map(c => String(c.name)).sort((a, b) => parseInt(a) - parseInt(b));
    const preservedOrder = arrivalOrder && arrivalOrder.length === normalNames.length && normalNames.every(name => arrivalOrder.includes(name));
    try {
      return normalizePuzzle({ width: W, height: H, fixed, blanks, cars, goal, goalEntry: gE, order: preservedOrder ? arrivalOrder : normalNames, maxSteps: maxSt, zeroSafetySteps: zeroSafetySt, tunnels, triggers, barriers, tswTriggers: tsw_triggers, tswitches, autoSwitches, platforms });
    } catch (error) {
      setMsg(`关卡无效：${error.message}`);
      return null;
    }
  }

  function doReach() {
    stopW(); const p = buildP(); if (!p) return; const fwd = forwardReachable(p), bwd = backwardReachable(p);
    const { useful, pruned } = filterBlanks(p); setReachInfo({ fwd, bwd, usefulSet: new Set(useful.map(b => pk(b[0], b[1]))) });
    setMsg(`可达性: ${useful.length} 有效 / ${p.blanks.length} 总 · 剪除 ${pruned}`);
  }

  function getWorkerUrl() { if (!workerUrlRef.current) workerUrlRef.current = createSolverWorkerUrl(); return workerUrlRef.current; }
  function stopW() {
    solveRequestRef.current += 1;
    if (proofGraceTimerRef.current != null) { clearTimeout(proofGraceTimerRef.current); proofGraceTimerRef.current = null; }
    workersRef.current.forEach(w => {
      w.onmessage = null; w.onerror = null; w.onmessageerror = null;
      try { w.terminate(); } catch { /* Worker may already be closed. */ }
    });
    workersRef.current = [];
  }

  function doSolve() {
    stopW();
    const p = buildP(); if (!p) return; if (!p.blanks.length) { setMsg("无空轨, 用「模拟」"); return; }
    setMsg("求解中..."); setSol(null); setPlaying(false); setReachInfo(null);
    const requestId = solveRequestRef.current;
    const { pruned } = filterBlanks(p);
    const nW = Math.min(navigator.hardwareConcurrency || 4, 16), t0 = performance.now();
    let totalIters = 0, failures = 0, lastMethod = "?", lastInfo = "";
    const url = getWorkerUrl(), pf = { ...p, _minTracks: true }, workers = [], settled = new Set();
    /* Per-Worker candidates that already passed the authoritative main-thread
       simulate(). A Worker's optimality proof is only honoured when it matches
       one of these, never when it merely claims a cost. */
    const validated = new Array(nW).fill(null);
    const candidateFailures = Array.from({ length: nW }, () => []);
    const overLimit = Array.from({ length: nW }, () => []);
    /* 异构组合：Worker 0 保持 CSP→DFS 作候选侦察兵，其余 Worker 跳过 CSP
       直接以不同 seed 跑 DFS。`skipCsp` 进入 solverOptions，因此两种角色
       天然拥有不同 proofScopeKey；组合的完备性域取 DFS-only 角色的域，
       CSP 角色的完备性声明不跨域转移（候选照常比较与验证）。 */
    const scopeKeyFor = roleOptions => createProofScopeKey({
      requestId,
      maxTracksHint: maxTrk > 0 ? maxTrk : 0,
      minTracks: true,
      solverOptions: roleOptions,
    });
    const heterogeneous = nW > 1;
    const roleSolverOptions = i => (heterogeneous && i > 0 ? { skipCsp: true } : {});
    const cspRoleScopeKey = scopeKeyFor({});
    const dfsRoleScopeKey = heterogeneous ? scopeKeyFor({ skipCsp: true }) : cspRoleScopeKey;
    const roleScopeKey = i => (heterogeneous && i > 0 ? dfsRoleScopeKey : cspRoleScopeKey);
    const proofScopeKey = heterogeneous ? dfsRoleScopeKey : cspRoleScopeKey;
    /* A single Worker has no portfolio race, so it keeps the old behaviour of
       running to completion instead of stopping on its own first candidate. */
    let machine = createPortfolioState({
      workerIds: Array.from({ length: nW }, (_, i) => i),
      expectSolution: nW > 1,
      proofScopeKey,
      proofGraceMs: BROWSER_PROOF_GRACE_MS,
    });

    function dispatch(event) {
      if (requestId !== solveRequestRef.current) return;
      const outcome = reducePortfolioEvent(machine, event);
      machine = outcome.state;
      for (const effect of outcome.effects) applyEffect(effect);
    }
    function stopWorker(i) {
      const w = workers[i];
      if (!w || settled.has(i)) return;
      settled.add(i);
      workersRef.current = workersRef.current.filter(ww => ww !== w);
      w.onmessage = null; w.onerror = null; w.onmessageerror = null;
      try { w.terminate(); } catch { /* Worker may already be closed. */ }
    }
    function applyEffect(effect) {
      if (effect.type === "cancel-worker") { stopWorker(effect.workerId); return; }
      if (effect.type === "publish-candidate") {
        const shown = validated[effect.workerId];
        if (!shown) return;
        setSol({ placed: shown.placed, result: shown.result, puzzle: p }); setStep(0);
        setMsg(`候选 ${(performance.now() - t0).toFixed(0)}ms · ${shown.result.steps}步 · ${shown.cost}轨 · 剪除${pruned}`);
        return;
      }
      if (effect.type === "start-proof-grace") {
        if (proofGraceTimerRef.current != null) clearTimeout(proofGraceTimerRef.current);
        proofGraceTimerRef.current = setTimeout(() => {
          proofGraceTimerRef.current = null;
          dispatch({ type: "proof-grace-expired", workerId: effect.workerId, atMs: performance.now() - t0 });
        }, effect.delayMs);
        return;
      }
      if (effect.type === "finish") {
        if (proofGraceTimerRef.current != null) { clearTimeout(proofGraceTimerRef.current); proofGraceTimerRef.current = null; }
        reportEvidence(effect.evidence);
      }
    }
    function reportEvidence(evidence) {
      const ms = (performance.now() - t0).toFixed(0);
      const cost = evidence.bestResult?.best?.cost ?? null;
      const failTail = failures ? ` · ${failures}线程失败` : "";
      if (evidence.complete === true && evidence.terminationReason === "optimal-proven") {
        setMsg(`✓ ${ms}ms · 已证最优${cost}轨 · ${lastMethod} · 剪除${pruned}${failTail}`);
      } else if (evidence.complete === true && evidence.terminationReason === "search-exhausted") {
        setMsg(`✕ 完备无解 (${ms}ms · ${lastMethod}${lastInfo ? " · " + lastInfo : ""}${failTail})`);
      } else if (cost != null) {
        setMsg(`△ ${ms}ms · 候选${cost}轨 · 未获最优性证明 (${terminationLabel(evidence.terminationReason)}) · 剪除${pruned}${failTail}`);
      } else if (failures === nW) {
        setMsg(`✕ 求解器启动失败 (${lastInfo || "Worker 未返回错误详情"})`);
      } else {
        setMsg(`△ 未找到候选 · 搜索未完备 (${ms}ms · ${terminationLabel(evidence.terminationReason)}${failTail})`);
      }
    }
    function settleWorker(i, event) {
      if (requestId !== solveRequestRef.current || settled.has(i)) return;
      stopWorker(i);
      dispatch(event);
    }
    for (let i = 0; i < nW; i++) {
      const w = new Worker(url, { type: "module" });
      w.onmessage = (e) => {
        if (requestId !== solveRequestRef.current || e.data?.requestId !== requestId) return;
        const { type, solution, cspInfo } = e.data;
        if (type === "progress") {
          if (e.data.diagnosis) {
            const d = e.data.diagnosis;
            let diagMsg = "诊断:";
            if (d.normalOnlyResult) diagMsg += ` 普通车${d.normalOnlyResult.ok ? "可解" : "不可解"}`;
            if (d.zeroCycleResult) diagMsg += ` · 零号循环${d.zeroCycleResult.count}个候选`;
            if (d.compatResult) diagMsg += ` · ${d.compatResult}`;
            setMsg(m => m + " | " + diagMsg);
          } else {
            totalIters += (e.data.iters || 0); const el = ((performance.now() - t0) / 1000).toFixed(1);
            let m = `求解中... ${nW}线程 · ${(totalIters / 1e6).toFixed(1)}M迭代 · ${el}s`;
            if (pruned) m += ` · 剪除${pruned}`; if (cspInfo) m += ` · ${cspInfo}`;
            if (e.data.info) m += ` · ${e.data.info}`;
            const current = machine.bestCandidate?.cost;
            if (Number.isFinite(current)) m += ` · 当前${current}轨`; setMsg(m);
          }
        }
        if (type === "solution" && solution) {
          const known = machine.bestCandidate?.cost;
          const clean = {}; for (const [k, v] of Object.entries(solution)) if (k !== "__cost") clean[k] = v;
          const r = simulate(p, clean);
          const inspected = inspectPortfolioCandidate(solution, r, maxTrk);
          if (!inspected.accepted) {
            (inspected.kind === "over-limit" ? overLimit[i] : candidateFailures[i]).push(inspected.issue);
            const reason = inspected.kind === "over-limit"
              ? `超过上限 ${inspected.actualCost}>${maxTrk}`
              : inspected.issue.reason;
            setMsg(`跳过无效候选 ${inspected.actualCost}轨: ${reason}${Number.isFinite(r.steps) ? ` @${r.steps}步` : ""}`);
            return;
          }
          const cost = inspected.actualCost;
          if (Number.isFinite(known) && cost >= known) return;
          const sources = normalizeCandidateSources(e.data.source);
          validated[i] = { cost, steps: r.steps, sources, placed: clean, result: r };
          dispatch({
            type: "valid-candidate",
            workerId: i,
            candidate: { cost, steps: r.steps, placed: clean, sources, seed: portfolioSeed(i) },
            result: r,
            atMs: performance.now() - t0,
          });
        }
        if (type === "done") {
          lastMethod = e.data.method || lastMethod;
          lastInfo = e.data.info || lastInfo;
          const best = validated[i];
          const proofIssue = workerProofIssue(e.data, {
            best,
            candidateFailures: candidateFailures[i],
            overLimit: overLimit[i],
          });
          const status = best
            ? "solved"
            : (overLimit[i].length
              ? "over-limit"
              : (candidateFailures[i].length
                ? "candidate-failed"
                : (e.data.complete === true && e.data.terminationReason === "search-exhausted"
                  ? "search-exhausted"
                  : "incomplete")));
          settleWorker(i, {
            type: "worker-done",
            workerId: i,
            atMs: performance.now() - t0,
            result: {
              status,
              complete: proofIssue == null && e.data.complete === true,
              terminationReason: proofIssue || e.data.terminationReason || null,
              finalCost: best?.cost ?? null,
              best: best ? { cost: best.cost, sources: best.sources } : null,
              candidateFailures: candidateFailures[i],
              overLimit: overLimit[i],
              proofScopeKey: roleScopeKey(i),
              workerIndex: i,
            },
          });
        }
      };
      const failWorker = (method, info) => {
        if (settled.has(i)) return;
        failures++;
        lastMethod = method; lastInfo = info || lastInfo;
        settleWorker(i, {
          type: "worker-failed",
          workerId: i,
          atMs: performance.now() - t0,
          result: {
            status: "error",
            complete: false,
            terminationReason: "worker-error",
            finalCost: null,
            best: null,
            proofScopeKey: roleScopeKey(i),
            workerIndex: i,
          },
        });
      };
      w.onerror = (event) => {
        event.preventDefault?.();
        failWorker("worker-error", event.message || "Worker 加载或执行失败");
      };
      w.onmessageerror = () => failWorker("message-error", "Worker 消息无法反序列化");
      w.postMessage({ type: "solve", requestId, puzzle: pf, seed: portfolioSeed(i), maxTracksHint: maxTrk > 0 ? maxTrk : 0, solverOptions: roleSolverOptions(i) });
      workers.push(w);
    }
    workersRef.current = workers;
  }

  function doSim() {
    stopW();
    const p = buildP(); if (!p) return;
    const placed = sol?.placed || {};
    setMsg(""); setPlaying(false); setReachInfo(null);
    const r = simulate(p, placed); setSol({ placed, result: r, puzzle: p }); setStep(0); setMsg(r.ok ? `✓ ${r.steps}步` : `✕ ${r.reason}`);
  }

  function doSave() {
    const puzzle = buildP();
    if (puzzle) setLibraryDialog({ mode: "save", puzzle });
  }

  function doOpenLibrary() {
    setLibraryDialog({ mode: "load" });
  }

  function loadPuzzleIntoEditor(d, name = "") {
    try {
      const nw = d.width, nh = d.height;
      const g = {}; for (let y = 0; y < nh; y++)for (let x = 0; x < nw; x++)g[pk(x, y)] = { t: "empty" };
      for (const [k, v] of Object.entries(d.fixed)) g[k] = { t: "fixed", track: v };
      for (const b of d.blanks) g[pk(b[0], b[1])] = { t: "blank" };
      for (const c of d.cars) {
        const track = d.fixed[pk(c.x, c.y)] || "-";
        const role = c.role === "zero" || String(c.name) === "0" ? "zero" : undefined;
        g[pk(c.x, c.y)] = { t: "car", name: String(c.name), role, facing: OPPOSITE[c.entry] || "E", track };
      }
      const gl = d.goal; g[pk(gl[0], gl[1])] = { t: "goal", entry: d.goalEntry };
      for (const t of d.tunnels) for (const c of t.cells) g[pk(c.x, c.y)] = { t: "tunnel", color: t.color, facing: c.facing };
      const triggerKeys = new Set();
      for (const t of d.triggers) {
        const key = pk(t.x, t.y); triggerKeys.add(key);
        g[key] = { t: "trigger", color: t.color, track: d.fixed[key] || "|" };
      }
      for (const b of d.barriers) {
        const key = pk(b.x, b.y);
        g[key] = { t: "barrier", color: b.color, track: d.fixed[key] || "|", initialState: b.initialState };
      }
      for (const t of d.tswTriggers) {
        const key = pk(t.x, t.y);
        if (!triggerKeys.has(key)) g[key] = { t: "tsw_trigger", color: t.color, track: d.fixed[key] || "|" };
      }
      for (const s of d.tswitches) g[pk(s.x, s.y)] = { t: "tswitch", color: s.color, track: s.track };
      for (const s of d.autoSwitches) g[pk(s.x, s.y)] = { t: "autoswitch", track: s.track };
      for (const p of d.platforms) g[pk(p.x, p.y)] = { t: "platform", dir: p.dir, car: p.car };
      invalidateSolution(); setDirPick(null); setW(nw); setH(nh); setGrid(g); setArrivalOrder(d.order);
      setMaxSt(d.maxSteps); setZeroSafetySt(d.zeroSafetySteps); setShowReach(false); setMsg(`导入成功 · 格式 v${d.formatVersion}`);
      setLibraryDialog(null);
      setMsg(`已载入${name ? `“${name}”` : "关卡"} · 格式 v${d.formatVersion}`);
    } catch (e) { setMsg("载入失败: " + e.message); }
  }

  useEffect(() => { if (playing && sol?.result?.history) { const mx = sol.result.history.length - 1; if (step >= mx) { setPlaying(false); return; } tr.current = setTimeout(() => setStep(s => s + 1), 350); return () => clearTimeout(tr.current); } }, [playing, step, sol]);
  const liveCars = sol?.result?.history?.[step] || [];
  const maxStep = sol?.result?.history ? sol.result.history.length - 1 : 0;
  const isLive = !!sol?.result?.history;

  const bg = "#12100e", pnl = "#17140f", c0 = "#1b1814", cB = "#221e16", bd = "#2a2520", hi = "#d4a256",
    trk_ = "#a08a5a", sTrk = "#4ab8e0", tx = "#c8bfb0", dm = "#6a5e4e", dm2 = "#3a332a", ok = "#6abf6a", fl = "#bf6a6a";

  /* ═══════ Track picker sub-component ═══════ */
  function TrackBtn({ t, selected, onPick }) {
    return <button onClick={() => onPick(t)} style={{
      width: 36, height: 36, background: selected ? "#2e2818" : pnl,
      border: `1px solid ${selected ? hi : bd}`, borderRadius: 3, cursor: "pointer",
      display: "flex", alignItems: "center", justifyContent: "center", padding: 0
    }}><svg width={28} height={28}><TrackSVG type={t} size={28} color={selected ? hi : trk_} width={2.5} /></svg></button>;
  }

  function TrackGroup({ label, tracks, pick, onPick, columns = null }) {
    return <div style={{ marginBottom: 6 }}>
      <div style={{ fontSize: 9, color: dm2, marginBottom: 3, letterSpacing: 0.5 }}>{label}</div>
      <div style={columns ? { display: "grid", gridTemplateColumns: `repeat(${columns}, 36px)`, gap: 3 } : { display: "flex", gap: 3, flexWrap: "wrap" }}>
        {tracks.map(t => <TrackBtn key={t} t={t} selected={pick === t} onPick={onPick} />)}
      </div>
    </div>;
  }

  /* ═══════ Tool definitions ═══════ */
  const TOOLS = [
    { id: "car", icon: "■", label: "起点" },
    { id: "goal", icon: "◉", label: "终点" },
    { id: "blank", icon: "◻", label: "铺轨区" },
    { id: "empty", icon: "✕", label: "清除" },
    { id: "fixed", icon: "═ ⚡", label: "固定轨 / 机关", wide: true },
    { id: "platform", icon: "▣", label: "站台" },
    { id: "tunnel", icon: "⧆", label: "隧道" },
  ];

  return (<div style={{ background: bg, minHeight: "100vh", color: tx, fontFamily: "'JetBrains Mono','Fira Code','SF Mono',monospace", fontSize: 12 }}>
    <div style={{ maxWidth: 1180, margin: "0 auto", padding: "12px 10px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, paddingBottom: 6, borderBottom: `1px solid ${bd}` }}>
        <span style={{ fontSize: 16, fontWeight: 800, color: hi, letterSpacing: 3 }}>RAILBOUND</span>
        <span style={{ color: dm, fontSize: 10, marginTop: 2 }}>v4 — basic-only enum · CSP forward check</span>
        <div style={{ flex: 1 }} /><Btn o={doClear}>清空</Btn><span style={{ width: 4 }}></span><Btn o={doSave}>保存</Btn><Btn o={doOpenLibrary}>关卡库</Btn>
      </div>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ width: 210, flexShrink: 0, display: "flex", flexDirection: "column", gap: 7 }}>
          <Bx t="网格"><div style={{ display: "flex", gap: 6, alignItems: "center" }}><Stp v={W} s={v => resize(v, H)} mn={2} mx={12} /><span style={{ color: dm2 }}>×</span><Stp v={H} s={v => resize(W, v)} mn={2} mx={12} /></div></Bx>
          <Bx t="工具"><div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 4 }}>
            {TOOLS.map(({ id, icon, label, wide }) =>
              <button key={id} title={label} onClick={() => { setTool(id); setDirPick(null); setMsg(""); }} style={{ gridColumn: wide ? "1 / -1" : undefined, display: "flex", minWidth: 0, minHeight: 46, flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3, padding: "5px 3px", background: tool === id ? "#2e2818" : "transparent", border: `1px solid ${tool === id ? hi : bd}`, borderRadius: 3, color: tool === id ? hi : tx, cursor: "pointer", fontSize: 10, fontFamily: "inherit", whiteSpace: "nowrap" }}><span style={{ textAlign: "center", fontSize: 15, lineHeight: 1 }}>{icon}</span>{label}</button>)}
          </div>

            {tool === "blank" && <div style={{ marginTop: 8 }}>
              <button onClick={doBlankAll} style={{ width: "100%", padding: "5px 7px", background: "#241f14", border: `1px solid ${bd}`, color: tx, borderRadius: 3, cursor: "pointer", fontSize: 11, fontFamily: "inherit" }}>全部空地设为可铺设</button>
            </div>}

            {/* ─── Car: facing direction only ─── */}
            {tool === "car" && <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 10, color: dm, marginBottom: 4 }}>起点类型</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, marginBottom: 8 }}>
                {[["normal", "普通火车"], ["zero", "零号火车"]].map(([v, lb]) =>
                  <button key={v} onClick={() => setCarKind(v)} style={{
                    minHeight: 30, fontSize: 11, fontFamily: "inherit", cursor: "pointer",
                    background: carKind === v ? "#2e2818" : pnl,
                    color: carKind === v ? hi : dm,
                    border: `1px solid ${carKind === v ? hi : bd}`,
                    borderRadius: 3,
                  }}>{lb}</button>)}
              </div>
              <div style={{ fontSize: 9, color: dm2, marginTop: 5, lineHeight: 1.5 }}>
                点击格子后选择行驶方向 · 零号火车不进通关顺序
              </div>
            </div>}

            {/* ─── Goal ─── */}
            {tool === "goal" && <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 10, color: dm, lineHeight: 1.5 }}>点击格子后，选择火车从哪一侧进入终点</div>
            </div>}

            {/* ─── Platform ─── */}
            {tool === "platform" && <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 10, color: dm, marginTop: 6, marginBottom: 3 }}>需求车号</div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <Stp v={parseInt(platformCar) || 1} s={v => setPlatformCar(String(v))} mn={1} mx={99} />
                <span style={{ color: dm2, fontSize: 9 }}>车 {platformCar || "1"}</span>
              </div>
              <div style={{ fontSize: 9, color: dm2, marginTop: 5, lineHeight: 1.5 }}>
                点击格子后选择指向道路 · 指定车接客后停 1 步
              </div>
            </div>}

            {/* ─── Tunnel ─── */}
            {tool === "tunnel" && <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 10, color: dm, marginBottom: 3 }}>隧道颜色</div>
              <div style={{ display: "flex", gap: 3 }}>{TUNNEL_COLORS.map(c => <button key={c} onClick={() => setTunnelColor(c)} style={{ width: 24, height: 24, borderRadius: 12, background: c, border: `2px solid ${tunnelColor === c ? "#fff" : "transparent"}`, cursor: "pointer", boxShadow: tunnelColor === c ? `0 0 6px ${c}` : "none" }} />)}</div>
              <div style={{ fontSize: 9, color: dm2, marginTop: 4, lineHeight: 1.4 }}>选择火车从哪一侧进入隧道 · 每色最多2个</div>
            </div>}

            {/* ─── Fixed track + mechanisms: all are track-backed cell types ─── */}
            {tool === "fixed" && <div style={{ marginTop: 8 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, marginBottom: 7 }}>
                {[["fixed", "═ 普通固定轨"], ["trigger", "◇ 触发器"], ["barrier", "▮ 关卡"], ["tswitch", "T 变轨T"], ["autoswitch", "A 自变T"]].map(([m, lb]) =>
                  <button key={m} onClick={() => setGateMode(m)} style={{
                    gridColumn: m === "fixed" ? "1 / -1" : undefined,
                    minHeight: 32, fontSize: 11, fontFamily: "inherit", cursor: "pointer",
                    background: gateMode === m ? "#2e2818" : pnl,
                    color: gateMode === m ? hi : dm,
                    border: `1px solid ${gateMode === m ? hi : bd}`,
                    borderRadius: 3,
                  }}>{lb}</button>)}
              </div>
              {gateMode !== "fixed" && gateMode !== "autoswitch" && <>
                <div style={{ fontSize: 10, color: dm, marginBottom: 3 }}>颜色</div>
                <div style={{ display: "flex", gap: 3 }}>{BARRIER_COLORS.map(c => <button key={c} onClick={() => setBarrierColor(c)} style={{ width: 24, height: 24, borderRadius: 12, background: c, border: `2px solid ${barrierColor === c ? "#fff" : "transparent"}`, cursor: "pointer", boxShadow: barrierColor === c ? `0 0 6px ${c}` : "none" }} />)}</div>
              </>}
              {gateMode === "fixed" && <div style={{ marginTop: 8 }}>
                <TrackGroup label="直线" tracks={trackGroups.straights} pick={trkPick} onPick={setTrkPick} />
                <TrackGroup label="弯道" tracks={trackGroups.curves} pick={trkPick} onPick={setTrkPick} columns={2} />
                <TrackGroup label="三头" tracks={trackGroups.tees} pick={trkPick} onPick={setTrkPick} columns={4} />
              </div>}
              {gateMode === "barrier" && <>
                <div style={{ fontSize: 10, color: dm, marginBottom: 3, marginTop: 6 }}>初始状态</div>
                <div style={{ display: "flex", gap: 2 }}>{[["closed", "🔒 关闭"], ["open", "🔓 打开"]].map(([v, lb]) =>
                  <button key={v} onClick={() => setBarrierInitState(v)} style={{
                    flex: 1, padding: "3px 0", background: barrierInitState === v ? "#2e2818" : pnl,
                    border: `1px solid ${barrierInitState === v ? hi : bd}`, borderRadius: 3,
                    color: barrierInitState === v ? hi : tx, cursor: "pointer", fontSize: 11, fontFamily: "inherit"
                  }}>{lb}</button>)}</div>
                <div style={{ marginTop: 8 }}>
                  <TrackGroup label="关卡底轨 · 直线" tracks={trackGroups.straights} pick={barrierTrack} onPick={setBarrierTrack} columns={2} />
                  <TrackGroup label="关卡底轨 · 弯道" tracks={trackGroups.curves} pick={barrierTrack} onPick={setBarrierTrack} columns={2} />
                  <TrackGroup label="关卡底轨 · 三头" tracks={trackGroups.tees} pick={barrierTrack} onPick={setBarrierTrack} columns={4} />
                </div>
              </>}
              {gateMode === "trigger" && <div style={{ marginTop: 8 }}>
                <TrackGroup label="触发器底轨 · 直线" tracks={trackGroups.straights} pick={tswTriggerTrack} onPick={setTswTriggerTrack} columns={2} />
                <TrackGroup label="触发器底轨 · 弯道" tracks={trackGroups.curves} pick={tswTriggerTrack} onPick={setTswTriggerTrack} columns={2} />
                <TrackGroup label="触发器底轨 · 三头" tracks={trackGroups.tees} pick={tswTriggerTrack} onPick={setTswTriggerTrack} columns={4} />
              </div>}
              {gateMode === "tswitch" && <div style={{ marginTop: 8 }}>
                <div style={{ fontSize: 10, color: dm, marginBottom: 3 }}>初始T轨</div>
                <TrackGroup label="" tracks={trackGroups.tees} pick={tswitchTrack} onPick={setTswitchTrack} columns={4} />
                <div style={{ fontSize: 9, color: dm2, marginTop: 5, lineHeight: 1.4 }}>
                  再点同色变轨T会切换到配对变体
                </div>
              </div>}
              {gateMode === "autoswitch" && <div style={{ marginTop: 8 }}>
                <div style={{ fontSize: 10, color: dm, marginBottom: 3 }}>初始T轨</div>
                <TrackGroup label="" tracks={trackGroups.tees} pick={autoSwitchTrack} onPick={setAutoSwitchTrack} columns={4} />
                <div style={{ fontSize: 9, color: dm2, marginTop: 5, lineHeight: 1.4 }}>
                  车从该格开出一次后自动切换到配对变体
                </div>
              </div>}
              <div style={{ fontSize: 9, color: dm2, marginTop: 5, lineHeight: 1.4 }}>
                {gateMode === "fixed" ? "普通固定轨：直接铺设不可被求解器修改的轨道" : gateMode === "trigger" ? "触发器：车经过时切换同色关卡和变轨T" : gateMode === "barrier" ? "关卡：阻断/开放轨道通行" : gateMode === "tswitch" ? "变轨T轨：被同色触发器切换" : "自变T轨：无需触发器，经过后自动切换"}
                {gateMode === "trigger" ? " · 再点同色按底轨列表轮换" : gateMode === "barrier" ? " · 再点同色应用当前底轨" : ""}
              </div>
            </div>}
          </Bx>
        </div>
        <div style={{ flex: 1, overflow: "auto" }}>
          <svg width={W * CL + 2} height={H * CL + 2} style={{ display: "block", borderRadius: 4, background: pnl }}>
            {Array.from({ length: H }, (_, y) => Array.from({ length: W }, (_, x) => {
              const k = pk(x, y), cell = grid[k] || { t: "empty" }, sx = x * CL + 1, sy = y * CL + 1;
              const placed = sol?.placed?.[k], carHere = liveCars.filter(c => c.x === x && c.y === y);
              let ro = null;
              if (showReach && reachInfo && cell.t === "blank") {
                const hf = !!reachInfo.fwd[k], hb = !!reachInfo.bwd[k], iu = reachInfo.usefulSet.has(k);
                if (hf && hb && iu) ro = "rgba(74,223,74,0.15)"; else if (hf && !hb) ro = "rgba(223,74,74,0.2)";
                else if (!hf && hb) ro = "rgba(74,74,223,0.2)"; else ro = "rgba(223,74,74,0.3)";
              }
              return <g key={k} onMouseDown={e => handleDown(e, x, y)} onMouseEnter={() => handleEnter(x, y)} onContextMenu={e => e.preventDefault()} style={{ cursor: "pointer" }}>
                <rect x={sx} y={sy} width={CL} height={CL} fill={cell.t === "blank" ? cB : cell.t === "goal" ? "#142014" : cell.t === "platform" ? "#17201d" : cell.t === "tunnel" ? "#1a1428" : cell.t === "trigger" ? "#1a1a14" : cell.t === "barrier" ? "#1e1418" : cell.t === "tsw_trigger" ? "#141a22" : cell.t === "tswitch" ? "#181426" : cell.t === "autoswitch" ? "#201a10" : c0}
                  stroke={cell.t === "blank" ? "#4a3e28" : cell.t === "platform" ? "#4a8a78" : cell.t === "tunnel" ? cell.color + "88" : cell.t === "trigger" ? cell.color + "66" : cell.t === "barrier" ? cell.color + "66" : cell.t === "tsw_trigger" ? cell.color + "66" : cell.t === "tswitch" ? cell.color + "88" : cell.t === "autoswitch" ? "#d4a256aa" : bd} strokeWidth={cell.t === "platform" || cell.t === "tunnel" || cell.t === "trigger" || cell.t === "barrier" || cell.t === "tsw_trigger" || cell.t === "tswitch" || cell.t === "autoswitch" ? 1.5 : 0.8} strokeDasharray={cell.t === "blank" ? "3,2" : "none"} rx={1} />
                {ro && <rect x={sx} y={sy} width={CL} height={CL} fill={ro} rx={1} />}
                {cell.t === "fixed" && <g transform={`translate(${sx},${sy})`}><TrackSVG type={cell.track} size={CL} color={trk_} width={3} /></g>}
                {cell.t === "car" && <g transform={`translate(${sx},${sy})`}>
                  <TrackSVG type={cell.track} size={CL} color="#6a5a3a" width={2} />
                  {!isLive && <><rect x={CL / 2 - 11} y={CL / 2 - 9} width={22} height={18} rx={3} fill={carColor(cell)} stroke={isZeroCarCell(cell) ? "#fff" : "#000"} strokeWidth={isZeroCarCell(cell) ? 1 : 0.5} />
                    <text x={CL / 2} y={CL / 2} textAnchor="middle" dominantBaseline="middle" fill="#fff" fontSize={11} fontWeight={700} fontFamily="monospace">{carLabel(cell)}</text>
                    <text x={CL / 2} y={CL / 2 + 13} textAnchor="middle" fill="rgba(255,255,255,0.45)" fontSize={9}>{DA[cell.facing]}</text></>}</g>}
                {cell.t === "goal" && <g transform={`translate(${sx},${sy})`}>
                  <rect x={8} y={8} width={CL - 16} height={CL - 16} rx={4} fill="#1a3a1a" stroke="#4a8a4a" strokeWidth={1.5} />
                  <text x={CL / 2} y={CL / 2 + 1} textAnchor="middle" dominantBaseline="middle" fill="#6ade6a" fontSize={14} fontWeight={700}>G</text>
                  <text x={CL / 2 + (cell.entry === "E" ? 17 : cell.entry === "W" ? -17 : 0)} y={CL / 2 + (cell.entry === "S" ? 17 : cell.entry === "N" ? -17 : 0)}
                    textAnchor="middle" dominantBaseline="middle" fill="#7de87d" fontSize={12} fontWeight={800}>{DA[OPPOSITE[cell.entry]]}</text></g>}
                {cell.t === "platform" && <g transform={`translate(${sx},${sy})`}>
                  <rect x={10} y={11} width={CL - 20} height={CL - 18} rx={3} fill="#20362f" stroke="#54b895" strokeWidth={1.4} />
                  <path d={`M${CL / 2},${CL / 2} L${CL / 2 + (cell.dir === "E" ? 14 : cell.dir === "W" ? -14 : 0)},${CL / 2 + (cell.dir === "S" ? 14 : cell.dir === "N" ? -14 : 0)}`} stroke="#7ee0bd" strokeWidth={2.2} strokeLinecap="round" />
                  <text x={CL / 2} y={CL / 2 - 2} textAnchor="middle" dominantBaseline="middle" fill="#d7fff2" fontSize={10} fontWeight={800}>P{cell.car}</text>
                  <text x={CL / 2 + (cell.dir === "E" ? 18 : cell.dir === "W" ? -18 : 0)} y={CL / 2 + (cell.dir === "S" ? 18 : cell.dir === "N" ? -18 : 0)}
                    textAnchor="middle" dominantBaseline="middle" fill="#7ee0bd" fontSize={11}>{DA[cell.dir]}</text>
                </g>}
                {placed && cell.t === "blank" && <g transform={`translate(${sx},${sy})`}><TrackSVG type={placed} size={CL} color={sTrk} width={3} /></g>}
                {cell.t === "tunnel" && <g transform={`translate(${sx},${sy})`}>
                  <circle cx={CL / 2} cy={CL / 2} r={CL * 0.32} fill="none" stroke={cell.color} strokeWidth={2.5} opacity={0.85} />
                  <circle cx={CL / 2} cy={CL / 2} r={CL * 0.18} fill={cell.color} opacity={0.3} />
                  <text x={CL / 2 + (cell.facing === "E" ? 14 : cell.facing === "W" ? -14 : 0)} y={CL / 2 + (cell.facing === "S" ? 14 : cell.facing === "N" ? -14 : 0)}
                    textAnchor="middle" dominantBaseline="middle" fill={cell.color} fontSize={12} fontWeight={800}>{DA[OPPOSITE[cell.facing]]}</text>
                </g>}
                {cell.t === "trigger" && <g transform={`translate(${sx},${sy})`}>
                  <TrackSVG type={cell.track} size={CL} color={trk_} width={3} />
                  <polygon points={`${CL / 2},${CL / 2 - 8} ${CL / 2 + 7},${CL / 2 + 5} ${CL / 2 - 7},${CL / 2 + 5}`} fill={cell.color} opacity={0.9} stroke="#000" strokeWidth={0.5} />
                  <text x={CL / 2} y={CL / 2 + 1} textAnchor="middle" dominantBaseline="middle" fill="#fff" fontSize={8} fontWeight={700}>T</text>
                </g>}
                {cell.t === "tsw_trigger" && <g transform={`translate(${sx},${sy})`}>
                  <TrackSVG type={cell.track} size={CL} color={trk_} width={3} />
                  <polygon points={`${CL / 2},${CL / 2 - 9} ${CL / 2 + 9},${CL / 2} ${CL / 2},${CL / 2 + 9} ${CL / 2 - 9},${CL / 2}`} fill={cell.color} opacity={0.9} stroke="#000" strokeWidth={0.5} />
                  <text x={CL / 2} y={CL / 2 + 1} textAnchor="middle" dominantBaseline="middle" fill="#fff" fontSize={8} fontWeight={700}>SW</text>
                </g>}
                {cell.t === "tswitch" && <g transform={`translate(${sx},${sy})`}>
                  <TrackSVG type={cell.track} size={CL} color={cell.color} width={3.2} />
                  <circle cx={CL / 2} cy={CL / 2} r={CL * 0.36} fill="none" stroke={cell.color} strokeWidth={1.5} strokeDasharray="4,3" opacity={0.75} />
                  <text x={CL / 2} y={CL - 7} textAnchor="middle" fill={cell.color} fontSize={8} fontWeight={700}>TS</text>
                </g>}
                {cell.t === "autoswitch" && <g transform={`translate(${sx},${sy})`}>
                  <TrackSVG type={cell.track} size={CL} color={hi} width={3.2} />
                  <circle cx={CL / 2} cy={CL / 2} r={CL * 0.35} fill="none" stroke={hi} strokeWidth={1.4} strokeDasharray="2,3" opacity={0.8} />
                  <path d={`M${CL / 2 - 8},${CL - 9} Q${CL / 2},${CL - 15} ${CL / 2 + 8},${CL - 9}`} stroke={hi} strokeWidth={1.5} fill="none" strokeLinecap="round" />
                  <text x={CL / 2} y={CL - 7} textAnchor="middle" fill={hi} fontSize={8} fontWeight={700}>A</text>
                </g>}
                {cell.t === "barrier" && <g transform={`translate(${sx},${sy})`}>
                  <TrackSVG type={cell.track} size={CL} color={trk_} width={3} />
                  {cell.initialState === "closed" ? <>
                    <rect x={CL / 2 - 12} y={CL / 2 - 8} width={24} height={16} rx={2} fill={cell.color} opacity={0.25} />
                    <line x1={CL / 2 - 10} y1={CL / 2 - 3} x2={CL / 2 + 10} y2={CL / 2 - 3} stroke={cell.color} strokeWidth={2.5} strokeLinecap="round" />
                    <line x1={CL / 2 - 10} y1={CL / 2 + 3} x2={CL / 2 + 10} y2={CL / 2 + 3} stroke={cell.color} strokeWidth={2.5} strokeLinecap="round" />
                  </> : <>
                    <line x1={CL / 2 - 10} y1={CL / 2 - 3} x2={CL / 2 + 10} y2={CL / 2 - 3} stroke={cell.color} strokeWidth={1.5} strokeLinecap="round" strokeDasharray="3,3" opacity={0.5} />
                    <line x1={CL / 2 - 10} y1={CL / 2 + 3} x2={CL / 2 + 10} y2={CL / 2 + 3} stroke={cell.color} strokeWidth={1.5} strokeLinecap="round" strokeDasharray="3,3" opacity={0.5} />
                  </>}
                </g>}
                {carHere.map(c => <g key={c.name} transform={`translate(${sx},${sy})`}>
                  {c.wait > 0 && <circle cx={CL / 2} cy={CL / 2} r={16} fill="none" stroke="#7ee0bd" strokeWidth={2} strokeDasharray="3,2" />}
                  <circle cx={CL / 2} cy={CL / 2} r={11} fill={carColor(c)} stroke="#fff" strokeWidth={isZeroCarCell(c) ? 2 : 1.5} />
                  <text x={CL / 2} y={CL / 2 + 1} textAnchor="middle" dominantBaseline="middle" fill="#fff" fontSize={12} fontWeight={800} fontFamily="monospace">{carLabel(c)}</text></g>)}
                {cell.t !== "empty" && <text x={sx + 2} y={sy + 9} fill={dm2} fontSize={7} fontFamily="monospace">{x},{y}</text>}
                {showReach && reachInfo && cell.t === "blank" && !reachInfo.usefulSet.has(k) &&
                  <line x1={sx + 4} y1={sy + 4} x2={sx + CL - 4} y2={sy + CL - 4} stroke="rgba(223,74,74,0.5)" strokeWidth={1.5} />}
              </g>;
            }))}
            {dirPick && (() => {
              const pickerSize = 98, buttonSize = 32;
              const boardWidth = W * CL + 2, boardHeight = H * CL + 2;
              const targetCenterX = dirPick.x * CL + CL / 2 + 1;
              const targetCenterY = dirPick.y * CL + CL / 2 + 1;
              const sx = Math.min(Math.max(targetCenterX - pickerSize / 2, 2), boardWidth - pickerSize - 2);
              const sy = Math.min(Math.max(targetCenterY - pickerSize / 2, 2), boardHeight - pickerSize - 2);
              const opts = [
                { d: "N", x: 33, y: 4 },
                { d: "W", x: 4, y: 33 },
                { d: "E", x: 62, y: 33 },
                { d: "S", x: 33, y: 62 },
              ];
              const centerLabel = dirPick.tool === "car" ? "方向" : dirPick.tool === "platform" ? "道路" : "入口";
              return <g transform={`translate(${sx},${sy})`}>
                <rect x={0} y={0} width={pickerSize} height={pickerSize} rx={8} fill="rgba(18,16,14,0.97)" stroke={hi} strokeWidth={1.6} />
                <circle cx={pickerSize / 2} cy={pickerSize / 2} r={13} fill="#17140f" stroke={bd} strokeWidth={1} />
                <text x={pickerSize / 2} y={pickerSize / 2 + 1} textAnchor="middle" dominantBaseline="middle" fill={dm} fontSize={9}>{centerLabel}</text>
                {opts.map(o => <g key={o.d} onMouseDown={e => { e.stopPropagation(); applyPickedDirection(o.d); }} style={{ cursor: "pointer" }}>
                  <rect x={o.x} y={o.y} width={buttonSize} height={buttonSize} rx={6} fill="#2a2317" stroke={hi} strokeWidth={1.2} />
                  <text x={o.x + buttonSize / 2} y={o.y + buttonSize / 2 + 1} textAnchor="middle" dominantBaseline="middle" fill={hi} fontSize={20} fontWeight={800}>{DA[directionGlyphDirection(dirPick.tool, o.d)]}</text>
                </g>)}
              </g>;
            })()}
          </svg>
        </div>
        <div style={{ width: 210, flexShrink: 0, display: "flex", flexDirection: "column", gap: 7 }}>
          <Bx t="参数">
            <div style={{ fontSize: 10, color: dm, marginBottom: 3 }}>最大步数</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 2 }}>{[50, 100, 150, 200, 300].map(v => <button key={v} onClick={() => updateMaxSteps(v)} style={{ padding: "3px 0", background: maxSt === v ? "#2e2818" : pnl, border: `1px solid ${maxSt === v ? hi : bd}`, borderRadius: 3, color: maxSt === v ? hi : tx, cursor: "pointer", fontSize: 11, fontFamily: "inherit" }}>{v}</button>)}</div>
            <input type="number" min={1} value={maxSt} onChange={e => updateMaxSteps(Math.max(1, parseInt(e.target.value, 10) || 1))} style={{ width: "100%", boxSizing: "border-box", marginTop: 5, background: pnl, border: `1px solid ${bd}`, borderRadius: 3, color: tx, padding: "4px 6px", fontSize: 11, fontFamily: "inherit" }} />
            <div style={{ fontSize: 10, color: hi, marginTop: 8, marginBottom: 2 }}>零号前瞻</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}><Stp v={zeroSafetySt} s={updateZeroSafetySteps} mn={0} mx={20} /><span style={{ fontSize: 9, color: dm2 }}>{zeroSafetySt}步</span></div>
            <div style={{ fontSize: 10, color: hi, marginTop: 8, marginBottom: 2 }}>轨道上限</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}><Stp v={maxTrk} s={updateMaxTracks} mn={0} mx={999} /><button onClick={() => updateMaxTracks(Math.min(999, maxTrk + 10))} style={{ background: "#1e1a14", border: `1px solid ${bd}`, color: tx, borderRadius: 3, padding: "2px 7px", cursor: "pointer", fontSize: 11, fontFamily: "inherit" }}>+10</button><span style={{ fontSize: 9, color: dm2 }}>{maxTrk === 0 ? "无限制" : `≤${maxTrk}轨`}</span></div>
          </Bx>
          <button onClick={doSolve} style={{ width: "100%", padding: "7px", background: "#2a2010", border: `1px solid ${hi}`, color: hi, borderRadius: 4, cursor: "pointer", fontSize: 13, fontWeight: 700, fontFamily: "inherit", letterSpacing: 1 }}>▶ 求解</button>
          <div style={{ display: "flex", gap: 4 }}>
            <button onClick={doSim} style={{ flex: 1, padding: "5px", background: "#1a2a1a", border: "1px solid #4a6a4a", color: "#8aba8a", borderRadius: 4, cursor: "pointer", fontSize: 11, fontFamily: "inherit" }}>⏵ 模拟</button>
            <button onClick={doReach} style={{ flex: 1, padding: "5px", background: "#1a1a2a", border: "1px solid #4a4a8a", color: "#8a8ade", borderRadius: 4, cursor: "pointer", fontSize: 11, fontFamily: "inherit" }}>◎ 可达性</button>
          </div>
          {msg && <div style={{ padding: "5px 7px", background: pnl, borderRadius: 3, fontSize: 11, color: msg[0] === "✓" ? ok : msg[0] === "✕" ? fl : msg.startsWith("可达") ? "#8a8ade" : hi, lineHeight: 1.5 }}>{msg}</div>}
          {reachInfo && <Bx t="可达性"><div style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 10 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer" }}><input type="checkbox" checked={showReach} onChange={e => setShowReach(e.target.checked)} style={{ accentColor: "#8a8ade" }} />叠加层</label>
            <div style={{ display: "flex", gap: 8 }}><span><span style={{ color: "#4adf4a" }}>■</span> 有效</span><span><span style={{ color: "#df4a4a" }}>■</span> 仅前向</span><span><span style={{ color: "#4a4adf" }}>■</span> 仅后向</span></div>
          </div></Bx>}
          {sol?.result?.history && <Bx t="回放">
            <div style={{ display: "flex", gap: 3, justifyContent: "center" }}>
              {[["⏮", () => { setStep(0); setPlaying(false) }], ["◀", () => setStep(v => Math.max(0, v - 1))], [playing ? "⏸" : "▶", () => setPlaying(p => !p)], ["▶▸", () => setStep(v => Math.min(maxStep, v + 1))], ["⏭", () => { setStep(maxStep); setPlaying(false) }]].map(([ic, fn], i) =>
                <button key={i} onClick={fn} style={{ background: pnl, border: `1px solid ${bd}`, color: i === 2 ? (playing ? fl : ok) : tx, borderRadius: 3, padding: "3px 7px", cursor: "pointer", fontSize: 12, fontFamily: "inherit" }}>{ic}</button>)}
            </div>
            <div style={{ fontSize: 10, color: dm, marginTop: 3, textAlign: "center" }}>步 {step}/{maxStep}{sol.result.arrived.length > 0 && <span style={{ color: ok }}> 已到: {sol.result.arrived.join(",")}</span>}</div>
          </Bx>}
          <div style={{ fontSize: 9, color: dm2, lineHeight: 1.5 }}>v4: 基础轨道枚举 · T-track仅CSP合并 · 前向检查 · 路径去重</div>
        </div>
      </div>
    </div>
    {libraryDialog && <PuzzleLibraryDialog
      mode={libraryDialog.mode}
      puzzle={libraryDialog.puzzle}
      onClose={() => setLibraryDialog(null)}
      onLoad={loadPuzzleIntoEditor}
      onMessage={setMsg}
    />}
  </div>);
}

function Bx({ t, children }) { return <div style={{ background: "#17140f", border: "1px solid #2a2520", borderRadius: 4, padding: "6px 8px" }}>{t && <div style={{ fontSize: 9, color: "#5a5040", textTransform: "uppercase", letterSpacing: 1, marginBottom: 5 }}>{t}</div>}{children}</div>; }
function Btn({ o, children }) { return <button onClick={o} style={{ background: "#1e1a14", border: "1px solid #2a2520", color: "#a09888", borderRadius: 3, padding: "2px 8px", cursor: "pointer", fontSize: 11, fontFamily: "inherit" }}>{children}</button>; }
function Stp({ v, s, mn = 1, mx = 99 }) {
  return <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
    <button onClick={() => s(Math.max(mn, v - 1))} style={{ background: "#1e1a14", border: "1px solid #2a2520", color: "#a09888", borderRadius: 2, padding: "1px 6px", cursor: "pointer", fontSize: 13, fontFamily: "inherit", lineHeight: 1 }}>−</button>
    <span style={{ minWidth: 18, textAlign: "center", fontSize: 13 }}>{v}</span>
    <button onClick={() => s(Math.min(mx, v + 1))} style={{ background: "#1e1a14", border: "1px solid #2a2520", color: "#a09888", borderRadius: 2, padding: "1px 6px", cursor: "pointer", fontSize: 13, fontFamily: "inherit", lineHeight: 1 }}>+</button></div>;
}
