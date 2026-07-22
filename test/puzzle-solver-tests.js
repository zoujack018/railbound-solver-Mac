import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { Worker } from "node:worker_threads";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizePuzzle } from "../puzzle-io.js";
import { isPuzzleManifestFileName, PUZZLE_TEST_MANIFEST } from "../puzzle-library.js";
import { simulate } from "../railbound-rules.js";

const TEST_DIR = fileURLToPath(new URL("./", import.meta.url));
const WORKER_URL = pathToFileURL(path.join(TEST_DIR, "solver-worker-node.js"));
const defaultTimeoutMs = positiveInteger(process.env.PUZZLE_TIMEOUT_MS, 20_000);
const requestedPattern = process.argv.slice(2).join(" ");

/* 结果分类（测试契约）：
 *   solved           找到 ≤ 上限且通过权威 simulate() 的候选
 *   over-limit       只找到超过轨道上限的合法解 —— 判失败
 *   candidate-failed 候选全部被 simulate() 拒绝 —— 判失败（搜索器与规则不一致）
 *   budget-exhausted 迭代预算耗尽仍无候选 —— 不是无解证明
 *   timeout          Worker 外层墙钟预算耗尽 —— 不是无解证明
 *   incomplete       Worker 未提供完备无解证明 —— 不是无解证明
 *   search-exhausted 搜索空间在预算内走完且无候选 —— 当前算法边界内无解
 * hasSolution=false 的题只有 search-exhausted 算通过；预算耗尽是"不确定"，仍判失败。 */

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalPositiveInteger(value) {
  if (value == null || value === "") return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Expected a positive integer, received: ${value}`);
  return parsed;
}

function buildSolverOptions(env = process.env) {
  const mode = String(env.CSP_TIMEBOX || "").trim().toLowerCase();
  if (mode && mode !== "on" && mode !== "off") {
    throw new Error(`CSP_TIMEBOX must be on or off, received: ${env.CSP_TIMEBOX}`);
  }
  const p8Mode = String(env.P8_BACKBONE || "").trim().toLowerCase();
  if (p8Mode && p8Mode !== "on" && p8Mode !== "off") {
    throw new Error(`P8_BACKBONE must be on or off, received: ${env.P8_BACKBONE}`);
  }

  const maxMs = optionalPositiveInteger(env.CSP_TIMEBOX_MS);
  const maxPaths = optionalPositiveInteger(env.CSP_PATH_BUDGET);
  const maxCombinations = optionalPositiveInteger(env.CSP_COMBINATION_BUDGET);
  const dfsMaxIterations = optionalPositiveInteger(env.DFS_MAX_ITERATIONS);
  const p8MaxMs = optionalPositiveInteger(env.P8_BACKBONE_MS);
  const p8MaxWorkUnits = optionalPositiveInteger(env.P8_BACKBONE_WORK_BUDGET);
  const cspTimebox = {};
  const p8 = {};

  /* No CSP environment variables means "use Worker defaults". `on` makes that
     choice explicit; `off` disables only the new P1 shared timebox and restores
     the pre-P1 CSP baseline (the solver's original internal caps still apply). */
  if (mode === "off") cspTimebox.enabled = false;
  else if (mode === "on") cspTimebox.enabled = true;
  if (maxMs != null) cspTimebox.maxMs = maxMs;
  if (maxPaths != null) cspTimebox.maxPaths = maxPaths;
  if (maxCombinations != null) cspTimebox.maxCombinations = maxCombinations;
  if (p8Mode) p8.enabled = p8Mode === "on";
  if (p8MaxMs != null) p8.maxMs = p8MaxMs;
  if (p8MaxWorkUnits != null) p8.maxWorkUnits = p8MaxWorkUnits;

  const options = {};
  if (Object.keys(cspTimebox).length) options.cspTimebox = cspTimebox;
  if (Object.keys(p8).length) options.p8 = p8;
  if (dfsMaxIterations != null) options.dfsMaxIterations = dfsMaxIterations;
  return options;
}

const solverOptions = buildSolverOptions();

function findJSONFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...findJSONFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith(".json") && !isPuzzleManifestFileName(entry.name)) files.push(fullPath);
  }
  return files.sort((a, b) => a.localeCompare(b, "zh-CN"));
}

function manifestKey(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function loadManifest() {
  const manifestPath = path.join(TEST_DIR, PUZZLE_TEST_MANIFEST);
  const empty = { defaults: { hasSolution: true, maxTracks: null }, byFile: new Map() };
  if (!fs.existsSync(manifestPath)) return empty;
  const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const defaults = { ...empty.defaults, ...(raw?.defaults || {}) };
  const byFile = new Map();
  for (const entry of Array.isArray(raw?.cases) ? raw.cases : []) {
    if (entry?.file) byFile.set(manifestKey(entry.file), entry);
  }
  return { defaults, byFile };
}

function loadCase(filePath, manifest) {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const source = raw?.puzzle && typeof raw.puzzle === "object" ? raw.puzzle : raw;
  const relativeToTest = manifestKey(path.relative(TEST_DIR, filePath));
  const meta = manifest.byFile.get(relativeToTest) || {};
  const fixtureExpected = raw?.expected || {};
  const hasSolution = meta.hasSolution ?? fixtureExpected.hasSolution ?? manifest.defaults.hasSolution;
  const maxTracks = meta.maxTracks ?? manifest.defaults.maxTracks;
  return {
    filePath,
    relativePath: path.relative(path.dirname(TEST_DIR), filePath),
    name: raw?.name || path.basename(filePath, ".json"),
    hasSolution,
    maxTracks: Number.isInteger(maxTracks) && maxTracks > 0 ? maxTracks : null,
    timeoutMs: positiveInteger(meta.timeoutMs, defaultTimeoutMs),
    note: meta.note || "",
    puzzle: normalizePuzzle(source),
  };
}

function cleanSolution(solution) {
  return Object.fromEntries(Object.entries(solution || {}).filter(([key]) => key !== "__cost"));
}

async function solveCase(testCase) {
  const started = performance.now();
  const worker = new Worker(WORKER_URL, { type: "module" });
  const candidateFailures = [];
  const overLimit = [];
  let best = null;
  let firstCandidateMs = null;
  let lastProgress = null;
  let dfsInfo = null;
  let reportedIterations = 0;
  let lastCspInfo = "";
  const telemetry = {
    cspMs: null,
    p8Ms: null,
    dfsMs: null,
    cspStats: null,
    dfsStats: null,
    workerFirstCandidateMs: null,
    workerFinalCost: null,
    complete: false,
    terminationReason: null,
    phase: null,
  };

  const mergeStats = (previous, next) => {
    if (!next || typeof next !== "object") return previous;
    return { ...(previous || {}), ...next };
  };
  const captureTelemetry = message => {
    if (Number.isFinite(message.cspMs)) telemetry.cspMs = message.cspMs;
    if (Number.isFinite(message.p8Ms)) telemetry.p8Ms = message.p8Ms;
    if (Number.isFinite(message.dfsMs)) telemetry.dfsMs = message.dfsMs;
    if (message.cspStats) telemetry.cspStats = mergeStats(telemetry.cspStats, message.cspStats);
    if (message.dfsStats) telemetry.dfsStats = mergeStats(telemetry.dfsStats, message.dfsStats);
    if (Number.isFinite(message.firstCandidateMs)) telemetry.workerFirstCandidateMs = message.firstCandidateMs;
    if (Number.isFinite(message.finalCost)) telemetry.workerFinalCost = message.finalCost;
    if (typeof message.complete === "boolean") telemetry.complete = message.complete;
    if (typeof message.terminationReason === "string" && message.terminationReason) {
      telemetry.terminationReason = message.terminationReason;
    }
    if (typeof message.phase === "string" && message.phase) telemetry.phase = message.phase;
    /* Transitional compatibility is for measurement only. It must never turn
       an old `dfsInfo.exhausted === false` into a completeness claim. */
    if (message.dfsInfo) {
      dfsInfo = mergeStats(dfsInfo, message.dfsInfo);
      telemetry.dfsStats = mergeStats(telemetry.dfsStats, {
        nodes: message.dfsInfo.iterations,
        limit: message.dfsInfo.limit,
        deepestStep: message.dfsInfo.deepest?.step ?? message.dfsInfo.deepest,
        deepest: message.dfsInfo.deepest,
        iterationBudgetHit: message.dfsInfo.exhausted,
        solutions: message.dfsInfo.solutions,
      });
    }
  };

  return await new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      const elapsedMs = performance.now() - started;
      let resolvedCspMs = telemetry.cspMs;
      let resolvedP8Ms = telemetry.p8Ms;
      let resolvedDfsMs = telemetry.dfsMs;
      if (result.terminationReason === "wall-clock-timeout") {
        if (telemetry.phase === "csp") {
          resolvedCspMs = Math.max(Number.isFinite(resolvedCspMs) ? resolvedCspMs : 0, elapsedMs);
          resolvedP8Ms = 0;
          resolvedDfsMs = 0;
        } else if (telemetry.phase === "p8") {
          if (!Number.isFinite(resolvedCspMs)) resolvedCspMs = 0;
          resolvedP8Ms = Math.max(Number.isFinite(resolvedP8Ms) ? resolvedP8Ms : 0, elapsedMs - resolvedCspMs);
          resolvedDfsMs = 0;
        } else if (telemetry.phase === "dfs") {
          if (!Number.isFinite(resolvedCspMs)) resolvedCspMs = 0;
          if (!Number.isFinite(resolvedP8Ms)) resolvedP8Ms = 0;
          resolvedDfsMs = Math.max(
            Number.isFinite(resolvedDfsMs) ? resolvedDfsMs : 0,
            Math.max(0, elapsedMs - resolvedCspMs - resolvedP8Ms),
          );
        } else {
          /* A timeout before the Worker announces a phase still must not emit
             null timings; zero means "no measured phase sample available". */
          if (!Number.isFinite(resolvedCspMs)) resolvedCspMs = 0;
          if (!Number.isFinite(resolvedP8Ms)) resolvedP8Ms = 0;
          if (!Number.isFinite(resolvedDfsMs)) resolvedDfsMs = 0;
        }
      }
      resolve({
        ...telemetry,
        cspMs: resolvedCspMs,
        p8Ms: resolvedP8Ms,
        dfsMs: resolvedDfsMs,
        ...result,
        best,
        overLimit,
        candidateFailures,
        lastProgress,
        dfsInfo,
        reportedIterations,
        lastCspInfo,
        firstCandidateMs,
        finalCost: best?.cost ?? null,
        elapsedMs: Math.round(elapsedMs),
      });
    };
    const timer = setTimeout(() => finish({
      status: best ? "solved" : "timeout",
      method: best ? "validated-candidate" : undefined,
      reason: best
        ? `已找到合法候选，但墙钟预算耗尽（${testCase.timeoutMs}ms），未证明最优`
        : `墙钟预算耗尽（${testCase.timeoutMs}ms）——不是无解证明`,
      complete: false,
      terminationReason: "wall-clock-timeout",
    }), testCase.timeoutMs);

    worker.on("message", message => {
      captureTelemetry(message);
      if (message.type === "progress") {
        lastProgress = message;
        reportedIterations += message.iters || 0;
        if (message.cspInfo) lastCspInfo = message.cspInfo;
        return;
      }
      if (message.type === "solution" && message.solution) {
        const cost = message.solution.__cost;
        const placed = cleanSolution(message.solution);
        const result = simulate(testCase.puzzle, placed);
        if (!result.ok) {
          candidateFailures.push({ cost, reason: result.reason, detail: result.detail });
          return;
        }
        /* simulate() 通过但超过轨道上限：记录为超限解，绝不算通过。 */
        if (testCase.maxTracks != null && cost > testCase.maxTracks) {
          overLimit.push({ cost, steps: result.steps });
          return;
        }
        if (firstCandidateMs == null) {
          firstCandidateMs = Number.isFinite(message.candidateMs)
            ? message.candidateMs
            : Math.round(performance.now() - started);
        }
        if (!best || cost < best.cost) {
          best = { cost, steps: result.steps, placed };
        }
        /* Do not finish on the first candidate. The authoritative runner keeps
           validating candidates until `done`, so it can report the final cost
           and whether optimality was actually proved. */
        return;
      }
      if (message.type === "done") {
        const proofMismatch = message.complete === true && (
          message.terminationReason === "optimal-proven"
            ? (candidateFailures.length > 0 || !best || message.finalCost !== best.cost)
            : Boolean(best)
        );
        if (best) {
          finish({
            status: "solved",
            method: message.method,
            reason: proofMismatch
              ? `Worker 最优证明与权威候选不一致（worker finalCost=${message.finalCost ?? "missing"}, validated=${best.cost}, rejected=${candidateFailures.length}）`
              : (message.complete === true && message.terminationReason === "optimal-proven" ? "" : "找到合法候选，但未证明最优"),
            ...(proofMismatch ? { complete: false, terminationReason: "candidate-unproven-early-stop" } : {}),
          });
          return;
        }
        let status, reason;
        if (overLimit.length) {
          const bestOver = Math.min(...overLimit.map(s => s.cost));
          status = "over-limit";
          reason = `找到超限解（最优 ${bestOver} 轨 > 上限 ${testCase.maxTracks}）`;
        } else if (candidateFailures.length) {
          status = "candidate-failed";
          reason = `${candidateFailures.length} 个候选全部被权威 simulate() 拒绝`;
        } else if (message.terminationReason === "dfs-iteration-budget"
          || message.terminationReason === "candidate-unproven-dfs-budget"
          || message.dfsStats?.iterationBudgetHit === true) {
          status = "budget-exhausted";
          const nodes = message.dfsStats?.nodes ?? dfsInfo?.iterations ?? reportedIterations;
          reason = `DFS 迭代预算耗尽（${nodes} 节点）——不是无解证明`;
        } else if (message.terminationReason === "wall-clock-timeout") {
          status = "timeout";
          reason = "Worker 报告墙钟预算耗尽——不是无解证明";
        } else if (message.complete === true && message.terminationReason === "search-exhausted") {
          status = "search-exhausted";
          reason = "搜索空间完整走完，无候选";
        } else {
          status = "incomplete";
          reason = `搜索未提供完备无解证明（complete=${message.complete === true}, terminationReason=${message.terminationReason || "missing"}）`;
        }
        finish({
          status,
          reason,
          method: message.method,
          info: message.info || "",
          pruned: message.pruned,
          alternateCount: message.alternates?.length || 0,
          ...(proofMismatch ? { complete: false, terminationReason: "candidate-unproven-early-stop" } : {}),
        });
      }
    });
    worker.on("error", error => finish({ status: "error", reason: error.stack || error.message }));
    worker.on("exit", code => {
      if (!settled && code !== 0) finish({ status: "error", reason: `Worker 异常退出 (${code})` });
    });

    worker.postMessage({
      type: "solve",
      requestId: testCase.relativePath,
      puzzle: { ...testCase.puzzle, _minTracks: true },
      seed: 0,
      maxTracksHint: testCase.maxTracks ?? 0,
      solverOptions,
    });
  });
}

function casePassed(testCase, result) {
  if (testCase.hasSolution === false) return result.status === "search-exhausted";
  return result.status === "solved";
}

function metric(value) {
  return Number.isFinite(value) ? String(Math.round(value * 100) / 100) : "-";
}

function describeTelemetry(result) {
  const csp = result.cspStats || {};
  const dfs = result.dfsStats || {};
  const nodes = dfs.nodes ?? result.dfsInfo?.iterations ?? result.reportedIterations;
  const deepest = dfs.deepestStep ?? dfs.deepest?.step ?? dfs.deepest ?? result.dfsInfo?.deepest?.step ?? result.dfsInfo?.deepest;
  const cspAbort = csp.aborted ? (csp.abortReason || "yes") : "no";
  const cspOverflow = csp.overflow === true ? "yes" : (csp.overflow === false ? "no" : "-");
  return [
    `nodes=${metric(nodes)}`,
    `cspMs=${metric(result.cspMs)}`,
    `p8Ms=${metric(result.p8Ms)}`,
    `dfsMs=${metric(result.dfsMs)}`,
    `cspPaths=${metric(csp.pathsEnumerated)}`,
    `cspPathIters=${metric(csp.pathIterations)}`,
    `cspCombinations=${metric(csp.combinationIterations)}`,
    `cspOverflow=${cspOverflow}`,
    `cspAbort=${cspAbort}`,
    `p8=${csp.p8?.terminationReason || "-"}`,
    `deepest=${metric(deepest)}`,
    `firstCandidateMs=${metric(result.firstCandidateMs)}`,
    `finalCost=${metric(result.finalCost)}`,
    `complete=${result.complete === true}`,
    `terminationReason=${result.terminationReason || "missing"}`,
  ].join(" · ");
}

function describeResult(testCase, result) {
  let summary;
  if (result.status === "solved") {
    const limit = testCase.maxTracks != null ? ` (≤${testCase.maxTracks})` : "";
    summary = `${result.best.cost} tracks${limit} · ${result.best.steps} steps · ${result.method}`
      + (result.reason ? ` · ${result.reason}` : "");
  } else {
    const extras = [];
    if (result.overLimit?.length) extras.push(`超限解 ${result.overLimit.map(s => s.cost).join("/")} 轨`);
    if (result.candidateFailures?.length) extras.push(`失败候选 ${result.candidateFailures.length}`);
    if (result.method) extras.push(result.method);
    summary = `${result.status} · ${result.reason}${extras.length ? ` · ${extras.join(" · ")}` : ""}`;
  }
  return `${summary} · ${describeTelemetry(result)}`;
}

const manifest = loadManifest();
const allFiles = findJSONFiles(TEST_DIR);
for (const key of manifest.byFile.keys()) {
  const exists = allFiles.some(filePath => manifestKey(path.relative(TEST_DIR, filePath)) === key);
  if (!exists) console.warn(`  ⚠ ${PUZZLE_TEST_MANIFEST} 中的 ${key} 不存在，条目被忽略`);
}
const selectedFiles = requestedPattern
  ? allFiles.filter(filePath => path.relative(TEST_DIR, filePath).includes(requestedPattern))
  : allFiles;

if (!selectedFiles.length) {
  console.error(`No puzzle JSON matched: ${requestedPattern}`);
  process.exit(2);
}

console.log(`\nPuzzle solver cases: ${selectedFiles.length} (default timeout ${defaultTimeoutMs}ms each)`);
console.log(`Solver options: ${Object.keys(solverOptions).length ? JSON.stringify(solverOptions) : "Worker defaults"}\n`);
const results = [];
for (const filePath of selectedFiles) {
  let testCase;
  try {
    testCase = loadCase(filePath, manifest);
  } catch (error) {
    const relativePath = path.relative(path.dirname(TEST_DIR), filePath);
    const result = { status: "invalid", reason: error.message, elapsedMs: 0 };
    results.push({ relativePath, name: path.basename(filePath), hasSolution: true, maxTracks: null, result });
    console.log(`  ✗ ${relativePath} · invalid · ${error.message}`);
    continue;
  }
  const result = await solveCase(testCase);
  results.push({ ...testCase, result });
  const mark = casePassed(testCase, result) ? "✓" : "✗";
  console.log(`  ${mark} ${testCase.relativePath} · ${describeResult(testCase, result)} · ${result.elapsedMs}ms`);
}

const failed = results.filter(entry => !casePassed(entry, entry.result));
const solvedCount = results.length - failed.length;
const byStatus = {};
for (const { result } of results) byStatus[result.status] = (byStatus[result.status] || 0) + 1;
console.log(`\n═══════════ Puzzle solver: ${solvedCount} passed, ${failed.length} failed ═══════════`);
console.log(`状态分布: ${Object.entries(byStatus).map(([k, v]) => `${k}=${v}`).join("  ")}\n`);

if (failed.length) {
  console.log("Failure details:");
  for (const { relativePath, maxTracks, result } of failed) {
    console.log(JSON.stringify({
      file: relativePath,
      status: result.status,
      reason: result.reason,
      maxTracks,
      method: result.method,
      info: result.info,
      overLimit: result.overLimit,
      cspMs: result.cspMs,
      dfsMs: result.dfsMs,
      cspStats: result.cspStats,
      dfsStats: result.dfsStats,
      nodes: result.dfsStats?.nodes ?? result.dfsInfo?.iterations ?? result.reportedIterations,
      deepest: result.dfsStats?.deepestStep
        ?? result.dfsStats?.deepest?.step
        ?? result.dfsStats?.deepest
        ?? result.dfsInfo?.deepest?.step
        ?? result.dfsInfo?.deepest,
      firstCandidateMs: result.firstCandidateMs,
      finalCost: result.finalCost,
      complete: result.complete,
      terminationReason: result.terminationReason,
      phase: result.phase,
      dfsInfo: result.dfsInfo,
      reportedIterations: result.reportedIterations,
      lastCspInfo: result.lastCspInfo,
      candidateFailures: result.candidateFailures,
    }));
  }
}

process.exit(failed.length ? 1 : 0);
