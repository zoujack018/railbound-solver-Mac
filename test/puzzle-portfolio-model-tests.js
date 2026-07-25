import assert from "node:assert/strict";
import { createPortfolioState, reducePortfolioEvent } from "../solver/portfolio-state-machine.js";

/* ═══════════ Deterministic bounded model checker ═══════════
   Exhaustively interleaves Worker completion order, candidate order, proof
   order, cancellation receipts and grace expiry, and compares the production
   reducer against an independent test-only oracle after EVERY event.

   The oracle never imports classifyPortfolioEvidence and never reads reducer
   internals: it restates the proof rules from the contract. No randomness, no
   clock, no Worker, no simulate(), no React, no DOM. */

const PORTFOLIO_SCOPE = "scope-a";
const FOREIGN_SCOPE = "scope-b";
const HIGH_COST = 9;
const LOW_COST = 7;

/* ── Worker terminal-state domain (9 kinds × 2 proof scopes) ── */
const TERMINAL_KINDS = [
  {
    id: "optimal-proven-7",
    build: scope => ({
      status: "solved", complete: true, terminationReason: "optimal-proven",
      finalCost: LOW_COST, best: { cost: LOW_COST, sources: ["csp"], placed: { worker: "opt7" } },
      candidateFailures: [], overLimit: [], proofScopeKey: scope,
    }),
  },
  {
    id: "optimal-proven-9",
    build: scope => ({
      status: "solved", complete: true, terminationReason: "optimal-proven",
      finalCost: HIGH_COST, best: { cost: HIGH_COST, sources: ["csp"], placed: { worker: "opt9" } },
      candidateFailures: [], overLimit: [], proofScopeKey: scope,
    }),
  },
  {
    id: "search-exhausted",
    build: scope => ({
      status: "search-exhausted", complete: true, terminationReason: "search-exhausted",
      finalCost: null, best: null, candidateFailures: [], overLimit: [], proofScopeKey: scope,
    }),
  },
  {
    id: "dfs-iteration-budget",
    build: scope => ({
      status: "budget-exhausted", complete: false, terminationReason: "dfs-iteration-budget",
      finalCost: null, best: null, candidateFailures: [], overLimit: [], proofScopeKey: scope,
    }),
  },
  {
    id: "worker-error",
    build: scope => ({
      status: "error", complete: false, terminationReason: "worker-error",
      finalCost: null, best: null, candidateFailures: [], overLimit: [], proofScopeKey: scope,
    }),
  },
  {
    id: "optimal-proven-tainted-failures",
    build: scope => ({
      status: "solved", complete: true, terminationReason: "optimal-proven",
      finalCost: HIGH_COST, best: { cost: HIGH_COST, sources: ["csp"], placed: { worker: "taintF" } },
      candidateFailures: [{ reason: "COLLISION" }], overLimit: [], proofScopeKey: scope,
    }),
  },
  {
    id: "optimal-proven-tainted-overlimit",
    build: scope => ({
      status: "solved", complete: true, terminationReason: "optimal-proven",
      finalCost: HIGH_COST, best: { cost: HIGH_COST, sources: ["csp"], placed: { worker: "taintO" } },
      candidateFailures: [], overLimit: [{ cost: 12 }], proofScopeKey: scope,
    }),
  },
  {
    id: "optimal-proven-cost-disagreement",
    build: scope => ({
      status: "solved", complete: true, terminationReason: "optimal-proven",
      finalCost: LOW_COST, best: { cost: HIGH_COST, sources: ["csp"], placed: { worker: "disagree" } },
      candidateFailures: [], overLimit: [], proofScopeKey: scope,
    }),
  },
  {
    id: "portfolio-cancelled",
    build: scope => ({
      status: "cancelled", complete: false, terminationReason: "portfolio-cancelled",
      finalCost: null, best: null, candidateFailures: [], overLimit: [], proofScopeKey: scope,
    }),
  },
];

const TERMINALS = [];
for (const kind of TERMINAL_KINDS) {
  for (const scope of [PORTFOLIO_SCOPE, FOREIGN_SCOPE]) {
    TERMINALS.push({ kindId: kind.id, scope, result: kind.build(scope) });
  }
}

function terminalResult(terminal, workerId) {
  return { ...terminal.result, workerIndex: workerId, workerId };
}

/* N=1 and N=2 draw from the complete 18-variant terminal alphabet. For N=3 and
   N=4 each Worker draws a disjoint slice whose union is still the complete
   alphabet, which keeps the settled-result product at 5^4 instead of 18^4
   without dropping a single terminal variant from the run. The union is
   asserted at the end of this file. */
function terminalAlphabet(config, workerId) {
  if (config.workerCount <= 2) return TERMINALS;
  return TERMINALS.filter((_, index) => index % config.workerCount === workerId);
}

function candidateEvent(workerId, cost, source, atMs) {
  return {
    type: "valid-candidate",
    workerId,
    candidate: {
      cost,
      steps: cost * 3,
      placed: { host: cost },
      sources: [source],
      seed: workerId * 7919,
    },
    result: { ok: true, steps: cost * 3 },
    atMs,
  };
}

/* ═══════════ Independent oracle ═══════════ */

function oracleInit(config) {
  return {
    phase: "running",
    winner: null,
    active: [...config.workerIds],
    cancelled: [],
    firstCost: null,
    bestCost: null,
    bestSources: null,
    bestPlaced: null,
    graceStarted: false,
    settled: [],
    evidence: null,
  };
}

function sameScope(result) {
  return result?.proofScopeKey === PORTFOLIO_SCOPE;
}
function untainted(result) {
  return !(result.candidateFailures?.length) && !(result.overLimit?.length);
}

/* A completeness proof of optimality is valid only when the Worker claims it,
   the claim is in the portfolio's own search domain, the claim is untainted,
   and its two cost fields agree with each other. */
function oracleValidOptimal(result) {
  return result?.status === "solved"
    && result.complete === true
    && result.terminationReason === "optimal-proven"
    && Number.isFinite(result.finalCost)
    && result.best != null
    && result.best.cost === result.finalCost
    && sameScope(result)
    && untainted(result);
}

/* A completeness proof of unsolvability is valid only when the Worker walked
   the whole domain, produced no candidate at all, and is untainted. */
function oracleValidExhaustion(result) {
  return result?.status === "search-exhausted"
    && result.complete === true
    && result.terminationReason === "search-exhausted"
    && result.finalCost == null
    && !result.best
    && sameScope(result)
    && untainted(result);
}

/* Any in-domain optimality claim, valid or not. A tainted or disagreeing claim
   may never raise completeness, but it must still be reported as a mismatch
   rather than silently ignored. */
function oracleOptimalClaim(result) {
  return result?.complete === true
    && result.terminationReason === "optimal-proven"
    && sameScope(result);
}

function oracleIncompleteStatus(results) {
  for (const wanted of ["error", "timeout", "budget-exhausted", "over-limit", "candidate-failed"]) {
    if (results.some(result => result.status === wanted)) return wanted;
  }
  return "incomplete";
}

/* Whichever Worker is credited with a proof must be a function of the evidence,
   so the oracle always credits the lowest workerIndex. */
function oraclePick(list) {
  let picked = null;
  for (const result of list) {
    if (!picked || (result.workerIndex ?? Infinity) < (picked.workerIndex ?? Infinity)) picked = result;
  }
  return picked;
}

function oracleEvidence(state) {
  /* One pass over the settled evidence; each contract predicate is still stated
     and evaluated separately, this simply avoids four array traversals per
     event in a checker that runs over a million transitions. */
  const validOptimal = [];
  const validExhaustion = [];
  const optimalClaims = [];
  const results = [];
  for (const entry of state.settled) {
    const result = entry.result;
    results.push(result);
    if (oracleValidOptimal(result)) validOptimal.push(result);
    if (oracleValidExhaustion(result)) validExhaustion.push(result);
    if (oracleOptimalClaim(result)) optimalClaims.push(result);
  }

  /* The ONLY authoritative candidate is one the portfolio accepted through a
     valid-candidate event — i.e. one the host re-verified with simulate().
     A Worker's `done` payload may claim a proof, but its self-reported `best`
     is not a verified solution and can never stand in for one. */
  const authCost = state.bestCost;
  const authPlaced = state.bestPlaced;

  if (authCost != null) {
    const exhaustion = oraclePick(validExhaustion);
    if (exhaustion) {
      return {
        status: "solved", complete: false, terminationReason: "portfolio-contract-conflict",
        bestCost: authCost, bestPlaced: authPlaced, proofWorker: exhaustion.workerIndex ?? null,
      };
    }
    const matching = oraclePick(validOptimal.filter(result => result.finalCost === authCost));
    if (matching) {
      return {
        status: "solved", complete: true, terminationReason: "optimal-proven",
        bestCost: authCost, bestPlaced: authPlaced, proofWorker: matching.workerIndex ?? null,
      };
    }
    const disagreeing = oraclePick(validOptimal.filter(result => result.finalCost !== authCost));
    if (disagreeing) {
      return {
        status: "solved", complete: false, terminationReason: "portfolio-proof-mismatch",
        bestCost: authCost, bestPlaced: authPlaced, proofWorker: disagreeing.workerIndex ?? null,
      };
    }
    const tainted = oraclePick(optimalClaims);
    if (tainted) {
      return {
        status: "solved", complete: false, terminationReason: "portfolio-proof-mismatch",
        bestCost: authCost, bestPlaced: authPlaced, proofWorker: tainted.workerIndex ?? null,
      };
    }
    return {
      status: "solved", complete: false, terminationReason: "candidate-unproven-portfolio",
      bestCost: authCost, bestPlaced: authPlaced, proofWorker: null,
    };
  }

  /* No accepted candidate. Unsolvability can still be proven, because an
     exhaustion proof asserts the absence of any solution and needs no candidate
     to be about. An optimality claim cannot: there is nothing for it to be
     optimal over, so it never raises completeness. */
  const exhaustion = oraclePick(validExhaustion);
  if (exhaustion) {
    return {
      status: "search-exhausted", complete: true, terminationReason: "search-exhausted",
      bestCost: null, bestPlaced: null, proofWorker: exhaustion.workerIndex ?? null,
    };
  }
  const material = results.filter(result => result.status !== "cancelled");
  const allDfsBudget = material.length > 0
    && material.every(result => result.terminationReason === "dfs-iteration-budget");
  return {
    status: oracleIncompleteStatus(results),
    complete: false,
    terminationReason: results.some(result => result.terminationReason === "wall-clock-timeout")
      ? "wall-clock-timeout"
      : (allDfsBudget ? "dfs-iteration-budget" : "portfolio-incomplete"),
    bestCost: null,
    bestPlaced: null,
    proofWorker: null,
  };
}

function oracleFirstValidEvidence(state) {
  return {
    status: "solved", complete: false, terminationReason: "portfolio-first-valid-candidate",
    bestCost: state.bestCost, bestPlaced: state.bestPlaced, proofWorker: null,
  };
}

const ORACLE_DECISIVE = ["optimal-proven", "portfolio-contract-conflict", "portfolio-proof-mismatch"];

function oracleFinish(state, evidence) {
  const cancels = state.active.map(workerId => ({ type: "cancel-worker", workerId }));
  return {
    state: {
      ...state,
      phase: "finished",
      active: [],
      cancelled: [...state.cancelled, ...state.active],
      evidence,
    },
    effects: [...cancels, { type: "finish", evidence }],
  };
}

function oracleMerge(state, workerId, cost, sources, placed) {
  if (state.bestCost == null || cost < state.bestCost) {
    return {
      state: {
        ...state,
        bestCost: cost,
        bestSources: [...sources].sort(),
        bestPlaced: placed,
        firstCost: state.firstCost ?? cost,
      },
      effects: [{ type: "publish-candidate", workerId }],
    };
  }
  if (cost === state.bestCost) {
    return {
      state: { ...state, bestSources: [...new Set([...state.bestSources, ...sources])].sort() },
      effects: [],
    };
  }
  return { state: { ...state }, effects: [] };
}

function oracleReduce(config, state, event) {
  if (state.phase === "finished") return { state: { ...state }, effects: [] };
  if (!config.workerIds.includes(event.workerId)) return { state: { ...state }, effects: [] };

  if (event.type === "valid-candidate") {
    const { cost, sources, placed } = {
      cost: event.candidate.cost,
      sources: event.candidate.sources,
      placed: event.candidate.placed,
    };
    if (!config.expectSolution) {
      if (!state.active.includes(event.workerId)) return { state: { ...state }, effects: [] };
      return oracleMerge(state, event.workerId, cost, sources, placed);
    }
    if (state.phase === "proof-grace") {
      if (event.workerId !== state.winner) return { state: { ...state }, effects: [] };
      return oracleMerge(state, event.workerId, cost, sources, placed);
    }
    if (!state.active.includes(event.workerId)) return { state: { ...state }, effects: [] };

    const losers = state.active.filter(workerId => workerId !== event.workerId);
    const claimed = {
      ...state,
      winner: event.workerId,
      firstCost: cost,
      bestCost: cost,
      bestSources: [...sources].sort(),
      bestPlaced: placed,
      active: [event.workerId],
      cancelled: [...state.cancelled, ...losers],
    };
    const effects = [
      { type: "publish-candidate", workerId: event.workerId },
      ...losers.map(workerId => ({ type: "cancel-worker", workerId })),
    ];
    const evidence = oracleEvidence(claimed);
    if (ORACLE_DECISIVE.includes(evidence.terminationReason)) {
      const finished = oracleFinish(claimed, evidence);
      return { state: finished.state, effects: [...effects, ...finished.effects] };
    }
    if (config.proofGraceMs > 0) {
      return {
        state: { ...claimed, phase: "proof-grace", graceStarted: true },
        effects: [...effects, { type: "start-proof-grace", workerId: event.workerId, delayMs: config.proofGraceMs }],
      };
    }
    const finished = oracleFinish(claimed, oracleFirstValidEvidence(claimed));
    return { state: finished.state, effects: [...effects, ...finished.effects] };
  }

  if (event.type === "worker-done" || event.type === "worker-failed") {
    if (state.settled.some(entry => entry.workerId === event.workerId)) {
      return { state: { ...state }, effects: [] };
    }
    const next = {
      ...state,
      active: state.active.filter(workerId => workerId !== event.workerId),
      settled: [...state.settled, { workerId: event.workerId, result: event.result }],
    };
    if (!next.active.length) return oracleFinish(next, oracleEvidence(next));
    if (next.phase === "proof-grace") {
      const evidence = oracleEvidence(next);
      if (ORACLE_DECISIVE.includes(evidence.terminationReason)) return oracleFinish(next, evidence);
    }
    return { state: next, effects: [] };
  }

  if (event.type === "proof-grace-expired") {
    if (state.phase !== "proof-grace" || event.workerId !== state.winner) {
      return { state: { ...state }, effects: [] };
    }
    return oracleFinish(state, oracleFirstValidEvidence(state));
  }

  return { state: { ...state }, effects: [] };
}

/* ═══════════ Semantic projections ═══════════ */

function sortedUnique(list) {
  return [...new Set(list)].sort((a, b) => a - b);
}

function evidenceProjection(evidence) {
  if (!evidence) return null;
  return {
    status: evidence.status,
    complete: evidence.complete,
    terminationReason: evidence.terminationReason,
    bestCost: evidence.bestCost,
    bestPlaced: evidence.bestPlaced ?? null,
    proofWorker: evidence.proofWorker,
  };
}

function productionEvidenceProjection(evidence) {
  if (!evidence) return null;
  return {
    status: evidence.status,
    complete: evidence.complete,
    terminationReason: evidence.terminationReason,
    bestCost: evidence.bestResult?.best?.cost ?? null,
    bestPlaced: evidence.bestResult?.best?.placed ?? null,
    proofWorker: evidence.proofResult?.workerIndex ?? null,
  };
}

function projectProduction(state) {
  return {
    phase: state.phase,
    winner: state.winnerWorkerId,
    active: [...state.activeWorkerIds].sort((a, b) => a - b),
    cancelled: sortedUnique(state.cancelledWorkerIds),
    firstCost: state.firstCandidate?.cost ?? null,
    bestCost: state.bestCandidate?.cost ?? null,
    bestSources: state.bestCandidate ? [...state.bestCandidate.sources] : null,
    graceStarted: state.graceStarted,
    evidence: productionEvidenceProjection(state.finalEvidence),
  };
}

function projectOracle(state) {
  return {
    phase: state.phase,
    winner: state.winner,
    active: [...state.active].sort((a, b) => a - b),
    cancelled: sortedUnique(state.cancelled),
    firstCost: state.firstCost,
    bestCost: state.bestCost,
    bestSources: state.bestSources ? [...state.bestSources] : null,
    graceStarted: state.graceStarted,
    evidence: evidenceProjection(state.evidence),
  };
}

function projectEffects(effects, evidenceProjector) {
  return effects.map(effect => {
    const projected = { type: effect.type };
    if (effect.workerId !== undefined) projected.workerId = effect.workerId;
    if (effect.delayMs !== undefined) projected.delayMs = effect.delayMs;
    if (effect.type === "finish") projected.evidence = evidenceProjector(effect.evidence);
    return projected;
  });
}

/* Compact comparison keys. Equivalent to comparing the projections field by
   field, but cheap enough to run on every one of the millions of transitions. */
function evidenceKey(evidence) {
  if (!evidence) return "-";
  const placed = evidence.bestPlaced;
  const placedKey = placed ? Object.entries(placed).map(([k, v]) => `${k}=${v}`).join("&") : "-";
  return `${evidence.status},${evidence.complete},${evidence.terminationReason},${evidence.bestCost},${placedKey},${evidence.proofWorker}`;
}

function projectionKey(projection) {
  return `${projection.phase}|${projection.winner}|${projection.active}|${projection.cancelled}`
    + `|${projection.firstCost}|${projection.bestCost}|${projection.bestSources}|${projection.graceStarted}`
    + `|${evidenceKey(projection.evidence)}`;
}

function effectsKey(effects, evidenceProjector) {
  let key = "";
  for (const effect of effects) {
    key += `${effect.type}:${effect.workerId ?? "-"}:${effect.delayMs ?? "-"}`;
    if (effect.type === "finish") key += `:${evidenceKey(evidenceProjector(effect.evidence))}`;
    key += ";";
  }
  return key;
}

/* ═══════════ Counterexample reporting ═══════════ */

class Counterexample extends Error {
  constructor(reason, config, trace, detail) {
    super(reason);
    this.reason = reason;
    this.config = config;
    this.trace = trace;
    this.detail = detail;
  }
}

const counterexamples = [];

function recordCounterexample(reason, config, trace, detail) {
  counterexamples.push({ reason, config, trace, detail });
  throw new Counterexample(reason, config, trace, detail);
}

/* ═══════════ Coverage counters ═══════════ */

const coverage = {
  configs: 0,
  uniqueStates: 0,
  transitions: 0,
  maxDepth: 0,
  eventTypes: {},
  terminalKinds: {},
  finalReasons: {},
  completeTrue: 0,
  completeFalse: 0,
  scopeProofAttempts: { "scope-a": 0, "scope-b": 0 },
  workerCounts: {},
  expectSolutionModes: {},
  graceModes: {},
  cancelEffects: 0,
  publishEffects: 0,
  graceStartEffects: 0,
  p19Checks: 0,
  pairwiseTerminalCasesN3: 0,
  pairwiseTerminalCasesN4: 0,
  n4CandidateAllSettledCases: 0,
  terminalVariantPerWorker: {},
};

function bump(bucket, key) {
  bucket[key] = (bucket[key] || 0) + 1;
}

/* ═══════════ Safety properties 1–18 ═══════════ */

function checkSafety(config, trace, before, output, oracleAfter, acceptedCandidateCosts) {
  const state = output.state;
  const active = state.activeWorkerIds;
  const cancelled = state.cancelledWorkerIds;

  // 3 / 4: no duplicates.
  if (new Set(active).size !== active.length) {
    recordCounterexample("P3 activeWorkerIds 出现重复", config, trace, { active });
  }
  if (new Set(cancelled).size !== cancelled.length) {
    recordCounterexample("P4 cancelledWorkerIds 出现重复", config, trace, { cancelled });
  }
  // 5: disjoint.
  if (active.some(workerId => cancelled.includes(workerId))) {
    recordCounterexample("P5 active 与 cancelled 相交", config, trace, { active, cancelled });
  }
  // 6: finished implies no active worker.
  if (state.phase === "finished" && active.length) {
    recordCounterexample("P6 finished 状态仍有 active Worker", config, trace, { active });
  }
  // 12: only the winner may stay active during proof grace.
  if (state.phase === "proof-grace"
    && (active.length !== 1 || active[0] !== state.winnerWorkerId)) {
    recordCounterexample("P12 proof-grace 中 active 不是唯一 winner", config, trace,
      { active, winner: state.winnerWorkerId });
  }
  // 13 / 14: grace starts at most once and is never restarted.
  const graceStarts = output.effects.filter(effect => effect.type === "start-proof-grace");
  if (graceStarts.length > 1) {
    recordCounterexample("P13 单次事件启动了多次 grace", config, trace, { graceStarts });
  }
  if (graceStarts.length && before.graceStarted) {
    recordCounterexample("P14 grace 被重启", config, trace, { graceStarts });
  }

  const evidence = state.finalEvidence;
  if (evidence) {
    // 7: complete=true only for the two proof verdicts.
    if (evidence.complete === true
      && evidence.terminationReason !== "optimal-proven"
      && evidence.terminationReason !== "search-exhausted") {
      recordCounterexample("P7 complete=true 出现在非证明终止原因", config, trace,
        { terminationReason: evidence.terminationReason });
    }
    const results = oracleAfter.settled.map(entry => entry.result);
    const authCost = evidence.bestResult?.best?.cost ?? null;
    // 8: an optimal-proven completeness claim needs a same-scope, same-cost,
    // untainted proof, independently recomputed by the oracle.
    if (evidence.complete === true && evidence.terminationReason === "optimal-proven") {
      const proof = results.find(result => oracleValidOptimal(result) && result.finalCost === authCost);
      if (!proof) {
        recordCounterexample("P8 optimal-proven complete=true 缺少同域同成本无污点证明", config, trace,
          { authCost, results });
      }
      // 10 / 18: no foreign-scope or tainted evidence may raise completeness.
      if (!sameScope(proof) || !untainted(proof) || proof.best.cost !== proof.finalCost) {
        recordCounterexample("P10/P18 异域或污点证据升级了 complete", config, trace, { proof });
      }
    }
    // 9: an unsolvability claim needs a same-scope exhaustion proof and no candidate.
    if (evidence.complete === true && evidence.terminationReason === "search-exhausted") {
      const proof = results.find(oracleValidExhaustion);
      if (!proof) {
        recordCounterexample("P9 search-exhausted complete=true 缺少同域完备穷尽证明", config, trace, { results });
      }
      if (evidence.bestResult) {
        recordCounterexample("P9 search-exhausted complete=true 却带有候选", config, trace,
          { bestResult: evidence.bestResult });
      }
    }
    /* 19: an optimal-proven completeness claim requires a valid-candidate the
       state machine actually accepted, at the very cost the proof asserts. This
       is derived from the publish-candidate effects seen along the trace, never
       from finalEvidence, so the verdict cannot vouch for itself. */
    if (evidence.complete === true && evidence.terminationReason === "optimal-proven") {
      coverage.p19Checks += 1;
      const provenCost = evidence.proofResult?.finalCost ?? null;
      if (!acceptedCandidateCosts.size) {
        recordCounterexample("P19 无任何被接纳的 valid-candidate 却声明 optimal-proven", config, trace,
          { provenCost });
      } else if (!acceptedCandidateCosts.has(provenCost)) {
        recordCounterexample("P19 optimal-proven 的成本没有对应被接纳的候选", config, trace,
          { provenCost, acceptedCandidateCosts: [...acceptedCandidateCosts] });
      }
    }
    // 17: an equal-cost Worker proof must not replace the host candidate layout.
    if (state.bestCandidate && evidence.bestResult) {
      const layout = evidence.bestResult.best?.placed ?? null;
      if (JSON.stringify(layout) !== JSON.stringify(state.bestCandidate.placed)) {
        recordCounterexample("P17 权威候选的 placed 布局被 Worker 证据替换", config, trace,
          { hostPlaced: state.bestCandidate.placed, evidencePlaced: layout,
            hostCost: state.bestCandidate.cost, evidenceCost: authCost });
      }
    }
  }

  // 11: negative portfolios never cancel or finish before every Worker settles.
  if (!config.expectSolution && before.phase !== "finished") {
    const settledCount = oracleAfter.settled.length;
    const everySettled = settledCount === config.workerIds.length;
    for (const effect of output.effects) {
      if (effect.type === "cancel-worker" && !everySettled) {
        recordCounterexample("P11 负例在全部 Worker 结束前发出 cancel-worker", config, trace, { effect });
      }
      if (effect.type === "finish" && !everySettled) {
        recordCounterexample("P11 负例在全部 Worker 结束前 finish", config, trace, { effect });
      }
    }
  }
}

/* ═══════════ BFS driver ═══════════ */

function stateKey(productionState, plan, precomputedProjection = null) {
  let key = projectionKey(precomputedProjection || projectProduction(productionState));
  for (const entry of productionState.results) {
    const result = entry.result;
    key += `#${entry.workerId},${entry.failed},${result?.status},${result?.terminationReason},`
      + `${result?.finalCost},${result?.best?.cost},${result?.proofScopeKey},`
      + `${result?.candidateFailures?.length ?? 0},${result?.overLimit?.length ?? 0}`;
  }
  for (const workerId of Object.keys(plan)) {
    const budget = plan[workerId];
    key += `@${workerId},${budget.candidates},${budget.lastCandidateCost},${budget.terminal},${budget.terminalScope},${budget.terminalType},${budget.duplicated}`;
  }
  return key;
}

/* Events a node may still fire, given each Worker's remaining budget:
   at most two candidates, one first terminal, one duplicate terminal. */
/* Candidate budget. N=1 and N=2 exercise the full candidate domain (both start
   costs, the 9→7 drop and the equal-cost source merge) at depth 6. For N=3 and
   N=4 the extra Workers exist to multiply *completion interleavings*, so only
   Worker 0 keeps the two-candidate plan there; the remaining Workers contribute
   one candidate each. Both dimensions are asserted at the end of this file. */
function candidateBudget(config, workerId) {
  if (config.workerCount <= 2) return { max: 2, startCosts: [HIGH_COST, LOW_COST] };
  if (workerId === 0) return { max: 2, startCosts: [HIGH_COST] };
  return { max: 1, startCosts: [HIGH_COST] };
}

/* Every event object is built once per config and deep-frozen. Freezing is a
   stronger check than snapshot comparison — a reducer that writes to any part
   of an event throws immediately — and it removes an allocation plus a
   serialization from each of the million-plus transitions. */
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function buildEventCatalog(config) {
  const catalog = { candidates: {}, terminals: {}, duplicates: {}, grace: {} };
  for (const workerId of config.workerIds) {
    catalog.candidates[workerId] = {};
    for (const round of [0, 1]) {
      catalog.candidates[workerId][round] = {};
      for (const cost of [HIGH_COST, LOW_COST]) {
        const source = round === 0 ? "dfs" : "csp";
        catalog.candidates[workerId][round][cost] = deepFreeze(candidateEvent(workerId, cost, source, 100 + round));
      }
    }
    catalog.terminals[workerId] = [];
    catalog.duplicates[workerId] = {};
    for (const terminal of terminalAlphabet(config, workerId)) {
      for (const type of ["worker-done", "worker-failed"]) {
        if (type === "worker-failed" && terminal.kindId !== "worker-error") continue;
        const result = deepFreeze(terminalResult(terminal, workerId));
        catalog.terminals[workerId].push({
          terminal,
          type,
          event: deepFreeze({ type, workerId, result, atMs: 300 }),
        });
        catalog.duplicates[workerId][`${terminal.kindId}|${terminal.scope}|${type}`] =
          deepFreeze({ type, workerId, result, atMs: 400 });
      }
    }
    catalog.grace[workerId] = deepFreeze({ type: "proof-grace-expired", workerId, atMs: 500 });
  }
  return catalog;
}

function availableEvents(config, catalog, node) {
  const events = [];
  for (const workerId of config.workerIds) {
    const budget = node.plan[workerId];
    const limit = candidateBudget(config, workerId);
    if (budget.candidates < limit.max) {
      const previous = budget.lastCandidateCost;
      const costs = previous == null
        ? limit.startCosts
        : (previous === HIGH_COST ? [HIGH_COST, LOW_COST] : [LOW_COST]);
      for (const cost of costs) {
        events.push({
          event: catalog.candidates[workerId][budget.candidates][cost],
          apply: next => {
            next[workerId] = { ...next[workerId], candidates: budget.candidates + 1, lastCandidateCost: cost };
          },
        });
      }
    }
    if (budget.terminal == null) {
      for (const entry of catalog.terminals[workerId]) {
        events.push({
          event: entry.event,
          terminal: entry.terminal,
          apply: next => {
            next[workerId] = {
              ...next[workerId],
              terminal: entry.terminal.kindId,
              terminalScope: entry.terminal.scope,
              terminalType: entry.type,
              duplicated: false,
            };
          },
        });
      }
    } else if (!budget.duplicated && (config.workerCount <= 2 || workerId === 0)) {
      events.push({
        event: catalog.duplicates[workerId][`${budget.terminal}|${budget.terminalScope}|${budget.terminalType}`],
        apply: next => { next[workerId] = { ...next[workerId], duplicated: true }; },
      });
    }
  }
  /* Grace expiry is only meaningful for the winner; one non-winner is kept so
     the "stray expiry is inert" rule is exercised. Firing it for every Worker
     at every step only multiplies no-op transitions. */
  const graceTargets = new Set([config.workerIds[0]]);
  if (node.production.winnerWorkerId != null) graceTargets.add(node.production.winnerWorkerId);
  if (config.workerCount > 1) graceTargets.add(config.workerIds[config.workerCount - 1]);
  for (const workerId of graceTargets) {
    if (node.graceFired[workerId]) continue;
    events.push({ event: catalog.grace[workerId], grace: workerId });
  }
  return events;
}

const POST_FINISH_PROBES = config => [
  candidateEvent(config.workerIds[0], LOW_COST, "dfs", 900),
  { type: "worker-done", workerId: config.workerIds[0], result: terminalResult(TERMINALS[2], config.workerIds[0]), atMs: 900 },
  { type: "worker-failed", workerId: config.workerIds[0], result: terminalResult(TERMINALS[8], config.workerIds[0]), atMs: 900 },
  { type: "proof-grace-expired", workerId: config.workerIds[0], atMs: 900 },
];

function runConfig(config, limits) {
  const seen = new Set();
  const initialProduction = createPortfolioState({
    workerIds: config.workerIds,
    expectSolution: config.expectSolution,
    proofScopeKey: PORTFOLIO_SCOPE,
    proofGraceMs: config.proofGraceMs,
  });
  const initialPlan = {};
  const initialGrace = {};
  for (const workerId of config.workerIds) {
    initialPlan[workerId] = { candidates: 0, lastCandidateCost: null, terminal: null, terminalScope: null, terminalType: null, duplicated: false };
    initialGrace[workerId] = false;
  }
  const queue = [{
    production: initialProduction,
    oracle: oracleInit(config),
    plan: initialPlan,
    graceFired: initialGrace,
    cancelCounts: {},
    acceptedCosts: new Set(),
    trace: [],
  }];
  seen.add(stateKey(initialProduction, initialPlan));

  try {
    exploreQueue(config, limits, queue, seen, buildEventCatalog(config));
  } finally {
    coverage.uniqueStates += seen.size;
  }
}

function exploreQueue(config, limits, queue, seen, catalog) {
  let head = 0;
  while (head < queue.length) {
    const node = queue[head++];
    coverage.maxDepth = Math.max(coverage.maxDepth, node.trace.length);

    if (node.production.phase === "finished") {
      /* Property 15: injecting any event type after finish must be inert. */
      deepFreeze(node.production);
      const finishedKey = projectionKey(projectProduction(node.production));
      for (const probe of POST_FINISH_PROBES(config)) {
        const output = reducePortfolioEvent(node.production, probe);
        coverage.transitions += 1;
        bump(coverage.eventTypes, probe.type);
        if (output.effects.length) {
          recordCounterexample("P15 finished 后仍产生 effects", config, [...node.trace, probe], { effects: output.effects });
        }
        if (projectionKey(projectProduction(output.state)) !== finishedKey) {
          recordCounterexample("P15 finished 后语义投影发生变化", config, [...node.trace, probe], {});
        }
      }
      continue;
    }
    if (node.trace.length >= limits.maxDepth) continue;

    /* Property 1: the input state is deep-frozen before expansion, so any write
       by the reducer throws instead of silently succeeding. Events are frozen in
       the catalog for the same reason. */
    deepFreeze(node.production);
    const beforeProjection = projectProduction(node.production);

    for (const choice of availableEvents(config, catalog, node)) {
      const trace = [...node.trace, choice.event];

      let output;
      try {
        output = reducePortfolioEvent(node.production, choice.event);
      } catch (error) {
        if (error instanceof TypeError && /read only|not extensible|object is not extensible|Cannot add|Cannot assign/i.test(error.message)) {
          recordCounterexample("P1 reducer 修改了冻结的传入 state 或 event", config, trace, { error: error.message });
        }
        throw error;
      }
      const oracleOutput = oracleReduce(config, node.oracle, choice.event);

      coverage.transitions += 1;
      bump(coverage.eventTypes, choice.event.type);
      if (choice.terminal) {
        bump(coverage.terminalKinds, choice.terminal.kindId);
        if (choice.terminal.result.complete === true) {
          coverage.scopeProofAttempts[choice.terminal.scope] += 1;
        }
      }
      for (const effect of output.effects) {
        if (effect.type === "cancel-worker") coverage.cancelEffects += 1;
        if (effect.type === "publish-candidate") coverage.publishEffects += 1;
        if (effect.type === "start-proof-grace") coverage.graceStartEffects += 1;
      }

      // 2: a fresh state object is always returned.
      if (output.state === node.production) {
        recordCounterexample("P2 reducer 返回了同一个 state 对象", config, trace, {});
      }

      const productionProjection = projectProduction(output.state);
      const oracleProjection = projectOracle(oracleOutput.state);
      if (projectionKey(productionProjection) !== projectionKey(oracleProjection)) {
        recordCounterexample("oracle 与 production 状态投影不一致", config, trace,
          { production: productionProjection, oracle: oracleProjection });
      }
      if (effectsKey(output.effects, productionEvidenceProjection)
        !== effectsKey(oracleOutput.effects, evidenceProjection)) {
        recordCounterexample("oracle 与 production effects 不一致", config, trace, {
          production: projectEffects(output.effects, productionEvidenceProjection),
          oracle: projectEffects(oracleOutput.effects, evidenceProjection),
        });
      }

      /* Accepted-candidate facts come from publish-candidate effects, which are
         emitted exactly when the reducer adopts a host-verified candidate. */
      let nextAccepted = node.acceptedCosts;
      for (const effect of output.effects) {
        if (effect.type !== "publish-candidate") continue;
        if (nextAccepted === node.acceptedCosts) nextAccepted = new Set(node.acceptedCosts);
        nextAccepted.add(effect.candidate.cost);
      }

      checkSafety(config, trace, beforeProjection, output, oracleOutput.state, nextAccepted);

      if (output.state.finalEvidence) {
        bump(coverage.finalReasons, output.state.finalEvidence.terminationReason);
        if (output.state.finalEvidence.complete === true) coverage.completeTrue += 1;
        else coverage.completeFalse += 1;
      }

      // 16: a workerId may be cancelled at most once along any single path.
      let nextCancels = node.cancelCounts;
      for (const effect of output.effects) {
        if (effect.type !== "cancel-worker") continue;
        if (nextCancels === node.cancelCounts) nextCancels = { ...node.cancelCounts };
        nextCancels[effect.workerId] = (nextCancels[effect.workerId] || 0) + 1;
        if (nextCancels[effect.workerId] > 1) {
          recordCounterexample("P16 同一个 workerId 被取消多次", config, trace, { counts: nextCancels });
        }
      }

      const nextPlan = { ...node.plan };
      if (choice.apply) choice.apply(nextPlan);
      const nextGrace = choice.grace === undefined
        ? node.graceFired
        : { ...node.graceFired, [choice.grace]: true };

      const key = stateKey(output.state, nextPlan, productionProjection);
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push({
        production: output.state,
        oracle: oracleOutput.state,
        plan: nextPlan,
        graceFired: nextGrace,
        cancelCounts: nextCancels,
        acceptedCosts: nextAccepted,
        trace,
      });
    }
  }
}

const CONFIGS = [];
for (const workerCount of [1, 2, 3, 4]) {
  for (const expectSolution of [true, false]) {
    for (const proofGraceMs of [0, 100]) {
      CONFIGS.push({
        workerIds: Array.from({ length: workerCount }, (_, index) => index),
        workerCount,
        expectSolution,
        proofGraceMs,
      });
    }
  }
}

const started = process.hrtime.bigint();
for (const config of CONFIGS) {
  coverage.configs += 1;
  bump(coverage.workerCounts, String(config.workerCount));
  bump(coverage.expectSolutionModes, String(config.expectSolution));
  bump(coverage.graceModes, String(config.proofGraceMs));
  /* Depth is set so every config can reach a finish through its own longest
     meaningful path: candidates plus one terminal per Worker. Larger N buys
     completion-order breadth rather than extra depth. */
  const maxDepth = { 1: 6, 2: 4, 3: 4, 4: 4 }[config.workerCount];
  try {
    runConfig(config, { maxDepth });
  } catch (error) {
    if (!(error instanceof Counterexample)) throw error;
  }
}

/* ═══════════ Forced replay sequences A–H ═══════════ */

/* ═══════════ Exhaustive pairwise terminal replay ═══════════
   The BFS above slices the terminal alphabet per Worker at N=3 and N=4, so a
   defect needing two specific Workers to emit two specific terminal variants is
   outside its reach. This layer closes exactly that gap: for every ordered
   Worker pair and every one of the 18×18 ordered terminal-variant pairs it
   replays both arrival orders and re-runs the same production/oracle/safety
   comparison. It is exhaustive over pairs, not over the whole state space. */

function noteTerminalVariant(workerCount, workerId, terminal) {
  const key = `N${workerCount}:w${workerId}`;
  if (!coverage.terminalVariantPerWorker[key]) coverage.terminalVariantPerWorker[key] = new Set();
  coverage.terminalVariantPerWorker[key].add(`${terminal.kindId}|${terminal.scope}`);
}

/* Drives a fixed event list through production and oracle in lockstep,
   asserting the projection, the effects and every safety property at each step. */
function replayLockstep(config, events, label) {
  let production = createPortfolioState({
    workerIds: config.workerIds,
    expectSolution: config.expectSolution,
    proofScopeKey: PORTFOLIO_SCOPE,
    proofGraceMs: config.proofGraceMs,
  });
  let oracle = oracleInit(config);
  let accepted = new Set();
  const cancelCounts = {};
  const trace = [];

  for (const event of events) {
    trace.push(event);
    deepFreeze(production);
    deepFreeze(event);
    const beforeProjection = projectProduction(production);
    const output = reducePortfolioEvent(production, event);
    const oracleOutput = oracleReduce(config, oracle, event);
    coverage.transitions += 1;
    bump(coverage.eventTypes, event.type);

    if (projectionKey(projectProduction(output.state)) !== projectionKey(projectOracle(oracleOutput.state))) {
      recordCounterexample(`oracle 与 production 状态投影不一致（${label}）`, config, trace, {
        production: projectProduction(output.state),
        oracle: projectOracle(oracleOutput.state),
      });
    }
    if (effectsKey(output.effects, productionEvidenceProjection)
      !== effectsKey(oracleOutput.effects, evidenceProjection)) {
      recordCounterexample(`oracle 与 production effects 不一致（${label}）`, config, trace, {
        production: projectEffects(output.effects, productionEvidenceProjection),
        oracle: projectEffects(oracleOutput.effects, evidenceProjection),
      });
    }
    for (const effect of output.effects) {
      if (effect.type === "publish-candidate") accepted.add(effect.candidate.cost);
      if (effect.type !== "cancel-worker") continue;
      cancelCounts[effect.workerId] = (cancelCounts[effect.workerId] || 0) + 1;
      if (cancelCounts[effect.workerId] > 1) {
        recordCounterexample(`P16 同一个 workerId 被取消多次（${label}）`, config, trace, { cancelCounts });
      }
    }
    checkSafety(config, trace, beforeProjection, output, oracleOutput.state, accepted);
    production = output.state;
    oracle = oracleOutput.state;
  }
  return production;
}

const pairwiseCoverage = { 3: new Map(), 4: new Map() };

function runPairwiseTerminalReplay() {
  for (const workerCount of [3, 4]) {
    const workerIds = Array.from({ length: workerCount }, (_, index) => index);
    for (const expectSolution of [true, false]) {
      const config = { workerIds, workerCount, expectSolution, proofGraceMs: 100 };
      for (const first of workerIds) {
        for (const second of workerIds) {
          if (first === second) continue;
          const pairKey = `${first}->${second}`;
          if (!pairwiseCoverage[workerCount].has(pairKey)) {
            pairwiseCoverage[workerCount].set(pairKey, new Set());
          }
          const combos = pairwiseCoverage[workerCount].get(pairKey);
          for (const terminalA of TERMINALS) {
            for (const terminalB of TERMINALS) {
              combos.add(`${terminalA.kindId}|${terminalA.scope}#${terminalB.kindId}|${terminalB.scope}`);
              noteTerminalVariant(workerCount, first, terminalA);
              noteTerminalVariant(workerCount, second, terminalB);
              const eventA = { type: "worker-done", workerId: first, result: terminalResult(terminalA, first), atMs: 300 };
              const eventB = { type: "worker-done", workerId: second, result: terminalResult(terminalB, second), atMs: 310 };
              const label = `N${workerCount} ${pairKey} ${terminalA.kindId}/${terminalA.scope} × ${terminalB.kindId}/${terminalB.scope}`;
              replayLockstep(config, [eventA, eventB], `${label} order=AB`);
              replayLockstep(config, [eventB, eventA], `${label} order=BA`);
              const counter = workerCount === 3 ? "pairwiseTerminalCasesN3" : "pairwiseTerminalCasesN4";
              coverage[counter] += 2;
            }
          }
        }
      }
    }
  }
}

/* N=4 negative convergence: one accepted candidate, then all four Workers
   settle, across both candidate costs, both grace settings, every terminal
   variant as a four-Worker sweep, and all 24 settle-order permutations. */
const n4SettleOrders = new Set();
const n4TerminalVariants = new Set();

function permute(list) {
  if (list.length <= 1) return [list.slice()];
  const output = [];
  for (let index = 0; index < list.length; index++) {
    const rest = list.slice(0, index).concat(list.slice(index + 1));
    for (const tail of permute(rest)) output.push([list[index], ...tail]);
  }
  return output;
}

function runN4CandidateAllSettledReplay() {
  const workerIds = [0, 1, 2, 3];
  const orders = permute(workerIds);
  for (const cost of [LOW_COST, HIGH_COST]) {
    for (const proofGraceMs of [0, 100]) {
      const config = { workerIds, workerCount: 4, expectSolution: false, proofGraceMs };
      for (const terminal of TERMINALS) {
        n4TerminalVariants.add(`${terminal.kindId}|${terminal.scope}`);
        for (const order of orders) {
          n4SettleOrders.add(order.join(""));
          const events = [candidateEvent(order[0], cost, "dfs", 100)];
          for (const workerId of order) {
            events.push({ type: "worker-done", workerId, result: terminalResult(terminal, workerId), atMs: 300 });
            noteTerminalVariant(4, workerId, terminal);
          }
          replayLockstep(config, events,
            `N4 negative cost=${cost} grace=${proofGraceMs} ${terminal.kindId}/${terminal.scope} order=${order.join("")}`);
          coverage.n4CandidateAllSettledCases += 1;
        }
      }
    }
  }
}

try {
  runPairwiseTerminalReplay();
} catch (error) {
  if (!(error instanceof Counterexample)) throw error;
}
try {
  runN4CandidateAllSettledReplay();
} catch (error) {
  if (!(error instanceof Counterexample)) throw error;
}
const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

const replayFailures = [];
function replay(name, config, events, expectation) {
  try {
    let state = createPortfolioState({
      workerIds: config.workerIds,
      expectSolution: config.expectSolution,
      proofScopeKey: PORTFOLIO_SCOPE,
      proofGraceMs: config.proofGraceMs,
    });
    const seen = [];
    for (const event of events) {
      const output = reducePortfolioEvent(state, event);
      state = output.state;
      seen.push(...output.effects);
    }
    expectation(state, seen);
  } catch (error) {
    replayFailures.push(`${name}: ${error.message}`);
  }
}

const FOUR = { workerIds: [0, 1, 2, 3], workerCount: 4, expectSolution: true, proofGraceMs: 100 };
const FOUR_NO_GRACE = { ...FOUR, proofGraceMs: 0 };
const FOUR_NEGATIVE = { ...FOUR, expectSolution: false };
const exhaustA = terminalResult(TERMINALS.find(t => t.kindId === "search-exhausted" && t.scope === PORTFOLIO_SCOPE), 0);
const exhaustB = terminalResult(TERMINALS.find(t => t.kindId === "search-exhausted" && t.scope === FOREIGN_SCOPE), 0);
const optimal9A = terminalResult(TERMINALS.find(t => t.kindId === "optimal-proven-9" && t.scope === PORTFOLIO_SCOPE), 0);
const optimal9Winner = terminalResult(TERMINALS.find(t => t.kindId === "optimal-proven-9" && t.scope === PORTFOLIO_SCOPE), 2);

replay("A 同域 search-exhausted 先到 + 候选", FOUR, [
  { type: "worker-done", workerId: 0, result: exhaustA, atMs: 10 },
  candidateEvent(2, HIGH_COST, "dfs", 20),
], (state) => {
  assert.equal(state.phase, "finished");
  assert.equal(state.finalEvidence.terminationReason, "portfolio-contract-conflict");
  assert.equal(state.finalEvidence.complete, false);
});

replay("B 异域 search-exhausted 先到 + 候选", FOUR, [
  { type: "worker-done", workerId: 0, result: exhaustB, atMs: 10 },
  candidateEvent(2, HIGH_COST, "dfs", 20),
], (state, effects) => {
  assert.notEqual(state.finalEvidence?.terminationReason, "portfolio-contract-conflict");
  assert.equal(state.phase, "proof-grace");
  assert.ok(effects.some(effect => effect.type === "start-proof-grace"));
});

replay("B' 异域 search-exhausted + 候选 + grace=0", FOUR_NO_GRACE, [
  { type: "worker-done", workerId: 0, result: exhaustB, atMs: 10 },
  candidateEvent(2, HIGH_COST, "dfs", 20),
], (state) => {
  assert.equal(state.phase, "finished");
  assert.equal(state.finalEvidence.terminationReason, "portfolio-first-valid-candidate");
  assert.equal(state.finalEvidence.complete, false);
});

replay("C 同域 optimal-proven 9 先到 + 候选 9", FOUR, [
  { type: "worker-done", workerId: 0, result: optimal9A, atMs: 10 },
  candidateEvent(2, HIGH_COST, "dfs", 20),
], (state) => {
  assert.equal(state.phase, "finished");
  assert.equal(state.finalEvidence.terminationReason, "optimal-proven");
  assert.equal(state.finalEvidence.complete, true);
});

replay("D 同域 optimal-proven 9 先到 + 候选 7", FOUR, [
  { type: "worker-done", workerId: 0, result: optimal9A, atMs: 10 },
  candidateEvent(2, LOW_COST, "dfs", 20),
], (state) => {
  assert.equal(state.phase, "finished");
  assert.equal(state.finalEvidence.terminationReason, "portfolio-proof-mismatch");
  assert.equal(state.finalEvidence.complete, false);
});

replay("E 候选 9 → 候选 7 → optimal-proven 9", FOUR, [
  candidateEvent(2, HIGH_COST, "dfs", 10),
  candidateEvent(2, LOW_COST, "csp", 20),
  { type: "worker-done", workerId: 2, result: optimal9Winner, atMs: 30 },
], (state) => {
  assert.equal(state.phase, "finished");
  assert.equal(state.finalEvidence.terminationReason, "portfolio-proof-mismatch");
  assert.equal(state.finalEvidence.complete, false);
});

replay("F 候选 9 → loser 取消 → loser 迟到 search-exhausted", FOUR, [
  candidateEvent(2, HIGH_COST, "dfs", 10),
  { type: "worker-done", workerId: 0, result: exhaustA, atMs: 20 },
], (state, effects) => {
  assert.ok(effects.some(effect => effect.type === "cancel-worker" && effect.workerId === 0));
  assert.equal(state.phase, "finished");
  assert.equal(state.finalEvidence.terminationReason, "portfolio-contract-conflict");
  assert.equal(state.finalEvidence.complete, false);
});

replay("G 候选 9 → grace 到期 → finished 后注入 optimal-proven 9", FOUR, [
  candidateEvent(2, HIGH_COST, "dfs", 10),
  { type: "proof-grace-expired", workerId: 2, atMs: 20 },
], (state) => {
  assert.equal(state.phase, "finished");
  assert.equal(state.finalEvidence.terminationReason, "portfolio-first-valid-candidate");
  assert.equal(state.finalEvidence.complete, false);
  const after = reducePortfolioEvent(state, { type: "worker-done", workerId: 2, result: optimal9Winner, atMs: 30 });
  assert.deepEqual(after.effects, []);
  assert.equal(after.state.finalEvidence.terminationReason, "portfolio-first-valid-candidate");
  assert.equal(after.state.finalEvidence.complete, false);
});

replay("H 负例：候选到达但其他 Worker 未结束", FOUR_NEGATIVE, [
  candidateEvent(2, HIGH_COST, "dfs", 10),
  { type: "worker-done", workerId: 0, result: exhaustA, atMs: 20 },
], (state, effects) => {
  assert.equal(state.phase, "running");
  assert.ok(!effects.some(effect => effect.type === "cancel-worker"), "负例不得取消 Worker");
  assert.ok(!effects.some(effect => effect.type === "finish"), "负例不得提前 finish");
  assert.deepEqual(state.activeWorkerIds, [1, 2, 3]);
});

/* ═══════════ Report ═══════════ */

console.log("\nPortfolio model check (bounded BFS + exhaustive pairwise terminal replay)");
console.log(`  bfsConfigs=${coverage.configs}`);
console.log(`  bfsUniqueStates=${coverage.uniqueStates}`);
console.log(`  transitions=${coverage.transitions} (BFS + pairwise replay)`);
console.log(`  maxDepth=${coverage.maxDepth}`);
console.log(`  elapsedMs=${Math.round(elapsedMs)}`);
console.log(`  eventTypes=${JSON.stringify(coverage.eventTypes)}`);
console.log(`  terminalKinds=${JSON.stringify(coverage.terminalKinds)}`);
console.log(`  finalReasons=${JSON.stringify(coverage.finalReasons)}`);
console.log(`  complete=true:${coverage.completeTrue} false:${coverage.completeFalse}`);
console.log(`  scopeProofAttempts=${JSON.stringify(coverage.scopeProofAttempts)}`);
console.log(`  workerCounts=${JSON.stringify(coverage.workerCounts)}`);
console.log(`  expectSolutionModes=${JSON.stringify(coverage.expectSolutionModes)}`);
console.log(`  graceModes=${JSON.stringify(coverage.graceModes)}`);
console.log(`  effects cancel=${coverage.cancelEffects} publish=${coverage.publishEffects} grace=${coverage.graceStartEffects}`);
console.log(`  pairwiseTerminalCasesN3=${coverage.pairwiseTerminalCasesN3}`);
console.log(`  pairwiseTerminalCasesN4=${coverage.pairwiseTerminalCasesN4}`);
console.log(`  n4CandidateAllSettledCases=${coverage.n4CandidateAllSettledCases}`);
console.log(`  n4SettleOrders=${n4SettleOrders.size} n4TerminalVariants=${n4TerminalVariants.size}`);
console.log(`  terminalVariantPerWorker=${JSON.stringify(Object.fromEntries(
  Object.entries(coverage.terminalVariantPerWorker).map(([key, set]) => [key, set.size])))}`);
console.log(`  p19Checks=${coverage.p19Checks}`);
console.log(`  counterexamples=${counterexamples.length}`);

if (counterexamples.length) {
  console.log("\nShortest counterexamples:");
  const byReason = new Map();
  for (const item of counterexamples) {
    if (!byReason.has(item.reason) || item.trace.length < byReason.get(item.reason).trace.length) {
      byReason.set(item.reason, item);
    }
  }
  for (const item of byReason.values()) {
    console.log(`\n  ✗ ${item.reason}`);
    console.log(`    config: ${JSON.stringify({
      workers: item.config.workerCount,
      expectSolution: item.config.expectSolution,
      proofGraceMs: item.config.proofGraceMs,
    })}`);
    console.log(`    trace: ${JSON.stringify(item.trace, null, 2).split("\n").join("\n    ")}`);
    console.log(`    detail: ${JSON.stringify(item.detail, null, 2).split("\n").join("\n    ")}`);
  }
}
if (replayFailures.length) {
  console.log("\nForced replay failures:");
  for (const failure of replayFailures) console.log(`  ✗ ${failure}`);
}

const REQUIRED_TERMINALS = TERMINAL_KINDS.map(kind => kind.id);
const REQUIRED_REASONS = [
  "optimal-proven",
  "search-exhausted",
  "portfolio-contract-conflict",
  "portfolio-proof-mismatch",
  "portfolio-first-valid-candidate",
  "candidate-unproven-portfolio",
];

const assertions = [];
function expect(label, fn) {
  try {
    fn();
    assertions.push({ label, ok: true });
  } catch (error) {
    assertions.push({ label, ok: false, message: error.message });
  }
}

expect("N=1,2,3,4 均有状态", () => {
  for (const n of ["1", "2", "3", "4"]) assert.ok(coverage.workerCounts[n] > 0, `N=${n} 未探索`);
});
expect("expectSolution 两种模式均有状态", () => {
  assert.ok(coverage.expectSolutionModes["true"] > 0);
  assert.ok(coverage.expectSolutionModes["false"] > 0);
});
expect("grace=0 和 grace=100 均有状态", () => {
  assert.ok(coverage.graceModes["0"] > 0);
  assert.ok(coverage.graceModes["100"] > 0);
});
expect("每种 Worker 终态至少执行一次", () => {
  for (const kind of REQUIRED_TERMINALS) {
    assert.ok(coverage.terminalKinds[kind] > 0, `终态 ${kind} 未执行`);
  }
});
expect("每个强制 terminationReason 至少命中一次", () => {
  for (const reason of REQUIRED_REASONS) {
    assert.ok(coverage.finalReasons[reason] > 0, `终止原因 ${reason} 未命中`);
  }
});
expect("BFS 层：每个 N 的逐 Worker 终态字母表并集等于完整 18 变体域（并集完整，非逐 Worker 穷举）", () => {
  for (const workerCount of [1, 2, 3, 4]) {
    const config = { workerCount, workerIds: Array.from({ length: workerCount }, (_, i) => i) };
    const union = new Set();
    for (const workerId of config.workerIds) {
      for (const terminal of terminalAlphabet(config, workerId)) union.add(`${terminal.kindId}|${terminal.scope}`);
    }
    assert.equal(union.size, TERMINALS.length, `N=${workerCount} 的终态并集缺失变体`);
  }
});
expect("scope-a 与 scope-b 证明均被尝试", () => {
  assert.ok(coverage.scopeProofAttempts["scope-a"] > 0);
  assert.ok(coverage.scopeProofAttempts["scope-b"] > 0);
});
expect("pairwise 层：N=3 每个 ordered worker pair 覆盖 18×18 终态组合", () => {
  const pairs = pairwiseCoverage[3];
  assert.equal(pairs.size, 6, `N=3 ordered pair 数应为 6，实际 ${pairs.size}`);
  for (const [pairKey, combos] of pairs) {
    assert.equal(combos.size, TERMINALS.length * TERMINALS.length, `N=3 ${pairKey} 组合数 ${combos.size}`);
  }
});
expect("pairwise 层：N=4 每个 ordered worker pair 覆盖 18×18 终态组合", () => {
  const pairs = pairwiseCoverage[4];
  assert.equal(pairs.size, 12, `N=4 ordered pair 数应为 12，实际 ${pairs.size}`);
  for (const [pairKey, combos] of pairs) {
    assert.equal(combos.size, TERMINALS.length * TERMINALS.length, `N=4 ${pairKey} 组合数 ${combos.size}`);
  }
});
expect("pairwise 层：N=3 与 N=4 的每个 Worker 都执行过全部 18 个终态变体", () => {
  for (const workerCount of [3, 4]) {
    for (let workerId = 0; workerId < workerCount; workerId++) {
      const seen = coverage.terminalVariantPerWorker[`N${workerCount}:w${workerId}`];
      assert.ok(seen, `N${workerCount} worker ${workerId} 无终态记录`);
      assert.equal(seen.size, TERMINALS.length, `N${workerCount} worker ${workerId} 只覆盖 ${seen.size} 个变体`);
    }
  }
});
expect("N=4 负例全收敛回放：候选成本、grace、18 变体与 24 个终止排列全覆盖", () => {
  assert.equal(coverage.n4CandidateAllSettledCases, 2 * 2 * TERMINALS.length * 24,
    `实际 ${coverage.n4CandidateAllSettledCases}`);
  assert.equal(n4SettleOrders.size, 24, `终止顺序排列数 ${n4SettleOrders.size}`);
  assert.equal(n4TerminalVariants.size, TERMINALS.length, `四 Worker 同变体轨迹覆盖 ${n4TerminalVariants.size} 个变体`);
});
expect("P19 至少被检查一次", () => {
  assert.ok(coverage.p19Checks > 0, `p19Checks=${coverage.p19Checks}`);
});
expect("探索转换数不少于 10000", () => {
  assert.ok(coverage.transitions >= 10000, `transitions=${coverage.transitions}`);
});
expect("complete=true 与 complete=false 均出现", () => {
  assert.ok(coverage.completeTrue > 0);
  assert.ok(coverage.completeFalse > 0);
});
expect("强制回放 A–H 全部通过", () => {
  assert.deepEqual(replayFailures, []);
});
expect("反例数为 0", () => {
  assert.equal(counterexamples.length, 0, `counterexamples=${counterexamples.length}`);
});
expect("模型检查时间不超过 3000ms", () => {
  assert.ok(elapsedMs < 3000, `elapsedMs=${Math.round(elapsedMs)}`);
});

const failed = assertions.filter(entry => !entry.ok);
console.log("");
for (const entry of assertions) {
  console.log(`  ${entry.ok ? "✓" : "✗"} ${entry.label}${entry.ok ? "" : ` — ${entry.message}`}`);
}
console.log(`\n═══════════ Portfolio model check: ${assertions.length - failed.length} passed, ${failed.length} failed ═══════════`);
if (failed.length) process.exit(1);
console.log("✓ puzzle portfolio model tests");
