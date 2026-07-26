/* railbound-worker.js — Solver Worker (real ES module, imported by Vite).
 * All game rules come from the shared Rule Layer (railbound-rules.js).
 * This file contains ONLY search-layer logic: CSP, DFS, path enumeration.
 */
import {
  TRACKS, OPPOSITE, DELTA, ALL_DIRS, T_TRACKS, TRACK_NAMES,
  pk, exitPort,
  TRACKS_BY_ENTRY, BASIC_BY_ENTRY, TRACKS_BY_EXIT,
  buildTunnelMap, buildTSwitchMap, buildAutoSwitchMap,
  effectiveTSwitchTrack, effectiveAutoSwitchTrack, effectiveTrackAt,
  tswitchTrackVariants, occupiedBarrierColors,
  buildPlatformState, platformPickupForCar, carNeedsPassengers, allPlatformsServed,
  isZeroCar, requiredOrder, zeroSafetySteps, zeroSafetyLookahead, detectSwapCollision,
  simulate, filterBlanks,
  blockedCellsForCar, carWaypoints,
  puzzleHasDynamicState,
} from "./railbound-rules.js";

let activeRequestId = null;
function postToMain(message) {
  self.postMessage({ ...message, requestId: activeRequestId });
}

// ═══════════ Search-layer constants ═══════════

const MAX_PATHS = 10000;
const MAX_ENUM_ITERS = 4000000;
const PATH_SLACK = 6;
const MAX_ALTERNATES = 5;
const CSP_BEAM_WIDTH = 2000;
const DEFAULT_CSP_TIMEBOX = Object.freeze({
  enabled: true,
  maxMs: 5000,
  maxPaths: 100000,
  maxCombinations: 5000000,
});
const DEFAULT_P12_SEED = Object.freeze({
  enabled: true,
  maxMs: 50,
  maxWorkUnits: 1000,
});
const DEFAULT_DFS_MAX_ITERATIONS = 15000000;

function elapsedMs(startedAt) {
  return performance.now() - startedAt;
}

function finiteBudget(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function normalizeCspTimebox(raw = {}) {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: value.enabled !== false,
    maxMs: finiteBudget(value.maxMs, DEFAULT_CSP_TIMEBOX.maxMs),
    maxPaths: finiteBudget(value.maxPaths, DEFAULT_CSP_TIMEBOX.maxPaths),
    maxCombinations: finiteBudget(value.maxCombinations, DEFAULT_CSP_TIMEBOX.maxCombinations),
  };
}

function normalizeP12Seed(raw = {}) {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: value.enabled !== false,
    maxMs: finiteBudget(value.maxMs, DEFAULT_P12_SEED.maxMs),
    maxWorkUnits: finiteBudget(value.maxWorkUnits, DEFAULT_P12_SEED.maxWorkUnits),
  };
}

function createP12SeedStats(config) {
  return {
    enabled: config.enabled,
    config: { ...config },
    attempted: false,
    applicable: false,
    skipped: false,
    skipReason: null,
    cycleFamilies: 0,
    layoutAttempts: 0,
    routeEdges: 0,
    usageMerges: 0,
    fullLeaves: 0,
    workUnits: 0,
    simulateCalls: 0,
    candidateFound: false,
    generatedCost: null,
    elapsedMs: 0,
    complete: false,
    truncated: false,
    terminationReason: "not-run",
  };
}

function createCspGuard(rawConfig, telemetry = null) {
  const config = normalizeCspTimebox(rawConfig);
  const startedAt = performance.now();
  let timePolls = 0;
  const stats = {
    attempted: false,
    skipped: false,
    skipReason: null,
    timeboxEnabled: config.enabled,
    config: { ...config },
    aborted: false,
    abortReason: null,
    pathIterations: 0,
    pathsEnumerated: 0,
    pathsRetained: 0,
    pathsByCar: {},
    combinationIterations: 0,
    overflow: false,
    overflowReasons: [],
  };

  function abort(reason) {
    if (!stats.aborted) {
      stats.aborted = true;
      stats.abortReason = reason;
    }
    return true;
  }
  function checkTime(force = false) {
    if (stats.aborted) return true;
    if (!config.enabled) return false;
    timePolls += 1;
    if ((force || (timePolls & 1023) === 0) && elapsedMs(startedAt) >= config.maxMs) {
      return abort("csp-time-budget");
    }
    return false;
  }
  function carStats(name) {
    const key = String(name);
    if (!stats.pathsByCar[key]) {
      stats.pathsByCar[key] = {
        invocations: 0,
        pathIterations: 0,
        pathsEnumerated: 0,
        pathsRetained: 0,
        overflow: false,
        overflowReasons: [],
      };
    }
    return stats.pathsByCar[key];
  }
  function addOverflow(reason, name = null) {
    stats.overflow = true;
    if (!stats.overflowReasons.includes(reason)) stats.overflowReasons.push(reason);
    if (name !== null) {
      const cs = carStats(name);
      cs.overflow = true;
      if (!cs.overflowReasons.includes(reason)) cs.overflowReasons.push(reason);
    }
  }
  function beginCar(name) {
    carStats(name).invocations += 1;
  }
  function notePathIteration(name) {
    if (stats.aborted) return true;
    stats.pathIterations += 1;
    carStats(name).pathIterations += 1;
    if (stats.pathIterations % 100000 === 0) {
      postToMain({
        type: "progress",
        phase: "csp",
        iters: 0,
        cspMs: telemetry?.cspStartedAt ? elapsedMs(telemetry.cspStartedAt) : (telemetry?.cspMs || 0),
        dfsMs: telemetry?.dfsMs || 0,
        cspStats: snapshot(),
      });
    }
    return checkTime();
  }
  function notePath(name) {
    if (stats.aborted) return true;
    stats.pathsEnumerated += 1;
    carStats(name).pathsEnumerated += 1;
    if (config.enabled && stats.pathsEnumerated >= config.maxPaths) abort("csp-path-budget");
    return stats.aborted;
  }
  function noteRetained(name, count) {
    stats.pathsRetained += count;
    carStats(name).pathsRetained += count;
  }
  function noteCombination() {
    if (stats.aborted) return true;
    stats.combinationIterations += 1;
    if (stats.combinationIterations % 100000 === 0) {
      postToMain({
        type: "progress",
        phase: "csp",
        iters: 0,
        cspMs: telemetry?.cspStartedAt ? elapsedMs(telemetry.cspStartedAt) : (telemetry?.cspMs || 0),
        dfsMs: telemetry?.dfsMs || 0,
        cspStats: snapshot(),
      });
    }
    if (config.enabled && stats.combinationIterations >= config.maxCombinations) return abort("csp-combination-budget");
    return checkTime();
  }
  function snapshot() {
    const pathsByCar = {};
    for (const [name, value] of Object.entries(stats.pathsByCar)) {
      pathsByCar[name] = { ...value, overflowReasons: [...value.overflowReasons] };
    }
    return {
      ...stats,
      config: { ...stats.config },
      pathsByCar,
      overflowReasons: [...stats.overflowReasons],
    };
  }
  return {
    config,
    stats,
    abort,
    checkTime,
    beginCar,
    notePathIteration,
    notePath,
    noteRetained,
    noteCombination,
    addOverflow,
    snapshot,
  };
}

function emitCandidate(solution, telemetry, source, metrics = {}) {
  const candidateMs = elapsedMs(telemetry.startedAt);
  if (telemetry.firstCandidateMs === null) telemetry.firstCandidateMs = candidateMs;
  postToMain({ type: "solution", solution, candidateMs, source, ...metrics });
}

/* P12 bounded pattern seed for one large four-platform/four-car funnel family.
   Its parameterized route topology was inspired by an externally verified
   layout, so this is deliberately a narrow pattern library entry, not a
   general-purpose enumerator. It matches relative puzzle structure and embeds no
   file name, absolute board coordinate, literal placed track, or known cost.
   It can never prove completeness; every materialized layout is accepted only
   after authoritative simulate(). */
function p12SeedLine(a, b) {
  const dx = Math.sign(b[0] - a[0]), dy = Math.sign(b[1] - a[1]);
  if (dx && dy) return null;
  const out = [[a[0], a[1]]];
  let x = a[0], y = a[1];
  while (x !== b[0] || y !== b[1]) {
    x += dx; y += dy; out.push([x, y]);
  }
  return out;
}

function p12SeedChain(...points) {
  const out = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const segment = p12SeedLine(points[i], points[i + 1]);
    if (!segment) return null;
    out.push(...(i ? segment.slice(1) : segment));
  }
  return out;
}

function p12SeedAppend(base, suffix) {
  if (!base?.length || !suffix?.length) return null;
  const end = base[base.length - 1], start = suffix[0];
  if (end[0] !== start[0] || end[1] !== start[1]) return null;
  return [...base, ...suffix.slice(1)];
}

function p12SeedPlatformTarget(platform) {
  const dir = platform.dir || platform.facing || platform.direction || "E";
  if (!DELTA[dir]) return null;
  return {
    car: String(platform.car ?? platform.carName ?? platform.name ?? platform.demand ?? ""),
    x: platform.target?.x ?? platform.x + DELTA[dir][0],
    y: platform.target?.y ?? platform.y + DELTA[dir][1],
  };
}

function deriveP12SeedTemplate(pz) {
  const reject = reason => ({ applicable: false, reason });
  const cars = (pz.cars || []).filter(car => !isZeroCar(car)).sort((a, b) => a.y - b.y || a.x - b.x);
  const targets = (pz.platforms || []).map(p12SeedPlatformTarget);
  const autos = pz.autoSwitches || pz.auto_switches || [];
  if (cars.length !== 4 || targets.length !== 4 || targets.some(target => !target) || autos.length !== 1) {
    return reject("requires-four-cars-platforms-and-one-auto");
  }
  targets.sort((a, b) => a.y - b.y || a.x - b.x);
  const points = [
    ...cars.map(car => [car.x, car.y]),
    ...targets.map(target => [target.x, target.y]),
    ...autos.map(auto => [auto.x, auto.y]),
    pz.goal,
  ];
  if (points.some(point => !Array.isArray(point) || point.length < 2
      || !Number.isInteger(point[0]) || !Number.isInteger(point[1])
      || point[0] < 0 || point[0] >= pz.width || point[1] < 0 || point[1] >= pz.height)) {
    return reject("invalid-or-out-of-bounds-coordinates");
  }
  if (new Set(cars.map(car => car.x)).size !== 1 || new Set(targets.map(target => target.x)).size !== 1) {
    return reject("requires-aligned-starts-and-platform-targets");
  }
  if (new Set(cars.map(car => car.y)).size !== 4 || new Set(targets.map(target => target.y)).size !== 4) {
    return reject("requires-distinct-start-and-platform-rows");
  }
  if (!cars.every(car => car.entry === "W")) return reject("requires-west-entry-starts");
  if ((pz.tunnels || []).length || (pz.triggers || []).length || (pz.barriers || []).length
      || (pz.tswitches || []).length || (pz.tsw_triggers || pz.tswTriggers || []).length) {
    return reject("unsupported-dynamic-or-tunnel-features");
  }

  const [c0, c1, c2, c3] = cars;
  const [t0, t1, t2, t3] = targets;
  const sx = c0.x, px = t0.x, auto = autos[0];
  const goalEntry = pz.goalEntry || pz.goal_entry;
  const goalExit = OPPOSITE[goalEntry];
  const autoMap = buildAutoSwitchMap([auto]);
  const autoSwitch = autoMap[pk(auto.x, auto.y)];
  if (!autoSwitch || !goalExit) return reject("invalid-auto-or-goal");

  const cycleFamilies = [];
  const autoTracks = [autoSwitch.track, autoSwitch.pair];
  for (const directEntry of ALL_DIRS) {
    const exits = autoTracks.map(track => exitPort(track, directEntry));
    for (let directPhase = 0; directPhase < exits.length; directPhase++) {
      const divertPhase = 1 - directPhase;
      if (exits[directPhase] === goalExit && exits[divertPhase] && exits[divertPhase] !== goalExit) {
        cycleFamilies.push({ directEntry, directPhase, divertPhase, divertExit: exits[divertPhase] });
      }
    }
  }
  const family = cycleFamilies.find(value => value.directEntry === "N" && value.divertExit === "S");
  if (!family) return reject("no-canonical-auto-cycle");
  if (auto.x + DELTA[goalExit][0] !== pz.goal[0] || auto.y + DELTA[goalExit][1] !== pz.goal[1]) {
    return reject("auto-not-adjacent-to-goal");
  }

  const expectedOwners = [c3, c1, c2, c0].map(car => String(car.name));
  if (targets.some((target, index) => target.car !== expectedOwners[index])) {
    return reject("platform-ownership-pattern-mismatch");
  }
  if (!(c0.y === t0.y + 1 && c1.y === t1.y && c2.y === t2.y && c3.y === t3.y - 1)) {
    return reject("platform-row-pattern-mismatch");
  }
  if (!(t2.y - t1.y === 2 && c3.y - c2.y === 2)) return reject("row-spacing-pattern-mismatch");
  if (!(px - sx === 4 && auto.x - px === 4 && auto.y === t1.y + 1 && auto.y === t2.y - 1)) {
    return reject("column-or-funnel-pattern-mismatch");
  }

  const left = sx + 1, center = sx + 2, platformLeft = px - 1;
  const platformRight = px + 1, funnelLeft = auto.x - 1;
  const upperGap = t1.y + 1, lowerGap = t2.y + 1;
  const lower = p12SeedChain(
    [left, t1.y], [left, upperGap], [center, upperGap], [center, t2.y], [left, t2.y],
    [left, lowerGap], [center, lowerGap], [center, t3.y], [platformRight, t3.y],
    [platformRight, c3.y], [platformLeft, c3.y], [platformLeft, t2.y], [funnelLeft, t2.y],
    [funnelLeft, t1.y], [auto.x, t1.y], [auto.x, auto.y],
  );
  const topTour = p12SeedChain(
    [left, t1.y], [platformLeft, t1.y], [platformLeft, t0.y], [platformRight, t0.y],
    [platformRight, t1.y], [left, t1.y],
  );
  const prefixes = [
    p12SeedChain([sx, c0.y], [platformLeft, c0.y], [platformLeft, t0.y], [platformRight, t0.y], [platformRight, t1.y], [left, t1.y]),
    p12SeedChain([sx, c1.y], [platformLeft, c1.y], [platformLeft, t0.y], [platformRight, t0.y], [platformRight, t1.y], [left, t1.y]),
    p12SeedChain([sx, c2.y], [center, c2.y], [center, upperGap], [left, upperGap], [left, t1.y]),
    p12SeedChain([sx, c3.y], [left, c3.y], [left, c2.y], [center, c2.y], [center, upperGap], [left, upperGap], [left, t1.y]),
  ];
  const loop = p12SeedChain(
    [auto.x, auto.y], [auto.x, lowerGap], [funnelLeft, lowerGap],
    [funnelLeft, t1.y], [auto.x, t1.y], [auto.x, auto.y],
  );
  if (!lower || !topTour || prefixes.some(prefix => !prefix) || !loop) return reject("route-construction-failed");
  const routes = new Map([
    [String(c0.name), p12SeedAppend(prefixes[0], lower)],
    [String(c1.name), p12SeedAppend(prefixes[1], lower)],
    [String(c2.name), p12SeedAppend(p12SeedAppend(prefixes[2], topTour), lower)],
    [String(c3.name), p12SeedAppend(p12SeedAppend(prefixes[3], topTour), lower)],
  ]);
  if ([...routes.values()].some(route => !route)) return reject("route-merge-failed");
  return { applicable: true, cars, routes, loop, auto, family, cycleFamilies: cycleFamilies.length };
}

function p12SeedDirection(a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  for (const dir of ALL_DIRS) if (DELTA[dir][0] === dx && DELTA[dir][1] === dy) return dir;
  return null;
}

function addP12SeedTrace(usages, coordinates, initialEntry, auto) {
  let entry = initialEntry;
  for (let i = 0; i + 1 < coordinates.length; i++) {
    const [x, y] = coordinates[i], exit = p12SeedDirection(coordinates[i], coordinates[i + 1]);
    if (!exit) return false;
    const k = pk(x, y);
    if (x !== auto.x || y !== auto.y) {
      const list = usages.get(k) || [];
      if (!list.some(value => value.entry === entry && value.exit === exit)) list.push({ entry, exit });
      usages.set(k, list);
    }
    entry = OPPOSITE[exit];
  }
  return true;
}

function solveP12PatternSeed(pz, maxCost, config, stats) {
  const startedAt = performance.now();
  stats.attempted = true;
  function stopForBudget(reason) {
    stats.truncated = true;
    stats.truncationReason = reason;
    stats.terminationReason = reason;
    return null;
  }
  function consume(count) {
    stats.workUnits += count;
    if (config.enabled && stats.workUnits > config.maxWorkUnits) return stopForBudget("p12-seed-work-budget");
    if (config.enabled && elapsedMs(startedAt) >= config.maxMs) return stopForBudget("p12-seed-time-budget");
    return true;
  }
  try {
    const derived = deriveP12SeedTemplate(pz);
    if (!derived.applicable) {
      stats.skipped = true;
      stats.skipReason = derived.reason;
      stats.terminationReason = "template-not-applicable";
      return null;
    }
    stats.applicable = true;
    stats.cycleFamilies = derived.cycleFamilies;
    stats.layoutAttempts += 1;
    const routeEdges = [...derived.routes.values()].reduce((sum, route) => sum + route.length - 1, 0)
      + derived.loop.length - 1;
    stats.routeEdges = routeEdges;
    if (!consume(routeEdges)) return null;

    const blanks = new Set(pz.blanks.map(([x, y]) => pk(x, y)));
    const usable = new Set([...blanks, ...Object.keys(pz.fixed || {}), pk(derived.auto.x, derived.auto.y)]);
    const usages = new Map();
    for (const car of derived.cars) {
      if (!addP12SeedTrace(usages, derived.routes.get(String(car.name)), car.entry, derived.auto)) {
        stats.terminationReason = "trace-construction-failed";
        return null;
      }
    }
    if (!addP12SeedTrace(usages, derived.loop, derived.family.directEntry, derived.auto)) {
      stats.terminationReason = "loop-construction-failed";
      return null;
    }
    stats.usageMerges = [...usages.values()].reduce((sum, requirements) => sum + requirements.length, 0);
    if (!consume(stats.usageMerges)) return null;

    const placed = {};
    for (const [k, requirements] of usages) {
      if (!consume(1)) return null;
      if (!usable.has(k)) {
        stats.terminationReason = "template-cell-unavailable";
        return null;
      }
      if (pz.fixed[k]) {
        if (!requirements.every(({ entry, exit }) => exitPort(pz.fixed[k], entry) === exit)) {
          stats.terminationReason = "fixed-track-conflict";
          return null;
        }
        continue;
      }
      if (!blanks.has(k)) {
        stats.terminationReason = "template-cell-not-placeable";
        return null;
      }
      const options = TRACK_NAMES.filter(track =>
        requirements.every(({ entry, exit }) => exitPort(track, entry) === exit));
      const usedPorts = new Set(requirements.flatMap(({ entry, exit }) => [entry, exit]));
      const choice = options.find(track => !track.startsWith("T_"))
        || options.find(track => Object.keys(TRACKS[track]).every(port => usedPorts.has(port)));
      if (!choice) {
        stats.terminationReason = "track-domain-empty";
        return null;
      }
      placed[k] = choice;
    }
    stats.fullLeaves += 1;

    const cost = Object.keys(placed).length;
    stats.generatedCost = cost;
    if (Number.isFinite(maxCost) && cost > maxCost) {
      stats.terminationReason = "candidate-over-budget";
      return null;
    }
    if (!consume(1)) return null;
    stats.simulateCalls += 1;
    const result = simulate(pz, placed);
    if (!result.ok) {
      stats.simulateFailure = result.detail?.errorCode || result.reason || "unknown";
      stats.terminationReason = "template-candidate-rejected";
      return null;
    }
    stats.candidateFound = true;
    stats.steps = result.steps;
    stats.terminationReason = "candidate-unproven-p12-seed";
    return { ...placed, __cost: cost };
  } catch (error) {
    stats.error = error instanceof Error ? error.message : String(error);
    stats.terminationReason = "template-error";
    return null;
  } finally {
    stats.elapsedMs = elapsedMs(startedAt);
  }
}

// ═══════════ Search helpers ═══════════

function getPorts(tn) {
  const t = TRACKS[tn]; if (!t) return [];
  const p = new Set();
  for (const [e, x] of Object.entries(t)) { p.add(e); p.add(x); }
  return [...p];
}

function bfsMinSteps(car, pz, bs, waypoints = [], blocked = null, cspGuard = null) {
  const gx = pz.goal[0], gy = pz.goal[1], ge = pz.goalEntry || pz.goal_entry;
  const tm = buildTunnelMap(pz.tunnels);
  const tsm = buildTSwitchMap(pz.tswitches);
  const asm = buildAutoSwitchMap(pz.autoSwitches || pz.auto_switches);
  const startWp = waypoints[0] && car.x === waypoints[0].x && car.y === waypoints[0].y ? 1 : 0;
  const q = [[car.x, car.y, car.entry, startWp, 0]];
  const visited = new Set();
  for (let qi = 0; qi < q.length; qi++) {
    if (cspGuard && cspGuard.checkTime()) return Infinity;
    const [x, y, entry, wpIdx, steps] = q[qi];
    const sk = x + "," + y + "," + entry + "," + wpIdx;
    if (visited.has(sk)) continue; visited.add(sk);
    const k = pk(x, y);
    let exits = [];
    if (tm[k]) {
      if (entry !== tm[k].facing) continue;
      const p = tm[k].pair;
      exits = [{ nx: p.x + DELTA[p.facing][0], ny: p.y + DELTA[p.facing][1], ne: OPPOSITE[p.facing] }];
    } else {
      let pool;
      if (tsm[k]) pool = tswitchTrackVariants(tsm[k]);
      else if (asm[k]) pool = tswitchTrackVariants(asm[k]);
      else if (pz.fixed[k]) pool = [pz.fixed[k]];
      else if (bs.has(k)) pool = BASIC_BY_ENTRY[entry];
      else continue;
      const seenExit = new Set();
      for (const tr of pool) {
        const ex = exitPort(tr, entry);
        if (!ex || seenExit.has(ex)) continue;
        seenExit.add(ex);
        exits.push({ nx: x + DELTA[ex][0], ny: y + DELTA[ex][1], ne: OPPOSITE[ex] });
      }
    }
    for (const { nx, ny, ne } of exits) {
      const wp = waypoints[wpIdx];
      const nwp = wp && nx === wp.x && ny === wp.y ? wpIdx + 1 : wpIdx;
      if (nx === gx && ny === gy) { if (nwp >= waypoints.length && ne === ge) return steps + 1; continue; }
      if (nx < 0 || nx >= pz.width || ny < 0 || ny >= pz.height) continue;
      const nk = pk(nx, ny);
      if (blocked && blocked.has(nk)) continue;
      if (!pz.fixed[nk] && !bs.has(nk) && !tm[nk] && !tsm[nk] && !asm[nk]) continue;
      q.push([nx, ny, ne, nwp, steps + 1]);
    }
  }
  return Infinity;
}

function buildHeuristic(car, pz, bs, waypoints = [], blocked = null, cspGuard = null) {
  const gx = pz.goal[0], gy = pz.goal[1], ge = pz.goalEntry || pz.goal_entry;
  const tm = buildTunnelMap(pz.tunnels);
  const tsm = buildTSwitchMap(pz.tswitches);
  const asm = buildAutoSwitchMap(pz.autoSwitches || pz.auto_switches);
  const fwd = new Map();
  const startWp = waypoints[0] && car.x === waypoints[0].x && car.y === waypoints[0].y ? 1 : 0;
  const q = [[car.x, car.y, car.entry, startWp, 0]];
  let bestTotal = Infinity;
  for (let qi = 0; qi < q.length; qi++) {
    if (cspGuard && cspGuard.checkTime()) break;
    const [x, y, entry, wpIdx, steps] = q[qi];
    const sk = x + "," + y + "," + entry + "," + wpIdx;
    if (fwd.has(sk)) continue; fwd.set(sk, steps);
    if (steps >= bestTotal) continue;
    const k = pk(x, y);
    let exits = [];
    if (tm[k]) {
      if (entry !== tm[k].facing) continue;
      const p = tm[k].pair;
      exits = [{ nx: p.x + DELTA[p.facing][0], ny: p.y + DELTA[p.facing][1], ne: OPPOSITE[p.facing] }];
    } else {
      let pool;
      if (tsm[k]) pool = tswitchTrackVariants(tsm[k]);
      else if (asm[k]) pool = tswitchTrackVariants(asm[k]);
      else if (pz.fixed[k]) pool = [pz.fixed[k]];
      else if (bs.has(k)) pool = BASIC_BY_ENTRY[entry];
      else continue;
      const seenExit = new Set();
      for (const tr of pool) {
        const ex = exitPort(tr, entry);
        if (!ex || seenExit.has(ex)) continue;
        seenExit.add(ex);
        exits.push({ nx: x + DELTA[ex][0], ny: y + DELTA[ex][1], ne: OPPOSITE[ex] });
      }
    }
    for (const { nx, ny, ne } of exits) {
      const wp = waypoints[wpIdx];
      const nwp = wp && nx === wp.x && ny === wp.y ? wpIdx + 1 : wpIdx;
      if (nx === gx && ny === gy) { if (nwp >= waypoints.length && ne === ge) { if (steps + 1 < bestTotal) bestTotal = steps + 1; } continue; }
      if (nx < 0 || nx >= pz.width || ny < 0 || ny >= pz.height) continue;
      const nk = pk(nx, ny);
      if (blocked && blocked.has(nk)) continue;
      if (!pz.fixed[nk] && !bs.has(nk) && !tm[nk] && !tsm[nk] && !asm[nk]) continue;
      q.push([nx, ny, ne, nwp, steps + 1]);
    }
  }
  function manh(x, y, wpIdx) {
    let d = 0, cx = x, cy = y;
    for (let i = wpIdx; i < waypoints.length; i++) {
      d += Math.abs(cx - waypoints[i].x) + Math.abs(cy - waypoints[i].y);
      cx = waypoints[i].x; cy = waypoints[i].y;
    }
    return d + Math.abs(cx - gx) + Math.abs(cy - gy);
  }
  function h(x, y, entry, wpIdx) {
    const m = manh(x, y, wpIdx);
    const sk = x + "," + y + "," + entry + "," + wpIdx;
    const fd = fwd.get(sk);
    if (fd !== undefined && bestTotal !== Infinity) { const r = bestTotal - fd; return r > m ? r : m; }
    return m;
  }
  return { h, minTotal: bestTotal };
}

// ═══════════ Path enumeration ═══════════

function enumeratePaths(car, pz, bs, meta, maxCost, waypoints = [], minRequiredArrival = 0, blocked = null, cspGuard = null) {
  const ge = pz.goalEntry || pz.goal_entry, gx = pz.goal[0], gy = pz.goal[1], pathLimit = pz.maxPaths || MAX_PATHS;
  if (cspGuard) cspGuard.beginCar(car.name);
  const heur = buildHeuristic(car, pz, bs, waypoints, blocked, cspGuard);
  const minSteps = heur.minTotal;
  const isZero = isZeroCar(car);
  if (minSteps === Infinity && !isZero) {
    if (cspGuard) cspGuard.noteRetained(car.name, 0);
    return { paths: [], overflow: false, overflowReasons: [], minSteps };
  }
  const slack = pz.pathSlack ?? PATH_SLACK;
  const minLen = Math.max(minSteps === Infinity ? 0 : minSteps, minRequiredArrival);
  const maxLen = isZero ? (pz.maxSteps || pz.max_steps || 50) : Math.min(pz.maxSteps || pz.max_steps || 50, minLen + slack);
  let iters = 0;
  let overflow = false;
  const overflowReasons = new Set();
  const tunnelMap = buildTunnelMap(pz.tunnels);
  const tswitchMap = buildTSwitchMap(pz.tswitches);
  const autoSwitchMap = buildAutoSwitchMap(pz.autoSwitches || pz.auto_switches);
  function nextWpIdxFor(nx, ny, wpIdx) { const wp = waypoints[wpIdx]; return wp && nx === wp.x && ny === wp.y ? wpIdx + 1 : wpIdx; }
  function pathKey(p) { return p.assigns.map(a => a.k + ":" + a.track).sort().join("|"); }
  function pathBucket(p) {
    let mask = 0;
    for (const a of p.assigns) {
      const parts = a.k.split(","), x = +parts[0], y = +parts[1];
      const xb = x < Math.ceil(pz.width / 3) ? 0 : (x < Math.ceil(pz.width * 2 / 3) ? 1 : 2);
      const yb = y < Math.ceil(pz.height / 3) ? 0 : (y < Math.ceil(pz.height * 2 / 3) ? 1 : 2);
      mask |= 1 << (yb * 3 + xb);
    }
    return String(mask);
  }
  function pathCompare(a, b) {
    const ac = a.assigns.length, bc = b.assigns.length;
    if (ac !== bc) return ac - bc;
    if (a.steps !== b.steps) return a.steps - b.steps;
    const ak = a._key || (a._key = pathKey(a)), bk = b._key || (b._key = pathKey(b));
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  }
  const pathBuckets = {}, bucketOrder = [], perBucket = pz.maxPathsPerBucket || Math.max(80, Math.ceil(pathLimit / 48));
  function keepPath(p) {
    if (cspGuard) cspGuard.notePath(car.name);
    const b = pathBucket(p);
    let arr = pathBuckets[b];
    if (!arr) { arr = []; pathBuckets[b] = arr; bucketOrder.push(b); }
    if (arr.length < perBucket) { arr.push(p); return; }
    overflow = true;
    overflowReasons.add("path-bucket-capacity");
    let wi = 0;
    for (let i = 1; i < arr.length; i++) if (pathCompare(arr[i], arr[wi]) > 0) wi = i;
    if (pathCompare(p, arr[wi]) < 0) arr[wi] = p;
  }
  function dfs(x, y, entry, assigns, visited, cost, steps, wpIdx) {
    iters += 1;
    if (cspGuard && cspGuard.notePathIteration(car.name)) return;
    if (iters > MAX_ENUM_ITERS) { overflow = true; overflowReasons.add("path-enumeration-iterations"); return; }
    if (cost > maxCost || steps >= maxLen) { if (isZero && assigns.length > 0) keepPath({ assigns, steps }); return; }
    if (steps + (minSteps === Infinity ? 0 : heur.h(x, y, entry, wpIdx)) > maxLen) return;
    const k = pk(x, y);
    const vk = k + ":" + entry + ":" + wpIdx;
    if (visited.has(vk)) { if (isZero && assigns.length > 0) keepPath({ assigns, steps }); return; }
    visited.add(vk);
    if (tunnelMap[k]) {
      if (entry !== tunnelMap[k].facing) { visited.delete(vk); return; }
      const p = tunnelMap[k].pair;
      const nx = p.x + DELTA[p.facing][0], ny = p.y + DELTA[p.facing][1], ne = OPPOSITE[p.facing];
      if (nx === gx && ny === gy) { if (isZero) { visited.delete(vk); return; } if (wpIdx >= waypoints.length && ne === ge && (steps + 1) >= minLen) keepPath({ assigns, steps: steps + 1 }); visited.delete(vk); return; }
      if (nx < 0 || nx >= pz.width || ny < 0 || ny >= pz.height) { visited.delete(vk); return; }
      const nk = pk(nx, ny);
      if (blocked && blocked.has(nk)) { visited.delete(vk); return; }
      if (!pz.fixed[nk] && !bs.has(nk) && !tunnelMap[nk] && !tswitchMap[nk] && !autoSwitchMap[nk]) { visited.delete(vk); return; }
      dfs(nx, ny, ne, assigns, visited, cost, steps + 1, nextWpIdxFor(nx, ny, wpIdx));
      visited.delete(vk); return;
    }
    const fixed = pz.fixed[k];
    const sw = tswitchMap[k];
    const au = autoSwitchMap[k];
    const existIdx = fixed || sw || au ? -1 : assigns.findIndex(a => a.k === k);
    let pool;
    if (sw) pool = tswitchTrackVariants(sw).filter(t => exitPort(t, entry) !== null);
    else if (au) pool = tswitchTrackVariants(au).filter(t => exitPort(t, entry) !== null);
    else if (fixed) pool = [fixed];
    else if (bs.has(k)) {
      if (existIdx >= 0) {
        const prev = assigns[existIdx]; pool = [];
        for (const tn of T_TRACKS) {
          if (exitPort(tn, prev.entry) !== prev.exit) continue;
          if (prev.extra) { let ok = true; for (const e of prev.extra) { if (exitPort(tn, e.entry) !== e.exit) { ok = false; break; } } if (!ok) continue; }
          if (exitPort(tn, entry) === null) continue;
          pool.push(tn);
        }
      } else {
        const m = meta[k];
        pool = m ? m.basicTracks.filter(t => exitPort(t, entry) !== null) : BASIC_BY_ENTRY[entry];
      }
    } else { visited.delete(vk); return; }
    for (const tr of pool) {
      const ex = exitPort(tr, entry); if (!ex) continue;
      const nx = x + DELTA[ex][0], ny = y + DELTA[ex][1], ne = OPPOSITE[ex];
      let na, nc;
      if (fixed || sw || au) { na = assigns; nc = cost; }
      else if (existIdx >= 0) {
        na = assigns.map((a, i) => {
          if (i !== existIdx) return a;
          const extra = a.extra ? [...a.extra, { entry, exit: ex }] : [{ entry, exit: ex }];
          return { k, track: tr, entry: a.entry, exit: a.exit, extra };
        });
        nc = cost;
      } else { na = [...assigns, { k, track: tr, entry, exit: ex }]; nc = cost + 1; }
      if (nx === gx && ny === gy) { if (isZero) continue; if (wpIdx >= waypoints.length && ne === ge && (steps + 1) >= minLen) keepPath({ assigns: na, steps: steps + 1 }); continue; }
      if (nx < 0 || nx >= pz.width || ny < 0 || ny >= pz.height) continue;
      const nk = pk(nx, ny);
      if (blocked && blocked.has(nk)) continue;
      if (!pz.fixed[nk] && !bs.has(nk) && !tunnelMap[nk] && !tswitchMap[nk] && !autoSwitchMap[nk]) continue;
      dfs(nx, ny, ne, na, visited, nc, steps + 1, nextWpIdxFor(nx, ny, wpIdx));
    }
    visited.delete(vk);
  }
  const initialWpIdx = nextWpIdxFor(car.x, car.y, 0);
  dfs(car.x, car.y, car.entry, [], new Set(), 0, 0, initialWpIdx);
  if (cspGuard && cspGuard.stats.aborted) {
    cspGuard.noteRetained(car.name, 0);
    for (const reason of overflowReasons) cspGuard.addOverflow(reason, car.name);
    return { paths: [], overflow, overflowReasons: [...overflowReasons], minSteps, maxLen, minLen };
  }
  for (const b of bucketOrder) pathBuckets[b].sort(pathCompare);
  const paths = [];
  const bucketPathCount = bucketOrder.reduce((sum, b) => sum + pathBuckets[b].length, 0);
  if (bucketPathCount > pathLimit) { overflow = true; overflowReasons.add("path-retention-limit"); }
  for (let i = 0; paths.length < pathLimit; i++) {
    let added = false;
    for (const b of bucketOrder) {
      const p = pathBuckets[b][i]; if (!p) continue;
      paths.push(p); added = true;
      if (paths.length >= pathLimit) break;
    }
    if (!added) break;
  }
  paths.sort(pathCompare);
  const seen = new Set(), deduped = [];
  for (const p of paths) { const fp = p._key || pathKey(p); if (!seen.has(fp)) { seen.add(fp); deduped.push(p); } }
  if (cspGuard) {
    cspGuard.noteRetained(car.name, deduped.length);
    for (const reason of overflowReasons) cspGuard.addOverflow(reason, car.name);
  }
  return { paths: deduped, overflow, overflowReasons: [...overflowReasons], minSteps, maxLen, minLen };
}

// ═══════════ CSP solver ═══════════

function solveCSP(pz, maxCost, bs, meta, cspGuard, telemetry) {
  cspGuard.stats.attempted = true;
  if (cspGuard.checkTime(true)) {
    return { sol: null, alternates: [], overflow: cspGuard.stats.overflow, info: "CSP aborted: " + cspGuard.stats.abortReason };
  }
  const platformState = buildPlatformState(pz.platforms);
  const blockedByCar = {};
  for (const car of pz.cars) blockedByCar[car.name] = blockedCellsForCar(platformState, car.name);
  const waypointsByCar = {}, minStepsByCar = {}, waypointCountByCar = {};
  for (const car of pz.cars) {
    if (cspGuard.checkTime()) break;
    const wps = carWaypoints(platformState, car.name);
    waypointsByCar[car.name] = wps;
    waypointCountByCar[car.name] = wps.length;
    minStepsByCar[car.name] = bfsMinSteps(car, pz, bs, wps, blockedByCar[car.name], cspGuard);
  }
  if (cspGuard.stats.aborted) {
    return { sol: null, alternates: [], overflow: cspGuard.stats.overflow, info: "CSP aborted: " + cspGuard.stats.abortReason };
  }
  const minRequiredByCar = {};
  let priorMaxArrival = 0;
  let zeroTriggerMinSteps = 0;
  if (pz.triggers && pz.triggers.length && pz.cars.some(isZeroCar)) {
    const zeroCar = pz.cars.find(isZeroCar);
    if (zeroCar) {
      for (const trig of pz.triggers) {
        const dist = Math.abs(zeroCar.x - trig.x) + Math.abs(zeroCar.y - trig.y);
        if (dist > zeroTriggerMinSteps) zeroTriggerMinSteps = dist;
      }
    }
  }
  for (const name of pz.order) {
    const wc = waypointCountByCar[name] || 0;
    minRequiredByCar[name] = Math.max(0, priorMaxArrival + 1 - 2 * wc);
    if (zeroTriggerMinSteps > 0) minRequiredByCar[name] = Math.max(minRequiredByCar[name], zeroTriggerMinSteps);
    const ms = minStepsByCar[name];
    if (ms !== Infinity) {
      const forcedMin = Math.max(ms, minRequiredByCar[name]);
      const arrival = forcedMin + 2 * wc;
      if (arrival > priorMaxArrival) priorMaxArrival = arrival;
    }
  }
  /* FIX: Skip zero car in CSP path enumeration entirely.
     Zero cars don't reach the goal, so enumerating their paths causes
     massive path explosion (pathSlack=30, no goal constraint).
     Their correctness is validated by quickCollisionCheck + simulate(). */
  const allPathResults = [];
  for (const car of pz.cars) {
    if (cspGuard.stats.aborted || cspGuard.checkTime()) break;
    if (isZeroCar(car)) {
      cspGuard.beginCar(car.name);
      cspGuard.noteRetained(car.name, 0);
      allPathResults.push({ paths: [], overflow: false, overflowReasons: [], minSteps: Infinity, minLen: 0, maxLen: 0 });
    } else {
      allPathResults.push(enumeratePaths(car, pz, bs, meta, maxCost, waypointsByCar[car.name], minRequiredByCar[car.name] || 0, blockedByCar[car.name], cspGuard));
    }
  }
  if (cspGuard.stats.aborted) {
    return { sol: null, alternates: [], overflow: cspGuard.stats.overflow, info: "CSP aborted: " + cspGuard.stats.abortReason };
  }
  const allPaths = allPathResults.map(r => r.paths);
  const overflow = allPathResults.some(r => r.overflow) || cspGuard.stats.overflow;
  for (let i = 0; i < allPaths.length; i++) if (!allPaths[i].length) {
    if (isZeroCar(pz.cars[i])) continue;
    return { sol: null, overflow, info: "car " + (i + 1) + " has 0 paths (minSteps=" + allPathResults[i].minSteps + ", req>=" + (minRequiredByCar[pz.cars[i].name] || 0) + ", blocked=" + blockedByCar[pz.cars[i].name].size + ")" };
  }
  const info = "paths: " + allPaths.map((p, i) => "c" + pz.cars[i].name + "=" + p.length + (allPathResults[i].overflow ? "!" : "") + "[" + allPathResults[i].minLen + "-" + allPathResults[i].maxLen + "]").join(" x ");
  postToMain({
    type: "progress",
    phase: "csp",
    iters: 0,
    cspInfo: info,
    cspMs: telemetry.cspStartedAt ? elapsedMs(telemetry.cspStartedAt) : 0,
    dfsMs: telemetry.dfsMs || 0,
    cspStats: cspGuard.snapshot(),
  });

  /* FIX: Exclude zero car indices from CSP merge order.
     Zero cars have no paths in CSP; they are validated post-hoc. */
  const order = [];
  for (const name of pz.order) { const ci = pz.cars.findIndex(c => String(c.name) === String(name)); if (ci >= 0) order.push(ci); }
  for (let i = 0; i < pz.cars.length; i++) if (!order.includes(i) && !isZeroCar(pz.cars[i]) && allPaths[i].length > 0) order.push(i);
  let bestSol = null, bestCost = maxCost, iters = 0;
  const alternates = [], alternateKeys = new Set();
  const MAX_I = 15000000;
  function placedKey(placed) { return Object.keys(placed).sort().map(k => k + ":" + placed[k]).join("|"); }
  function rememberSolution(placed, cost) {
    if (cost > maxCost) return;
    const sol = { ...placed, __cost: cost }, key = placedKey(placed);
    if (cost < bestCost || (cost === bestCost && bestSol === null)) { bestCost = cost; bestSol = sol; alternates.length = 0; alternateKeys.clear(); }
    if (cost === bestCost && !alternateKeys.has(key) && alternates.length < MAX_ALTERNATES) {
      alternateKeys.add(key); alternates.push(sol);
    }
    if (bestSol === sol || alternates[alternates.length - 1] === sol) {
      emitCandidate(sol, telemetry, "csp", {
        phase: "csp",
        cspMs: telemetry.cspStartedAt ? elapsedMs(telemetry.cspStartedAt) : (telemetry.cspMs || 0),
        p12SeedMs: telemetry.p12SeedMs || 0,
        dfsMs: telemetry.dfsMs || 0,
        cspStats: cspGuard.snapshot(),
      });
    }
  }

  const orderPosByCi = [], wpCountByCi = [];
  for (let i = 0; i < pz.cars.length; i++) {
    orderPosByCi[i] = pz.order.indexOf(String(pz.cars[i].name));
    wpCountByCi[i] = waypointCountByCar[pz.cars[i].name] || 0;
  }
  const pathMaps = allPaths.map((paths, ci) => paths.map(path => {
    const m = {}; for (const a of path.assigns) { m[a.k] = { track: a.track, entry: a.entry, exit: a.exit }; if (a.extra) m[a.k].extra = a.extra; }
    return { cells: m, steps: path.steps, arrival: path.steps + 2 * wpCountByCi[ci] };
  }));
  for (const list of pathMaps) list.sort((a, b) => Object.keys(a.cells).length - Object.keys(b.cells).length || a.arrival - b.arrival);
  if (cspGuard.checkTime(true)) {
    return { sol: bestSol, alternates, overflow: overflow || cspGuard.stats.overflow, info: info + "; CSP aborted: " + cspGuard.stats.abortReason };
  }

  function usagesOfCell(a) {
    const out = [{ entry: a.entry, exit: a.exit }];
    if (a.extra) out.push(...a.extra);
    const seen = new Set(), res = [];
    for (const u of out) { const id = u.entry + ">" + u.exit; if (!seen.has(id)) { seen.add(id); res.push(u); } }
    return res;
  }
  function tPortsAllUsed(track, usages) {
    if (!track || !track.startsWith("T_")) return true;
    const ports = new Set(getPorts(track)), used = new Set();
    for (const u of usages) { used.add(u.entry); used.add(u.exit); }
    for (const p of ports) { if (!used.has(p)) return false; }
    return true;
  }
  function validateTUsage(asgn) {
    for (const k in asgn) {
      if (asgn[k].track && asgn[k].track.startsWith("T_")) {
        if (!tPortsAllUsed(asgn[k].track, usagesOfCell(asgn[k]))) return false;
      }
    }
    return true;
  }
  function checkCompat(pm, asgn) {
    let added = 0; const merges = {};
    for (const k in pm) {
      if (asgn[k]) {
        const oldUsages = usagesOfCell(asgn[k]);
        const newUsages = [{ entry: pm[k].entry, exit: pm[k].exit }];
        if (pm[k].extra) for (const e of pm[k].extra) newUsages.push(e);
        const allU = [...oldUsages, ...newUsages];
        let allOk = true;
        for (const u of newUsages) { if (exitPort(asgn[k].track, u.entry) !== u.exit) { allOk = false; break; } }
        if (allOk) { merges[k] = asgn[k].track; continue; }
        let found = null;
        for (const tn of T_TRACKS) {
          let ok = true;
          for (const u of allU) { if (exitPort(tn, u.entry) !== u.exit) { ok = false; break; } }
          if (ok) { found = tn; break; }
        }
        if (!found) return null;
        merges[k] = found;
      } else { added++; }
    }
    return { added, merges };
  }
  function forwardCheck(asgn, remaining) {
    for (const ci of remaining) {
      let any = false;
      for (const po of pathMaps[ci]) {
        if (cspGuard.noteCombination()) return false;
        if (checkCompat(po.cells, asgn) !== null) { any = true; break; }
      }
      if (!any) return false;
    }
    return true;
  }
  function asgnKey(asgn) { return Object.keys(asgn).sort().map(k => k + ":" + asgn[k].track).join("|"); }
  function cloneMergedAsgn(asgn, pm, merges) {
    const na = {}; for (const k in asgn) na[k] = { ...asgn[k], extra: asgn[k].extra ? [...asgn[k].extra] : undefined };
    for (const k in pm) {
      if (na[k]) {
        const extra = na[k].extra ? [...na[k].extra] : [{ entry: na[k].entry, exit: na[k].exit }];
        extra.push({ entry: pm[k].entry, exit: pm[k].exit });
        if (pm[k].extra) for (const e of pm[k].extra) extra.push(e);
        na[k] = { track: merges[k], entry: na[k].entry, exit: na[k].exit, extra };
      } else { na[k] = { track: pm[k].track, entry: pm[k].entry, exit: pm[k].exit }; if (pm[k].extra) na[k].extra = pm[k].extra.map(e => ({ ...e })); }
    }
    return na;
  }
  function asgnBucket(asgn) {
    let mask = 0;
    for (const k in asgn) {
      const parts = k.split(","), x = +parts[0], y = +parts[1];
      const xb = x < Math.ceil(pz.width / 3) ? 0 : (x < Math.ceil(pz.width * 2 / 3) ? 1 : 2);
      const yb = y < Math.ceil(pz.height / 3) ? 0 : (y < Math.ceil(pz.height * 2 / 3) ? 1 : 2);
      mask |= 1 << (yb * 3 + xb);
    }
    return String(mask);
  }
  function stateCompare(a, b) { return a.cost - b.cost || a.arrivalSum - b.arrivalSum || asgnKey(a.asgn).localeCompare(asgnKey(b.asgn)); }
  function trimBeam(states, width) {
    if (states.length <= width) { states.sort(stateCompare); return states; }
    const buckets = {}, keys = [];
    for (const s of states) { const b = asgnBucket(s.asgn); if (!buckets[b]) { buckets[b] = []; keys.push(b); } buckets[b].push(s); }
    for (const b of keys) buckets[b].sort(stateCompare);
    const out = [];
    for (let i = 0; out.length < width; i++) {
      let added = false;
      for (const b of keys) { const s = buckets[b][i]; if (!s) continue; out.push(s); added = true; if (out.length >= width) break; }
      if (!added) break;
    }
    out.sort(stateCompare);
    return out;
  }

  /* FIX: quickCollisionCheck now uses effectiveTrackAt (was raw tracks[k])
     and handles tsw_triggers, auto-switch state, and T-switch locks. */
  function quickCollisionCheck(placed) {
    const tracks = { ...pz.fixed, ...placed };
    const tm = buildTunnelMap(pz.tunnels);
    const tswitchMap = buildTSwitchMap(pz.tswitches);
    const autoSwitchMap = buildAutoSwitchMap(pz.autoSwitches || pz.auto_switches);
    const gx = pz.goal[0], gy = pz.goal[1], ms = Math.min(pz.maxSteps || pz.max_steps || 50, 80);
    const triggers = {}; if (pz.triggers) for (const t of pz.triggers) triggers[pk(t.x, t.y)] = t.color;
    const barriers = {}; if (pz.barriers) for (const b of pz.barriers) barriers[pk(b.x, b.y)] = { color: b.color, initialState: b.initialState };
    const tswTriggers = {}; const rawTsw = pz.tsw_triggers || pz.tswTriggers || []; for (const t of rawTsw) tswTriggers[pk(t.x, t.y)] = t.color;
    let toggled = {}, tsToggled = {}, autoToggled = {}, tsLocks = {};
    let cars = pz.cars.map(c => ({ ...c, wait: c.wait || 0 }));
    for (let s = 1; s <= ms; s++) {
      const nxt = [], triggeredColors = [], tsTriggeredColors = [], autoUsedKeys = [], releaseTSLocks = new Set();
      /* 三阶段推进（与权威 simulate 一致）：意向移动 -> 占格碰撞裁决 -> 移动者发信号 */
      const recs = [];
      for (const c of cars) {
        /* Parked zero car: stays put forever */
        if (c.parked) { recs.push({ stay: true, c, keep: { ...c } }); continue; }
        if (c.wait > 0) { recs.push({ stay: true, c, keep: { ...c, wait: c.wait - 1 } }); continue; }
        let x = c.x, y = c.y, entry = c.entry, nx, ny, ne;
        let usedTSLock = false, usedAutoSwitch = false;
        const k = pk(x, y);
        if (tm[k]) {
          if (entry !== tm[k].facing) return true;
          const p = tm[k].pair;

          nx = p.x + DELTA[p.facing][0]; ny = p.y + DELTA[p.facing][1]; ne = OPPOSITE[p.facing];
        } else {
          /* FIX: use effectiveTrackAt with full dynamic state */
          const locked = tsLocks[c.name];
          const t = locked && locked.k === k ? locked.track : effectiveTrackAt(k, tracks, tswitchMap, tsToggled, autoSwitchMap, autoToggled);
          usedTSLock = !!(locked && locked.k === k);
          usedAutoSwitch = !!autoSwitchMap[k] && !usedTSLock;
          /* No track or incompatible entry: always a collision (zero cars need track too) */
          if (!t || !exitPort(t, entry)) {
            return true;
          }
          const ex = exitPort(t, entry);
          nx = x + DELTA[ex][0]; ny = y + DELTA[ex][1]; ne = OPPOSITE[ex];
        }
        if (nx === gx && ny === gy) {
          /* Match the authority simulator: a zero car can never enter the goal. */
          if (isZeroCar(c)) return true;
          if (triggers[pk(nx, ny)]) triggeredColors.push(triggers[pk(nx, ny)]);
          if (tswTriggers[pk(nx, ny)]) tsTriggeredColors.push(tswTriggers[pk(nx, ny)]);
          if (usedTSLock) releaseTSLocks.add(c.name);
          if (usedAutoSwitch) autoUsedKeys.push(k);
          continue;
        }
        /* Zero car dead-end: exit leads OOB → park at current cell */
        if (nx < 0 || nx >= pz.width || ny < 0 || ny >= pz.height) {
          if (isZeroCar(c)) { recs.push({ stay: true, c, keep: { ...c, parked: true } }); continue; }
          return true;
        }
        const nk = pk(nx, ny);
        /* Zero car dead-end: next cell has no traversable track or tunnel → park at current cell */
        if (isZeroCar(c) && !tm[nk]) {
          const nkTrack = effectiveTrackAt(nk, tracks, tswitchMap, tsToggled, autoSwitchMap, autoToggled);
          if (!nkTrack || !exitPort(nkTrack, ne)) { recs.push({ stay: true, c, keep: { ...c, parked: true } }); continue; }
        }
        let _barrierBlocked = false;
        if (barriers[nk]) {
          const b = barriers[nk], isT = toggled[b.color] || false;
          const cs = b.initialState === 'closed' ? (isT ? 'open' : 'closed') : (isT ? 'closed' : 'open');
          if (cs === 'closed') { _barrierBlocked = true; }
        }
        if (_barrierBlocked) {
          recs.push({ stay: true, c, keep: { name: c.name, role: c.role, x, y, entry, wait: 0, _blocked: true } });
          continue;
        }
        recs.push({ stay: false, c, nx, ny, ne, usedTSLock, usedAutoSwitch, fromKey: k });
      }
      /* 静止车=墙：无排队降级，驶入不动车格子由占格检测判碰撞（作者实测） */
      for (const m of recs) {
        if (m.stay) { nxt.push(m.keep); continue; }
        const { c, nx, ny, ne, usedTSLock, usedAutoSwitch, fromKey } = m;
        if (triggers[pk(nx, ny)]) triggeredColors.push(triggers[pk(nx, ny)]);
        if (tswTriggers[pk(nx, ny)]) tsTriggeredColors.push(tswTriggers[pk(nx, ny)]);
        if (usedTSLock) releaseTSLocks.add(c.name);
        if (usedAutoSwitch) autoUsedKeys.push(fromKey);
        nxt.push({ name: c.name, role: c.role, x: nx, y: ny, entry: ne, wait: 0 });
      }
      const occ = new Set();
      for (const c of nxt) {
        const k = pk(c.x, c.y);
        if (occ.has(k)) return true; occ.add(k);
        if (tm[k]) { const pkp = pk(tm[k].pair.x, tm[k].pair.y); if (occ.has(pkp)) return true; occ.add(pkp); }
      }
      /* 追尾判定已删除（作者确认）：跟随合法，追撞由排队与占格碰撞覆盖 */
      if (detectSwapCollision(cars, nxt)) return true;
      const blocked = occupiedBarrierColors(nxt, barriers);
      cars = nxt;
      for (const name of releaseTSLocks) delete tsLocks[name];
      for (const cl of triggeredColors) if (!blocked.has(cl)) toggled[cl] = !toggled[cl];
      const tsTriggeredColorSet = new Set(tsTriggeredColors);
      for (const c of cars) { const k = pk(c.x, c.y), sw = tswitchMap[k]; if (sw && tsTriggeredColorSet.has(sw.color)) tsLocks[c.name] = { k, track: effectiveTSwitchTrack(sw, tsToggled) }; }
      for (const cl of tsTriggeredColors) tsToggled[cl] = !tsToggled[cl];
      for (const k of autoUsedKeys) autoToggled[k] = !autoToggled[k];
      if (!cars.length) return false;
    }
    return false;
  }

  function runBeam() {
    const width = pz.cspBeamWidth || CSP_BEAM_WIDTH;
    let states = [{ asgn: {}, cost: 0, arrivals: {}, arrivalSum: 0 }];
    for (let idx = 0; idx < order.length; idx++) {
      if (cspGuard.stats.aborted) return;
      const ci = order[idx], posCi = orderPosByCi[ci], next = [], seen = new Set();
      const limit = Math.min(pathMaps[ci].length, pz.cspBeamPathLimit || pathMaps[ci].length);
      for (const st of states) {
        for (let pi = 0; pi < limit; pi++) {
          if (cspGuard.noteCombination()) return;
          const po = pathMaps[ci][pi], aCi = po.arrival;
          let orderOk = true;
          for (const otherCi in st.arrivals) {
            const aOther = st.arrivals[otherCi], posOther = orderPosByCi[otherCi];
            if (posCi === -1 || posOther === -1) continue;
            if (posOther < posCi) { if (aOther >= aCi) { orderOk = false; break; } }
            else if (posOther > posCi) { if (aOther <= aCi) { orderOk = false; break; } }
          }
          if (!orderOk) continue;
          const compat = checkCompat(po.cells, st.asgn);
          if (!compat) continue;
          const cost = st.cost + compat.added;
          if (cost > bestCost) continue;
          const na = cloneMergedAsgn(st.asgn, po.cells, compat.merges);
          const key = cost + "|" + aCi + "|" + asgnKey(na);
          if (seen.has(key)) continue; seen.add(key);
          const arrivals = { ...st.arrivals }; arrivals[ci] = aCi;
          next.push({ asgn: na, cost, arrivals, arrivalSum: st.arrivalSum + aCi });
          if (next.length > width * 4) { const trimmed = trimBeam(next, width); next.length = 0; for (const s of trimmed) next.push(s); }
        }
      }
      states = trimBeam(next, width);
      if (!states.length) return;
    }
    for (const st of states) {
      if (cspGuard.checkTime()) return;
      if (!validateTUsage(st.asgn)) continue;
      const placed = {}; for (const k in st.asgn) placed[k] = st.asgn[k].track;
      if (quickCollisionCheck(placed)) continue;
      /* Always validate through the unified Rule Layer simulate */
      const r = simulate(pz, placed);
      if (r.ok && st.cost <= bestCost) rememberSolution(placed, st.cost);
    }
  }
  function bt(idx, asgn, cost, arrivals) {
    if (cspGuard.stats.aborted) return;
    if (iters++ > MAX_I) { cspGuard.addOverflow("csp-backtracking-iterations"); return; }
    if (cost > bestCost || (cost === bestCost && alternates.length >= MAX_ALTERNATES)) return;
    if (iters % 100000 === 0) postToMain({
      type: "progress",
      phase: "csp",
      iters: 100000,
      cspMs: telemetry.cspStartedAt ? elapsedMs(telemetry.cspStartedAt) : 0,
      dfsMs: telemetry.dfsMs || 0,
      cspStats: cspGuard.snapshot(),
    });
    if (idx === order.length) {
      if (!validateTUsage(asgn)) return;
      const placed = {}; for (const k in asgn) placed[k] = asgn[k].track;
      if (quickCollisionCheck(placed)) return;
      const r = simulate(pz, placed);
      if (r.ok && cost <= bestCost) rememberSolution(placed, cost);
      return;
    }
    const ci = order[idx], remaining = order.slice(idx + 1), posCi = orderPosByCi[ci];
    for (const po of pathMaps[ci]) {
      if (cspGuard.noteCombination()) return;
      const aCi = po.arrival;
      let orderOk = true;
      for (const otherCi in arrivals) {
        const aOther = arrivals[otherCi], posOther = orderPosByCi[otherCi];
        if (posCi === -1 || posOther === -1) continue;
        if (posOther < posCi) { if (aOther >= aCi) { orderOk = false; break; } }
        else if (posOther > posCi) { if (aOther <= aCi) { orderOk = false; break; } }
      }
      if (!orderOk) continue;
      const pm = po.cells, compat = checkCompat(pm, asgn);
      if (!compat) continue;
      if (cost + compat.added > bestCost) continue;
      const na = {}; for (const k in asgn) na[k] = { ...asgn[k], extra: asgn[k].extra ? [...asgn[k].extra] : undefined };
      for (const k in pm) {
        if (na[k]) {
          const merged = compat.merges[k];
          const extra = na[k].extra ? [...na[k].extra] : [{ entry: na[k].entry, exit: na[k].exit }];
          extra.push({ entry: pm[k].entry, exit: pm[k].exit });
          if (pm[k].extra) for (const e of pm[k].extra) extra.push(e);
          na[k] = { track: merged, entry: na[k].entry, exit: na[k].exit, extra };
        } else { na[k] = { track: pm[k].track, entry: pm[k].entry, exit: pm[k].exit }; if (pm[k].extra) na[k].extra = pm[k].extra.map(e => ({ ...e })); }
      }
      if (remaining.length > 0 && !forwardCheck(na, remaining)) continue;
      const newArrivals = { ...arrivals }; newArrivals[ci] = aCi;
      bt(idx + 1, na, cost + compat.added, newArrivals);
      if (iters > MAX_I || cspGuard.stats.aborted) return;
    }
  }
  runBeam();
  if (!cspGuard.stats.aborted) bt(0, {}, 0, {});
  return {
    sol: bestSol,
    alternates,
    overflow: overflow || cspGuard.stats.overflow,
    info: cspGuard.stats.aborted ? info + "; CSP aborted: " + cspGuard.stats.abortReason : info,
  };
}

// ═══════════ DFS fallback solver ═══════════

function solveDFS(pz, maxSol, minTracks, budget, seed, bs, meta, telemetry, maxIters = DEFAULT_DFS_MAX_ITERATIONS, prePlaced = {}) {
  const placed = { ...prePlaced }, solutions = [], tm = buildTunnelMap(pz.tunnels);
  const _prePlacedCount = Object.keys(prePlaced).length;
  const ge = pz.goalEntry || pz.goal_entry, ms = pz.maxSteps || pz.max_steps || 50, gx = pz.goal[0], gy = pz.goal[1];
  const _trigMap = {}; if (pz.triggers) for (const t of pz.triggers) _trigMap[pk(t.x, t.y)] = t.color;
  const _barMap = {}; if (pz.barriers) for (const b of pz.barriers) _barMap[pk(b.x, b.y)] = { color: b.color, initialState: b.initialState };
  const _hasBars = pz.barriers && pz.barriers.length > 0;
  const _tswMap = {}; const _rawTsw = pz.tsw_triggers || pz.tswTriggers || []; for (const t of _rawTsw) _tswMap[pk(t.x, t.y)] = t.color;
  const _tswitchMap = buildTSwitchMap(pz.tswitches);
  const _autoSwitchMap = buildAutoSwitchMap(pz.autoSwitches || pz.auto_switches);
  const _hasTS = _rawTsw.length > 0 || Object.keys(_tswitchMap).length > 0;
  const _hasAuto = Object.keys(_autoSwitchMap).length > 0;
  const _hasZero = pz.cars.some(isZeroCar);
  const _isDynamic = _hasBars || _hasZero || _hasAuto || _hasTS;
  const _platformState = buildPlatformState(pz.platforms);
  const _hasPlatforms = _platformState.count > 0;
  const _order = requiredOrder(pz);
  let bestCost = budget, iters = 0; const MAX = maxIters;
  let iterationBudgetHit = false, solutionLimitHit = false;
  /* 零号车多后继世界的端口约束：portBans[k] = 该格禁止出现的入口端口集合。
     当零号车面对某格停车时，最终布局中该格不能有零号车入口侧的端口
     （否则零号车本应驶入）；该格仍可为其他车辆铺设不含该端口的轨道，也可不铺。
     放置(candidates)与升级(findUpgrades/canUpgrade)都必须遵守。 */
  const portBans = {};
  function addPortBan(k, side) {
    if (!portBans[k]) portBans[k] = new Set();
    if (portBans[k].has(side)) return () => { };
    portBans[k].add(side);
    return () => { portBans[k].delete(side); if (!portBans[k].size) delete portBans[k]; };
  }
  function trackViolatesPortBan(k, track) {
    const bansAt = portBans[k];
    if (!bansAt) return false;
    for (const side of bansAt) if (exitPort(track, side) !== null) return true;
    return false;
  }
  let deepest = { step: 0, arrived: [], cars: [], placed: {} };
  const solutionKeys = new Set();
  function placedKey(obj) { return Object.keys(obj).sort().map(k => k + ":" + obj[k]).join("|"); }
  function rememberSolution(cost) {
    const authoritative = simulate(pz, placed);
    if (!authoritative.ok) return false;
    const key = placedKey(placed);
    if (cost < bestCost) { bestCost = cost; solutions.length = 0; solutionKeys.clear(); }
    if (cost === bestCost && !solutionKeys.has(key) && solutions.length < MAX_ALTERNATES) {
      solutionKeys.add(key);
      const sol = { ...placed, __cost: cost };
      solutions.push(sol);
      const candidateStats = dfsStats(false);
      emitCandidate(sol, telemetry, "dfs", {
        phase: "dfs",
        cspMs: telemetry.cspMs || 0,
        p12SeedMs: telemetry.p12SeedMs || 0,
        dfsMs: telemetry.dfsStartedAt ? elapsedMs(telemetry.dfsStartedAt) : (telemetry.dfsMs || 0),
        dfsInfo: candidateStats,
        dfsStats: candidateStats,
      });
      return true;
    }
    return false;
  }
  function dfsStats(final = false) {
    const searchComplete = final && !iterationBudgetHit && !solutionLimitHit;
    let terminationReason = "running";
    if (final) {
      if (iterationBudgetHit) terminationReason = solutions.length > 0 ? "candidate-unproven-dfs-budget" : "dfs-iteration-budget";
      else if (solutionLimitHit) terminationReason = "candidate-unproven-early-stop";
      else terminationReason = solutions.length > 0 ? "optimal-proven" : "search-exhausted";
    }
    return {
      nodes: iters,
      iterations: iters,
      limit: MAX,
      deepestStep: deepest.step,
      deepest,
      iterationBudgetHit,
      exhausted: iterationBudgetHit,
      solutionLimitHit,
      searchComplete,
      terminationReason,
      solutions: solutions.length,
    };
  }
  function candidateLimitReached() {
    if (!minTracks && solutions.length >= Math.max(maxSol, MAX_ALTERNATES)) {
      solutionLimitHit = true;
      return true;
    }
    return false;
  }
  const useMap = {};
  function hasUsage(k, entry, exit) { const arr = useMap[k]; return !!arr && arr.some(u => u.entry === entry && u.exit === exit); }
  function pushUsage(k, entry, exit) {
    if (!useMap[k]) useMap[k] = [];
    if (hasUsage(k, entry, exit)) return () => { };
    useMap[k].push({ entry, exit });
    return () => { useMap[k].pop(); if (!useMap[k].length) delete useMap[k]; };
  }
  function trackSupportsUsages(track, k, extra) {
    const arr = useMap[k] ? [...useMap[k]] : [];
    if (extra) arr.push(extra);
    for (const u of arr) { if (exitPort(track, u.entry) !== u.exit) return false; }
    return true;
  }
  function tPortsAllUsedDFS(track, k) {
    if (!track || !track.startsWith("T_")) return true;
    const ports = new Set(getPorts(track)), used = new Set();
    for (const u of useMap[k] || []) { used.add(u.entry); used.add(u.exit); }
    for (const p of ports) { if (!used.has(p)) return false; }
    return true;
  }
  function validatePlacedTUsage() {
    for (const k in placed) { if (placed[k].startsWith("T_") && !tPortsAllUsedDFS(placed[k], k)) return false; }
    return true;
  }
  function canUpgradePlacedCellForEntry(k, entry) {
    if (!placed[k]) return false;
    for (const tn of T_TRACKS) {
      const ex = exitPort(tn, entry); if (!ex) continue;
      if (trackViolatesPortBan(k, tn)) continue;
      if (trackSupportsUsages(tn, k)) return true;
    }
    return false;
  }
  function cellCanAcceptDFS(x, y, entry, isZero = false) {
    if (x === gx && y === gy) return isZero ? false : entry === ge;
    if (isZero) {
      if (x < 0 || x >= pz.width || y < 0 || y >= pz.height) return true;
    } else {
      if (x < 0 || x >= pz.width || y < 0 || y >= pz.height) return false;
    }
    const k = pk(x, y);
    if (tm[k]) return entry === tm[k].facing;
    if (_tswitchMap[k]) return tswitchTrackVariants(_tswitchMap[k]).some(t => exitPort(t, entry) !== null);
    if (_autoSwitchMap[k]) return tswitchTrackVariants(_autoSwitchMap[k]).some(t => exitPort(t, entry) !== null);
    if (pz.fixed[k]) return exitPort(pz.fixed[k], entry) !== null;
    if (placed[k]) {
      if (exitPort(placed[k], entry) !== null) return true;
      return canUpgradePlacedCellForEntry(k, entry);
    }
    if (isZero) return true;
    return bs.has(k) && !portBans[k]?.has(entry);
  }
  function candidates(c) {
    const k = pk(c.x, c.y);
    if (tm[k]) return [];
    const m = meta[k];
    let pool = m ? m.basicTracks.filter(t => exitPort(t, c.entry) !== null) : BASIC_BY_ENTRY[c.entry];
    const result = [];
    for (const tr of pool) {
      const ex = exitPort(tr, c.entry); if (!ex) continue;
      if (trackViolatesPortBan(k, tr)) continue;
      const nx = c.x + DELTA[ex][0], ny = c.y + DELTA[ex][1], ne = OPPOSITE[ex];
      if (isZeroCar(c) && nx === gx && ny === gy) continue;
      if (!cellCanAcceptDFS(nx, ny, ne, isZeroCar(c))) continue;
      result.push(tr);
    }
    /* For dynamic puzzles, skip distance-to-goal sorting — optimal paths
       often require detours through triggers/switches that go AWAY from the goal. */
    if (!_isDynamic) {
      result.sort((a, b) => {
        const ea = exitPort(a, c.entry), eb = exitPort(b, c.entry);
        return (Math.abs(c.x + DELTA[ea][0] - gx) + Math.abs(c.y + DELTA[ea][1] - gy)) - (Math.abs(c.x + DELTA[eb][0] - gx) + Math.abs(c.y + DELTA[eb][1] - gy));
      });
    }
    if (seed > 0 && result.length > 1) {
      let s = seed ^ (iters * 2654435761 >>> 0);
      for (let i = result.length - 1; i > 0; i--) { s = (s * 1664525 + 1013904223) & 0x7fffffff; const j = s % (i + 1);[result[i], result[j]] = [result[j], result[i]]; }
    }
    return result;
  }
  function findUpgrades(oldTrack, cx, cy, newEntry, isZero = false) {
    const k = pk(cx, cy), ups = [];
    for (const tn of T_TRACKS) {
      const ex = exitPort(tn, newEntry); if (!ex) continue;
      if (trackViolatesPortBan(k, tn)) continue;
      if (!trackSupportsUsages(tn, k, { entry: newEntry, exit: ex })) continue;
      const nx = cx + DELTA[ex][0], ny = cy + DELTA[ex][1];
      if (!cellCanAcceptDFS(nx, ny, OPPOSITE[ex], isZero)) continue;
      ups.push({ track: tn, exit: ex });
    }
    return ups;
  }
  /* 热路径轨道查询：语义与 effectiveTrackAt 一致，但直接查 placed/fixed，
     避免每车每步构造 { ...pz.fixed, ...placed } 合并对象 */
  function effTrackAtDFS(k, tsTog, autoTog) {
    if (_tswitchMap[k]) return effectiveTSwitchTrack(_tswitchMap[k], tsTog);
    if (_autoSwitchMap[k]) return effectiveAutoSwitchTrack(_autoSwitchMap[k], autoTog, k);
    const t = placed[k];
    if (t !== undefined) return t;
    return pz.fixed[k] !== undefined ? pz.fixed[k] : null;
  }

  function dfs(cars, arrived, step, visited, toggled, tsToggled, autoToggled, tsLocks, servedPlatforms) {
    if (iterationBudgetHit || solutionLimitHit) return;
    if (iters >= MAX) { iterationBudgetHit = true; return; }
    iters += 1;
    if (iters % 500000 === 0) {
      const progressStats = dfsStats(false);
      postToMain({
        type: "progress",
        phase: "dfs",
        iters: 500000,
        cspMs: telemetry.cspMs || 0,
        p12SeedMs: telemetry.p12SeedMs || 0,
        dfsMs: telemetry.dfsStartedAt ? elapsedMs(telemetry.dfsStartedAt) : (telemetry.dfsMs || 0),
        dfsInfo: progressStats,
        dfsStats: progressStats,
      });
    }
    if (step > deepest.step || (step === deepest.step && arrived.length > deepest.arrived.length)) {
      deepest = {
        step,
        arrived: [...arrived],
        cars: cars.map(c => ({ name: c.name, x: c.x, y: c.y, entry: c.entry, parked: !!c.parked })),
        placed: { ...placed },
      };
    }
    if (arrived.length === _order.length && !cars.some(c => !isZeroCar(c))) {
      if (!allPlatformsServed(_platformState, servedPlatforms)) return;
      /* Validate via unified Rule Layer */
      const zs = zeroSafetyLookahead(pz, cars, { tracks: { ...pz.fixed, ...placed }, tm, triggers: _trigMap, barriers: _barMap, tswTriggers: _tswMap, tswitchMap: _tswitchMap, autoSwitchMap: _autoSwitchMap, toggled, tsToggled, autoToggled, tsLocks });
      if (zs.ok) {
        if (!validatePlacedTUsage()) return;
        const cost = Object.keys(placed).length - _prePlacedCount; if (!minTracks || cost <= bestCost) rememberSolution(cost); return;
      }
      /* zs.ok is false — fall through to let DFS continue placing tracks for the zero car.
         The cycle-at-visited detection below will catch valid zero-car cycles. */
    }
    const placedCount = Object.keys(placed).length;
    if (step > ms || placedCount > bestCost || (placedCount === bestCost && solutions.length >= MAX_ALTERNATES)) return;
    if (candidateLimitReached()) return;
    for (const c0 of cars) {
      const c = c0; const k = pk(c.x, c.y);
      if (c.parked) continue; /* parked zero car: no track needed */
      if (c.wait > 0) continue;
      if (tm[k]) continue;
      if (_tswitchMap[k]) continue;
      if (_autoSwitchMap[k]) continue;
      if (pz.fixed[k]) continue;
      if (placed[k]) {
        const old = placed[k];
        const ex0 = exitPort(old, c.entry);
        /* FIX: Zero cars on already-placed tracks should not force upgrades
           or block DFS progress. If the track works for them, just continue.
           If not (ex0 is null), zero cars should skip (not abort DFS). */
        if (isZeroCar(c)) {
          if (ex0 !== null) {
            if (!hasUsage(k, c.entry, ex0)) {
              const undo = pushUsage(k, c.entry, ex0);
              dfs(cars, arrived, step, visited, toggled, tsToggled, autoToggled, tsLocks, servedPlatforms); undo(); return;
            }
            continue;
          }
          /* Zero car can't traverse this placed track — try upgrading to T-junction */
          const ups = findUpgrades(old, c.x, c.y, c.entry, true);
          for (const up of ups) {
            if (up.exit === ex0) continue;
            placed[k] = up.track;
            const undo = pushUsage(k, c.entry, up.exit);
            dfs(cars, arrived, step, visited, toggled, tsToggled, autoToggled, tsLocks, servedPlatforms); undo();
            placed[k] = old;
            if (candidateLimitReached()) return;
          }
          return; /* Zero car must have a traversable track — can't skip */
        }
        const ups = findUpgrades(old, c.x, c.y, c.entry);
        for (const up of ups) {
          if (up.exit === ex0) continue;
          placed[k] = up.track;
          const undo = pushUsage(k, c.entry, up.exit);
          dfs(cars, arrived, step, visited, toggled, tsToggled, autoToggled, tsLocks, servedPlatforms); undo();
          placed[k] = old;
          if (candidateLimitReached()) return;
        }
        if (ex0 !== null) {
          if (!hasUsage(k, c.entry, ex0)) {
            const undo = pushUsage(k, c.entry, ex0);
            dfs(cars, arrived, step, visited, toggled, tsToggled, autoToggled, tsLocks, servedPlatforms); undo(); return;
          }
          continue;
        }
        return;
      }
      if (!bs.has(k)) {
        /* No track and not a blank cell — can't proceed (for any car) */
        return;
      }
      const cands = candidates(c);
      for (const tr of cands) {
        if (Object.keys(placed).length + 1 > bestCost) continue;
        const ex = exitPort(tr, c.entry); if (!ex) continue;
        placed[k] = tr;
        const undo = pushUsage(k, c.entry, ex);
        dfs(cars, arrived, step, visited, toggled, tsToggled, autoToggled, tsLocks, servedPlatforms); undo();
        delete placed[k];
        if (candidateLimitReached()) return;
      }
      /* All cars (including zero) must have a track placed — no skip option */
      return;
    }
    /* Build visited key with FULL dynamic state (banned = 已决定不铺轨的格) */
    const sk = arrived.join(",") + "|" + cars.map(c => c.name + ":" + c.x + "," + c.y + "," + c.entry + ":" + (c.wait || 0) + (c.parked ? ":P" : "")).sort().join("|") +
      (_hasBars ? "|T:" + Object.keys(toggled).filter(k => toggled[k]).sort().join(",") : "") +
      (_hasTS ? "|TS:" + Object.keys(tsToggled).filter(k => tsToggled[k]).sort().join(",") + "|L:" + Object.keys(tsLocks).sort().map(n => n + ":" + tsLocks[n].k + ":" + tsLocks[n].track).join(",") : "") +
      (_hasAuto ? "|A:" + Object.keys(autoToggled).filter(k => autoToggled[k]).sort().join(",") : "") +
      (_hasPlatforms ? "|P:" + [...servedPlatforms].sort().join(",") : "") +
      (_hasZero && Object.keys(portBans).length ? "|X:" + Object.keys(portBans).sort().map(k => k + ":" + [...portBans[k]].sort().join("")).join(",") : "");
    if (visited.has(sk)) {
      if (arrived.length === _order.length && !cars.some(c => !isZeroCar(c))) {
        if (allPlatformsServed(_platformState, servedPlatforms) && validatePlacedTUsage()) {
          const cost = Object.keys(placed).length - _prePlacedCount;
          if (!minTracks || cost <= bestCost) rememberSolution(cost);
        }
      }
      return;
    }
    visited.add(sk);

    const nxt = [], na = [...arrived], _trgd = [], _tsTrgd = [], _autoUsed = [], _releaseTSLocks = new Set();
    const _nServed = _hasPlatforms ? new Set(servedPlatforms) : servedPlatforms;
    /* 三阶段推进（与权威 simulate 一致）：意向移动 -> 占格碰撞裁决 -> 移动者发信号 */
    const _recs = [];
    for (const c0 of cars) {
      const c = c0; const k = pk(c.x, c.y);
      /* Parked zero car: stays put forever */
      if (c.parked) { _recs.push({ stay: true, c, keep: { ...c } }); continue; }
      if (c.wait > 0) { _recs.push({ stay: true, c, keep: { ...c, wait: c.wait - 1 } }); continue; }
      let nx, ny, ne, _usedTSLock = false, _usedAutoSwitch = false;
      if (tm[k]) {
        if (c.entry !== tm[k].facing) { visited.delete(sk); return; }
        const p = tm[k].pair;

        nx = p.x + DELTA[p.facing][0]; ny = p.y + DELTA[p.facing][1]; ne = OPPOSITE[p.facing];
      } else {
        /* Use effectiveTrackAt from Rule Layer — single source of truth */
        const _locked = tsLocks[c.name];
        const t = _locked && _locked.k === k ? _locked.track : effTrackAtDFS(k, tsToggled, autoToggled);
        _usedTSLock = !!(_locked && _locked.k === k);
        _usedAutoSwitch = !!_autoSwitchMap[k] && !_usedTSLock;
        /* No track or incompatible entry: always an error (zero cars need track too) */
        if (!t || !exitPort(t, c.entry)) {
          visited.delete(sk); return;
        }
        const ex = exitPort(t, c.entry);
        nx = c.x + DELTA[ex][0]; ny = c.y + DELTA[ex][1]; ne = OPPOSITE[ex];
      }
      if (nx === gx && ny === gy) {
        /* Zero car dead-end: exit leads to goal → error (zero car cannot enter goal) */
        if (isZeroCar(c)) { visited.delete(sk); return; }
        if (!isZeroCar(c)) {
          if (ne !== ge) { visited.delete(sk); return; }
          if (carNeedsPassengers(_platformState, _nServed, c.name)) { visited.delete(sk); return; }
          na.push(c.name);
          const pfx = _order.slice(0, na.length);
          if (na.join(",") !== pfx.join(",")) { visited.delete(sk); return; }
        }
        if (_trigMap[pk(nx, ny)]) _trgd.push(_trigMap[pk(nx, ny)]);
        if (_tswMap[pk(nx, ny)]) _tsTrgd.push(_tswMap[pk(nx, ny)]);
        if (_usedAutoSwitch) _autoUsed.push(k);
        if (_usedTSLock) _releaseTSLocks.add(c.name);
        continue;
      }
      /* Zero car dead-end: exit leads OOB → park at current cell */
      if (nx < 0 || nx >= pz.width || ny < 0 || ny >= pz.height) {
        if (isZeroCar(c)) { _recs.push({ stay: true, c, keep: { ...c, parked: true } }); continue; }
        visited.delete(sk); return;
      }
      const _nk = pk(nx, ny);
      /* 零号车面对下一格缺乏可用端口时的多后继世界（advance-world branching）：
         最终布局在该格有三类可能，每类都是独立后继世界：
           1. 铺了接受零号车入口的轨 —— 零号车驶入，放置/升级阶段决定轨型；
           2. 铺了不含零号车入口端口的轨（服务其他车）或不铺 —— 零号车停车，
              该格挂端口约束(portBans)后重放本步；
         已有轨且端口不匹配、又无法升级的格子只有停车世界。
         portBans 进入 visited 状态键，各世界独立推进。 */
      if (isZeroCar(c) && !tm[_nk]) {
        const _nkTrack = effTrackAtDFS(_nk, tsToggled, autoToggled);
        const _mismatch = !_nkTrack || !exitPort(_nkTrack, ne);
        const _unassignedBlank = bs.has(_nk) && !placed[_nk] && !pz.fixed[_nk] && !_tswitchMap[_nk] && !_autoSwitchMap[_nk];
        if (_mismatch && _unassignedBlank && !portBans[_nk]?.has(ne)) {
          /* 世界 2：停车 + 端口约束（含"最终不铺"与"铺不含该端口的轨"两种结局） */
          const _undoBan = addPortBan(_nk, ne);
          const _carsB = cars.map(cc => cc === c0 ? { ...cc, parked: true } : cc);
          dfs(_carsB, arrived, step, visited, toggled, tsToggled, autoToggled, tsLocks, servedPlatforms);
          _undoBan();
          if (candidateLimitReached()) { visited.delete(sk); return; }
          /* 世界 1：继续向下执行，驶入待铺格 */
        } else if (_mismatch && _unassignedBlank) {
          /* 该格入口已被约束禁止 —— 只有停车世界 */
          _recs.push({ stay: true, c, keep: { ...c, parked: true } }); continue;
        } else if (_mismatch && placed[_nk] && canUpgradePlacedCellForEntry(_nk, ne)) {
          /* 已铺基础轨可升级：世界 A) 保持现状停车（挂端口约束防后续升级破坏一致性）；
             世界 B) 驶入，放置阶段升级为 T。 */
          const _undoBan = addPortBan(_nk, ne);
          const _carsB = cars.map(cc => cc === c0 ? { ...cc, parked: true } : cc);
          dfs(_carsB, arrived, step, visited, toggled, tsToggled, autoToggled, tsLocks, servedPlatforms);
          _undoBan();
          if (candidateLimitReached()) { visited.delete(sk); return; }
          /* 世界 B：继续向下执行 */
        } else if (_mismatch) {
          _recs.push({ stay: true, c, keep: { ...c, parked: true } }); continue;
        }
      }
      let _barrierBlocked = false;
      if (_barMap[_nk]) {
        const _b = _barMap[_nk], _isT = toggled[_b.color] || false;
        const _cs = _b.initialState === 'closed' ? (_isT ? 'open' : 'closed') : (_isT ? 'closed' : 'open');
        if (_cs === 'closed') { _barrierBlocked = true; }
      }
      if (_barrierBlocked) {
        _recs.push({ stay: true, c, keep: { name: c.name, role: c.role, x: c.x, y: c.y, entry: c.entry, wait: 0, _blocked: true } });
        continue;
      }
      /* Apply cellCanAcceptDFS to ALL cars including zero cars. */
      if (!cellCanAcceptDFS(nx, ny, ne, isZeroCar(c))) { visited.delete(sk); return; }
      _recs.push({ stay: false, c, nx, ny, ne, _usedTSLock, _usedAutoSwitch, fromKey: k });
    }
    /* 静止车=墙：无排队降级，驶入不动车格子由占格检测判碰撞（作者实测） */
    for (const m of _recs) {
      if (m.stay) { nxt.push(m.keep); continue; }
      const { c, nx, ny, ne, _usedTSLock, _usedAutoSwitch, fromKey } = m;
      const _nk = pk(nx, ny);
      if (_trigMap[_nk]) _trgd.push(_trigMap[_nk]);
      if (_tswMap[_nk]) _tsTrgd.push(_tswMap[_nk]);
      if (_usedAutoSwitch) _autoUsed.push(fromKey);
      if (_usedTSLock) _releaseTSLocks.add(c.name);
      let _wait = 0;
      if (!isZeroCar(c)) {
        const _pickup = platformPickupForCar(_platformState, _nServed, c.name, _nk);
        if (!_pickup.ok) { visited.delete(sk); return; }
        _wait = _pickup.wait;
      }
      nxt.push({ name: c.name, role: c.role, x: nx, y: ny, entry: ne, wait: _wait });
    }
    const occ = new Set();
    for (const c of nxt) {
      const k = pk(c.x, c.y); if (occ.has(k)) { visited.delete(sk); return; } occ.add(k);
      if (tm[k]) { const pkp = pk(tm[k].pair.x, tm[k].pair.y); if (occ.has(pkp)) { visited.delete(sk); return; } occ.add(pkp); }
    }
    /* 追尾判定已删除（作者确认）：跟随合法，追撞由排队与占格碰撞覆盖 */
    if (detectSwapCollision(cars, nxt)) { visited.delete(sk); return; }

    const _blocked = occupiedBarrierColors(nxt, _barMap);
    const _nt = _hasBars && _trgd.length ? { ...toggled } : toggled;
    if (_trgd.length) for (const cl of _trgd) { if (!_blocked.has(cl)) _nt[cl] = !_nt[cl]; }
    const _nts = _hasTS && _tsTrgd.length ? { ...tsToggled } : tsToggled;
    const _locks = _hasTS ? { ...tsLocks } : tsLocks;
    if (_hasTS) for (const name of _releaseTSLocks) delete _locks[name];
    const _tsTrgdSet = new Set(_tsTrgd);
    if (_hasTS) for (const c of nxt) { const k = pk(c.x, c.y), sw = _tswitchMap[k]; if (sw && _tsTrgdSet.has(sw.color)) _locks[c.name] = { k, track: effectiveTSwitchTrack(sw, tsToggled) }; }
    if (_tsTrgd.length) for (const cl of _tsTrgd) _nts[cl] = !_nts[cl];
    const _nat = _hasAuto && _autoUsed.length ? { ...autoToggled } : autoToggled;
    if (_autoUsed.length) for (const k of _autoUsed) _nat[k] = !_nat[k];

    dfs(nxt, na, step + 1, visited, _nt, _nts, _nat, _locks, _nServed); visited.delete(sk);
  }

  dfs(pz.cars.map(c => ({ ...c, wait: c.wait || 0 })), [], 1, new Set(), {}, {}, {}, {}, new Set());
  const finalStats = dfsStats(true);
  postToMain({
    type: "progress",
    phase: "dfs",
    iters: 0,
    cspMs: telemetry.cspMs || 0,
    p12SeedMs: telemetry.p12SeedMs || 0,
    dfsMs: telemetry.dfsStartedAt ? elapsedMs(telemetry.dfsStartedAt) : (telemetry.dfsMs || 0),
    dfsInfo: finalStats,
    dfsStats: finalStats,
  });
  return {
    solutions: solutions.slice(0, Math.max(maxSol, MAX_ALTERNATES)),
    stats: finalStats,
  };
}

/* solveZeroAware removed: the phased approach (solve normal/zero cars separately
   then combine) has fundamental flaws — it cannot detect temporal collisions between
   normal and zero cars during individual phases, and fails when car paths share
   auto-switch state. Train 0 is now handled natively by CSP (excluded from path
   enumeration, validated by simulate) and DFS (joint simulation with collision
   detection). */

// ═══════════ Worker entry point ═══════════

self.onmessage = function (e) {
  const { type, requestId, puzzle: pz, seed, maxTracksHint, solverOptions: rawSolverOptions } = e.data;
  if (type === "stop") { self.close(); return; }
  if (type !== "solve") return;
  activeRequestId = requestId ?? null;
  const solverOptions = rawSolverOptions && typeof rawSolverOptions === "object" ? rawSolverOptions : {};

  const telemetry = {
    startedAt: performance.now(),
    firstCandidateMs: null,
    cspStartedAt: null,
    dfsStartedAt: null,
    cspMs: 0,
    p12SeedMs: 0,
    dfsMs: 0,
  };
  const minTracks = pz._minTracks !== false;
  const { useful, meta, pruned } = filterBlanks(pz);
  const bs = new Set(useful.map(b => pk(b[0], b[1])));
  const budget = maxTracksHint > 0 ? Math.min(maxTracksHint, useful.length) : (minTracks ? Infinity : useful.length + 1);
  const fpz = { ...pz, blanks: useful };
  const features = puzzleHasDynamicState(pz);
  const cspGuard = createCspGuard(solverOptions.cspTimebox, telemetry);
  const p12SeedConfig = normalizeP12Seed(solverOptions.p12Seed || DEFAULT_P12_SEED);
  cspGuard.stats.p12Seed = createP12SeedStats(p12SeedConfig);
  const dfsMaxIterations = finiteBudget(solverOptions.dfsMaxIterations, DEFAULT_DFS_MAX_ITERATIONS);
  let cspMs = 0, p12SeedMs = 0, dfsMs = 0;

  function emptyDfsStats(reason = "not-run") {
    return {
      nodes: 0,
      iterations: 0,
      limit: dfsMaxIterations,
      deepestStep: 0,
      deepest: { step: 0, arrived: [], cars: [], placed: {} },
      iterationBudgetHit: false,
      exhausted: false,
      solutionLimitHit: false,
      searchComplete: false,
      terminationReason: reason,
      solutions: 0,
    };
  }
  function mergeAlternates(a, b) {
    const out = [], seen = new Set();
    function key(sol) { return Object.keys(sol).filter(k => k !== "__cost").sort().map(k => k + ":" + sol[k]).join("|"); }
    for (const list of [a, b]) for (const sol of list || []) {
      if (!sol || (Number.isFinite(budget) && sol.__cost > budget)) continue;
      const k = key(sol);
      if (seen.has(k)) continue;
      seen.add(k); out.push(sol);
    }
    out.sort((left, right) => left.__cost - right.__cost || key(left).localeCompare(key(right)));
    return out.slice(0, MAX_ALTERNATES);
  }
  function finish({ method, info = "", alternates = [], dfsStats = emptyDfsStats(), complete, terminationReason }) {
    const accepted = alternates.filter(sol => sol && (!Number.isFinite(budget) || sol.__cost <= budget));
    const finalCost = accepted.length ? Math.min(...accepted.map(sol => sol.__cost)) : null;
    postToMain({
      type: "done",
      method,
      info,
      pruned,
      alternates: accepted,
      cspMs,
      p12SeedMs,
      dfsMs,
      cspStats: cspGuard.snapshot(),
      dfsStats,
      firstCandidateMs: telemetry.firstCandidateMs,
      finalCost,
      complete,
      terminationReason,
    });
  }
  function markCspSkipped(reason) {
    cspGuard.stats.skipped = true;
    cspGuard.stats.skipReason = reason;
  }
  function runDfs(dfsBudget) {
    const dfsStartedAt = performance.now();
    telemetry.cspMs = cspMs;
    telemetry.dfsStartedAt = dfsStartedAt;
    postToMain({
      type: "progress",
      phase: "dfs",
      iters: 0,
      cspMs,
      p12SeedMs,
      dfsMs,
      cspStats: cspGuard.snapshot(),
      dfsStats: emptyDfsStats("running"),
    });
    const result = solveDFS(fpz, 1, minTracks, dfsBudget, seed || 0, bs, meta, telemetry, dfsMaxIterations);
    dfsMs += elapsedMs(dfsStartedAt);
    telemetry.dfsMs = dfsMs;
    telemetry.dfsStartedAt = null;
    return result;
  }
  function finishAfterDfs(method, info, cspAlternates, dfsResult) {
    const alternates = mergeAlternates(cspAlternates, dfsResult.solutions);
    const hasCandidate = alternates.length > 0;
    let terminationReason;
    if (dfsResult.stats.iterationBudgetHit) terminationReason = hasCandidate ? "candidate-unproven-dfs-budget" : "dfs-iteration-budget";
    else if (dfsResult.stats.solutionLimitHit) terminationReason = "candidate-unproven-early-stop";
    else terminationReason = hasCandidate ? "optimal-proven" : "search-exhausted";
    const complete = dfsResult.stats.searchComplete;
    finish({ method, info, alternates, dfsStats: dfsResult.stats, complete, terminationReason });
  }

  postToMain({ type: "progress", phase: "prepare", iters: 0, pruned, cspMs: 0, dfsMs: 0, cspStats: cspGuard.snapshot(), dfsStats: emptyDfsStats() });

  /* Heterogeneous portfolio role: candidate generation (CSP and the P12 seed)
     is delegated to the CSP-role Worker; this one goes straight to DFS on its
     own seed. `skipCsp` lives in solverOptions, so the DFS-only role owns a
     distinct proofScopeKey and its completeness claims never transfer to the
     CSP role's scope. */
  if (solverOptions.skipCsp === true) {
    cspGuard.stats.p12Seed.skipped = true;
    cspGuard.stats.p12Seed.skipReason = "dfs-only-role";
    cspGuard.stats.p12Seed.terminationReason = "dfs-only-role";
    markCspSkipped("dfs-only-role");
    const cspInfo = "CSP skipped: portfolio dfs-only role";
    postToMain({ type: "progress", phase: "dfs", iters: 0, cspInfo, cspMs, dfsMs, cspStats: cspGuard.snapshot() });
    const dfsResult = runDfs(budget);
    finishAfterDfs(dfsResult.solutions.length > 0 ? "dfs(skip-csp)" : "no-solution", cspInfo, [], dfsResult);
    return;
  }

  /* Train 0 handling: CSP enumerates paths only for normal cars (zero car
     excluded — it has no goal). DFS simulates all cars jointly with full
     collision detection. Final validation uses simulate() + zeroSafetyLookahead(). */

  if (useful.length <= 45 && pz.cars.length <= 8) {
    cspGuard.stats.p12Seed.skipped = true;
    cspGuard.stats.p12Seed.skipReason = p12SeedConfig.enabled ? "classic-csp-route" : "disabled";
    cspGuard.stats.p12Seed.terminationReason = cspGuard.stats.p12Seed.skipReason;
    /* Global triggers can flip remote state, which static CSP cannot model.
       Auto-switches are local state, so CSP still runs and simulate validates. */
    if (features.cspUnsafe) {
      markCspSkipped("dynamic-global-state");
      const cspInfo = "CSP skipped: global triggers (tswTrig=" + features.hasTSwTriggers + " barTrig=" + features.hasBarrierTriggers + ")";
      postToMain({ type: "progress", phase: "dfs", iters: 0, cspInfo, cspMs, dfsMs, cspStats: cspGuard.snapshot() });
      const dfsResult = runDfs(budget);
      finishAfterDfs(dfsResult.solutions.length > 0 ? "dfs(skip-csp)" : "no-solution", cspInfo, [], dfsResult);
      return;
    }

    const slacks = pz.pathSlack ? [pz.pathSlack] : [4, 8, 14];
    let lastCsp = null, bestSol = null, bestAlternates = [], bestSlack = null, curBudget = budget;
    const cspStartedAt = performance.now();
    telemetry.cspStartedAt = cspStartedAt;
    postToMain({ type: "progress", phase: "csp", iters: 0, cspMs: 0, dfsMs, cspStats: cspGuard.snapshot() });
    for (const slack of slacks) {
      if (cspGuard.stats.aborted) break;
      const ppz = { ...fpz, pathSlack: slack };
      const csp = solveCSP(ppz, curBudget, bs, meta, cspGuard, telemetry);
      lastCsp = csp;
      if (csp && csp.sol && (!bestSol || csp.sol.__cost < bestSol.__cost)) {
        bestSol = csp.sol;
        bestAlternates = csp.alternates || [csp.sol];
        bestSlack = slack;
        curBudget = csp.sol.__cost - 1;
      }
    }
    cspMs += elapsedMs(cspStartedAt);
    telemetry.cspMs = cspMs;
    telemetry.cspStartedAt = null;
    postToMain({ type: "progress", phase: "csp", iters: 0, cspInfo: lastCsp ? lastCsp.info : "", cspMs, dfsMs, cspStats: cspGuard.snapshot() });

    /* A CSP-only candidate is useful, but bounded slack/path enumeration does
       not constitute an optimality proof. Any CSP abort always falls through. */
    const cspTrustworthyCandidate = bestSol && lastCsp && !lastCsp.overflow && !cspGuard.stats.aborted && !features.isDynamic && !features.hasZero;
    if (cspTrustworthyCandidate) {
      finish({
        method: "csp(slack=" + bestSlack + ")",
        info: lastCsp.info,
        alternates: bestAlternates,
        dfsStats: emptyDfsStats("candidate-unproven-csp"),
        complete: false,
        terminationReason: "candidate-unproven-csp",
      });
      return;
    }

    /* CSP is candidate generation only. An abort, overflow, dynamic feature,
       or empty result must reliably enter the sound DFS fallback. */
    const dfsBudget = bestSol ? Math.min(budget, bestSol.__cost) : budget;
    const dfsResult = runDfs(dfsBudget);
    const dfsBest = dfsResult.solutions.length > 0 ? dfsResult.solutions[0].__cost : null;
    const method = bestSol
      ? (dfsBest !== null && dfsBest < bestSol.__cost ? "csp+dfs(csp=" + bestSol.__cost + ",dfs=" + dfsBest + ")" : "csp+dfs(csp=" + bestSol.__cost + ",dfs-noimprove)")
      : (dfsResult.solutions.length > 0 ? "dfs" : "no-solution");
    finishAfterDfs(method, lastCsp ? lastCsp.info : "", bestAlternates, dfsResult);
    return;
  }

  markCspSkipped("size-threshold");
  let p12SeedCandidate = null;
  if (!p12SeedConfig.enabled) {
    cspGuard.stats.p12Seed.skipped = true;
    cspGuard.stats.p12Seed.skipReason = "disabled";
    cspGuard.stats.p12Seed.terminationReason = "disabled";
  } else {
    postToMain({
      type: "progress",
      phase: "p12-seed",
      iters: 0,
      cspInfo: "CSP skipped: puzzle size threshold; P12 bounded pattern seed",
      cspMs,
      p12SeedMs,
      dfsMs,
      cspStats: cspGuard.snapshot(),
    });
    const p12SeedStartedAt = performance.now();
    p12SeedCandidate = solveP12PatternSeed(pz, budget, p12SeedConfig, cspGuard.stats.p12Seed);
    p12SeedMs += elapsedMs(p12SeedStartedAt);
    telemetry.p12SeedMs = p12SeedMs;
    if (p12SeedCandidate) {
      emitCandidate(p12SeedCandidate, telemetry, "p12-pattern-seed", {
        phase: "p12-seed",
        cspMs,
        p12SeedMs,
        dfsMs,
        cspStats: cspGuard.snapshot(),
        dfsStats: emptyDfsStats("candidate-unproven-p12-seed"),
      });
      cspGuard.stats.p12Seed.firstCandidateMs = telemetry.firstCandidateMs;
    }
  }
  const p12SeedInfo = p12SeedCandidate
    ? "P12 bounded pattern seed produced a simulate()-validated candidate"
    : "P12 bounded pattern seed: " + cspGuard.stats.p12Seed.terminationReason;
  postToMain({
    type: "progress",
    phase: "dfs",
    iters: 0,
    cspInfo: "CSP skipped: puzzle size threshold; " + p12SeedInfo,
    cspMs,
    p12SeedMs,
    dfsMs,
    cspStats: cspGuard.snapshot(),
  });
  const dfsBudget = p12SeedCandidate ? Math.min(budget, p12SeedCandidate.__cost) : budget;
  const dfsResult = runDfs(dfsBudget);
  const method = p12SeedCandidate
    ? (dfsResult.solutions.length > 0 ? "p12-seed+dfs" : "p12-seed+dfs(no-improve)")
    : (dfsResult.solutions.length > 0 ? "dfs(skip-csp)" : "no-solution");
  finishAfterDfs(method, "CSP skipped: puzzle size threshold; " + p12SeedInfo, p12SeedCandidate ? [p12SeedCandidate] : [], dfsResult);
};
