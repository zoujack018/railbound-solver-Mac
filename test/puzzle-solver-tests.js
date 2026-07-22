import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { Worker } from "node:worker_threads";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizePuzzle } from "../puzzle-io.js";
import { isPuzzleManifestFileName, PUZZLE_TEST_MANIFEST } from "../puzzle-library.js";
import { simulate } from "../railbound-rules.js";
import {
  classifyPortfolioEvidence,
  MAX_PUZZLE_WORKERS,
  normalizeCandidateSources,
  placedTrackCost,
  portfolioSeed,
  solvedStatusLabel,
} from "./puzzle-portfolio.js";

const TEST_DIR = fileURLToPath(new URL("./", import.meta.url));
const WORKER_URL = pathToFileURL(path.join(TEST_DIR, "solver-worker-node.js"));
const defaultTimeoutMs = positiveInteger(process.env.PUZZLE_TIMEOUT_MS, 20_000);
const puzzleWorkers = Math.min(positiveInteger(process.env.PUZZLE_WORKERS, 1), MAX_PUZZLE_WORKERS);
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
  const p12ModeNew = String(env.P12_PATTERN_SEED || "").trim().toLowerCase();
  const p12ModeLegacy = String(env.P8_BACKBONE || "").trim().toLowerCase();
  if (p12ModeNew && p12ModeLegacy && p12ModeNew !== p12ModeLegacy) {
    throw new Error("P12_PATTERN_SEED conflicts with deprecated P8_BACKBONE");
  }
  const p12Mode = p12ModeNew || p12ModeLegacy;
  if (p12Mode && p12Mode !== "on" && p12Mode !== "off") {
    throw new Error(`P12_PATTERN_SEED must be on or off, received: ${p12Mode}`);
  }

  const maxMs = optionalPositiveInteger(env.CSP_TIMEBOX_MS);
  const maxPaths = optionalPositiveInteger(env.CSP_PATH_BUDGET);
  const maxCombinations = optionalPositiveInteger(env.CSP_COMBINATION_BUDGET);
  const dfsMaxIterations = optionalPositiveInteger(env.DFS_MAX_ITERATIONS);
  const p12MaxMsNew = optionalPositiveInteger(env.P12_PATTERN_SEED_MS);
  const p12MaxMsLegacy = optionalPositiveInteger(env.P8_BACKBONE_MS);
  if (p12MaxMsNew != null && p12MaxMsLegacy != null && p12MaxMsNew !== p12MaxMsLegacy) {
    throw new Error("P12_PATTERN_SEED_MS conflicts with deprecated P8_BACKBONE_MS");
  }
  const p12MaxWorkNew = optionalPositiveInteger(env.P12_PATTERN_SEED_WORK_BUDGET);
  const p12MaxWorkLegacy = optionalPositiveInteger(env.P8_BACKBONE_WORK_BUDGET);
  if (p12MaxWorkNew != null && p12MaxWorkLegacy != null && p12MaxWorkNew !== p12MaxWorkLegacy) {
    throw new Error("P12_PATTERN_SEED_WORK_BUDGET conflicts with deprecated P8_BACKBONE_WORK_BUDGET");
  }
  const p12MaxMs = p12MaxMsNew ?? p12MaxMsLegacy;
  const p12MaxWorkUnits = p12MaxWorkNew ?? p12MaxWorkLegacy;
  const cspTimebox = {};
  const p12Seed = {};

  /* No CSP environment variables means "use Worker defaults". `on` makes that
     choice explicit; `off` disables only the new P1 shared timebox and restores
     the pre-P1 CSP baseline (the solver's original internal caps still apply). */
  if (mode === "off") cspTimebox.enabled = false;
  else if (mode === "on") cspTimebox.enabled = true;
  if (maxMs != null) cspTimebox.maxMs = maxMs;
  if (maxPaths != null) cspTimebox.maxPaths = maxPaths;
  if (maxCombinations != null) cspTimebox.maxCombinations = maxCombinations;
  if (p12Mode) p12Seed.enabled = p12Mode === "on";
  if (p12MaxMs != null) p12Seed.maxMs = p12MaxMs;
  if (p12MaxWorkUnits != null) p12Seed.maxWorkUnits = p12MaxWorkUnits;

  const options = {};
  if (Object.keys(cspTimebox).length) options.cspTimebox = cspTimebox;
  if (Object.keys(p12Seed).length) options.p12Seed = p12Seed;
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

async function solveWorkerSession(testCase, {
  seed = 0,
  workerIndex = 0,
  signal = null,
  stopOnValidCandidate = false,
  onValidCandidate = null,
  proofScopeKey = null,
} = {}) {
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
  let phaseObservedAt = null;
  const telemetry = {
    cspMs: null,
    p12SeedMs: null,
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
    if (Number.isFinite(message.p12SeedMs)) telemetry.p12SeedMs = message.p12SeedMs;
    if (Number.isFinite(message.dfsMs)) telemetry.dfsMs = message.dfsMs;
    if (message.cspStats) telemetry.cspStats = mergeStats(telemetry.cspStats, message.cspStats);
    if (message.dfsStats) telemetry.dfsStats = mergeStats(telemetry.dfsStats, message.dfsStats);
    if (Number.isFinite(message.firstCandidateMs)) telemetry.workerFirstCandidateMs = message.firstCandidateMs;
    if (Number.isFinite(message.finalCost)) telemetry.workerFinalCost = message.finalCost;
    if (typeof message.complete === "boolean") telemetry.complete = message.complete;
    if (typeof message.terminationReason === "string" && message.terminationReason) {
      telemetry.terminationReason = message.terminationReason;
    }
    if (typeof message.phase === "string" && message.phase) {
      telemetry.phase = message.phase;
      phaseObservedAt = performance.now();
    }
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
    let onAbort = null;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      worker.removeAllListeners("message");
      const elapsedMs = performance.now() - started;
      let resolvedCspMs = telemetry.cspMs;
      let resolvedP12SeedMs = telemetry.p12SeedMs;
      let resolvedDfsMs = telemetry.dfsMs;
      const forcedStop = result.terminationReason === "wall-clock-timeout"
        || result.terminationReason === "portfolio-cancelled"
        || result.terminationReason === "portfolio-first-valid-candidate"
        || result.status === "error";
      if (forcedStop) {
        const phaseTailMs = Number.isFinite(phaseObservedAt)
          ? Math.max(0, performance.now() - phaseObservedAt)
          : null;
        if (telemetry.phase === "csp") {
          if (Number.isFinite(phaseTailMs)) resolvedCspMs = (Number.isFinite(resolvedCspMs) ? resolvedCspMs : 0) + phaseTailMs;
        } else if (telemetry.phase === "p12-seed") {
          if (Number.isFinite(phaseTailMs)) {
            resolvedP12SeedMs = (Number.isFinite(resolvedP12SeedMs) ? resolvedP12SeedMs : 0) + phaseTailMs;
          }
        } else if (telemetry.phase === "dfs") {
          if (Number.isFinite(phaseTailMs)) resolvedDfsMs = (Number.isFinite(resolvedDfsMs) ? resolvedDfsMs : 0) + phaseTailMs;
        }
      }
      const payload = {
        ...telemetry,
        cspMs: resolvedCspMs,
        p12SeedMs: resolvedP12SeedMs,
        dfsMs: resolvedDfsMs,
        timingExact: !forcedStop,
        timingEstimated: forcedStop && Number.isFinite(phaseObservedAt),
        cspStatsKnown: telemetry.cspStats != null,
        dfsStatsKnown: telemetry.dfsStats != null,
        ...result,
        workerIndex,
        seed,
        proofScopeKey,
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
      };
      Promise.resolve(worker.terminate())
        .catch(() => undefined)
        .then(() => resolve(payload));
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
    onAbort = () => finish({
      status: "cancelled",
      method: "portfolio-cancelled",
      reason: "另一个 Worker 已找到合法候选，当前 Worker 被取消",
      complete: false,
      terminationReason: "portfolio-cancelled",
    });
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }

    worker.on("message", message => {
      if (settled) return;
      captureTelemetry(message);
      if (message.type === "progress") {
        lastProgress = message;
        reportedIterations += message.iters || 0;
        if (message.cspInfo) lastCspInfo = message.cspInfo;
        return;
      }
      if (message.type === "solution" && message.solution) {
        const reportedCost = message.solution.__cost;
        const source = normalizeCandidateSources(message.source)[0];
        const placed = cleanSolution(message.solution);
        const cost = placedTrackCost(placed);
        const result = simulate(testCase.puzzle, placed);
        if (!result.ok) {
          candidateFailures.push({ reportedCost, actualCost: cost, reason: result.reason, detail: result.detail });
          return;
        }
        if (reportedCost !== cost) {
          candidateFailures.push({
            reportedCost,
            actualCost: cost,
            reason: "COST_MISMATCH",
            detail: `Worker reported ${reportedCost}; authoritative placed-key count is ${cost}`,
          });
          return;
        }
        /* simulate() 通过但超过轨道上限：记录为超限解，绝不算通过。 */
        if (testCase.maxTracks != null && cost > testCase.maxTracks) {
          overLimit.push({ cost, steps: result.steps });
          return;
        }
        if (firstCandidateMs == null) {
          firstCandidateMs = performance.now() - started;
          if (Number.isFinite(message.candidateMs)) telemetry.workerFirstCandidateMs = message.candidateMs;
        }
        if (!best || cost < best.cost) {
          best = { cost, steps: result.steps, placed, sources: [source] };
        } else if (cost === best.cost) {
          best.sources = normalizeCandidateSources([...(best.sources || []), source]);
        }
        if (typeof onValidCandidate === "function") {
          onValidCandidate({
            workerIndex,
            seed,
            cost,
            steps: result.steps,
            placed,
            source,
          });
        }
        if (stopOnValidCandidate) {
          finish({
            status: "solved",
            method: "portfolio-first-valid",
            reason: "多种子组合找到首个合法候选；已提前停止，未证明最优",
            complete: false,
            terminationReason: "portfolio-first-valid-candidate",
          });
          return;
        }
        /* Do not finish on the first candidate. The authoritative runner keeps
           validating candidates until `done`, so it can report the final cost
           and whether optimality was actually proved. */
        return;
      }
      if (message.type === "done") {
        const proofMismatch = message.complete === true && (
          candidateFailures.length > 0
          || overLimit.length > 0
          || (message.terminationReason === "optimal-proven"
            ? (!best || message.finalCost !== best.cost)
            : Boolean(best))
        );
        if (best) {
          finish({
            status: "solved",
            method: message.method,
            reason: proofMismatch
              ? `Worker 最优证明与权威候选不一致（worker finalCost=${message.finalCost ?? "missing"}, validated=${best.cost}, rejected=${candidateFailures.length}, overLimit=${overLimit.length}）`
              : (message.complete === true && message.terminationReason === "optimal-proven" ? "" : "找到合法候选，但未证明最优"),
            ...(proofMismatch ? {
              complete: false,
              terminationReason: candidateFailures.length
                ? "candidate-validation-failed"
                : (overLimit.length ? "candidate-over-limit" : "candidate-unproven-early-stop"),
            } : {}),
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
          reason = `${candidateFailures.length} 个候选未通过权威验证（simulate() 或成本注解不一致）`;
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
          ...(proofMismatch ? {
            complete: false,
            terminationReason: candidateFailures.length
              ? "candidate-validation-failed"
              : (overLimit.length ? "candidate-over-limit" : "candidate-unproven-early-stop"),
          } : {}),
        });
      }
    });
    worker.on("error", error => finish({
      status: "error",
      reason: error.stack || error.message,
      complete: false,
      terminationReason: "worker-error",
    }));
    worker.on("exit", code => {
      if (!settled && code !== 0) finish({
        status: "error",
        reason: `Worker 异常退出 (${code})`,
        complete: false,
        terminationReason: "worker-exit",
      });
    });

    if (!settled) {
      worker.postMessage({
        type: "solve",
        requestId: `${testCase.relativePath}#worker-${workerIndex}`,
        puzzle: { ...testCase.puzzle, _minTracks: true },
        seed,
        maxTracksHint: testCase.maxTracks ?? 0,
        solverOptions,
      });
    }
  });
}

function finiteSum(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) : null;
}

function finiteMax(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? Math.max(...finite) : null;
}

function aggregatePortfolioTelemetry(results, wallMs, firstCandidateWallMs) {
  const workerStats = results.map(result => ({
    workerIndex: result.workerIndex,
    seed: result.seed,
    status: result.status,
    method: result.method,
    phase: result.phase,
    nodes: result.dfsStats?.nodes ?? result.dfsInfo?.iterations ?? result.reportedIterations ?? 0,
    deepestStep: result.dfsStats?.deepestStep
      ?? result.dfsStats?.deepest?.step
      ?? result.dfsStats?.deepest
      ?? result.dfsInfo?.deepest?.step
      ?? result.dfsInfo?.deepest
      ?? null,
    cspMs: result.cspMs,
    p12SeedMs: result.p12SeedMs,
    dfsMs: result.dfsMs,
    firstCandidateMs: result.firstCandidateMs,
    bestCost: result.best?.cost ?? null,
    sources: result.best ? normalizeCandidateSources(result.best.sources) : [],
    complete: result.complete === true,
    terminationReason: result.terminationReason || "missing",
    cspOverflow: result.cspStats?.overflow,
    cspAborted: result.cspStats?.aborted,
    cspAbortReason: result.cspStats?.abortReason || null,
    p12SeedTermination: result.cspStats?.p12Seed?.terminationReason || null,
    timingExact: result.timingExact === true,
    timingEstimated: result.timingEstimated === true,
    cspStatsKnown: result.cspStatsKnown === true,
    dfsStatsKnown: result.dfsStatsKnown === true,
  }));
  const terminationCounts = {};
  for (const worker of workerStats) {
    terminationCounts[worker.terminationReason] = (terminationCounts[worker.terminationReason] || 0) + 1;
  }
  const p12SeedTerminationCounts = {};
  for (const worker of workerStats) {
    if (!worker.p12SeedTermination) continue;
    p12SeedTerminationCounts[worker.p12SeedTermination]
      = (p12SeedTerminationCounts[worker.p12SeedTermination] || 0) + 1;
  }
  const totalNodesObserved = finiteSum(workerStats.map(worker => worker.nodes)) ?? 0;
  const cancelledWorkers = workerStats.filter(worker => worker.status === "cancelled").length;
  const erroredWorkers = workerStats.filter(worker => worker.status === "error").length;
  const estimatedTimingWorkers = workerStats.filter(worker => worker.timingEstimated).length;
  const unknownTimingWorkers = workerStats.filter(worker =>
    !worker.timingExact && !worker.timingEstimated).length;
  const cspStatsKnownWorkers = workerStats.filter(worker => worker.cspStatsKnown).length;
  const dfsStatsKnownWorkers = workerStats.filter(worker => worker.dfsStatsKnown).length;
  const nodesExact = !workerStats.some(worker =>
    worker.status === "cancelled"
    || worker.status === "timeout"
    || worker.status === "error"
    || worker.terminationReason === "wall-clock-timeout"
    || worker.terminationReason === "portfolio-first-valid-candidate");

  return {
    workerStats,
    portfolioStats: {
      enabled: true,
      workerCount: results.length,
      seeds: workerStats.map(worker => worker.seed),
      wallMs,
      settledWorkers: results.length - cancelledWorkers,
      cancelledWorkers,
      erroredWorkers,
      totalNodesObserved,
      nodesExact,
      phaseTimesExact: workerStats.every(worker => worker.timingExact),
      estimatedTimingWorkers,
      unknownTimingWorkers,
      sumCspMs: finiteSum(workerStats.map(worker => worker.cspMs)),
      sumP12SeedMs: finiteSum(workerStats.map(worker => worker.p12SeedMs)),
      sumDfsMs: finiteSum(workerStats.map(worker => worker.dfsMs)),
      cspTimingKnownWorkers: workerStats.filter(worker => Number.isFinite(worker.cspMs)).length,
      p12SeedTimingKnownWorkers: workerStats.filter(worker => Number.isFinite(worker.p12SeedMs)).length,
      dfsTimingKnownWorkers: workerStats.filter(worker => Number.isFinite(worker.dfsMs)).length,
      cspStatsKnownWorkers,
      dfsStatsKnownWorkers,
      firstCandidateWallMs,
      terminationCounts,
    },
    cspStats: {
      pathsEnumerated: finiteSum(results.map(result => result.cspStats?.pathsEnumerated)),
      pathIterations: finiteSum(results.map(result => result.cspStats?.pathIterations)),
      combinationIterations: finiteSum(results.map(result => result.cspStats?.combinationIterations)),
      knownWorkers: cspStatsKnownWorkers,
      exact: cspStatsKnownWorkers === results.length && results.every(result => result.timingExact),
      overflowWorkers: results.filter(result => result.cspStats?.overflow === true).length,
      abortedWorkers: results.filter(result => result.cspStats?.aborted === true).length,
      p12Seed: { terminationCounts: p12SeedTerminationCounts },
    },
    dfsStats: {
      nodes: totalNodesObserved,
      deepestStep: finiteMax(workerStats.map(worker => worker.deepestStep)),
    },
  };
}

function portfolioReason(evidence, workerCount) {
  switch (evidence.terminationReason) {
    case "portfolio-first-valid-candidate":
      return `${workerCount} Worker 多种子组合找到首个合法候选；已提前停止，未证明最优`;
    case "optimal-proven":
      return "至少一个同证明域 Worker 找到候选并证明最优";
    case "search-exhausted":
      return "至少一个同证明域 Worker 完整走完搜索且无候选";
    case "portfolio-contract-conflict":
      return "不同 Worker 的合法候选与完备无解声明冲突；保留候选但撤销完备性";
    case "portfolio-proof-mismatch":
      return "Worker 的最优证明与组合内权威候选成本不一致";
    case "candidate-unproven-portfolio":
      return "组合找到合法候选，但没有 Worker 证明其最优";
    case "wall-clock-timeout":
      return "多 Worker 墙钟预算耗尽——不是无解证明";
    case "dfs-iteration-budget":
      return "所有有效 Worker 都耗尽 DFS 迭代预算——不是无解证明";
    default:
      return "多 Worker 均未提供可接受的候选或完备证明";
  }
}

async function solveCase(testCase) {
  if (puzzleWorkers === 1) {
    return solveWorkerSession(testCase, { seed: 0, workerIndex: 0 });
  }

  const portfolioStarted = performance.now();
  const proofScopeKey = JSON.stringify({
    requestId: testCase.relativePath,
    maxTracksHint: testCase.maxTracks ?? 0,
    minTracks: true,
    solverOptions,
  });
  const controllers = Array.from({ length: puzzleWorkers }, () => new AbortController());
  let firstCandidate = null;
  const sessionPromises = controllers.map((controller, workerIndex) => solveWorkerSession(testCase, {
    seed: portfolioSeed(workerIndex),
    workerIndex,
    signal: controller.signal,
    stopOnValidCandidate: testCase.hasSolution !== false,
    proofScopeKey,
    onValidCandidate: candidate => {
      if (firstCandidate) return;
      firstCandidate = {
        ...candidate,
        wallMs: performance.now() - portfolioStarted,
      };
      if (testCase.hasSolution !== false) {
        for (let index = 0; index < controllers.length; index++) {
          if (index !== workerIndex) controllers[index].abort();
        }
      }
    },
  }));
  const results = await Promise.all(sessionPromises);
  const wallMs = Math.round(performance.now() - portfolioStarted);
  const evidence = classifyPortfolioEvidence(results, {
    fastCandidate: testCase.hasSolution !== false && Boolean(firstCandidate),
    proofScopeKey,
  });
  const telemetry = aggregatePortfolioTelemetry(results, wallMs, firstCandidate?.wallMs ?? null);
  const bestCost = evidence.bestResult?.best?.cost ?? null;
  const equalBest = bestCost == null
    ? []
    : results.filter(result => result.best?.cost === bestCost);
  const best = evidence.bestResult?.best
    ? {
        ...evidence.bestResult.best,
        sources: normalizeCandidateSources(equalBest.flatMap(result => result.best?.sources || [])),
      }
    : null;
  const proofWorkerIndex = evidence.proofResult?.workerIndex ?? null;
  const winningWorkerIndex = evidence.bestResult?.workerIndex ?? firstCandidate?.workerIndex ?? null;
  const winningSeed = evidence.bestResult?.seed ?? firstCandidate?.seed ?? null;
  const winningSource = evidence.bestResult?.best?.sources?.[0] ?? firstCandidate?.source ?? null;
  telemetry.portfolioStats.winningWorkerIndex = winningWorkerIndex;
  telemetry.portfolioStats.winningSeed = winningSeed;
  telemetry.portfolioStats.winningSource = winningSource;
  telemetry.portfolioStats.proofWorkerIndex = proofWorkerIndex;
  telemetry.portfolioStats.proofScopeKey = proofScopeKey;

  return {
    status: evidence.status,
    method: `portfolio(${puzzleWorkers})`,
    reason: portfolioReason(evidence, puzzleWorkers),
    complete: evidence.complete,
    terminationReason: evidence.terminationReason,
    best,
    overLimit: results.flatMap(result => result.overLimit || []),
    candidateFailures: results.flatMap(result => result.candidateFailures || []),
    firstCandidateMs: firstCandidate?.wallMs ?? null,
    finalCost: best?.cost ?? null,
    elapsedMs: wallMs,
    reportedIterations: finiteSum(results.map(result => result.reportedIterations)) ?? 0,
    lastCspInfo: results.map(result => result.lastCspInfo).filter(Boolean).join(" | "),
    ...telemetry,
    cspMs: telemetry.portfolioStats.sumCspMs,
    p12SeedMs: telemetry.portfolioStats.sumP12SeedMs,
    dfsMs: telemetry.portfolioStats.sumDfsMs,
  };
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
  const portfolio = result.portfolioStats;
  const timingLabel = portfolio
    ? (portfolio.phaseTimesExact ? "Σworker" : "Σobserved+estimated")
    : "";
  const cspAbort = portfolio
    ? `${csp.abortedWorkers || 0}/${csp.knownWorkers || 0}known`
    : (csp.aborted ? (csp.abortReason || "yes") : "no");
  const cspOverflow = portfolio
    ? `${csp.overflowWorkers || 0}/${csp.knownWorkers || 0}known`
    : (csp.overflow === true ? "yes" : (csp.overflow === false ? "no" : "-"));
  return [
    `nodes=${portfolio && portfolio.nodesExact === false ? ">=" : ""}${metric(nodes)}`,
    `cspMs${portfolio ? `(${timingLabel})` : ""}=${metric(result.cspMs ?? portfolio?.sumCspMs)}`,
    `p12SeedMs${portfolio ? `(${timingLabel})` : ""}=${metric(result.p12SeedMs ?? portfolio?.sumP12SeedMs)}`,
    `dfsMs${portfolio ? `(${timingLabel})` : ""}=${metric(result.dfsMs ?? portfolio?.sumDfsMs)}`,
    `cspPaths=${portfolio && csp.exact === false ? ">=" : ""}${metric(csp.pathsEnumerated)}`,
    `cspPathIters=${portfolio && csp.exact === false ? ">=" : ""}${metric(csp.pathIterations)}`,
    `cspCombinations=${portfolio && csp.exact === false ? ">=" : ""}${metric(csp.combinationIterations)}`,
    `cspOverflow=${cspOverflow}`,
    `cspAbort=${cspAbort}`,
    `p12Seed=${portfolio
      ? (Object.entries(csp.p12Seed?.terminationCounts || {}).map(([reason, count]) => `${reason}:${count}`).join(",") || "-")
      : (csp.p12Seed?.terminationReason || "-")}`,
    `deepest=${metric(deepest)}`,
    `firstCandidateMs=${metric(result.firstCandidateMs)}`,
    `finalCost=${metric(result.finalCost)}`,
    `complete=${result.complete === true}`,
    `terminationReason=${result.terminationReason || "missing"}`,
    ...(portfolio ? [
      `portfolioWallMs=${metric(portfolio.wallMs)}`,
      `workers=${portfolio.workerCount}`,
      `phaseTimesExact=${portfolio.phaseTimesExact}`,
      `cspStatsKnown=${portfolio.cspStatsKnownWorkers}/${portfolio.workerCount}`,
      `winner=${portfolio.winningWorkerIndex ?? "-"}/${portfolio.winningSeed ?? "-"}/${portfolio.winningSource || "-"}`,
    ] : []),
  ].join(" · ");
}

function describeResult(testCase, result) {
  let summary;
  if (result.status === "solved") {
    const limit = testCase.maxTracks != null ? ` (≤${testCase.maxTracks})` : "";
    summary = `${solvedStatusLabel(result)} · ${result.best.cost} tracks${limit} · ${result.best.steps} steps · ${result.method}`
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

function describePortfolioWorkers(result) {
  if (!result.workerStats?.length) return "";
  return result.workerStats.map(worker => [
    `#${worker.workerIndex}`,
    `seed=${worker.seed}`,
    worker.status,
    `nodes=${metric(worker.nodes)}`,
    `deepest=${metric(worker.deepestStep)}`,
    `cspMs=${metric(worker.cspMs)}`,
    `p12SeedMs=${metric(worker.p12SeedMs)}`,
    `dfsMs=${metric(worker.dfsMs)}`,
    `firstMs=${metric(worker.firstCandidateMs)}`,
    `cost=${metric(worker.bestCost)}`,
    `source=${worker.sources.join("+") || "-"}`,
    `timing=${worker.timingExact ? "exact" : (worker.timingEstimated ? "estimated" : "unknown")}`,
    `complete=${worker.complete}`,
    `reason=${worker.terminationReason}`,
  ].join("/")).join(" | ");
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

console.log(`\nPuzzle solver cases: ${selectedFiles.length} (default timeout ${defaultTimeoutMs}ms each, workers ${puzzleWorkers})`);
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
  if (result.workerStats?.length) console.log(`    workers: ${describePortfolioWorkers(result)}`);
}

const failed = results.filter(entry => !casePassed(entry, entry.result));
const solvedCount = results.length - failed.length;
const byStatus = {};
for (const { result } of results) {
  const label = solvedStatusLabel(result);
  byStatus[label] = (byStatus[label] || 0) + 1;
}
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
      p12SeedMs: result.p12SeedMs,
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
      portfolioStats: result.portfolioStats,
      workerStats: result.workerStats,
    }));
  }
}

process.exit(failed.length ? 1 : 0);
