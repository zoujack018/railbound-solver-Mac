import assert from "node:assert/strict";
import {
  classifyPortfolioEvidence,
  normalizeCandidateSources,
  placedTrackCost,
  portfolioSeed,
  solvedStatusLabel,
} from "./puzzle-portfolio.js";

assert.deepEqual(Array.from({ length: 8 }, (_, index) => portfolioSeed(index)), [
  0, 7950, 15869, 23788, 31707, 39626, 47545, 55464,
]);
assert.equal(placedTrackCost({ "0,0": "-", "1,0": "NE", __cost: 999 }), 2);
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
assert.equal(classifyPortfolioEvidence([
  candidate,
  { ...optimal, overLimit: [{ reportedCost: 10, maxTracks: 9 }] },
]).complete, false);
assert.equal(classifyPortfolioEvidence([
  { ...candidate, proofScopeKey: "scope-b" },
  { ...optimal, proofScopeKey: "scope-a" },
], { proofScopeKey: "scope-a" }).complete, false);
assert.equal(
  classifyPortfolioEvidence([candidate, { ...optimal, best: { cost: 10 }, finalCost: 10 }]).terminationReason,
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

console.log("✓ puzzle portfolio contract tests");
