# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

A pure-frontend Railbound puzzle editor, simulator, and solver. Built with React 18, Vite 8, and Web Workers. No backend — puzzle JSON is saved/loaded via the browser's File System Access API (with download fallback).

The app does four things: (1) grid-based level editing, (2) puzzle data validation and serialization, (3) authoritative simulation with structured error reporting, and (4) multi-Worker CSP/DFS portfolio search whose stopping and proof semantics are governed by a pure, host-shared state machine, with main-thread verification of every candidate.

The project has moved from the "rule correctness" phase into the "auditable parallel solver" phase: collision semantics are frozen and canary-protected; the portfolio proof layer is the current focus.

## Commands

```bash
nvm use                    # Node 20.19.0 (.nvmrc)
npm ci                     # Install from lockfile
npm run dev                # Dev server at http://127.0.0.1:5173/
npm test                   # format + portfolio evidence/state-machine/model/integration + canary checks
npm run test:format        # Only format/adapter tests
npm run test:canary        # Only solver soundness canaries (incl. CSP→DFS fallback, P12 checks)
npm run test:puzzles       # Recursive per-puzzle runner (20s default; configurable)
npm run build              # Vite production build (includes module Worker bundling)
npm run check              # test + build (CI gate)
npm run preview            # Preview production build at 127.0.0.1
```

`npm test` runs, in order: `test/format-adapter-tests.js` (15 format assertions),
`test/puzzle-portfolio-tests.js` (pure evidence-helper contract),
`test/puzzle-portfolio-state-machine-tests.js` (pure reducer contract),
`test/puzzle-portfolio-model-tests.js` (bounded model checker, ~1.2M transitions,
production reducer vs an independent oracle after every event),
`test/puzzle-portfolio-integration-tests.js` (spawns the real Node runner on three
fixtures), and `test/canary-tests.js`. To run a single suite, invoke its file with
`node test/<name>.js`. To run a single puzzle, pass a filename pattern:
`npm run test:puzzles -- "7x7-20260722-8-5A"`.

Solver A/B controls for `test:puzzles`:

```bash
CSP_TIMEBOX=on CSP_TIMEBOX_MS=5000 npm run test:puzzles
CSP_PATH_BUDGET=100000 CSP_COMBINATION_BUDGET=5000000 npm run test:puzzles
CSP_TIMEBOX=off npm run test:puzzles       # Disable only the shared P1 guard
P12_PATTERN_SEED=on npm run test:puzzles -- "10x11"
P12_PATTERN_SEED=off npm run test:puzzles -- "10x11"  # Disable the bounded P12 seed
P12_PATTERN_SEED_MS=50 P12_PATTERN_SEED_WORK_BUDGET=1000 npm run test:puzzles -- "10x11"
PUZZLE_WORKERS=8 npm run test:puzzles -- "7x7-20260722-8-5A"
PUZZLE_PROOF_GRACE_MS=0 PUZZLE_WORKERS=8 npm run test:puzzles -- "4x8"
PUZZLE_PROOF_GRACE_MS=100 PUZZLE_WORKERS=8 npm run test:puzzles -- "4x8"
PORTFOLIO_HETEROGENEOUS=off PUZZLE_WORKERS=8 npm run test:puzzles  # Homogeneous A/B
DFS_P7_LOWER_BOUND=off npm run test:puzzles  # Disable the P7 admissible lower bound
CSP_P8_SEGMENTED=off npm run test:puzzles    # Disable P8① segmented waypoint enumeration
DFS_MAX_ITERATIONS=15000000 npm run test:puzzles
```

The Worker default is a conservative shared CSP budget of 5,000 ms, 100,000
enumerated paths, and 5,000,000 combination iterations. `CSP_TIMEBOX=off`
restores the pre-P1 comparison mode; legacy per-enumerator caps and the CSP
beam width remain active. Large puzzles may also try one bounded P12 pattern
candidate (default soft limit 50 ms / 1,000 work units);
`P12_PATTERN_SEED=off` disables it for A/B. P12 is heuristic, must pass
`simulate()`, and never contributes a completeness proof. The canonical Worker
message field is `solverOptions.p12Seed`. True P8 means the
still-unimplemented waypoint/CSP segmented enumeration for 8×8-8-5B.

`PUZZLE_WORKERS` accepts 1..16 and defaults to 1, preserving the old runner path.
For N>1 the portfolio is heterogeneous by default (`PORTFOLIO_HETEROGENEOUS=on`):
Worker 0 keeps the full CSP→DFS pipeline (incl. P12) as a candidate scout, Workers
1..N-1 carry `solverOptions.skipCsp` and go straight to DFS on their own seeds.
`skipCsp` lives in solverOptions, so the two roles own distinct `proofScopeKey`s —
cross-role candidates compare, completeness proofs never transfer. The state
machine's proof domain is the DFS-only role's scope; the CSP role's own proofs
are conservatively dropped. `off` restores the homogeneous portfolio for A/B.
`PUZZLE_PROOF_GRACE_MS` defaults to 100ms; `0` restores immediate stop on first
candidate. Effective grace is capped at the remaining case wall-clock budget
minus a 10ms margin. Keep portfolio wall time separate from summed worker phase
times/nodes; cancelled worker phase times are extrapolated from their last phase
snapshot and carry `phaseTimesExact:false`, while nodes/partial counters remain
lower bounds. Runner first-candidate/wall clocks include startup; Worker-local
candidate time is retained separately. Grace telemetry exposes configured,
effective, actual wait, and outcome fields.

CI runs `npm ci && npm run check` on Node 20 and 22 via GitHub Actions.

## Architecture

```
index.html → main.jsx → railbound-solver-v3.jsx (~860 lines, main editor/orchestrator)
  ├── editor-helpers.js          Default grid size, direction helpers
  ├── PuzzleLibraryDialog.jsx    Save/load dialog
  │   ├── puzzle-library.js      File System Access API, IndexedDB, directory scanning
  │   └── PuzzleThumbnail.jsx    SVG thumbnail renderer
  ├── puzzle-io.js               Trust boundary: normalize, validate, import/export Puzzle v1
  ├── railbound-logic.js         Compatibility re-export (don't add new code here)
  ├── railbound-rules.js (~690L) Authoritative rules, simulate(), reachability, pruning
  ├── solver/
  │   ├── portfolio-state-machine.js  Pure portfolio reducer: when to stop, what may be claimed
  │   └── portfolio-evidence.js       Candidate inspection, proof scope keys, evidence classifier
  └── railbound-worker-code.js   Vite module Worker URL factory
      └── railbound-worker.js          CSP + P12 seed + DFS search, imports rules via ESM
```

The Node runner `test/puzzle-solver-tests.js` (via `test/solver-worker-node.js`)
drives the *same* `solver/portfolio-*` modules as the browser, so the two hosts
cannot drift apart on proof semantics.

### Data flow

**Edit → Simulate:** `buildP()` → `normalizePuzzle()` → `simulate(puzzle, placed)` → history frames + errorCode → SVG playback

**Edit → Solve:** `buildP()` → `filterBlanks()` → N module Workers (CSP or DFS) → candidate → main-thread `simulate()` re-verification → `valid-candidate` event into the portfolio reducer → display only legal solutions

**Library I/O:** directory handle → scan root + `普通/` + `测试/` → `parsePuzzleDocument()` → loadable / preview-only / helper / invalid

### Key module boundaries

- **`puzzle-io.js`** is the trust boundary for all external JSON. `normalizePuzzle()` does strict validation; `parsePuzzleDocument()` handles test fixture unwrapping. New code should never bypass this layer.
- **`railbound-rules.js`** is the single source of truth for game rules. Worker imports it via ESM. All rule changes go here; Worker candidates must always be re-verified by main-thread `simulate()`.
- **`railbound-worker.js`** is the search layer. CSP is candidate generation and
  always falls through to DFS if its shared time/path/combination budget aborts.
  A no-candidate result is a proof only when `complete === true` and
  `terminationReason === "search-exhausted"`.
- **`solver/portfolio-state-machine.js` + `solver/portfolio-evidence.js`** are the
  portfolio proof layer (see below). Treat it as a frozen interface: do not add
  further abstraction; changes require re-running the model checker.

## Portfolio proof layer (solver/)

`createPortfolioState()` / `reducePortfolioEvent()` form a pure reducer with no
access to Workers, timers, clocks, React, `simulate()`, or the DOM. Time,
verified candidates, and Worker final results arrive as events
(`valid-candidate`, `worker-done`, `worker-failed`, `proof-grace-expired`);
side effects leave as declarative effects (`publish-candidate`, `cancel-worker`,
`start-proof-grace`, `finish`). Both hosts must drive this reducer — never
reimplement stop/claim logic in a host.

Invariants that must never be weakened:

- **Only host-verified candidates are authoritative.** A Worker's self-reported
  `best` is never trusted. `classifyPortfolioEvidence()`'s
  `authoritativeCandidate` option is three-state: `undefined` = legacy inference
  from results; an object = the host-verified candidate is the sole authority;
  `null` = the caller asserts no verified candidate exists and inference is
  forbidden. The reducer always passes an explicit object or `null`, which is
  what makes "no accepted `valid-candidate` ⇒ never `optimal-proven` /
  `complete:true` with a solution" hold.
- **Proof scope.** A completeness proof only transfers between Workers that
  searched the same domain. `createProofScopeKey()` canonicalizes exactly
  `maxTracksHint`, `minTracks`, `requestId`, `solverOptions` (order-insensitive,
  strict about non-finite/non-serializable values). Seeds only reorder
  exploration and must never enter the key. Cross-scope candidates may be
  compared; cross-scope completeness proofs must not transfer.
- **Conflict downgrade.** A proof contradicting the verified candidate becomes
  `portfolio-contract-conflict` (exhaustion proof + candidate) or
  `portfolio-proof-mismatch` (optimal proof at a different cost), both
  `complete:false`. Same-scope, same-cost `optimal-proven` beats the
  `portfolio-first-valid-candidate` fallback.
- **Order insensitivity.** Classification must not depend on the arrival order
  of evidence; deterministic tie-breaking lives in the classifier, and the
  reducer keeps no second tie-break.
- **Negative cases never race.** When `expectSolution` is false there is no
  winner/grace path; every Worker must settle before any completeness claim,
  and the answer requires same-domain `complete:true` / `search-exhausted`.
- Positive N>1 flow: first verified candidate cancels losers; the winner may
  continue for the bounded proof grace; lower-cost winner candidates replace,
  equal-cost merge sources, higher-cost drop — none restart grace; a cancelled
  loser's in-flight candidate must not move the winner.

`test/puzzle-portfolio-model-tests.js` model-checks the reducer against an
independent oracle that restates the contract without importing the classifier.
Any portfolio change must keep that oracle honest (the oracle accepting a
Worker-reported best was itself a bug class once) and re-run the full gate.

## Critical domain rules

### Direction semantics (easy to get wrong)
- `cars[].entry` = port the train enters from (opposite of visual facing direction). Editor `facing` converts via `OPPOSITE[facing]` on save.
- `goal_entry` = port required to enter the goal cell.
- Tunnel `facing` = entry port. UI arrows are visually reversed to show "entering from this side."
- Direction fields are frequently inverted between UI, editor state, and rule data. Any new direction logic needs unit tests.

### Zero train (`role: "zero"` or legacy `name: "0"`)
- Participates in movement, collision, and triggers but NOT in arrival order.
- Out-of-bounds or no-matching-track → parks (stops permanently) instead of failing.
- Cannot enter the goal. After all normal trains finish, a safety lookahead runs for `zeroSafetySteps`.

### Dynamic switches and locks
- Color T-switches toggle via same-color triggers. A T-track is locked to whatever state a train entered it with.
- Auto-switches flip after a train leaves.
- `simulate()` and `zeroSafetyLookahead()` share collision/signal logic but still duplicate per-car movement (known tech debt).

### Collision semantics (rules corrected 2026-07-22, author-confirmed; treat as FROZEN unless a canary fails)
- Trains may follow each other one cell apart while both are MOVING — the old TAILING rule was wrong and has been removed (evidence: real-game track limits 9 and 11 were provably unreachable with it, exactly reachable without it).
- A stationary train (pickup wait, barrier-blocked, parked zero) is a WALL: moving into its cell is a CELL_COLLISION. There is NO anticipatory queuing — a queue mechanic was briefly implemented and then reverted after in-game testing (8×8-8-5B: car 4 rear-ending waiting car 3 crashes). Solutions must keep spacing via timing/routing. Regression fixture: test/scratch_test_rearend_4x2.json.
- Adjacent trains swapping cells through the same edge in one step is a SWAP_COLLISION (confirmed via 关卡-7x7-20260722-8-5A). Shared `detectSwapCollision()` in railbound-rules.js is used by simulate, zero lookahead, DFS, and CSP quick-check. Position swaps via tunnels are NOT collisions (no physical crossing). Regression fixture: test/scratch_test_swap_3x3.json.
- Movement resolves in three phases: intended moves → occupancy/swap collision checks → signals fire only for trains that actually moved.

### Platforms
- Platform cells are not road; `dir` points to an adjacent road cell. The assigned car must reach that road cell to pick up passengers.

## Two JSON contracts

**Portable Puzzle v1** (`formatVersion: 1`): the production format. Must pass `normalizePuzzle()`. Coordinates are top-left origin, `x` right, `y` down. Keys use `"x,y"`.

**Test Fixture Document**: wraps a puzzle with `id/name/category/description/puzzle/placed/expected`. Handled by `parsePuzzleDocument()`. May intentionally violate editor constraints (1-row boards, out-of-bounds goals, etc.). Never mix test fixture leniency into production validation.

Compatible field aliases handled on import: `goal_entry`/`goalEntry`, `max_steps`/`maxSteps`, `zero_safety_steps`/`zeroSafetySteps`, `tsw_triggers`/`tswTriggers`, `autoSwitches`/`auto_switches`, plus legacy T-track name mapping.

## Modification checklists

**Changing puzzle format:** Update `PUZZLE_FORMAT_VERSION` only for breaking changes. Ensure `normalizePuzzle()` handles old+new fields. Add round-trip tests.

**Changing rules:** Keep `simulate()` and `zeroSafetyLookahead()` consistent. Verify Worker fast-checks don't diverge. New dynamic state must enter cycle detection and collision logic. Run `npm run check`.

**Changing Worker:** All messages must carry `requestId` via `postToMain()`. Verify old results can't leak after re-solve. Run `npm run build` to confirm module Worker bundling.

**Changing the portfolio proof layer:** Both hosts must keep driving the same reducer. Preserve the three-state `authoritativeCandidate` contract, proof-scope non-transfer, and order insensitivity. Update the model-checker oracle independently of the production classifier (never by importing it), and run the full `npm test` including the three real-runner integration fixtures (4×8 grace=0 fast stop, 4×8 grace retained cost-9 optimal proof, N=4 swap `search-exhausted`).

`done` telemetry includes `cspMs`, `p12SeedMs`, `dfsMs`, `cspStats`, `dfsStats`,
`firstCandidateMs`, `finalCost`, `complete`, and `terminationReason`.
`cspStats` distinguishes skipped CSP, guard aborts (`csp-time-budget`,
`csp-path-budget`, `csp-combination-budget`), path/combination counts, and
overflow. `dfsStats` reports nodes, deepest step/state, iteration-limit state,
and whether DFS completed. `complete:false` means neither optimality nor
unsolvability was proved, even if a legal candidate was found. P12 telemetry is
nested under `cspStats.p12Seed`; a P12 miss or non-applicable template always falls
through to DFS. P12 progress uses phase `p12-seed`; solution source is
`p12-pattern-seed`.

## Roadmap and single-variable discipline

Each optimization round changes exactly one performance variable, measured on
one benchmark puzzle plus one negative-case proof. The seventh round added
portfolio execution; the eighth added bounded portfolio proof grace; the ninth
added the heterogeneous Worker portfolio (Worker 0 CSP→DFS scout, Workers
1..N-1 DFS-only, distinct role `proofScopeKey`s, default on,
`PORTFOLIO_HETEROGENEOUS=off` for A/B — 7×7-8-5A N=8 first candidate
≈5.42s→≈0.45s, ΣCSP ≈40s→≈0.42s; role allocation, not pruning). The tenth
added the P7 admissible cost lower bound in DFS (h = max over unarrived
normal cars of unpaved-blank count on the relaxed shortest path to the
car's next required target; target-side 0-1 BFS fields cached on the
placed-key version; skipped entirely when slack ≥ bs.size so uncapped
first-candidate search pays zero overhead; `DFS_P7_LOWER_BOUND=off` for
A/B — 7×7-8-7A budget 19 nodes −28.8%, budget 20 flips from
budget-truncated `complete:false` to single-run `optimal-proven` within
the default 15M iterations). The eleventh round closed the Barrier static
direction: an applicability probe PROVED the P5② connectivity-freeze prune
can never fire on the current Barrier corpus (all barrier triggers stay
reachable from all cars even with every barrier cell walled — the goals of
7×7-8-7A / 7×8-8-7 are barrier-mouthed and gated by toggle TIMING, which
static pruning cannot shortcut), so it was not implemented; the probe's one
implemented by-product is the P7 goal-entry refinement (relaxed BFS leaves
the goal only via `goal_entry`; benchmark-neutral, kept as a zero-cost
exact-rule tightening, `DFS_P7_GOAL_ENTRY=off` to revert). The twelfth round
implemented P8① segmented waypoint enumeration (`CSP_P8_SEGMENTED=off` to
revert; per-segment/per-entry quota 512, lazy join charged to the shared P1
budget, truncation only ever drops candidates): waypoint-car enumeration
−54%/−65% on 7×7-8-5A, but a terminal diagnostic (244.8M combination
iterations, zero budget/timebox aborts) proved the cross-car combination
layer (beam trim + arrival-order windows + quick-check) still yields ZERO
valid leaves — the wall moved from enumeration to combination. The next
rounds, in order:

The thirteenth round closed the diagnosis: funnel counters (3,645 complete
merge leaves, all genuinely invalid), a zero-false-reject measurement on the
quick check, and an arrival probe on the real 23-track solution (per-car
arrivals 7/23/40/67 vs enumeration windows capped at 21/31/32/33) proved the
**slack windowing is the structural root cause** — funnel-waiting puzzles'
solutions only exist outside minLen+slack, so enumerative CSP (whole-route
or segmented) is structurally unproductive on that family. **P8② admission
for 8×8-8-5B is dead as motivated** (same waiting family); candidate
generation for funnel puzzles belongs to a future P12 generalization
(cycle-family parameterization, a design round) or stays with the DFS
portfolio. The next rounds, in order:

1. **P10 precondition: DFS profile** — measure the per-node hotspot (state-key
   string building is the standing suspect; P7 evaluation adds ~16%) before
   designing any Zobrist/compact encoding.
2. **P12 generalization (cycle families)** — only as a deliberate design
   round, if funnel-puzzle candidates beyond the DFS portfolio are needed.

Historical probe scope: the old P4 probe rejects only the naive string-key LRU,
not Zobrist/P10; the old P5 negative result covers the 10×11 P5① probe only,
not Barrier P5②.

## Context loading strategy

Do not re-read the whole project per task:

- Proof/concurrency tasks: load only `solver/portfolio-*` and their tests.
- Worker strategy tasks: load the Worker core, the Node adapter
  (`test/solver-worker-node.js` + the runner), and the three integration fixtures.
- Collision rules are frozen; open `railbound-rules.js` only if a canary fails.
- `test/SOLVER-REPORT.md` is append-structured by experiment round — read only
  the current round's section, never the whole file.
- Additional background lives in `docs/` (architecture, development,
  puzzle-format, solver-optimization, migration) and the Chinese README.

## Current state and caveats (as of 2026-07-26)

- The `7493164` acceptance gate PASSED (three-state `authoritativeCandidate`,
  both CE-2 orderings, classifier permutation invariance, asserted N=3/N=4
  pairwise coverage all independently verified); the proof layer
  (`solver/portfolio-*`) is FROZEN. Any change requires updating the
  model-checker oracle independently and re-running the full gate.
- Key solver results to preserve: 6×7 17-track optimal; 7×7-8-5A N=8
  heterogeneous ≈0.45s first candidate at cost 23, `complete:false`
  (homogeneous A/B: ≈5.42s); 7×7-8-7A 20-track optimum proven;
  10×11 P12 seed 37 tracks, strictly `complete:false`; 4×8 N=8 retains the
  9-track optimal proof within grace under both portfolio modes.
- A new Git baseline is linked to `zoujack018/railbound-solver-Mac`; history from
  before the 2026-07-22 repository initialization is still unavailable.
- Historical 73 fine-grained rule tests are missing (scripts were lost); do not
  claim they were restored. Current fast coverage is what `npm test` runs (see
  Commands), plus the separately invoked per-puzzle runner.
- P12 currently matches only corpus case 10×11-8-6A. It produces a verified
  37-track/64-step candidate in a few milliseconds but remains `complete:false`;
  organic first-candidate search and optimality proof without P12 are unresolved.
  Score it as `solved(p12-seed)`. Its roughly 370 lines are explicit maintenance
  debt and should be reevaluated if no second corpus case matches.
- Seventh-round 7×7-8-5A baseline: N=1 uses 4,911.13ms CSP + 73,048.59ms DFS,
  reaches 15,000,000 nodes in 77,978ms, and returns no candidate; N=8 with
  grace=0 finds a 26-track/95-step DFS candidate at about 5.45s. Eighth-round
  A/B: grace=0 first/wall 5,433/5,440ms and 5,474/5,480ms at cost 26; default
  100ms grace 5,443/5,550ms and 5,455/5,560ms with ~101ms actual wait and
  observed cost 23, still `complete:false`. That cost improvement is an
  observation, not an optimality proof or repeatability guarantee. The portfolio
  is seed coverage trading CPU for latency — not pruning.
- 7×7-8-7A is a slow Barrier benchmark, not a fast canary: with P7 on, budget
  19 exhausts completely at 7,262,738 nodes in ≈28.6s (P7 off: 10,199,936 /
  ≈35.2s), and budget 20 completes within the default 15M iteration budget at
  14,233,286 nodes (≈56.5s), giving a single-run `optimal-proven` minimum of
  20 (candidate at ≈0.7s). A v3.02 game screenshot supports a 20-rail
  inventory but is not a per-level developer text claim.
- `railbound-solver-v3.jsx` is the largest tech debt: grid state, SVG rendering, solver orchestration, and playback all in one file.
- Dev and preview servers bind to `127.0.0.1` only. Don't use `--host 0.0.0.0` on untrusted networks.
