/* 搜索健全性金丝雀（solver soundness canaries）
 *
 * 每条金丝雀是一对"已证事实"：
 *   solved    —— 在已证最小轨道数的预算下，必须找到恰好该成本的合法解；
 *   exhausted —— 在最小值减一的预算下，搜索必须"完备走完"且无候选
 *                （dfsInfo.exhausted 必须为 false —— 是走完，不是被迭代上限打断）。
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

function runCase(puzzle, budget) {
  return new Promise(resolve => {
    const worker = new Worker(WORKER_URL, { type: "module" });
    let best = null;
    let dfsInfo = null;
    let settled = false;
    const finish = outcome => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ status: "timeout", best, dfsInfo }), CASE_TIMEOUT_MS);
    worker.on("message", message => {
      if (message.type === "progress") {
        if (message.dfsInfo) dfsInfo = message.dfsInfo;
        return;
      }
      if (message.type === "solution" && message.solution) {
        const cost = message.solution.__cost;
        if (budget > 0 && cost > budget) return; /* CSP 可能放出恰好超限 1 轨的解，忽略 */
        const placed = Object.fromEntries(Object.entries(message.solution).filter(([key]) => key !== "__cost"));
        const result = simulate(puzzle, placed);
        if (result.ok && (!best || cost < best.cost)) best = { cost, steps: result.steps };
        return;
      }
      if (message.type === "done") finish({ status: "done", best, dfsInfo });
    });
    worker.on("error", error => finish({ status: "error", error: error.message, best, dfsInfo }));
    worker.postMessage({
      type: "solve",
      requestId: "canary",
      puzzle: { ...puzzle, _minTracks: true },
      seed: 0,
      maxTracksHint: budget,
    });
  });
}

function judge(canary, outcome) {
  if (outcome.status === "error") return `Worker 错误：${outcome.error}`;
  if (outcome.status === "timeout") return `超时（金丝雀必须亚秒级完成，当前搜索退化）`;
  if (canary.expect === "solved") {
    if (!outcome.best) return "未找到合法解（剪枝切掉了已证存在的最小解 —— 不健全）";
    if (outcome.best.cost !== canary.budget) return `成本 ${outcome.best.cost} ≠ 已证最小 ${canary.budget}`;
    return null;
  }
  /* expect === "exhausted" */
  if (outcome.best) return `预算内出现合法解（成本 ${outcome.best.cost}）——规则被放宽或碰撞判定失效`;
  if (outcome.dfsInfo?.exhausted) return "DFS 被迭代上限打断，不能作为完备无解声明";
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
    console.error(`  ✗ ${label} · ${problem} · ${elapsed}ms`);
  } else {
    console.log(`  ✓ ${label} · ${elapsed}ms`);
  }
}
console.log(`\n═══════════ Canaries: ${CANARIES.length - failed} passed, ${failed} failed ═══════════\n`);
process.exit(failed ? 1 : 0);
