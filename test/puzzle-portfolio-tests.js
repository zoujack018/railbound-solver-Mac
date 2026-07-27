import assert from "node:assert/strict";
import {
  boundedProofGraceMs,
  classifyPortfolioEvidence,
  inspectPortfolioCandidate,
  normalizeCandidateSources,
  placedTrackCost,
  portfolioSeed,
  solvedStatusLabel,
  workerProofIssue,
} from "../solver/portfolio-evidence.js";

assert.equal(boundedProofGraceMs(100, 100, 1000), 100);
assert.equal(boundedProofGraceMs(100, 950, 1000), 40);
assert.equal(boundedProofGraceMs(100, 995, 1000), 0);
assert.deepEqual(Array.from({ length: 8 }, (_, index) => portfolioSeed(index)), [
  0, 7950, 15869, 23788, 31707, 39626, 47545, 55464,
]);
assert.equal(placedTrackCost({ "0,0": "-", "1,0": "NE", __cost: 999 }), 2);
assert.deepEqual(
  inspectPortfolioCandidate({ "0,0": "-", __cost: 1 }, { ok: true, steps: 4 }, 1),
  {
    accepted: true,
    kind: "valid",
    placed: { "0,0": "-" },
    reportedCost: 1,
    actualCost: 1,
    issue: null,
  },
);
assert.equal(
  inspectPortfolioCandidate({ "0,0": "-", __cost: 0 }, { ok: true, steps: 4 }, 1).issue.reason,
  "COST_MISMATCH",
);
assert.equal(
  inspectPortfolioCandidate({ "0,0": "-", __cost: 1 }, { ok: false, reason: "COLLISION" }, 1).kind,
  "candidate-failed",
);
assert.equal(
  inspectPortfolioCandidate({ "0,0": "-", __cost: 1 }, { ok: true, steps: 4 }, 0).accepted,
  true,
);
assert.equal(
  inspectPortfolioCandidate(
    { "0,0": "-", "1,0": "-", __cost: 2 },
    { ok: true, steps: 4 },
    1,
  ).kind,
  "over-limit",
);
assert.equal(workerProofIssue({
  complete: true,
  terminationReason: "optimal-proven",
  finalCost: 1,
}, { best: { cost: 1 } }), null);
assert.equal(workerProofIssue({
  complete: true,
  terminationReason: "optimal-proven",
  finalCost: 1,
}, { best: { cost: 1 }, candidateFailures: [{ reason: "COLLISION" }] }), "candidate-validation-failed");
assert.equal(workerProofIssue({
  complete: true,
  terminationReason: "optimal-proven",
  finalCost: 2,
}, { best: { cost: 1 } }), "candidate-unproven-early-stop");
assert.deepEqual(normalizeCandidateSources(["dfs", "dfs", "p12-pattern-seed"]), ["dfs", "p12-pattern-seed"]);
assert.equal(solvedStatusLabel({ status: "solved", best: { sources: ["dfs"] } }), "solved");
assert.equal(solvedStatusLabel({ status: "solved", best: { sources: ["p12-pattern-seed"] } }), "solved(p12-seed)");
assert.equal(
  solvedStatusLabel({ status: "solved", best: { sources: ["p12-pattern-seed", "dfs"] } }),
  "solved(mixed:dfs+p12-seed)",
);
assert.equal(solvedStatusLabel({ status: "solved", best: {} }), "solved(unknown-source)");

const candidate = {
  status: "solved",
  best: { cost: 9, sources: ["dfs"] },
  complete: false,
  terminationReason: "candidate-unproven-dfs-budget",
  finalCost: 9,
  candidateFailures: [],
  overLimit: [],
};
const exhaustion = {
  status: "search-exhausted",
  best: null,
  complete: true,
  terminationReason: "search-exhausted",
  finalCost: null,
  candidateFailures: [],
  overLimit: [],
};
const timeout = {
  status: "timeout",
  best: null,
  complete: false,
  terminationReason: "wall-clock-timeout",
  finalCost: null,
};

assert.deepEqual(
  classifyPortfolioEvidence([candidate, { status: "cancelled", complete: false }], { fastCandidate: true }),
  {
    status: "solved",
    complete: false,
    terminationReason: "portfolio-first-valid-candidate",
    bestResult: candidate,
    proofResult: null,
  },
);
assert.equal(classifyPortfolioEvidence([candidate, exhaustion]).terminationReason, "portfolio-contract-conflict");
assert.equal(
  classifyPortfolioEvidence([candidate, exhaustion], { fastCandidate: true }).terminationReason,
  "portfolio-contract-conflict",
);
assert.equal(classifyPortfolioEvidence([
  { ...candidate, proofScopeKey: "scope-a" },
  { ...exhaustion, proofScopeKey: "scope-b" },
], { proofScopeKey: "scope-a" }).terminationReason, "candidate-unproven-portfolio");
assert.deepEqual(classifyPortfolioEvidence([timeout, exhaustion]), {
  status: "search-exhausted",
  complete: true,
  terminationReason: "search-exhausted",
  bestResult: null,
  proofResult: exhaustion,
});

const optimal = {
  ...candidate,
  complete: true,
  terminationReason: "optimal-proven",
};
assert.equal(classifyPortfolioEvidence([candidate, optimal]).complete, true);
assert.deepEqual(classifyPortfolioEvidence([candidate, optimal], { fastCandidate: true }), {
  status: "solved",
  complete: true,
  terminationReason: "optimal-proven",
  bestResult: candidate,
  proofResult: optimal,
});
assert.equal(
  classifyPortfolioEvidence([candidate, optimal, exhaustion], { fastCandidate: true }).terminationReason,
  "portfolio-contract-conflict",
);
assert.equal(classifyPortfolioEvidence([
  candidate,
  { ...optimal, overLimit: [{ reportedCost: 10, maxTracks: 9 }] },
]).complete, false);
/* Legacy inference mode (no authoritativeCandidate). Two equal-cost candidates,
   one foreign-domain and one in-domain: the in-domain one is chosen
   deterministically, so its own valid proof stands. This used to depend on which
   result appeared first in the array. */
assert.equal(classifyPortfolioEvidence([
  { ...candidate, proofScopeKey: "scope-b" },
  { ...optimal, proofScopeKey: "scope-a" },
], { proofScopeKey: "scope-a" }).complete, true);
assert.equal(classifyPortfolioEvidence([
  { ...optimal, proofScopeKey: "scope-a" },
  { ...candidate, proofScopeKey: "scope-b" },
], { proofScopeKey: "scope-a" }).complete, true);
assert.equal(classifyPortfolioEvidence([
  { ...candidate, proofScopeKey: "scope-b" },
  { ...optimal, proofScopeKey: "scope-a" },
]).terminationReason, "optimal-proven");
/* An explicit null authoritativeCandidate forbids inference outright: with no
   host-verified candidate there is nothing an optimality proof can be about. */
assert.deepEqual(classifyPortfolioEvidence([
  { ...optimal, proofScopeKey: "scope-a" },
], { proofScopeKey: "scope-a", authoritativeCandidate: null }), {
  status: "incomplete",
  complete: false,
  terminationReason: "portfolio-incomplete",
  bestResult: null,
  proofResult: null,
});
assert.equal(
  classifyPortfolioEvidence([candidate, { ...optimal, best: { cost: 10 }, finalCost: 10 }]).terminationReason,
  "portfolio-proof-mismatch",
);
assert.equal(
  classifyPortfolioEvidence([
    candidate,
    { ...optimal, best: { cost: 10 }, finalCost: 10 },
  ], { fastCandidate: true }).terminationReason,
  "portfolio-proof-mismatch",
);
assert.deepEqual(classifyPortfolioEvidence([timeout]), {
  status: "timeout",
  complete: false,
  terminationReason: "wall-clock-timeout",
  bestResult: null,
  proofResult: null,
});
assert.equal(classifyPortfolioEvidence([
  { status: "budget-exhausted", complete: false, terminationReason: "dfs-iteration-budget" },
  { status: "budget-exhausted", complete: false, terminationReason: "dfs-iteration-budget" },
]).terminationReason, "dfs-iteration-budget");

/* ═══════════ Permutation invariance ═══════════
   The verdict must be a function of the evidence set, never of the order the
   Workers happened to finish in. Every permutation of the same evidence array
   must project to the same verdict. */

function permutations(list) {
  if (list.length <= 1) return [list.slice()];
  const output = [];
  for (let index = 0; index < list.length; index++) {
    const rest = list.slice(0, index).concat(list.slice(index + 1));
    for (const tail of permutations(rest)) output.push([list[index], ...tail]);
  }
  return output;
}

function verdictProjection(evidence) {
  return JSON.stringify({
    status: evidence.status,
    complete: evidence.complete,
    terminationReason: evidence.terminationReason,
    bestCost: evidence.bestResult?.best?.cost ?? null,
    bestScope: evidence.bestResult?.proofScopeKey ?? null,
    proofWorker: evidence.proofResult?.workerIndex ?? null,
  });
}

const optimalProof = (workerIndex, cost, scope) => ({
  status: "solved",
  complete: true,
  terminationReason: "optimal-proven",
  finalCost: cost,
  best: { cost, sources: ["csp"] },
  candidateFailures: [],
  overLimit: [],
  proofScopeKey: scope,
  workerIndex,
});
const plainCandidate = (workerIndex, cost, scope) => ({
  status: "solved",
  complete: false,
  terminationReason: "candidate-unproven-dfs-budget",
  finalCost: cost,
  best: { cost, sources: ["dfs"] },
  candidateFailures: [],
  overLimit: [],
  proofScopeKey: scope,
  workerIndex,
});
const exhaustionProof = (workerIndex, scope) => ({
  status: "search-exhausted",
  complete: true,
  terminationReason: "search-exhausted",
  finalCost: null,
  best: null,
  candidateFailures: [],
  overLimit: [],
  proofScopeKey: scope,
  workerIndex,
});

const PERMUTATION_SETS = [
  {
    name: "scope-a/scope-b 同成本 optimal proof",
    results: [optimalProof(0, 7, "scope-b"), optimalProof(1, 7, "scope-a")],
    options: { proofScopeKey: "scope-a" },
  },
  {
    name: "两个同域同成本 optimal proof",
    results: [optimalProof(2, 7, "scope-a"), optimalProof(1, 7, "scope-a")],
    options: { proofScopeKey: "scope-a" },
  },
  {
    name: "同域 candidate + exhaustion",
    results: [plainCandidate(0, 9, "scope-a"), exhaustionProof(1, "scope-a")],
    options: { proofScopeKey: "scope-a" },
  },
  {
    name: "同域 candidate + 成本不一致 optimal proof",
    results: [plainCandidate(0, 9, "scope-a"), optimalProof(1, 7, "scope-a")],
    options: { proofScopeKey: "scope-a" },
  },
  {
    name: "三方混合：同域候选 + 异域 proof + 同域 proof",
    results: [plainCandidate(0, 9, "scope-a"), optimalProof(1, 9, "scope-b"), optimalProof(2, 9, "scope-a")],
    options: { proofScopeKey: "scope-a" },
  },
];

let permutationCount = 0;
let orderDependentSets = 0;
for (const set of PERMUTATION_SETS) {
  const projections = new Map();
  for (const permutation of permutations(set.results)) {
    permutationCount += 1;
    const projection = verdictProjection(classifyPortfolioEvidence(permutation, set.options));
    if (!projections.has(projection)) {
      projections.set(projection, permutation.map(result => result.workerIndex));
    }
  }
  if (projections.size !== 1) orderDependentSets += 1;
  assert.equal(
    projections.size,
    1,
    `${set.name} 的判定依赖到达顺序：\n${[...projections].map(([p, order]) => `  order=${order} → ${p}`).join("\n")}`,
  );
}
assert.equal(orderDependentSets, 0);
console.log(`  permutation invariance: ${PERMUTATION_SETS.length} evidence sets, ${permutationCount} permutations, ${orderDependentSets} order-dependent`);

console.log("✓ puzzle portfolio contract tests");
