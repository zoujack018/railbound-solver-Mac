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
- **`railbound-worker.js`** is the search layer. "No solution found" means budget exhausted, not mathematically proven unsolvable.

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

### Following and queuing (rules corrected 2026-07-22, author-confirmed)
- Trains may follow each other one cell apart — the old TAILING rule was wrong and has been removed (evidence: real-game track limits 9/11/16 were provably unreachable with it, exactly reachable without it).
- A train whose target cell is occupied by a non-moving train (parked, waiting, barrier-blocked, queued) waits in place; queuing cascades. Movement resolves in three phases: intended moves → fixpoint demotion → signals fire only for trains that actually moved.
- Adjacent trains swapping cells in the same step is still allowed (open question — the real game likely crashes; no current fixture depends on it).

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

## Current state and caveats

- No git repository. Treat file changes carefully — no rollback available.
- Historical 73 fine-grained rule tests are missing (scripts were lost). Current coverage: 15 format tests + 5×5 solver regression + per-puzzle Worker execution. See `test/SOLVER-REPORT.md` for solve pass/fail status.
- `railbound-solver-v3.jsx` is the largest tech debt: grid state, SVG rendering, solver orchestration, and playback all in one file.
- Dev and preview servers bind to `127.0.0.1` only. Don't use `--host 0.0.0.0` on untrusted networks.
