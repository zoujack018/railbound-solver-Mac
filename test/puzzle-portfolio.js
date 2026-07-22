export const MAX_PUZZLE_WORKERS = 16;

export function placedTrackCost(solution) {
  return Object.keys(solution || {}).filter(key => key !== "__cost").length;
}

export function portfolioSeed(workerIndex) {
  if (!Number.isInteger(workerIndex) || workerIndex < 0) {
    throw new Error(`workerIndex must be a non-negative integer, received: ${workerIndex}`);
  }
  return workerIndex === 0 ? 0 : workerIndex * 7919 + 31;
}

export function normalizeCandidateSources(sources) {
  const normalized = [...new Set((Array.isArray(sources) ? sources : [sources])
    .filter(source => typeof source === "string" && source.trim())
    .map(source => source.trim()))];
  return normalized.length ? normalized.sort() : ["unknown-source"];
}

export function solvedStatusLabel(result) {
  if (result?.status !== "solved") return result?.status || "unknown";
  const sources = normalizeCandidateSources(result.best?.sources);
  const display = sources.map(source => source === "p12-pattern-seed" ? "p12-seed" : source);
  if (display.length === 1 && (display[0] === "dfs" || display[0] === "csp")) return "solved";
  if (display.length === 1) return `solved(${display[0]})`;
  return `solved(mixed:${display.join("+")})`;
}

function hasValidExhaustionProof(result) {
  return result?.status === "search-exhausted"
    && result.complete === true
    && result.terminationReason === "search-exhausted"
    && result.finalCost == null
    && !result.best
    && !(result.candidateFailures?.length)
    && !(result.overLimit?.length);
}

function hasValidOptimalProof(result) {
  return result?.status === "solved"
    && result.complete === true
    && result.terminationReason === "optimal-proven"
    && Number.isFinite(result.finalCost)
    && result.best?.cost === result.finalCost
    && !(result.candidateFailures?.length)
    && !(result.overLimit?.length);
}

function preferredIncompleteStatus(results) {
  if (results.some(result => result.status === "error")) return "error";
  if (results.some(result => result.status === "timeout")) return "timeout";
  if (results.some(result => result.status === "budget-exhausted")) return "budget-exhausted";
  if (results.some(result => result.status === "over-limit")) return "over-limit";
  if (results.some(result => result.status === "candidate-failed")) return "candidate-failed";
  return "incomplete";
}

/* Pure portfolio proof classifier. Worker-local telemetry and candidates enter
   as immutable evidence; no top-level proof field is inherited via object
   spread from an arbitrary worker. */
export function classifyPortfolioEvidence(results, { fastCandidate = false, proofScopeKey = null } = {}) {
  const proofEligibleResults = proofScopeKey == null
    ? results
    : results.filter(result => result?.proofScopeKey === proofScopeKey);
  const candidates = results
    .filter(result => result?.status === "solved" && result.best)
    .sort((a, b) => a.best.cost - b.best.cost);
  const bestResult = candidates[0] || null;
  const exhaustionProofs = proofEligibleResults.filter(hasValidExhaustionProof);
  const optimalProofs = proofEligibleResults.filter(hasValidOptimalProof);

  if (bestResult) {
    if (exhaustionProofs.length) {
      return {
        status: "solved",
        complete: false,
        terminationReason: "portfolio-contract-conflict",
        bestResult,
        proofResult: exhaustionProofs[0],
      };
    }
    if (fastCandidate) {
      return {
        status: "solved",
        complete: false,
        terminationReason: "portfolio-first-valid-candidate",
        bestResult,
        proofResult: null,
      };
    }
    const bestScopeEligible = proofScopeKey == null || bestResult.proofScopeKey === proofScopeKey;
    const matchingProof = bestScopeEligible
      ? optimalProofs.find(result => result.finalCost === bestResult.best.cost)
      : null;
    if (matchingProof) {
      return {
        status: "solved",
        complete: true,
        terminationReason: "optimal-proven",
        bestResult,
        proofResult: matchingProof,
      };
    }
    const mismatchedProof = optimalProofs[0] || proofEligibleResults.find(result =>
      result?.complete === true && result?.terminationReason === "optimal-proven");
    return {
      status: "solved",
      complete: false,
      terminationReason: mismatchedProof ? "portfolio-proof-mismatch" : "candidate-unproven-portfolio",
      bestResult,
      proofResult: mismatchedProof || null,
    };
  }

  if (exhaustionProofs.length) {
    return {
      status: "search-exhausted",
      complete: true,
      terminationReason: "search-exhausted",
      bestResult: null,
      proofResult: exhaustionProofs[0],
    };
  }

  const materialResults = results.filter(result => result?.status !== "cancelled");
  const allDfsBudget = materialResults.length > 0 && materialResults.every(result =>
    result?.terminationReason === "dfs-iteration-budget");
  return {
    status: preferredIncompleteStatus(results),
    complete: false,
    terminationReason: results.some(result => result?.terminationReason === "wall-clock-timeout")
      ? "wall-clock-timeout"
      : (allDfsBudget ? "dfs-iteration-budget" : "portfolio-incomplete"),
    bestResult: null,
    proofResult: null,
  };
}
