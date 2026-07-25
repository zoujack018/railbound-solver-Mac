export const MAX_PUZZLE_WORKERS = 16;

export function boundedProofGraceMs(configuredMs, elapsedMs, timeoutMs, marginMs = 10) {
  const configured = Number.isFinite(configuredMs) ? Math.max(0, configuredMs) : 0;
  const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  const timeout = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 0;
  const margin = Number.isFinite(marginMs) ? Math.max(0, marginMs) : 0;
  return Math.min(configured, Math.max(0, timeout - elapsed - margin));
}

export function placedTrackCost(solution) {
  return Object.keys(solution || {}).filter(key => key !== "__cost").length;
}

/* Both hosts must derive candidate cost from the placed tracks, not trust the
   Worker's annotation. simulateResult is supplied by the host because this
   module deliberately has no dependency on either rules runtime. */
export function inspectPortfolioCandidate(solution, simulateResult, maxTracks = null) {
  const placed = Object.fromEntries(
    Object.entries(solution || {}).filter(([key]) => key !== "__cost"),
  );
  const reportedCost = solution?.__cost;
  const actualCost = placedTrackCost(placed);
  if (!simulateResult?.ok) {
    return {
      accepted: false,
      kind: "candidate-failed",
      placed,
      reportedCost,
      actualCost,
      issue: {
        reportedCost,
        actualCost,
        reason: simulateResult?.reason || "SIMULATION_FAILED",
        detail: simulateResult?.detail,
      },
    };
  }
  if (reportedCost !== actualCost) {
    return {
      accepted: false,
      kind: "candidate-failed",
      placed,
      reportedCost,
      actualCost,
      issue: {
        reportedCost,
        actualCost,
        reason: "COST_MISMATCH",
        detail: `Worker reported ${reportedCost}; authoritative placed-key count is ${actualCost}`,
      },
    };
  }
  if (Number.isFinite(maxTracks) && maxTracks > 0 && actualCost > maxTracks) {
    return {
      accepted: false,
      kind: "over-limit",
      placed,
      reportedCost,
      actualCost,
      issue: { cost: actualCost, steps: simulateResult.steps, maxTracks },
    };
  }
  return {
    accepted: true,
    kind: "valid",
    placed,
    reportedCost,
    actualCost,
    issue: null,
  };
}

/* A complete claim is tainted by any rejected candidate, over-limit solution,
   missing authoritative candidate, or cost disagreement. Keeping this check
   shared prevents the browser and Node adapters from constructing different
   proof evidence from the same Worker transcript. */
export function workerProofIssue(message, { best = null, candidateFailures = [], overLimit = [] } = {}) {
  if (message?.complete !== true) return null;
  if (candidateFailures.length) return "candidate-validation-failed";
  if (overLimit.length) return "candidate-over-limit";
  if (message.terminationReason === "optimal-proven") {
    return !best || message.finalCost !== best.cost ? "candidate-unproven-early-stop" : null;
  }
  return best ? "candidate-unproven-early-stop" : null;
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

/* ═══════════ Proof scope ═══════════
   A completeness proof only transfers between Workers that searched the same
   domain. The scope key is the canonical identity of that domain: the same data
   must always produce the same string regardless of property insertion order,
   and any search-domain parameter change must produce a different one. Seeds
   only reorder exploration, so they must never enter the key. */

const PROOF_SCOPE_FIELDS = ["maxTracksHint", "minTracks", "requestId", "solverOptions"];

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalize(value, path) {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "string") return JSON.stringify(value);
  if (type === "boolean") return value ? "true" : "false";
  if (type === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`proof scope value at ${path} must be a finite number, received: ${value}`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => canonicalize(item, `${path}[${index}]`)).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort()
      .map(key => `${JSON.stringify(key)}:${canonicalize(value[key], `${path}.${key}`)}`)
      .join(",")}}`;
  }
  const described = type === "object" ? Object.prototype.toString.call(value) : type;
  throw new TypeError(`proof scope value at ${path} is not serializable: ${described}`);
}

export function createProofScopeKey(scope) {
  if (!isPlainObject(scope)) {
    throw new TypeError(`proof scope must be a plain object, received: ${scope === null ? "null" : typeof scope}`);
  }
  /* Only the declared search-domain fields are read, so a stray `seed` or
     `workerIndex` on the caller's object can never widen the scope. */
  return `{${PROOF_SCOPE_FIELDS
    .map(field => `${JSON.stringify(field)}:${canonicalize(scope[field], field)}`)
    .join(",")}}`;
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

/* ═══════════ Deterministic evidence ordering ═══════════
   Every selection below must be a function of the evidence set alone. Sorting
   lives here rather than in the callers so no caller can influence a verdict by
   pre-ordering its results array. All sorts run on filtered copies, so neither
   the input array nor any result object is modified. */

function scopeRank(result, proofScopeKey) {
  return proofScopeKey == null || result.proofScopeKey === proofScopeKey ? 0 : 1;
}

/* Last-resort ordering when results carry no workerIndex: a stable key derived
   from the evidence content, never from array position. */
function identityFallbackKey(result) {
  return [
    result.proofScopeKey ?? "",
    result.status ?? "",
    result.terminationReason ?? "",
    result.finalCost ?? "",
    result.best?.cost ?? "",
  ].join("|");
}

function compareByIdentity(a, b) {
  const aIndexed = Number.isFinite(a.workerIndex);
  const bIndexed = Number.isFinite(b.workerIndex);
  if (aIndexed !== bIndexed) return aIndexed ? -1 : 1;
  if (aIndexed && a.workerIndex !== b.workerIndex) return a.workerIndex - b.workerIndex;
  const aKey = identityFallbackKey(a);
  const bKey = identityFallbackKey(b);
  if (aKey < bKey) return -1;
  return aKey > bKey ? 1 : 0;
}

/* Cheapest first; on a tie the portfolio's own search domain wins, because a
   foreign-domain candidate disqualifies every proof. */
function compareCandidates(a, b, proofScopeKey) {
  return (a.best.cost - b.best.cost)
    || (scopeRank(a, proofScopeKey) - scopeRank(b, proofScopeKey))
    || compareByIdentity(a, b);
}

function pickDeterministic(results, predicate) {
  let picked = null;
  for (const result of results) {
    if (!predicate(result)) continue;
    if (!picked || compareByIdentity(result, picked) < 0) picked = result;
  }
  return picked;
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
export function classifyPortfolioEvidence(results, options = {}) {
  const { fastCandidate = false, proofScopeKey = null } = options;
  const proofEligibleResults = proofScopeKey == null
    ? results
    : results.filter(result => result?.proofScopeKey === proofScopeKey);

  /* `authoritativeCandidate` is three-state and the distinction is the safety
     line of the whole portfolio:
       omitted / undefined — legacy call: infer a candidate from `results`.
       object              — the caller holds a candidate the host re-verified;
                             it is the only authority, and no Worker's
                             self-reported `best` may replace it.
       null                — the caller states there is NO verified candidate;
                             inferring one from `results` is forbidden, so a
                             Worker's self-reported `best` can never become the
                             portfolio's answer. */
  const inferCandidate = options.authoritativeCandidate === undefined;
  const bestResult = inferCandidate
    ? (results
        .filter(result => result?.status === "solved" && result.best)
        .sort((a, b) => compareCandidates(a, b, proofScopeKey))[0] || null)
    : options.authoritativeCandidate;

  if (bestResult) {
    const exhaustionProof = pickDeterministic(proofEligibleResults, hasValidExhaustionProof);
    if (exhaustionProof) {
      return {
        status: "solved",
        complete: false,
        terminationReason: "portfolio-contract-conflict",
        bestResult,
        proofResult: exhaustionProof,
      };
    }
    const bestScopeEligible = proofScopeKey == null || bestResult.proofScopeKey === proofScopeKey;
    const sharesBestScope = result => proofScopeKey != null
      || result?.proofScopeKey === bestResult.proofScopeKey;
    const relevantOptimalProof = predicate => (bestScopeEligible
      ? pickDeterministic(proofEligibleResults, result =>
          hasValidOptimalProof(result) && sharesBestScope(result) && predicate(result))
      : null);

    const matchingProof = relevantOptimalProof(result => result.finalCost === bestResult.best.cost);
    if (matchingProof) {
      return {
        status: "solved",
        complete: true,
        terminationReason: "optimal-proven",
        bestResult,
        proofResult: matchingProof,
      };
    }
    const costMismatchedProof = relevantOptimalProof(result => result.finalCost !== bestResult.best.cost);
    if (costMismatchedProof) {
      return {
        status: "solved",
        complete: false,
        terminationReason: "portfolio-proof-mismatch",
        bestResult,
        proofResult: costMismatchedProof,
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
    const taintedProof = bestScopeEligible
      ? pickDeterministic(proofEligibleResults, result => sharesBestScope(result)
          && result?.complete === true
          && result?.terminationReason === "optimal-proven")
      : null;
    return {
      status: "solved",
      complete: false,
      terminationReason: taintedProof ? "portfolio-proof-mismatch" : "candidate-unproven-portfolio",
      bestResult,
      proofResult: taintedProof,
    };
  }

  const exhaustionProof = pickDeterministic(proofEligibleResults, hasValidExhaustionProof);
  if (exhaustionProof) {
    return {
      status: "search-exhausted",
      complete: true,
      terminationReason: "search-exhausted",
      bestResult: null,
      proofResult: exhaustionProof,
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
