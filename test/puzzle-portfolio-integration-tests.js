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

const proofRetained = runPortfolio("关卡-4x8-20260722-6-3A.json", {
  PUZZLE_WORKERS: "8",
  PUZZLE_PROOF_GRACE_MS: "1000",
});
assert.match(proofRetained, /finalCost=9/);
assert.match(proofRetained, /complete=true/);
assert.match(proofRetained, /terminationReason=optimal-proven/);

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
