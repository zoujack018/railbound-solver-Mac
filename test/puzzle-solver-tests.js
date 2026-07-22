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
 *   timeout          时间预算耗尽 —— 不是无解证明
 *   search-exhausted 搜索空间在预算内走完且无候选 —— 当前算法边界内无解
 * hasSolution=false 的题只有 search-exhausted 算通过；预算耗尽是"不确定"，仍判失败。 */

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

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
  let lastProgress = null;
  let dfsInfo = null;
  let reportedIterations = 0;
  let lastCspInfo = "";

  return await new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve({
        ...result,
        best,
        overLimit,
        candidateFailures,
        lastProgress,
        dfsInfo,
        reportedIterations,
        lastCspInfo,
        elapsedMs: Math.round(performance.now() - started),
      });
    };
    const timer = setTimeout(() => finish({
      status: "timeout",
      reason: `时间预算耗尽（${testCase.timeoutMs}ms）——不是无解证明`,
    }), testCase.timeoutMs);

    worker.on("message", message => {
      if (message.type === "progress") {
        lastProgress = message;
        reportedIterations += message.iters || 0;
        if (message.cspInfo) lastCspInfo = message.cspInfo;
        if (message.dfsInfo) dfsInfo = message.dfsInfo;
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
        if (!best || cost < best.cost) {
          best = { cost, steps: result.steps, placed };
        }
        finish({ status: "solved", method: "validated-candidate", reason: "" });
        return;
      }
      if (message.type === "done") {
        if (best) {
          finish({ status: "solved", method: message.method, reason: "" });
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
        } else if (dfsInfo?.exhausted) {
          status = "budget-exhausted";
          reason = `迭代预算耗尽（${dfsInfo.iterations} 次）——不是无解证明`;
        } else {
          status = "search-exhausted";
          reason = "搜索空间在预算内走完，无候选（当前算法边界内无解）";
        }
        finish({
          status,
          reason,
          method: message.method,
          info: message.info || "",
          pruned: message.pruned,
          alternateCount: message.alternates?.length || 0,
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
    });
  });
}

function casePassed(testCase, result) {
  if (testCase.hasSolution === false) return result.status === "search-exhausted";
  return result.status === "solved";
}

function describeResult(testCase, result) {
  if (result.status === "solved") {
    const limit = testCase.maxTracks != null ? ` (≤${testCase.maxTracks})` : "";
    return `${result.best.cost} tracks${limit} · ${result.best.steps} steps · ${result.method}`;
  }
  const extras = [];
  if (result.overLimit?.length) extras.push(`超限解 ${result.overLimit.map(s => s.cost).join("/")} 轨`);
  if (result.candidateFailures?.length) extras.push(`失败候选 ${result.candidateFailures.length}`);
  if (result.method) extras.push(result.method);
  return `${result.status} · ${result.reason}${extras.length ? ` · ${extras.join(" · ")}` : ""}`;
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

console.log(`\nPuzzle solver cases: ${selectedFiles.length} (default timeout ${defaultTimeoutMs}ms each)\n`);
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
      dfsInfo: result.dfsInfo,
      reportedIterations: result.reportedIterations,
      lastCspInfo: result.lastCspInfo,
      candidateFailures: result.candidateFailures,
    }));
  }
}

process.exit(failed.length ? 1 : 0);
