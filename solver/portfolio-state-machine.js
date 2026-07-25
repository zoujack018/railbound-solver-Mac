import { classifyPortfolioEvidence, normalizeCandidateSources } from "./portfolio-evidence.js";

/* ═══════════ Pure portfolio orchestration ═══════════
   This module owns *when* a portfolio stops and *what* it is allowed to claim.
   It has no access to Workers, timers, clocks, React, simulate() or the DOM:
   the current time, every main-thread-verified candidate and every Worker final
   result arrive as events, and every side effect leaves as a declarative
   effect. Both the browser and the Node runner drive the same reducer so the
   two hosts cannot drift apart on proof semantics. */

const FIRST_VALID_CANDIDATE = "portfolio-first-valid-candidate";

/* Evidence that settles the portfolio no matter which Worker produced it. */
const DECISIVE_TERMINATION_REASONS = new Set([
  "optimal-proven",
  "portfolio-contract-conflict",
  "portfolio-proof-mismatch",
]);

export function createPortfolioState(config = {}) {
  const { workerIds, expectSolution, proofScopeKey = null, proofGraceMs = 0 } = config;
  if (!Array.isArray(workerIds) || !workerIds.length) {
    throw new TypeError("createPortfolioState requires a non-empty workerIds array");
  }
  const grace = Number.isFinite(proofGraceMs) && proofGraceMs > 0 ? proofGraceMs : 0;
  return {
    phase: "running",
    workerIds: [...workerIds],
    activeWorkerIds: [...workerIds],
    cancelledWorkerIds: [],
    winnerWorkerId: null,
    firstCandidate: null,
    bestCandidate: null,
    results: [],
    proofScopeKey,
    proofGraceMs: grace,
    expectSolution: expectSolution !== false,
    graceStarted: false,
    finalEvidence: null,
  };
}

export function reducePortfolioEvent(state, event) {
  if (!state || typeof state !== "object") {
    throw new TypeError("reducePortfolioEvent requires a portfolio state object");
  }
  if (!event || typeof event !== "object" || typeof event.type !== "string") {
    throw new TypeError("reducePortfolioEvent requires an event object with a string type");
  }
  if (state.phase === "finished") return inert(state);
  switch (event.type) {
    case "valid-candidate": return reduceValidCandidate(state, event);
    case "worker-done": return reduceWorkerSettled(state, event, false);
    case "worker-failed": return reduceWorkerSettled(state, event, true);
    case "proof-grace-expired": return reduceProofGraceExpired(state, event);
    default: return inert(state);
  }
}

/* A no-op still returns a fresh object: callers may hold the previous state. */
function inert(state) {
  return { state: { ...state }, effects: [] };
}

function normalizeCandidate(event) {
  const candidate = event.candidate;
  if (!candidate || typeof candidate !== "object" || !Number.isFinite(candidate.cost)) return null;
  return {
    workerId: event.workerId,
    cost: candidate.cost,
    steps: Number.isFinite(candidate.steps) ? candidate.steps : null,
    placed: candidate.placed ?? null,
    sources: normalizeCandidateSources(candidate.sources ?? candidate.source),
    seed: candidate.seed ?? null,
    atMs: Number.isFinite(event.atMs) ? event.atMs : null,
  };
}

/* The state machine's own candidate is the authority: it is the one the host
   already re-verified with simulate(). It enters classification as evidence so
   a Worker proof is always compared against the verified cost, never against
   the Worker's self-reported one. */
function candidateEvidenceResult(state) {
  const best = state.bestCandidate;
  if (!best) return null;
  return {
    status: "solved",
    complete: false,
    terminationReason: "candidate-unproven-portfolio",
    finalCost: best.cost,
    best: { cost: best.cost, steps: best.steps, placed: best.placed, sources: best.sources },
    candidateFailures: [],
    overLimit: [],
    proofScopeKey: state.proofScopeKey,
    workerId: best.workerId,
    workerIndex: best.workerId,
    seed: best.seed,
  };
}

function classify(state, fastCandidate) {
  const results = state.results.map(entry => entry.result).filter(Boolean);
  const candidateEvidence = candidateEvidenceResult(state);
  return classifyPortfolioEvidence(candidateEvidence ? [...results, candidateEvidence] : results, {
    fastCandidate,
    proofScopeKey: state.proofScopeKey,
  });
}

function firstValidCandidateEvidence(state) {
  return {
    status: "solved",
    complete: false,
    terminationReason: FIRST_VALID_CANDIDATE,
    bestResult: candidateEvidenceResult(state),
    proofResult: null,
  };
}

function finishWith(state, evidence) {
  const cancels = state.activeWorkerIds.map(workerId => ({ type: "cancel-worker", workerId }));
  return {
    state: {
      ...state,
      phase: "finished",
      activeWorkerIds: [],
      cancelledWorkerIds: [...state.cancelledWorkerIds, ...state.activeWorkerIds],
      finalEvidence: evidence,
    },
    effects: [...cancels, { type: "finish", evidence }],
  };
}

/* Lower cost replaces the best candidate and is republished; equal cost only
   merges sources; higher cost is dropped. None of these restart proof grace. */
function mergeCandidate(state, candidate) {
  const best = state.bestCandidate;
  if (!best || candidate.cost < best.cost) {
    return {
      state: {
        ...state,
        bestCandidate: candidate,
        firstCandidate: state.firstCandidate ?? candidate,
      },
      effects: [{ type: "publish-candidate", workerId: candidate.workerId, candidate }],
    };
  }
  if (candidate.cost === best.cost) {
    return {
      state: {
        ...state,
        bestCandidate: { ...best, sources: normalizeCandidateSources([...best.sources, ...candidate.sources]) },
      },
      effects: [],
    };
  }
  return inert(state);
}

function reduceValidCandidate(state, event) {
  const candidate = normalizeCandidate(event);
  if (!candidate || !state.workerIds.includes(event.workerId)) return inert(state);

  /* Negative cases never race: every Worker must finish before the portfolio
     may say anything about completeness. */
  if (!state.expectSolution) return mergeCandidate(state, candidate);

  if (state.phase === "proof-grace") {
    /* A cancelled loser's in-flight candidate must not move the winner. */
    if (event.workerId !== state.winnerWorkerId) return inert(state);
    return mergeCandidate(state, candidate);
  }

  if (!state.activeWorkerIds.includes(event.workerId)) return inert(state);

  const losers = state.activeWorkerIds.filter(workerId => workerId !== event.workerId);
  const claimed = {
    ...state,
    winnerWorkerId: event.workerId,
    firstCandidate: candidate,
    bestCandidate: candidate,
    activeWorkerIds: [event.workerId],
    cancelledWorkerIds: [...state.cancelledWorkerIds, ...losers],
  };
  const effects = [
    { type: "publish-candidate", workerId: event.workerId, candidate },
    ...losers.map(workerId => ({ type: "cancel-worker", workerId })),
  ];

  if (state.proofGraceMs > 0) {
    return {
      state: { ...claimed, phase: "proof-grace", graceStarted: true },
      effects: [...effects, { type: "start-proof-grace", workerId: event.workerId, delayMs: state.proofGraceMs }],
    };
  }
  const finished = finishWith(claimed, firstValidCandidateEvidence(claimed));
  return { state: finished.state, effects: [...effects, ...finished.effects] };
}

function reduceWorkerSettled(state, event, failed) {
  if (!state.workerIds.includes(event.workerId)) return inert(state);
  if (state.results.some(entry => entry.workerId === event.workerId)) return inert(state);

  const result = event.result ?? (failed
    ? { status: "error", complete: false, terminationReason: "worker-error" }
    : null);
  const next = {
    ...state,
    activeWorkerIds: state.activeWorkerIds.filter(workerId => workerId !== event.workerId),
    results: [...state.results, {
      workerId: event.workerId,
      failed,
      atMs: Number.isFinite(event.atMs) ? event.atMs : null,
      result,
    }],
  };

  if (!next.activeWorkerIds.length) return finishWith(next, classify(next, false));

  if (next.phase === "proof-grace") {
    const evidence = classify(next, false);
    if (DECISIVE_TERMINATION_REASONS.has(evidence.terminationReason)) return finishWith(next, evidence);
  }
  return { state: next, effects: [] };
}

function reduceProofGraceExpired(state, event) {
  if (state.phase !== "proof-grace" || event.workerId !== state.winnerWorkerId) return inert(state);
  return finishWith(state, firstValidCandidateEvidence(state));
}
