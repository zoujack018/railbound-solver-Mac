import assert from "node:assert/strict";
import { createProofScopeKey } from "../solver/portfolio-evidence.js";
import { createPortfolioState, reducePortfolioEvent } from "../solver/portfolio-state-machine.js";

/* 纯状态机契约测试。此处没有 Worker、计时器和 simulate()：
   所有时间、候选和 Worker 最终结果都以事件形式传入。 */

const failures = [];
let passed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failures.push({ name, message: error.message });
  }
}

/* 每次 reduce 都断言旧 state / event 未被修改，且返回了新对象。 */
function reduce(state, event) {
  const stateBefore = structuredClone(state);
  const eventBefore = structuredClone(event);
  const output = reducePortfolioEvent(state, event);
  assert.deepEqual(state, stateBefore, "reducer 修改了传入 state");
  assert.deepEqual(event, eventBefore, "reducer 修改了传入 event");
  assert.notEqual(output.state, state, "reducer 必须返回新的 state 对象");
  assert.ok(Array.isArray(output.effects), "effects 必须是数组");
  return output;
}

const WORKERS = [0, 1, 2, 3];

function newState(overrides = {}) {
  return createPortfolioState({
    workerIds: WORKERS,
    expectSolution: true,
    proofScopeKey: "scope-a",
    proofGraceMs: 100,
    ...overrides,
  });
}

function candidateEvent(workerId, cost, { sources = ["dfs"], atMs = 100 } = {}) {
  return {
    type: "valid-candidate",
    workerId,
    candidate: { cost, steps: cost * 3, placed: { "0,0": "-" }, sources, seed: workerId * 7919 },
    result: { ok: true, steps: cost * 3 },
    atMs,
  };
}

function doneEvent(workerId, result, atMs = 300) {
  return { type: "worker-done", workerId, result, atMs };
}

function optimalResult(cost, proofScopeKey = "scope-a") {
  return {
    status: "solved",
    complete: true,
    terminationReason: "optimal-proven",
    finalCost: cost,
    best: { cost, sources: ["dfs"] },
    candidateFailures: [],
    overLimit: [],
    proofScopeKey,
  };
}

function exhaustionResult(proofScopeKey = "scope-a") {
  return {
    status: "search-exhausted",
    complete: true,
    terminationReason: "search-exhausted",
    finalCost: null,
    best: null,
    candidateFailures: [],
    overLimit: [],
    proofScopeKey,
  };
}

function budgetResult(proofScopeKey = "scope-a") {
  return {
    status: "budget-exhausted",
    complete: false,
    terminationReason: "dfs-iteration-budget",
    finalCost: null,
    best: null,
    candidateFailures: [],
    overLimit: [],
    proofScopeKey,
  };
}

function cancelledResult(proofScopeKey = "scope-a") {
  return {
    status: "cancelled",
    complete: false,
    terminationReason: "portfolio-cancelled",
    finalCost: null,
    best: null,
    proofScopeKey,
  };
}

function effectTypes(effects) {
  return effects.map(effect => effect.type);
}

function cancelledIds(effects) {
  return effects.filter(effect => effect.type === "cancel-worker").map(effect => effect.workerId).sort((a, b) => a - b);
}

function finishEffect(effects) {
  return effects.find(effect => effect.type === "finish") || null;
}

/* winner 已固定、grace 已启动的公共起点（序列 2 的结果）。 */
function graceState(cost = 9, winner = 2) {
  return reduce(newState(), candidateEvent(winner, cost)).state;
}

test("1. 首候选 + grace=0：立即取消全部 Worker 并返回未证明的候选", () => {
  const { state, effects } = reduce(newState({ proofGraceMs: 0 }), candidateEvent(2, 9));
  assert.equal(state.phase, "finished");
  assert.equal(state.winnerWorkerId, 2);
  assert.deepEqual(state.activeWorkerIds, []);
  assert.deepEqual([...state.cancelledWorkerIds].sort((a, b) => a - b), [0, 1, 2, 3]);
  assert.equal(effects[0].type, "publish-candidate");
  assert.equal(effects[0].workerId, 2);
  assert.deepEqual(cancelledIds(effects), [0, 1, 2, 3]);
  assert.ok(!effectTypes(effects).includes("start-proof-grace"));
  const finish = finishEffect(effects);
  assert.ok(finish, "缺少 finish effect");
  assert.equal(finish.evidence.status, "solved");
  assert.equal(finish.evidence.complete, false);
  assert.equal(finish.evidence.terminationReason, "portfolio-first-valid-candidate");
  assert.equal(finish.evidence.bestResult.best.cost, 9);
  assert.equal(state.finalEvidence.terminationReason, "portfolio-first-valid-candidate");
});

test("2. 首候选 + grace=100：取消 losers，只保留 winner", () => {
  const { state, effects } = reduce(newState(), candidateEvent(2, 9));
  assert.equal(state.phase, "proof-grace");
  assert.equal(state.winnerWorkerId, 2);
  assert.deepEqual(state.activeWorkerIds, [2]);
  assert.deepEqual([...state.cancelledWorkerIds].sort((a, b) => a - b), [0, 1, 3]);
  assert.deepEqual(cancelledIds(effects), [0, 1, 3]);
  assert.equal(state.firstCandidate.cost, 9);
  assert.equal(state.finalEvidence, null);
  const grace = effects.find(effect => effect.type === "start-proof-grace");
  assert.ok(grace, "缺少 start-proof-grace effect");
  assert.equal(grace.workerId, 2);
  assert.equal(grace.delayMs, 100);
});

test("3. grace 内 winner 给出同成本 optimal proof：complete=true", () => {
  const { state, effects } = reduce(graceState(9), doneEvent(2, optimalResult(9)));
  assert.equal(state.phase, "finished");
  const finish = finishEffect(effects);
  assert.ok(finish, "缺少 finish effect");
  assert.equal(finish.evidence.complete, true);
  assert.equal(finish.evidence.terminationReason, "optimal-proven");
  assert.equal(finish.evidence.bestResult.best.cost, 9);
});

test("4. grace 内先降成本，再给出同成本 proof：complete=true", () => {
  const improved = reduce(graceState(9), candidateEvent(2, 7));
  assert.equal(improved.state.bestCandidate.cost, 7);
  assert.equal(improved.state.phase, "proof-grace");
  assert.ok(!effectTypes(improved.effects).includes("start-proof-grace"), "不得重启证明宽限");
  assert.ok(effectTypes(improved.effects).includes("publish-candidate"));
  const { state, effects } = reduce(improved.state, doneEvent(2, optimalResult(7)));
  assert.equal(state.phase, "finished");
  assert.equal(finishEffect(effects).evidence.complete, true);
  assert.equal(finishEffect(effects).evidence.terminationReason, "optimal-proven");
  assert.equal(finishEffect(effects).evidence.bestResult.best.cost, 7);
});

test("5. grace 内降成本后收到旧成本 proof：portfolio-proof-mismatch", () => {
  const improved = reduce(graceState(9), candidateEvent(2, 7));
  const { state, effects } = reduce(improved.state, doneEvent(2, optimalResult(9)));
  assert.equal(state.phase, "finished");
  assert.equal(finishEffect(effects).evidence.complete, false);
  assert.equal(finishEffect(effects).evidence.terminationReason, "portfolio-proof-mismatch");
});

test("6. 候选与完备无解证明并存：portfolio-contract-conflict", () => {
  const { state, effects } = reduce(graceState(9), doneEvent(0, exhaustionResult()));
  assert.equal(state.phase, "finished");
  assert.equal(finishEffect(effects).evidence.complete, false);
  assert.equal(finishEffect(effects).evidence.terminationReason, "portfolio-contract-conflict");
  assert.deepEqual(cancelledIds(effects), [2], "finish 时应取消仍活跃的 winner");
});

test("7. grace 到期：portfolio-first-valid-candidate", () => {
  const { state, effects } = reduce(graceState(9), { type: "proof-grace-expired", workerId: 2, atMs: 200 });
  assert.equal(state.phase, "finished");
  assert.deepEqual(cancelledIds(effects), [2]);
  assert.equal(finishEffect(effects).evidence.complete, false);
  assert.equal(finishEffect(effects).evidence.terminationReason, "portfolio-first-valid-candidate");
  assert.equal(finishEffect(effects).evidence.bestResult.best.cost, 9);
});

test("8. grace 到期事件重复：第二次无 effects", () => {
  const expired = reduce(graceState(9), { type: "proof-grace-expired", workerId: 2, atMs: 200 });
  const again = reduce(expired.state, { type: "proof-grace-expired", workerId: 2, atMs: 260 });
  assert.deepEqual(again.effects, []);
  assert.deepEqual(again.state, expired.state);
});

test("8b. 非 winner 的 grace 到期事件无效果", () => {
  const state = graceState(9);
  const stray = reduce(state, { type: "proof-grace-expired", workerId: 0, atMs: 180 });
  assert.deepEqual(stray.effects, []);
  assert.equal(stray.state.phase, "proof-grace");
});

test("9. 被取消的 loser 迟到的更低成本候选：忽略", () => {
  const state = graceState(9);
  const late = reduce(state, candidateEvent(0, 3));
  assert.deepEqual(late.effects, []);
  assert.equal(late.state.bestCandidate.cost, 9);
  assert.equal(late.state.winnerWorkerId, 2);
  assert.equal(late.state.phase, "proof-grace");
});

test("10. winner 重复发送同成本候选：合并 sources，不重启 grace", () => {
  const state = graceState(9);
  const repeat = reduce(state, candidateEvent(2, 9, { sources: ["csp"] }));
  assert.deepEqual(repeat.state.bestCandidate.sources, ["csp", "dfs"]);
  assert.deepEqual(repeat.effects, []);
  assert.equal(repeat.state.phase, "proof-grace");
});

test("11. N=4 负例：一个 search-exhausted，其余正常结束 → complete=true", () => {
  let state = createPortfolioState({
    workerIds: WORKERS,
    expectSolution: false,
    proofScopeKey: "scope-a",
    proofGraceMs: 100,
  });
  const outcomes = [budgetResult(), budgetResult(), exhaustionResult(), budgetResult()];
  let lastEffects = [];
  outcomes.forEach((result, workerId) => {
    const output = reduce(state, doneEvent(workerId, result));
    state = output.state;
    lastEffects = output.effects;
    if (workerId < 3) {
      assert.equal(state.phase, "running", `worker ${workerId} 结束后不得提前收敛`);
      assert.deepEqual(output.effects, [], `worker ${workerId} 结束不应产生 effect`);
    }
  });
  assert.equal(state.phase, "finished");
  assert.equal(state.finalEvidence.complete, true);
  assert.equal(state.finalEvidence.terminationReason, "search-exhausted");
  assert.ok(finishEffect(lastEffects), "缺少 finish effect");
});

test("12. 不同 proofScopeKey 的 search-exhausted：不得升级 complete", () => {
  let state = createPortfolioState({
    workerIds: [0, 1],
    expectSolution: false,
    proofScopeKey: "scope-a",
    proofGraceMs: 0,
  });
  state = reduce(state, doneEvent(0, budgetResult("scope-a"))).state;
  const output = reduce(state, doneEvent(1, exhaustionResult("scope-b")));
  assert.equal(output.state.phase, "finished");
  assert.equal(output.state.finalEvidence.complete, false);
  assert.notEqual(output.state.finalEvidence.terminationReason, "search-exhausted");
});

test("13. winner 在 grace 内正常结束但无证明：candidate-unproven-portfolio", () => {
  const { state, effects } = reduce(graceState(9), doneEvent(2, budgetResult()));
  assert.equal(state.phase, "finished");
  assert.equal(finishEffect(effects).evidence.complete, false);
  assert.equal(finishEffect(effects).evidence.terminationReason, "candidate-unproven-portfolio");
});

test("14. 被取消的 loser 结果不会提前结束 grace", () => {
  const output = reduce(graceState(9), doneEvent(1, cancelledResult()));
  assert.equal(output.state.phase, "proof-grace");
  assert.deepEqual(output.effects, []);
});

test("15. 结束后注入任意事件均无 effects 且状态语义不变", () => {
  const finished = reduce(newState({ proofGraceMs: 0 }), candidateEvent(1, 5)).state;
  const injected = [
    candidateEvent(1, 3),
    doneEvent(1, optimalResult(3)),
    { type: "worker-failed", workerId: 2, result: { status: "error", complete: false, terminationReason: "worker-error" }, atMs: 400 },
    { type: "proof-grace-expired", workerId: 1, atMs: 500 },
  ];
  for (const event of injected) {
    const output = reduce(finished, event);
    assert.deepEqual(output.effects, [], `${event.type} 结束后不得产生 effect`);
    assert.deepEqual(output.state, finished, `${event.type} 结束后不得改变状态语义`);
  }
});

test("16. worker-failed 参与最终分类，不提前声明无解", () => {
  let state = createPortfolioState({
    workerIds: [0, 1],
    expectSolution: false,
    proofScopeKey: "scope-a",
    proofGraceMs: 0,
  });
  const first = reduce(state, {
    type: "worker-failed",
    workerId: 0,
    result: { status: "error", complete: false, terminationReason: "worker-error", proofScopeKey: "scope-a" },
    atMs: 120,
  });
  assert.equal(first.state.phase, "running");
  assert.deepEqual(first.effects, []);
  const second = reduce(first.state, doneEvent(1, exhaustionResult()));
  assert.equal(second.state.phase, "finished");
  assert.equal(second.state.finalEvidence.complete, true);
  assert.equal(second.state.finalEvidence.terminationReason, "search-exhausted");
});

test("17. 完备无解证明先到、候选后到：立即报告 contract conflict", () => {
  const first = reduce(newState({ proofGraceMs: 0 }), doneEvent(0, exhaustionResult()));
  assert.equal(first.state.phase, "running");
  const second = reduce(first.state, candidateEvent(2, 9));
  assert.equal(second.state.phase, "finished");
  assert.equal(finishEffect(second.effects).evidence.complete, false);
  assert.equal(finishEffect(second.effects).evidence.terminationReason, "portfolio-contract-conflict");
  assert.ok(!effectTypes(second.effects).includes("start-proof-grace"));
});

test("18. 已结束 Worker 的迟到候选：负例组合不得接纳", () => {
  const initial = createPortfolioState({
    workerIds: [0, 1],
    expectSolution: false,
    proofScopeKey: "scope-a",
    proofGraceMs: 0,
  });
  const first = reduce(initial, doneEvent(0, budgetResult()));
  const late = reduce(first.state, candidateEvent(0, 3));
  assert.deepEqual(late.effects, []);
  assert.equal(late.state.bestCandidate, null);
});

test("19. 同成本 optimal proof 先到、候选后到：直接保留证明", () => {
  const first = reduce(newState(), doneEvent(0, optimalResult(9)));
  assert.equal(first.state.phase, "running");
  const second = reduce(first.state, candidateEvent(2, 9));
  assert.equal(second.state.phase, "finished");
  assert.equal(finishEffect(second.effects).evidence.complete, true);
  assert.equal(finishEffect(second.effects).evidence.terminationReason, "optimal-proven");
  assert.deepEqual(finishEffect(second.effects).evidence.bestResult.best.placed, { "0,0": "-" });
  assert.ok(!effectTypes(second.effects).includes("start-proof-grace"));
});

test("20. 不同证明域的 proof 先到：候选仍进入 grace", () => {
  const first = reduce(newState(), doneEvent(0, exhaustionResult("scope-b")));
  const second = reduce(first.state, candidateEvent(2, 9));
  assert.equal(second.state.phase, "proof-grace");
  assert.equal(second.state.finalEvidence, null);
  assert.ok(effectTypes(second.effects).includes("start-proof-grace"));
});

test("createProofScopeKey：键序无关、数组保序、参数变化改 key、输入不变", () => {
  const a = {
    requestId: "测试/关卡-4x8.json",
    maxTracksHint: 9,
    minTracks: true,
    solverOptions: { cspTimebox: { enabled: true, maxMs: 5000 }, dfsMaxIterations: 15000000 },
  };
  const b = {
    solverOptions: { dfsMaxIterations: 15000000, cspTimebox: { maxMs: 5000, enabled: true } },
    minTracks: true,
    maxTracksHint: 9,
    requestId: "测试/关卡-4x8.json",
  };
  const snapshot = structuredClone(a);
  assert.equal(createProofScopeKey(a), createProofScopeKey(b));
  assert.deepEqual(a, snapshot, "createProofScopeKey 修改了输入");
  assert.notEqual(createProofScopeKey(a), createProofScopeKey({ ...a, maxTracksHint: 10 }));
  assert.notEqual(createProofScopeKey(a), createProofScopeKey({ ...a, requestId: "测试/关卡-5x5.json" }));
  assert.notEqual(createProofScopeKey(a), createProofScopeKey({ ...a, minTracks: false }));
  assert.notEqual(createProofScopeKey(a), createProofScopeKey({ ...a, solverOptions: {} }));
  assert.notEqual(
    createProofScopeKey({ ...a, solverOptions: { order: ["a", "b"] } }),
    createProofScopeKey({ ...a, solverOptions: { order: ["b", "a"] } }),
  );
  assert.equal(
    createProofScopeKey({ ...a, solverOptions: { order: ["a", "b"] } }),
    createProofScopeKey({ ...a, solverOptions: { order: ["a", "b"] } }),
  );
});

test("createProofScopeKey：seed 不进入 proof scope", () => {
  const base = { requestId: "case-1", maxTracksHint: 0, minTracks: true, solverOptions: {} };
  const key = createProofScopeKey(base);
  assert.equal(createProofScopeKey({ ...base, seed: 7919 }), key);
  assert.equal(createProofScopeKey({ ...base, seed: 0, workerIndex: 3 }), key);
  assert.ok(!key.includes("7919"));
  assert.ok(!key.includes("\"seed\""));
});

test("createProofScopeKey：非法值抛 TypeError", () => {
  const base = { requestId: "case-1", maxTracksHint: 0, minTracks: true, solverOptions: {} };
  const bad = [undefined, () => {}, Symbol("s"), 10n, new Date(0), Number.NaN, Number.POSITIVE_INFINITY, new Map(), /re/];
  for (const value of bad) {
    assert.throws(
      () => createProofScopeKey({ ...base, solverOptions: { value } }),
      TypeError,
      `未对 ${String(value)} 抛 TypeError`,
    );
  }
  assert.throws(() => createProofScopeKey({ requestId: "case-1", maxTracksHint: 0, minTracks: true }), TypeError);
  assert.throws(() => createProofScopeKey(null), TypeError);
  assert.throws(() => createProofScopeKey("case-1"), TypeError);
});

console.log(`\n═══════════ Portfolio state machine: ${passed} passed, ${failures.length} failed ═══════════`);
if (failures.length) {
  for (const failure of failures) console.log(`  ✗ ${failure.name}\n      ${failure.message}`);
  process.exit(1);
}
console.log("✓ puzzle portfolio state machine tests");
