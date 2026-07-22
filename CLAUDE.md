# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

A pure-frontend Railbound puzzle editor, simulator, and solver. Built with React 18, Vite 8, and Web Workers. No backend — puzzle JSON is saved/loaded via the browser's File System Access API (with download fallback).

The app does four things: (1) grid-based level editing, (2) puzzle data validation and serialization, (3) authoritative simulation with structured error reporting, and (4) multi-Worker CSP/DFS search with main-thread verification.

## Commands

```bash
nvm use                    # Node 20.19.0 (.nvmrc)
npm ci                     # Install from lockfile
npm run dev                # Dev server at http://127.0.0.1:5173/
npm test                   # Format assertions + 5×5 solver regression
npm run test:format        # Only format/adapter tests
npm run test:puzzles       # All 16 puzzles (20s/puzzle default, set PUZZLE_TIMEOUT_MS to adjust)
npm run build              # Vite production build (includes module Worker bundling)
npm run check              # test + build (CI gate)
npm run preview            # Preview production build at 127.0.0.1
```

Solver A/B controls for `test:puzzles`:

```bash
CSP_TIMEBOX=on CSP_TIMEBOX_MS=5000 npm run test:puzzles
CSP_PATH_BUDGET=100000 CSP_COMBINATION_BUDGET=5000000 npm run test:puzzles
CSP_TIMEBOX=off npm run test:puzzles       # Disable only the shared P1 guard
DFS_MAX_ITERATIONS=15000000 npm run test:puzzles
```

The Worker default is a conservative shared CSP budget of 5,000 ms, 100,000
enumerated paths, and 5,000,000 combination iterations. `CSP_TIMEBOX=off`
restores the pre-P1 comparison mode; legacy per-enumerator caps and the CSP
beam width remain active.

CI runs `npm ci && npm run check` on Node 20 and 22 via GitHub Actions.

## Architecture

```
index.html → main.jsx → railbound-solver-v3.jsx (699 lines, main editor/orchestrator)
  ├── editor-helpers.js          Default grid size, direction helpers
  ├── PuzzleLibraryDialog.jsx    Save/load dialog
  │   ├── puzzle-library.js      File System Access API, IndexedDB, directory scanning
  │   └── PuzzleThumbnail.jsx    SVG thumbnail renderer
  ├── puzzle-io.js               Trust boundary: normalize, validate, import/export Puzzle v1
  ├── railbound-logic.js         Compatibility re-export (don't add new code here)
  ├── railbound-rules.js (661L)  Authoritative rules, simulate(), reachability, pruning
  └── railbound-worker-code.js   Vite module Worker URL factory
      └── railbound-worker.js (1201L)  CSP + DFS search, imports rules via ESM
```

### Data flow

**Edit → Simulate:** `buildP()` → `normalizePuzzle()` → `simulate(puzzle, placed)` → history frames + errorCode → SVG playback

**Edit → Solve:** `buildP()` → `filterBlanks()` → N module Workers (CSP or DFS) → candidate → main-thread `simulate()` re-verification → display only legal solutions

**Library I/O:** directory handle → scan root + `普通/` + `测试/` → `parsePuzzleDocument()` → loadable / preview-only / helper / invalid

### Key module boundaries

- **`puzzle-io.js`** is the trust boundary for all external JSON. `normalizePuzzle()` does strict validation; `parsePuzzleDocument()` handles test fixture unwrapping. New code should never bypass this layer.
- **`railbound-rules.js`** is the single source of truth for game rules. Worker imports it via ESM. All rule changes go here; Worker candidates must always be re-verified by main-thread `simulate()`.
- **`railbound-worker.js`** is the search layer. CSP is candidate generation and
  always falls through to DFS if its shared time/path/combination budget aborts.
  A no-candidate result is a proof only when `complete === true` and
  `terminationReason === "search-exhausted"`.

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

### Collision semantics (rules corrected 2026-07-22, author-confirmed)
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

`done` telemetry includes `cspMs`, `dfsMs`, `cspStats`, `dfsStats`,
`firstCandidateMs`, `finalCost`, `complete`, and `terminationReason`.
`cspStats` distinguishes skipped CSP, guard aborts (`csp-time-budget`,
`csp-path-budget`, `csp-combination-budget`), path/combination counts, and
overflow. `dfsStats` reports nodes, deepest step/state, iteration-limit state,
and whether DFS completed. `complete:false` means neither optimality nor
unsolvability was proved, even if a legal candidate was found.

## Current state and caveats

- A new Git baseline is linked to `zoujack018/railbound-solver-Mac`; history from
  before the 2026-07-22 repository initialization is still unavailable.
- Historical 73 fine-grained rule tests are missing (scripts were lost). Current fast coverage: 15 format tests, 10 solver soundness canaries, 2 forced CSP→DFS fallback protocol checks, plus the separately invoked per-puzzle Worker runner. See `test/SOLVER-REPORT.md` for solve pass/fail status.
- `railbound-solver-v3.jsx` is the largest tech debt: grid state, SVG rendering, solver orchestration, and playback all in one file.
- Dev and preview servers bind to `127.0.0.1` only. Don't use `--host 0.0.0.0` on untrusted networks.
