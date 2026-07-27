import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const RUNNER = fileURLToPath(new URL("./puzzle-solver-tests.js", import.meta.url));

function runPortfolio(pattern, env) {
  const result = spawnSync(process.execPath, [RUNNER, pattern], {
    encoding: "utf8",
    env: { ...process.env, PUZZLE_TIMEOUT_MS: "10000", ...env },
    timeout: 15000,
  });
  assert.equal(result.error, undefined, result.error?.stack);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const summary = result.stdout.split("\n").find(line => line.includes("portfolio("));
  assert.ok(summary, result.stdout);
  return summary;
}

const immediate = runPortfolio("关卡-4x8-20260722-6-3A.json", {
  PUZZLE_WORKERS: "8",
  PUZZLE_PROOF_GRACE_MS: "0",
});
assert.match(immediate, /complete=false/);
assert.match(immediate, /terminationReason=portfolio-first-valid-candidate/);
assert.match(immediate, /proofGraceOutcome=disabled/);

const proofRetained = runPortfolio("关卡-4x8-20260722-6-3A.json", {
  PUZZLE_WORKERS: "8",
  PUZZLE_PROOF_GRACE_MS: "1000",
});
assert.match(proofRetained, /finalCost=9/);
assert.match(proofRetained, /complete=true/);
assert.match(proofRetained, /terminationReason=optimal-proven/);

/* The proof scope is the identity of the searched domain. Seeds only reorder
   exploration, so a seed inside the key would split otherwise shared proofs. */
const proofScope = proofRetained.match(/proofScopeKey=(\{.*?\})/);
assert.ok(proofScope, `proofScopeKey 未出现在组合遥测中：${proofRetained}`);
assert.doesNotMatch(proofScope[1], /"seed"/);
assert.match(proofScope[1], /"requestId":/);
assert.match(proofScope[1], /"minTracks":/);
/* 异构模式（默认）下组合的完备性域是 DFS-only 角色的域，机器 scope key
   必须携带 skipCsp —— 这钉住"不同角色不同 proofScopeKey"。 */
assert.match(proofRetained, /heterogeneous=true/);
assert.match(proofScope[1], /"skipCsp":true/);

/* 同构 A/B：PORTFOLIO_HETEROGENEOUS=off 恢复第七轮同构组合，最优证明
   仍在 grace 内保留，且 scope key 不含 skipCsp。 */
const homogeneous = runPortfolio("关卡-4x8-20260722-6-3A.json", {
  PUZZLE_WORKERS: "8",
  PUZZLE_PROOF_GRACE_MS: "1000",
  PORTFOLIO_HETEROGENEOUS: "off",
});
assert.match(homogeneous, /finalCost=9/);
assert.match(homogeneous, /complete=true/);
assert.match(homogeneous, /terminationReason=optimal-proven/);
assert.match(homogeneous, /heterogeneous=false/);
assert.doesNotMatch(homogeneous, /"skipCsp"/);

const repeatedWinnerCandidate = runPortfolio("关卡-7x5-20260722-5-7.json", {
  PUZZLE_WORKERS: "8",
  PUZZLE_PROOF_GRACE_MS: "1000",
});
assert.match(repeatedWinnerCandidate, /finalCost=\d+/);
assert.match(repeatedWinnerCandidate, /complete=true/);
assert.match(repeatedWinnerCandidate, /terminationReason=optimal-proven/);

const negative = runPortfolio("scratch_test_swap_3x3.json", {
  PUZZLE_WORKERS: "4",
  PUZZLE_PROOF_GRACE_MS: "1000",
});
assert.match(negative, /complete=true/);
assert.match(negative, /terminationReason=search-exhausted/);

console.log("✓ puzzle portfolio integration tests");
