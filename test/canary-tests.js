/* 搜索健全性金丝雀（solver soundness canaries）
 *
 * 每条金丝雀是一对"已证事实"：
 *   solved    —— 在已证最小轨道数的预算下，必须找到恰好该成本的合法解；
 *   exhausted —— 在最小值减一的预算下，搜索必须"完备走完"且无候选
 *                （complete:true + terminationReason:search-exhausted；预算中断不算）。
 *
 * 用途：任何剪枝/搜索改动后运行。若 solved 变 exhausted → 新剪枝切掉了合法解
 * （不健全）；若 exhausted 变 solved → 规则被放宽或碰撞判定失效。
 * 全部用例均为亚秒级，随 npm test 每次运行。
 *
 * 最小值证据（2026-07-22，单 Worker、seed 0 完备搜索）：
 *   4×8 (6-3A)  = 9   —— 游戏上限 9，恰好命中
 *   5×5 (7-6A)  = 11  —— 游戏上限 11，恰好命中
 *   7×5 (7-4A)  = 8
 *   autoswitch 6×4 = 9
 *   swap 3×3    = 无解（对穿回归夹具）
 * 方法论见 docs/solver-optimization.md。
 */
import path from "node:path";
import process from "node:process";
import { Worker } from "node:worker_threads";
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import { normalizePuzzle } from "../puzzle-io.js";
import { simulate } from "../railbound-rules.js";

const TEST_DIR = fileURLToPath(new URL("./", import.meta.url));
const WORKER_URL = pathToFileURL(path.join(TEST_DIR, "solver-worker-node.js"));
const CASE_TIMEOUT_MS = 15_000;

const CANARIES = [
  { file: "测试/关卡-4x8-20260722-6-3A.json", budget: 9, expect: "solved" },
  { file: "测试/关卡-4x8-20260722-6-3A.json", budget: 8, expect: "exhausted" },
  { file: "测试/关卡-5x5-20260722-7-6A.json", budget: 11, expect: "solved" },
  { file: "测试/关卡-5x5-20260722-7-6A.json", budget: 10, expect: "exhausted" },
  { file: "测试/关卡-7x5-20260722-7-4A.json", budget: 8, expect: "solved" },
  { file: "测试/关卡-7x5-20260722-7-4A.json", budget: 7, expect: "exhausted" },
  { file: "scratch_test_autoswitch_6x4.json", budget: 9, expect: "solved" },
  { file: "scratch_test_autoswitch_6x4.json", budget: 8, expect: "exhausted" },
  { file: "scratch_test_swap_3x3.json", budget: 0, expect: "exhausted" },
  { file: "scratch_test_rearend_4x2.json", budget: 0, expect: "exhausted" },
];

function loadPuzzle(relativePath) {
  const raw = JSON.parse(fs.readFileSync(path.join(TEST_DIR, relativePath), "utf8"));
  const source = raw?.puzzle && typeof raw.puzzle === "object" ? raw.puzzle : raw;
  return normalizePuzzle(source);
}

function runCase(puzzle, budget, solverOptions = undefined) {
  return new Promise(resolve => {
    const started = performance.now();
    const worker = new Worker(WORKER_URL, { type: "module" });
    let best = null;
    let dfsInfo = null;
    let cspStats = null;
    let dfsStats = null;
    let cspMs = null;
    let p12SeedMs = null;
    let dfsMs = null;
    let firstCandidateMs = null;
    let finalCost = null;
    let complete = false;
    let terminationReason = null;
    let phase = null;
    const candidateFailures = [];
    let settled = false;
    const finish = outcome => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve({
        ...outcome,
        best,
        dfsInfo,
        cspStats,
        dfsStats,
        cspMs,
        p12SeedMs,
        dfsMs,
        firstCandidateMs,
        finalCost,
        complete,
        terminationReason,
        phase,
        candidateFailures,
      });
    };
    const timer = setTimeout(() => {
      complete = false;
      terminationReason = "wall-clock-timeout";
      const elapsedMs = performance.now() - started;
      if (phase === "csp") {
        cspMs = Math.max(Number.isFinite(cspMs) ? cspMs : 0, elapsedMs);
        p12SeedMs = 0;
        dfsMs = 0;
      } else if (phase === "p12-seed") {
        if (!Number.isFinite(cspMs)) cspMs = 0;
        p12SeedMs = Math.max(Number.isFinite(p12SeedMs) ? p12SeedMs : 0, elapsedMs - cspMs);
        dfsMs = 0;
      } else if (phase === "dfs") {
        if (!Number.isFinite(cspMs)) cspMs = 0;
        if (!Number.isFinite(p12SeedMs)) p12SeedMs = 0;
        dfsMs = Math.max(
          Number.isFinite(dfsMs) ? dfsMs : 0,
          Math.max(0, elapsedMs - cspMs - p12SeedMs),
        );
      } else {
        if (!Number.isFinite(cspMs)) cspMs = 0;
        if (!Number.isFinite(p12SeedMs)) p12SeedMs = 0;
        if (!Number.isFinite(dfsMs)) dfsMs = 0;
      }
      finish({ status: "timeout" });
    }, CASE_TIMEOUT_MS);
    worker.on("message", message => {
      if (Number.isFinite(message.cspMs)) cspMs = message.cspMs;
      if (Number.isFinite(message.p12SeedMs)) p12SeedMs = message.p12SeedMs;
      if (Number.isFinite(message.dfsMs)) dfsMs = message.dfsMs;
      if (message.cspStats) cspStats = { ...(cspStats || {}), ...message.cspStats };
      if (message.dfsStats) dfsStats = { ...(dfsStats || {}), ...message.dfsStats };
      if (typeof message.complete === "boolean") complete = message.complete;
      if (typeof message.terminationReason === "string" && message.terminationReason) terminationReason = message.terminationReason;
      if (typeof message.phase === "string" && message.phase) phase = message.phase;
      if (message.type === "progress") {
        if (message.dfsInfo) dfsInfo = message.dfsInfo;
        return;
      }
      if (message.type === "solution" && message.solution) {
        const cost = message.solution.__cost;
        if (budget > 0 && cost > budget) return;
        const placed = Object.fromEntries(Object.entries(message.solution).filter(([key]) => key !== "__cost"));
        const result = simulate(puzzle, placed);
        if (!result.ok) {
          candidateFailures.push({ cost, reason: result.reason, detail: result.detail });
          return;
        }
        if (firstCandidateMs == null) {
          firstCandidateMs = Number.isFinite(message.candidateMs)
            ? message.candidateMs
            : Math.round(performance.now() - started);
        }
        if (!best || cost < best.cost) {
          best = { cost, steps: result.steps, simulateOk: true, source: message.source, requestId: message.requestId };
          finalCost = cost;
        }
        return;
      }
      if (message.type === "done") finish({ status: "done" });
    });
    worker.on("error", error => finish({ status: "error", error: error.message }));
    worker.postMessage({
      type: "solve",
      requestId: "canary",
      puzzle: { ...puzzle, _minTracks: true },
      seed: 0,
      maxTracksHint: budget,
      ...(solverOptions ? { solverOptions } : {}),
    });
  });
}

function judge(canary, outcome) {
  if (outcome.status === "error") return `Worker 错误：${outcome.error}`;
  if (outcome.status === "timeout") return `超时（金丝雀必须亚秒级完成，当前搜索退化）`;
  if (outcome.candidateFailures.length) {
    return `${outcome.candidateFailures.length} 个候选被权威 simulate() 拒绝`;
  }
  if (canary.expect === "solved") {
    if (!outcome.best) return "未找到合法解（剪枝切掉了已证存在的最小解 —— 不健全）";
    if (outcome.best.simulateOk !== true) return "候选未经权威 simulate() 验证";
    if (outcome.best.cost !== canary.budget) return `成本 ${outcome.best.cost} ≠ 已证最小 ${canary.budget}`;
    if (outcome.complete !== true || outcome.terminationReason !== "optimal-proven") {
      return `最小解未完成证明（complete=${outcome.complete === true}, terminationReason=${outcome.terminationReason || "missing"}）`;
    }
    return null;
  }
  /* expect === "exhausted" */
  if (outcome.best) return `预算内出现合法解（成本 ${outcome.best.cost}）——规则被放宽或碰撞判定失效`;
  if (outcome.complete !== true) return "complete 不为 true，不能作为完备无解声明";
  if (outcome.terminationReason !== "search-exhausted") {
    return `terminationReason=${outcome.terminationReason || "missing"}，不是完备 search-exhausted`;
  }
  return null;
}

function describeMetrics(outcome) {
  const nodes = outcome.dfsStats?.nodes ?? outcome.dfsInfo?.iterations ?? "-";
  const deepest = outcome.dfsStats?.deepestStep
    ?? outcome.dfsStats?.deepest?.step
    ?? outcome.dfsStats?.deepest
    ?? outcome.dfsInfo?.deepest?.step
    ?? "-";
  return [
    `nodes=${nodes}`,
    `cspMs=${outcome.cspMs ?? "-"}`,
    `p12SeedMs=${outcome.p12SeedMs ?? "-"}`,
    `dfsMs=${outcome.dfsMs ?? "-"}`,
    `cspPaths=${outcome.cspStats?.pathsEnumerated ?? "-"}`,
    `cspCombinations=${outcome.cspStats?.combinationIterations ?? "-"}`,
    `cspOverflow=${outcome.cspStats?.overflow ?? "-"}`,
    `cspAbort=${outcome.cspStats?.aborted ? outcome.cspStats.abortReason : "no"}`,
    `p12Seed=${outcome.cspStats?.p12Seed?.terminationReason ?? "-"}`,
    `deepest=${deepest}`,
    `firstCandidateMs=${outcome.firstCandidateMs ?? "-"}`,
    `finalCost=${outcome.finalCost ?? "-"}`,
    `complete=${outcome.complete === true}`,
    `terminationReason=${outcome.terminationReason || "missing"}`,
    `phase=${outcome.phase || "-"}`,
  ].join(" · ");
}

function judgeForcedTimebox(outcome, expectedAbortReason) {
  if (outcome.status === "error") return `Worker 错误：${outcome.error}`;
  if (outcome.status === "timeout") return "forced timebox fallback 超时";
  if (outcome.cspStats?.aborted !== true) return "极低 CSP 预算未触发 abort";
  if (outcome.cspStats?.abortReason !== expectedAbortReason) {
    return `CSP abortReason=${outcome.cspStats?.abortReason || "missing"}，预期 ${expectedAbortReason}`;
  }
  if (!(outcome.dfsStats?.nodes > 0)) return "CSP abort 后 DFS 未接管搜索";
  if (!outcome.best?.simulateOk || outcome.best.cost !== 9) return "DFS fallback 未返回经 simulate() 验证的 9 轨解";
  if (outcome.complete !== true || outcome.terminationReason !== "optimal-proven") {
    return `DFS fallback 未证明最优（complete=${outcome.complete === true}, terminationReason=${outcome.terminationReason || "missing"}）`;
  }
  return null;
}

function judgeP12SeedCandidate(outcome) {
  if (outcome.status === "error") return `Worker 错误：${outcome.error}`;
  if (outcome.status === "timeout") return "P12 seed candidate protocol 超时";
  if (outcome.candidateFailures.length) return "P12 seed 发出了被权威 simulate() 拒绝的候选";
  if (!outcome.best?.simulateOk || outcome.best.cost !== 37) return "P12 seed 未返回经 simulate() 验证的 37 轨候选";
  if (outcome.best.source !== "p12-pattern-seed" || outcome.best.requestId !== "canary") {
    return "P12 seed 候选来源或 requestId 不匹配";
  }
  if (outcome.cspStats?.p12Seed?.simulateCalls !== 1 || outcome.cspStats?.p12Seed?.candidateFound !== true) {
    return "P12 seed 内部 simulate() 门禁或候选统计缺失";
  }
  if (outcome.complete !== false || outcome.terminationReason !== "candidate-unproven-dfs-budget") {
    return `启发式候选被误报为完备（complete=${outcome.complete === true}, terminationReason=${outcome.terminationReason || "missing"}）`;
  }
  return null;
}

function judgeP12SeedDisabledFallback(outcome) {
  if (outcome.status === "error") return `Worker 错误：${outcome.error}`;
  if (outcome.status === "timeout") return "P12 seed disabled fallback 超时";
  if (outcome.best) return "P12 seed 关闭时仍出现结构化候选";
  if (outcome.cspStats?.p12Seed?.skipReason !== "disabled") return "P12 seed 关闭状态未进入可观测统计";
  if (!(outcome.dfsStats?.nodes > 0)) return "P12 seed 关闭后 DFS 未接管";
  if (outcome.complete !== false || outcome.terminationReason !== "dfs-iteration-budget") {
    return `DFS 预算中断语义错误（complete=${outcome.complete === true}, terminationReason=${outcome.terminationReason || "missing"}）`;
  }
  return null;
}

function judgeP12SeedOverBudgetFallback(outcome) {
  if (outcome.status === "error") return `Worker 错误：${outcome.error}`;
  if (outcome.status === "timeout") return "P12 seed over-budget fallback 超时";
  if (outcome.best || outcome.candidateFailures.length) return "超预算 P12 seed 布局不应发出 solution";
  const p12Seed = outcome.cspStats?.p12Seed;
  if (p12Seed?.generatedCost !== 37 || p12Seed?.terminationReason !== "candidate-over-budget") {
    return "P12 seed 未在 Worker 内按 37>36 拒绝候选";
  }
  if (p12Seed.simulateCalls !== 0 || p12Seed.candidateFound !== false) return "超预算布局不应进入 simulate()/候选通道";
  if (!(outcome.dfsStats?.nodes > 0)) return "P12 seed 超预算后 DFS 未接管";
  if (outcome.complete !== false || outcome.terminationReason !== "dfs-iteration-budget") {
    return `P12 seed 本地失败污染了顶层语义（complete=${outcome.complete === true}, terminationReason=${outcome.terminationReason || "missing"}）`;
  }
  return null;
}

function judgeP12SeedNotApplicableFallback(outcome) {
  if (outcome.status === "error") return `Worker 错误：${outcome.error}`;
  if (outcome.status === "timeout") return "P12 seed not-applicable fallback 超时";
  if (outcome.best || outcome.candidateFailures.length) return "不匹配模板的题不应出现 P12 seed 候选";
  const p12Seed = outcome.cspStats?.p12Seed;
  if (p12Seed?.attempted !== true || p12Seed?.applicable !== false || p12Seed?.terminationReason !== "template-not-applicable") {
    return "P12 seed 不适用状态统计错误";
  }
  if (p12Seed.simulateCalls !== 0 || !(outcome.dfsStats?.nodes > 0)) return "P12 seed 不适用后未直接进入 DFS";
  if (outcome.complete !== false || outcome.terminationReason !== "dfs-iteration-budget") {
    return "P12 seed 不适用原因污染了顶层完备性语义";
  }
  return null;
}

function judgeP12SeedWorkBudgetFallback(outcome) {
  if (outcome.status === "error") return `Worker 错误：${outcome.error}`;
  if (outcome.status === "timeout") return "P12 seed work-budget fallback 超时";
  if (outcome.best || outcome.candidateFailures.length) return "P12 seed 工作预算中止后不应发出候选";
  const p12Seed = outcome.cspStats?.p12Seed;
  if (p12Seed?.truncated !== true || p12Seed?.terminationReason !== "p12-seed-work-budget") return "P12 seed 工作预算中止统计错误";
  if (p12Seed.simulateCalls !== 0 || !(outcome.dfsStats?.nodes > 0)) return "P12 seed 工作预算中止后 DFS 未接管";
  if (outcome.complete !== false || outcome.terminationReason !== "dfs-iteration-budget") {
    return "P12 seed 工作预算原因污染了顶层完备性语义";
  }
  return null;
}

console.log(`\nSolver canaries: ${CANARIES.length}\n`);
let failed = 0;
for (const canary of CANARIES) {
  const puzzle = loadPuzzle(canary.file);
  const started = performance.now();
  const outcome = await runCase(puzzle, canary.budget);
  const elapsed = Math.round(performance.now() - started);
  const problem = judge(canary, outcome);
  const label = `${canary.file} · budget=${canary.budget || "∞"} · expect=${canary.expect}`;
  if (problem) {
    failed += 1;
    console.error(`  ✗ ${label} · ${problem} · ${describeMetrics(outcome)} · ${elapsed}ms`);
  } else {
    console.log(`  ✓ ${label} · ${describeMetrics(outcome)} · ${elapsed}ms`);
  }
}
console.log(`\n═══════════ Canaries: ${CANARIES.length - failed} passed, ${failed} failed ═══════════\n`);

/* These are protocol checks, deliberately not extra soundness canaries. They
   force P1 to abandon CSP at both budget checkpoints and prove DFS takes over. */
console.log("Forced timebox fallback protocols: 2\n");
const forcedPuzzle = loadPuzzle("测试/关卡-4x8-20260722-6-3A.json");
const forcedCases = [
  { label: "maxPaths=1", cspTimebox: { enabled: true, maxPaths: 1 }, abortReason: "csp-path-budget" },
  { label: "maxCombinations=1", cspTimebox: { enabled: true, maxCombinations: 1 }, abortReason: "csp-combination-budget" },
];
let protocolFailed = 0;
for (const forcedCase of forcedCases) {
  const forcedStarted = performance.now();
  const forcedOutcome = await runCase(forcedPuzzle, 9, { cspTimebox: forcedCase.cspTimebox });
  const forcedElapsed = Math.round(performance.now() - forcedStarted);
  const forcedProblem = judgeForcedTimebox(forcedOutcome, forcedCase.abortReason);
  if (forcedProblem) {
    protocolFailed += 1;
    console.error(`  ✗ 4×8 ${forcedCase.label} · ${forcedProblem} · ${describeMetrics(forcedOutcome)} · ${forcedElapsed}ms`);
  } else {
    console.log(`  ✓ 4×8 ${forcedCase.label} · CSP abort → DFS fallback · ${describeMetrics(forcedOutcome)} · ${forcedElapsed}ms`);
  }
}
console.log(`\n═══════════ Protocol checks: ${forcedCases.length - protocolFailed} passed, ${protocolFailed} failed ═══════════\n`);
failed += protocolFailed;

console.log("P12 bounded pattern seed protocols: 5\n");
const p12SeedPuzzle = loadPuzzle("测试/关卡-10x11-20260722-8-6A.json");
const p12SeedNearNeighbor = loadPuzzle("测试/关卡-8x8-20260722-8-5B.json");
const p12SeedCases = [
  { label: "enabled candidate", options: { p12Seed: { enabled: true }, dfsMaxIterations: 1 }, judge: judgeP12SeedCandidate },
  { label: "disabled fallback", options: { p12Seed: { enabled: false }, dfsMaxIterations: 1 }, judge: judgeP12SeedDisabledFallback },
  { label: "over-budget fallback", options: { p12Seed: { enabled: true }, dfsMaxIterations: 1 }, budget: 36, judge: judgeP12SeedOverBudgetFallback },
  { label: "work-budget fallback", options: { p12Seed: { enabled: true, maxWorkUnits: 1 }, dfsMaxIterations: 1 }, judge: judgeP12SeedWorkBudgetFallback },
  { label: "near-neighbor not-applicable", puzzle: p12SeedNearNeighbor, options: { p12Seed: { enabled: true }, dfsMaxIterations: 1 }, judge: judgeP12SeedNotApplicableFallback },
];
let p12SeedProtocolFailed = 0;
for (const p12SeedCase of p12SeedCases) {
  const p12SeedStarted = performance.now();
  const p12SeedOutcome = await runCase(p12SeedCase.puzzle || p12SeedPuzzle, p12SeedCase.budget || 37, p12SeedCase.options);
  const p12SeedElapsed = Math.round(performance.now() - p12SeedStarted);
  const p12SeedProblem = p12SeedCase.judge(p12SeedOutcome);
  const p12SeedLabel = p12SeedCase.puzzle ? "8×8" : "10×11";
  if (p12SeedProblem) {
    p12SeedProtocolFailed += 1;
    console.error(`  ✗ ${p12SeedLabel} ${p12SeedCase.label} · ${p12SeedProblem} · ${describeMetrics(p12SeedOutcome)} · ${p12SeedElapsed}ms`);
  } else {
    console.log(`  ✓ ${p12SeedLabel} ${p12SeedCase.label} · ${describeMetrics(p12SeedOutcome)} · ${p12SeedElapsed}ms`);
  }
}
console.log(`\n═══════════ P12 seed protocols: ${p12SeedCases.length - p12SeedProtocolFailed} passed, ${p12SeedProtocolFailed} failed ═══════════\n`);
failed += p12SeedProtocolFailed;
process.exit(failed ? 1 : 0);
