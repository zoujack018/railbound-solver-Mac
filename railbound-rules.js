const TRACKS = {
  "|": { N: "S", S: "N" }, "-": { E: "W", W: "E" },
  NE: { N: "E", E: "N" }, ES: { E: "S", S: "E" }, SW: { S: "W", W: "S" }, WN: { W: "N", N: "W" },
  T_NE_S: { S: "N", E: "N", N: "E" }, T_NE_W: { W: "E", N: "E", E: "N" },
  T_ES_N: { N: "S", E: "S", S: "E" }, T_ES_W: { W: "E", S: "E", E: "S" },
  T_SW_N: { N: "S", W: "S", S: "W" }, T_SW_E: { E: "W", S: "W", W: "S" },
  T_WN_E: { E: "W", N: "W", W: "N" }, T_WN_S: { S: "N", W: "N", N: "W" },
};
const T_META = {
  T_NE_S: { curve: ["N", "E"], branch: "S", merge: "N" }, T_NE_W: { curve: ["N", "E"], branch: "W", merge: "E" },
  T_ES_N: { curve: ["E", "S"], branch: "N", merge: "S" }, T_ES_W: { curve: ["E", "S"], branch: "W", merge: "E" },
  T_SW_N: { curve: ["S", "W"], branch: "N", merge: "S" }, T_SW_E: { curve: ["S", "W"], branch: "E", merge: "W" },
  T_WN_E: { curve: ["W", "N"], branch: "E", merge: "W" }, T_WN_S: { curve: ["W", "N"], branch: "S", merge: "N" },
};
const T_SWITCH_PAIRS = {
  T_NE_S: "T_ES_N",
  T_ES_N: "T_NE_S",
  T_NE_W: "T_WN_E",
  T_WN_E: "T_NE_W",
  T_ES_W: "T_SW_E",
  T_SW_E: "T_ES_W",
  T_SW_N: "T_WN_S",
  T_WN_S: "T_SW_N",
};
const OPPOSITE = { N: "S", S: "N", E: "W", W: "E" };
const DELTA = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
const ALL_DIRS = ["N", "E", "S", "W"];
const BASIC_TRACKS = ["|", "-", "NE", "ES", "SW", "WN"];
const T_TRACKS = ["T_NE_S", "T_NE_W", "T_ES_N", "T_ES_W", "T_SW_N", "T_SW_E", "T_WN_E", "T_WN_S"];
const TRACK_NAMES = [...BASIC_TRACKS, ...T_TRACKS];
const pk = (x, y) => `${x},${y}`;
function exitPort(t, e) { const r = TRACKS[t]; return r ? (r[e] || null) : null; }

const TRACKS_BY_ENTRY = {};
for (const d of ALL_DIRS) TRACKS_BY_ENTRY[d] = TRACK_NAMES.filter(t => exitPort(t, d) !== null);
const BASIC_BY_ENTRY = {};
for (const d of ALL_DIRS) BASIC_BY_ENTRY[d] = BASIC_TRACKS.filter(t => exitPort(t, d) !== null);
const TRACKS_BY_EXIT = {};
for (const d of ALL_DIRS) { TRACKS_BY_EXIT[d] = []; for (const t of TRACK_NAMES) for (const e of ALL_DIRS) if (exitPort(t, e) === d) TRACKS_BY_EXIT[d].push({ track: t, entry: e }); }

const TUNNEL_COLORS = ["#e74c3c", "#3498db", "#2ecc71", "#f39c12", "#9b59b6"];
const BARRIER_COLORS = ["#e8584a", "#4a8ae8", "#5ad85a", "#e8b84a", "#b84ae8"];
function buildTunnelMap(tunnels) {
  const m = {};
  if (!tunnels) return m;
  for (const t of tunnels) {
    if (t.cells.length !== 2) continue;
    const [a, b] = t.cells;
    m[pk(a.x, a.y)] = { facing: a.facing, pair: b, color: t.color };
    m[pk(b.x, b.y)] = { facing: b.facing, pair: a, color: t.color };
  }
  return m;
}
function buildTSwitchMap(tswitches) {
  const m = {};
  if (!tswitches) return m;
  for (const s of tswitches) {
    if (!T_SWITCH_PAIRS[s.track]) continue;
    m[pk(s.x, s.y)] = { color: s.color, track: s.track, pair: T_SWITCH_PAIRS[s.track] };
  }
  return m;
}

function buildAutoSwitchMap(autoSwitches) {
  const m = {};
  if (!autoSwitches) return m;
  for (const s of autoSwitches) {
    if (!T_SWITCH_PAIRS[s.track]) continue;
    m[pk(s.x, s.y)] = { track: s.track, pair: T_SWITCH_PAIRS[s.track] };
  }
  return m;
}

function isCellBarrierBlocked(nk, toggled, barriers) {
  if (!barriers[nk]) return false;
  const b = barriers[nk];
  const isToggled = toggled[b.color] || false;
  const currentState = b.initialState === 'closed' ? (isToggled ? 'open' : 'closed') : (isToggled ? 'closed' : 'open');
  return currentState === 'closed';
}

function effectiveTSwitchTrack(sw, tsToggled) {
  if (!sw) return null;
  return tsToggled[sw.color] ? sw.pair : sw.track;
}

function effectiveAutoSwitchTrack(sw, autoToggled, k) {
  if (!sw) return null;
  return autoToggled[k] ? sw.pair : sw.track;
}

function effectiveTrackAt(k, tracks, tswitchMap, tsToggled, autoSwitchMap = {}, autoToggled = {}) {
  if (tswitchMap[k]) return effectiveTSwitchTrack(tswitchMap[k], tsToggled);
  if (autoSwitchMap[k]) return effectiveAutoSwitchTrack(autoSwitchMap[k], autoToggled, k);
  return tracks[k] || null;
}

function tswitchTrackVariants(sw) {
  if (!sw) return [];
  return [...new Set([sw.track, sw.pair])];
}

/* ═══════════════════════════════════════════════
 * Helper: collect barrier colors occupied by cars
 * If any car sits on a barrier of color X, toggling X is suppressed.
 * ═══════════════════════════════════════════════ */
function occupiedBarrierColors(cars, barriers) {
  const colors = new Set();
  for (const c of cars) {
    const k = pk(c.x, c.y);
    if (barriers[k]) colors.add(barriers[k].color);
  }
  return colors;
}

function buildPlatformState(platforms) {
  const targets = {}, requiredByCar = {};
  if (!platforms) return { targets, requiredByCar, count: 0 };
  let count = 0;
  for (let i = 0; i < platforms.length; i++) {
    const p = platforms[i];
    const dir = p.dir || p.facing || p.direction || "E";
    if (!DELTA[dir]) continue;
    const car = String(p.car ?? p.carName ?? p.name ?? p.demand ?? "");
    if (!car) continue;
    const tx = p.target?.x ?? (p.x + DELTA[dir][0]);
    const ty = p.target?.y ?? (p.y + DELTA[dir][1]);
    const item = { id: String(i), x: p.x, y: p.y, dir, car, targetKey: pk(tx, ty) };
    if (!targets[item.targetKey]) targets[item.targetKey] = [];
    targets[item.targetKey].push(item);
    if (!requiredByCar[car]) requiredByCar[car] = [];
    requiredByCar[car].push(item);
    count++;
  }
  return { targets, requiredByCar, count };
}

function platformPickupForCar(platformState, served, carName, targetKey) {
  const platforms = platformState.targets[targetKey];
  if (!platforms) return { ok: true, wait: 0 };
  const pending = platforms.filter(p => !served.has(p.id));
  if (!pending.length) return { ok: true, wait: 0 };
  const match = pending.find(p => p.car === String(carName));
  if (!match) return { ok: true, wait: 0 };
  served.add(match.id);
  return { ok: true, wait: 2 };
}

function carNeedsPassengers(platformState, served, carName) {
  const needed = platformState.requiredByCar[String(carName)] || [];
  return needed.some(p => !served.has(p.id));
}

function allPlatformsServed(platformState, served) {
  return served.size >= platformState.count;
}

function isZeroCar(c) {
  return c?.role === "zero" || String(c?.name) === "0";
}

function requiredOrder(puzzle) {
  const order = puzzle.order || puzzle.cars.filter(c => !isZeroCar(c)).map(c => String(c.name));
  return order.filter(name => String(name) !== "0");
}

function zeroSafetySteps(puzzle) {
  const raw = puzzle.zeroSafetySteps ?? puzzle.zero_safety_steps ?? 3;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 3;
}

function zeroSafetyKey(cars, toggled, tsToggled, autoToggled, tsLocks) {
  const carsKey = cars.map(c => `${c.name}:${c.x},${c.y},${c.entry}:${c.wait || 0}${c.parked ? ':P' : ''}`).sort().join("|");
  const onKeys = obj => Object.keys(obj || {}).filter(k => obj[k]).sort().join(",");
  const lockKey = Object.keys(tsLocks || {}).sort().map(n => `${n}:${tsLocks[n].k}:${tsLocks[n].track}`).join(",");
  return `${carsKey}|B:${onKeys(toggled)}|TS:${onKeys(tsToggled)}|A:${onKeys(autoToggled)}|L:${lockKey}`;
}

/* 追尾判定已删除（2026-07-22，作者确认）：真实 Railbound 允许车辆一格间距
   跟随行驶；若前车静止，后车驶入其占格会由同一步落点重合的 CELL_COLLISION
   直接拒绝。删除依据：4×8 关卡在原规则下完备搜索最小 11 轨 > 题目上限 9，
   删除后恰好 9 轨；autoswitch 6×4 夹具的 hasSolution:true 与原规则第 1 步
   必然 TAILING 直接矛盾。 */

/* 对穿碰撞（2026-07-22，作者确认，实例：7×7-8-5A 自变 T 处 3 向下、4 向右）：
   相邻两车同一步穿过同一条边互换格子是碰撞。只对相邻格互换判撞——
   经隧道传送导致的"位置互换"没有物理交汇，不算。 */
function detectSwapCollision(prevCars, nextCars) {
  if (nextCars.length < 2) return null;
  const prevByName = new Map();
  for (const c of prevCars) prevByName.set(c.name, c);
  let moves = null;
  for (const c of nextCars) {
    const p = prevByName.get(c.name);
    if (!p || (p.x === c.x && p.y === c.y)) continue;
    const adjacent = Math.abs(p.x - c.x) + Math.abs(p.y - c.y) === 1;
    if (!adjacent) continue;
    const from = pk(p.x, p.y), to = pk(c.x, c.y);
    if (moves) {
      const other = moves.get(to + ">" + from);
      if (other) {
        return {
          reason: "对穿碰撞",
          detail: { errorCode: "SWAP_COLLISION", cars: [other, c.name], cells: [from, to] },
        };
      }
    } else {
      moves = new Map();
    }
    moves.set(from + ">" + to, c.name);
  }
  return null;
}

function detectCarCollision(cars, world) {
  const occupied = new Map();
  for (const car of cars) {
    const key = pk(car.x, car.y);
    if (occupied.has(key)) return { reason: "碰撞", detail: { errorCode: "CELL_COLLISION", cars: [occupied.get(key), car.name], cell: key } };
    occupied.set(key, car.name);
    if (world.tm[key]) {
      const pairKey = pk(world.tm[key].pair.x, world.tm[key].pair.y);
      if (occupied.has(pairKey)) return { reason: "碰撞", detail: { errorCode: "TUNNEL_COLLISION", cars: [occupied.get(pairKey), car.name], cells: [key, pairKey] } };
      occupied.set(pairKey, car.name);
    }
  }
  return null;
}

function applyWorldTransitions(cars, signals, world) {
  const blockedColors = occupiedBarrierColors(cars, world.barriers);
  for (const name of signals.releaseTSLocks) delete world.tsLocks[name];
  for (const color of signals.triggeredColors) if (!blockedColors.has(color)) world.toggled[color] = !world.toggled[color];

  const triggeredSwitchColors = new Set(signals.tsTriggeredColors);
  for (const car of cars) {
    const key = pk(car.x, car.y), sw = world.tswitchMap[key];
    if (sw && triggeredSwitchColors.has(sw.color)) world.tsLocks[car.name] = { k: key, track: effectiveTSwitchTrack(sw, world.tsToggled) };
  }
  for (const color of signals.tsTriggeredColors) world.tsToggled[color] = !world.tsToggled[color];
  for (const key of signals.autoUsedKeys) world.autoToggled[key] = !world.autoToggled[key];
}

function zeroSafetyLookahead(puzzle, cars, ctx) {
  const steps = zeroSafetySteps(puzzle);
  let zeroCars = cars.filter(isZeroCar).map(c => ({ ...c, wait: c.wait || 0 }));
  if (!zeroCars.length) return { ok: true, reason: "无零号车" };

  const {
    tracks, tm, triggers, barriers, tswTriggers, tswitchMap, autoSwitchMap
  } = ctx;
  let toggled = { ...ctx.toggled };
  let tsToggled = { ...ctx.tsToggled };
  let autoToggled = { ...ctx.autoToggled };
  let tsLocks = { ...ctx.tsLocks };
  const seen = new Set();

  for (let i = 0; i <= steps; i++) {
    const sk = zeroSafetyKey(zeroCars, toggled, tsToggled, autoToggled, tsLocks);
    if (seen.has(sk)) return { ok: true, reason: "零号车循环安全" };
    seen.add(sk);
    if (i === steps) break;

    const nxt = [];
    const triggeredColors = [];
    const tsTriggeredColors = [];
    const autoUsedKeys = [];
    const releaseTSLocks = new Set();
    /* 与 simulate() 一致的三阶段推进：意向移动 -> 占格碰撞裁决 -> 移动者发信号
       （静止车=墙，无排队降级） */
    const moveRecs = [];

    for (const c of zeroCars) {
      const k = pk(c.x, c.y);
      /* Parked zero car: stays put forever — trivially safe */
      if (c.parked) { moveRecs.push({ stay: true, c, keep: { ...c } }); continue; }
      if (c.wait > 0) {
        moveRecs.push({ stay: true, c, keep: { ...c, wait: c.wait - 1 } });
        continue;
      }

      let nx, ny, ne;
      let usedTSLock = false;
      let usedAutoSwitch = false;
      if (tm[k]) {
        if (c.entry !== tm[k].facing) return { ok: false, reason: `${c.name} 错误进入隧道`, detail: { errorCode: 'TUNNEL_ENTRY', car: c.name, cell: k, entry: c.entry, expected: tm[k].facing } };
        const p = tm[k].pair;

        nx = p.x + DELTA[p.facing][0]; ny = p.y + DELTA[p.facing][1]; ne = OPPOSITE[p.facing];
      } else {
        const locked = tsLocks[c.name];
        const tr = locked && locked.k === k ? locked.track : effectiveTrackAt(k, tracks, tswitchMap, tsToggled, autoSwitchMap, autoToggled);
        usedTSLock = !!(locked && locked.k === k);
        usedAutoSwitch = !!autoSwitchMap[k] && !usedTSLock;
        /* No track or incompatible entry: zero car safety failure */
        if (!tr || !exitPort(tr, c.entry)) {
          return { ok: false, reason: `${c.name} 无法通行`, detail: { errorCode: !tr ? 'NO_TRACK' : 'PORT_MISMATCH', car: c.name, cell: k } };
        }
        const ex = exitPort(tr, c.entry);
        nx = c.x + DELTA[ex][0]; ny = c.y + DELTA[ex][1]; ne = OPPOSITE[ex];
      }

      /* Goal entry is unsafe; OOB or a trackless next cell parks the zero car. */
      if (nx === puzzle.goal[0] && ny === puzzle.goal[1]) return { ok: false, reason: `${c.name} 进终点`, detail: { errorCode: 'ZERO_AT_GOAL', car: c.name, from: k, goal: pk(nx, ny) } };
      if (nx < 0 || nx >= puzzle.width || ny < 0 || ny >= puzzle.height) { moveRecs.push({ stay: true, c, keep: { ...c, parked: true } }); continue; }

      const nk = pk(nx, ny);
      /* Check if next cell has a traversable track or tunnel before moving */
      if (!tm[nk]) {
        const nkTrack = effectiveTrackAt(nk, tracks, tswitchMap, tsToggled, autoSwitchMap, autoToggled);
        if (!nkTrack || !exitPort(nkTrack, ne)) { moveRecs.push({ stay: true, c, keep: { ...c, parked: true } }); continue; }
      }

      let _barrierBlocked = false;
      if (barriers[nk]) {
        const b = barriers[nk];
        const isToggled = toggled[b.color] || false;
        const currentState = b.initialState === 'closed' ? (isToggled ? 'open' : 'closed') : (isToggled ? 'closed' : 'open');
        if (currentState === 'closed') {
          _barrierBlocked = true;
        }
      }
      if (_barrierBlocked) {
        moveRecs.push({ stay: true, c, keep: { name: c.name, role: c.role, x: c.x, y: c.y, entry: c.entry, wait: 0, _blocked: true } });
        continue;
      }

      moveRecs.push({ stay: false, c, nx, ny, ne, usedTSLock, usedAutoSwitch, fromKey: k });
    }

    for (const m of moveRecs) {
      if (m.stay) { nxt.push(m.keep); continue; }
      const { c, nx, ny, ne, usedTSLock, usedAutoSwitch, fromKey } = m;
      if (triggers[pk(nx, ny)]) triggeredColors.push(triggers[pk(nx, ny)]);
      if (tswTriggers[pk(nx, ny)]) tsTriggeredColors.push(tswTriggers[pk(nx, ny)]);
      if (usedTSLock) releaseTSLocks.add(c.name);
      if (usedAutoSwitch) autoUsedKeys.push(fromKey);
      nxt.push({ name: c.name, role: c.role, x: nx, y: ny, entry: ne, wait: 0 });
    }

    const world = { tracks, tm, barriers, tswitchMap, autoSwitchMap, toggled, tsToggled, autoToggled, tsLocks };
    const collision = detectCarCollision(nxt, world) || detectSwapCollision(zeroCars, nxt);
    if (collision) return { ok: false, ...collision };
    zeroCars = nxt;
    applyWorldTransitions(zeroCars, { triggeredColors, tsTriggeredColors, autoUsedKeys, releaseTSLocks }, world);
  }

  return { ok: true, reason: "零号车前瞻安全" };
}

function carWaypoints(platformState, carName) {
  const needed = platformState.requiredByCar[String(carName)] || [];
  return needed.map(p => {
    const [x, y] = p.targetKey.split(",").map(Number);
    return { x, y };
  });
}

function minRemainingDist(x, y, waypoints, wpIdx, gx, gy) {
  let d = 0, cx = x, cy = y;
  for (let i = wpIdx; i < waypoints.length; i++) {
    d += Math.abs(cx - waypoints[i].x) + Math.abs(cy - waypoints[i].y);
    cx = waypoints[i].x; cy = waypoints[i].y;
  }
  return d + Math.abs(cx - gx) + Math.abs(cy - gy);
}

/* Cells that are platform-pickup targets assigned to OTHER cars.
   Conservative: return empty set (non-matching cars can freely pass). */
function blockedCellsForCar(platformState, carName) {
  return new Set();
}

function simulate(puzzle, placed) {
  const ge = puzzle.goalEntry ?? puzzle.goal_entry, ms = puzzle.maxSteps ?? puzzle.max_steps ?? 50,
    tracks = { ...puzzle.fixed, ...placed }, tm = buildTunnelMap(puzzle.tunnels);
  const order = requiredOrder(puzzle);

  const triggers = {};
  if (puzzle.triggers) for (const t of puzzle.triggers) triggers[pk(t.x, t.y)] = t.color;
  const barriers = {};
  if (puzzle.barriers) for (const b of puzzle.barriers) barriers[pk(b.x, b.y)] = { color: b.color, initialState: b.initialState };
  const tswTriggers = {};
  const rawTswTriggers = puzzle.tsw_triggers || puzzle.tswTriggers || [];
  for (const t of rawTswTriggers) tswTriggers[pk(t.x, t.y)] = t.color;
  const tswitchMap = buildTSwitchMap(puzzle.tswitches);
  const autoSwitchMap = buildAutoSwitchMap(puzzle.autoSwitches || puzzle.auto_switches);
  const platformState = buildPlatformState(puzzle.platforms);
  const servedPlatforms = new Set();
  let toggled = {};
  let tsToggled = {};
  let autoToggled = {};
  let tsLocks = {};

  let cars = puzzle.cars.map(c => ({ ...c, wait: c.wait || 0 })); const arrived = [], history = [cars.map(c => ({ ...c }))];
  for (let t = 1; t <= ms; t++) {
    const nxt = [];
    const triggeredColors = [];
    const tsTriggeredColors = [];
    const autoUsedKeys = [];
    const releaseTSLocks = new Set();
    /* 三阶段推进：① 逐车计算意向移动；② 碰撞由占格检测统一裁决 ——
       静止车（停车/接客等待/Barrier 阻挡）就是墙，驶入其格子 = 碰撞，
       游戏中没有"预判性排队"（2026-07-22 作者实测：8×8-8-5B 中 4 追撞
       接客等待的 3 = 撞车；此前的排队降级机制因此回退）；
       ③ 只对实际移动的车辆触发机关信号与接客。 */
    const moveRecs = [];

    for (const c0 of cars) {
      const c = c0;
      const k = pk(c.x, c.y);
      /* Parked zero car: stays put forever */
      if (c.parked) { moveRecs.push({ stay: true, c, keep: { ...c } }); continue; }
      if (c.wait > 0) {
        moveRecs.push({ stay: true, c, keep: { ...c, wait: c.wait - 1 } });
        continue;
      }
      let nx, ny, ne;
      let usedTSLock = false;
      let usedAutoSwitch = false;
      if (tm[k]) {
        if (c.entry !== tm[k].facing) return { ok: false, reason: `${c.name} 错误进入隧道`, arrived, steps: t, history, detail: { errorCode: 'TUNNEL_ENTRY', car: c.name, cell: k, entry: c.entry, expected: tm[k].facing } };
        const p = tm[k].pair;

        nx = p.x + DELTA[p.facing][0]; ny = p.y + DELTA[p.facing][1]; ne = OPPOSITE[p.facing];
      } else {
        const locked = tsLocks[c.name];
        const tr = locked && locked.k === k ? locked.track : effectiveTrackAt(k, tracks, tswitchMap, tsToggled, autoSwitchMap, autoToggled);
        usedTSLock = !!(locked && locked.k === k);
        usedAutoSwitch = !!autoSwitchMap[k] && !usedTSLock;
        /* No track or incompatible entry: always an error (zero cars need track too) */
        if (!tr || !exitPort(tr, c.entry)) {
          if (!tr) return { ok: false, reason: `${c.name} 无轨道 @(${c.x},${c.y})`, arrived, steps: t, history, detail: { errorCode: 'NO_TRACK', car: c.name, cell: k, x: c.x, y: c.y, isAutoSwitch: !!autoSwitchMap[k] } };
          return { ok: false, reason: `${c.name} 端口不匹配`, arrived, steps: t, history, detail: { errorCode: 'PORT_MISMATCH', car: c.name, cell: k, track: tr, entry: c.entry, x: c.x, y: c.y, isAutoSwitch: usedAutoSwitch, isLocked: usedTSLock } };
        }
        const ex = exitPort(tr, c.entry);
        nx = c.x + DELTA[ex][0]; ny = c.y + DELTA[ex][1]; ne = OPPOSITE[ex];
      }

      if (nx === puzzle.goal[0] && ny === puzzle.goal[1]) {
        /* A zero car can never enter the goal. */
        if (isZeroCar(c)) return { ok: false, reason: `${c.name} 进终点`, arrived, steps: t, history, detail: { errorCode: 'ZERO_AT_GOAL', car: c.name, from: k } };
        if (!isZeroCar(c)) {
          if (ne !== ge) return { ok: false, reason: `${c.name} 进站方向错`, arrived, steps: t, history, detail: { errorCode: 'WRONG_GOAL_DIR', car: c.name, actual: ne, expected: ge } };
          if (carNeedsPassengers(platformState, servedPlatforms, c.name)) return { ok: false, reason: `${c.name} 未完成接客`, arrived, steps: t, history, detail: { errorCode: 'UNSERVED_PLATFORM', car: c.name } };
          arrived.push(c.name); const pfx = order.slice(0, arrived.length);
          if (arrived.join(",") !== pfx.join(",")) return { ok: false, reason: "顺序错", arrived, steps: t, history, detail: { errorCode: 'WRONG_ORDER', car: c.name, arrived: [...arrived], expected: order } };
        }
        if (triggers[pk(nx, ny)]) triggeredColors.push(triggers[pk(nx, ny)]);
        if (tswTriggers[pk(nx, ny)]) tsTriggeredColors.push(tswTriggers[pk(nx, ny)]);
        if (usedTSLock) releaseTSLocks.add(c.name);
        if (usedAutoSwitch) autoUsedKeys.push(k);
        continue;
      }
      /* Zero car dead-end: exit leads OOB → park at current cell */
      if (nx < 0 || nx >= puzzle.width || ny < 0 || ny >= puzzle.height) {
        if (isZeroCar(c)) { moveRecs.push({ stay: true, c, keep: { ...c, parked: true } }); continue; }
        return { ok: false, reason: `${c.name} 出界`, arrived, steps: t, history, detail: { errorCode: 'OUT_OF_BOUNDS', car: c.name, from: k, target: pk(nx, ny) } };
      }

      const nk = pk(nx, ny);
      /* Zero car dead-end: next cell has no traversable track or tunnel → park at current cell */
      if (isZeroCar(c) && !tm[nk]) {
        const nkTrack = effectiveTrackAt(nk, tracks, tswitchMap, tsToggled, autoSwitchMap, autoToggled);
        if (!nkTrack || !exitPort(nkTrack, ne)) { moveRecs.push({ stay: true, c, keep: { ...c, parked: true } }); continue; }
      }

      let _barrierBlocked = false;
      if (barriers[nk]) {
        const b = barriers[nk];
        const isToggled = toggled[b.color] || false;
        const currentState = b.initialState === 'closed' ? (isToggled ? 'open' : 'closed') : (isToggled ? 'closed' : 'open');
        if (currentState === 'closed') {
          _barrierBlocked = true;
        }
      }
      if (_barrierBlocked) {
        moveRecs.push({ stay: true, c, keep: { name: c.name, role: c.role, x: c.x, y: c.y, entry: c.entry, wait: 0, _blocked: true } });
        continue;
      }

      moveRecs.push({ stay: false, c, nx, ny, ne, usedTSLock, usedAutoSwitch, fromKey: k });
    }

    for (const m of moveRecs) {
      if (m.stay) { nxt.push(m.keep); continue; }
      const { c, nx, ny, ne, usedTSLock, usedAutoSwitch, fromKey } = m;
      if (triggers[pk(nx, ny)]) triggeredColors.push(triggers[pk(nx, ny)]);
      if (tswTriggers[pk(nx, ny)]) tsTriggeredColors.push(tswTriggers[pk(nx, ny)]);
      if (usedTSLock) releaseTSLocks.add(c.name);
      if (usedAutoSwitch) autoUsedKeys.push(fromKey);
      let wait = 0;
      if (!isZeroCar(c)) {
        const pickup = platformPickupForCar(platformState, servedPlatforms, c.name, pk(nx, ny));
        if (!pickup.ok) return { ok: false, reason: `${c.name} 接客需求不匹配`, arrived, steps: t, history, detail: { errorCode: 'PLATFORM_MISMATCH', car: c.name, cell: pk(nx, ny) } };
        wait = pickup.wait;
      }
      nxt.push({ name: c.name, role: c.role, x: nx, y: ny, entry: ne, wait });
    }
    const world = { tracks, tm, barriers, tswitchMap, autoSwitchMap, toggled, tsToggled, autoToggled, tsLocks };
    const collision = detectCarCollision(nxt, world) || detectSwapCollision(cars, nxt);
    if (collision) return { ok: false, ...collision, arrived, steps: t, history };
    cars = nxt; history.push(cars.map(c => ({ ...c })));
    applyWorldTransitions(cars, { triggeredColors, tsTriggeredColors, autoUsedKeys, releaseTSLocks }, world);
    if (arrived.join(",") === order.join(",") && !cars.some(c => !isZeroCar(c))) {
      if (!allPlatformsServed(platformState, servedPlatforms)) return { ok: false, reason: "乘客未接完", arrived, steps: t, history, detail: { errorCode: 'UNSERVED_PLATFORMS' } };
      const zeroSafety = zeroSafetyLookahead(puzzle, cars, { tracks, tm, triggers, barriers, tswTriggers, tswitchMap, autoSwitchMap, toggled, tsToggled, autoToggled, tsLocks });
      if (!zeroSafety.ok) return { ok: false, reason: `零号车不安全：${zeroSafety.reason}`, arrived, steps: t, history, detail: { errorCode: 'ZERO_UNSAFE', zeroDetail: zeroSafety.detail || zeroSafety.reason } };
      return { ok: true, reason: "通关", arrived, steps: t, history };
    }
  }
  return { ok: false, reason: "超时", arrived, steps: ms, history, detail: { errorCode: 'TIMEOUT', maxSteps: ms } };
}

/**
 * Format a simulate() error result into a human-readable diagnostic string.
 * Usage: console.log(formatSimError(simulate(pz, placed)));
 * @param {Object} result - The result object from simulate()
 * @returns {string} Formatted error string for debugging
 */
function formatSimError(result) {
  if (result.ok) return `✅ PASS step=${result.steps} arrived=[${result.arrived}]`;
  const d = result.detail || {};
  const parts = [`❌ ${result.reason}`, `step=${result.steps}`];
  if (d.errorCode) parts.push(`code=${d.errorCode}`);
  if (d.car) parts.push(`car=${d.car}`);
  if (d.cell) parts.push(`cell=(${d.cell})`);
  if (d.track) parts.push(`track=${d.track}`);
  if (d.entry) parts.push(`entry=${d.entry}`);
  if (d.expected) parts.push(`expected=${d.expected}`);
  if (d.actual) parts.push(`actual=${d.actual}`);
  if (d.cars) parts.push(`involved=[${d.cars.join(',')}]`);
  if (d.cells) parts.push(`cells=[${d.cells.join(' | ')}]`);
  if (d.leader) parts.push(`leader=${d.leader} follower=${d.follower}`);
  if (d.direction) parts.push(`dir=${d.direction}`);
  if (d.from) parts.push(`from=(${d.from})`);
  if (d.target) parts.push(`to=(${d.target})`);
  if (d.isAutoSwitch) parts.push('(auto-switch)');
  if (d.isLocked) parts.push('(ts-locked)');
  if (result.arrived?.length) parts.push(`arrived=[${result.arrived}]`);
  if (result.history?.length > 0) {
    const last = result.history[result.history.length - 1];
    parts.push(`positions: ${last.map(c => `${c.name}@(${c.x},${c.y})${c.entry}`).join(' ')}`);
  }
  return parts.join(' | ');
}


function forwardReachable(pz) {
  const bs = new Set(pz.blanks.map(b => pk(b[0], b[1]))), gx = pz.goal[0], gy = pz.goal[1], r = {},
    tm = buildTunnelMap(pz.tunnels), tswitchMap = buildTSwitchMap(pz.tswitches),
    autoSwitchMap = buildAutoSwitchMap(pz.autoSwitches || pz.auto_switches);
  for (const car of pz.cars) {
    const q = [[car.x, car.y, car.entry]], v = new Set();
    while (q.length) {
      const [x, y, en] = q.shift(), sk = `${x},${y},${en}`; if (v.has(sk)) continue; v.add(sk);
      const k = pk(x, y); if (!r[k]) r[k] = new Set(); r[k].add(en);
      if (tm[k]) {
        if (en !== tm[k].facing) continue;
        const p = tm[k].pair;
        const nx = p.x + DELTA[p.facing][0], ny = p.y + DELTA[p.facing][1], ne = OPPOSITE[p.facing];
        if (nx === gx && ny === gy) continue;
        if (nx < 0 || nx >= pz.width || ny < 0 || ny >= pz.height) continue;
        const nk = pk(nx, ny); if (!pz.fixed[nk] && !bs.has(nk) && !tm[nk] && !tswitchMap[nk] && !autoSwitchMap[nk]) continue;
        q.push([nx, ny, ne]);
        continue;
      }
      const sw = tswitchMap[k];
      const au = autoSwitchMap[k];
      const tl = sw ? tswitchTrackVariants(sw) : (au ? tswitchTrackVariants(au) : (pz.fixed[k] ? [pz.fixed[k]] : (bs.has(k) ? TRACKS_BY_ENTRY[en] : [])));
      for (const tr of tl) {
        const ex = exitPort(tr, en); if (!ex) continue;
        const nx = x + DELTA[ex][0], ny = y + DELTA[ex][1], ne = OPPOSITE[ex];
        if (nx === gx && ny === gy) continue;
        if (nx < 0 || nx >= pz.width || ny < 0 || ny >= pz.height) continue;
        const nk = pk(nx, ny); if (!pz.fixed[nk] && !bs.has(nk) && !tm[nk] && !tswitchMap[nk] && !autoSwitchMap[nk]) continue;
        q.push([nx, ny, ne]);
      }
    }
  }
  return r;
}

function backwardReachable(pz) {
  const bs = new Set(pz.blanks.map(b => pk(b[0], b[1]))), gx = pz.goal[0], gy = pz.goal[1],
    ge = pz.goalEntry ?? pz.goal_entry, etg = OPPOSITE[ge], r = {},
    tm = buildTunnelMap(pz.tunnels), tswitchMap = buildTSwitchMap(pz.tswitches),
    autoSwitchMap = buildAutoSwitchMap(pz.autoSwitches || pz.auto_switches),
    q = [[gx - DELTA[etg][0], gy - DELTA[etg][1], etg]], v = new Set();
  for (const tk in tm) {
    const ti = tm[tk], p = ti.pair;
    const ex2 = p.facing, nx2 = p.x + DELTA[ex2][0], ny2 = p.y + DELTA[ex2][1];
    if (nx2 === gx && ny2 === gy && OPPOSITE[ex2] === ge) {
      const [tx, ty] = tk.split(",").map(Number);
      q.push([tx + DELTA[ti.facing][0], ty + DELTA[ti.facing][1], OPPOSITE[ti.facing]]);
    }
  }
  while (q.length) {
    const [x, y, re] = q.shift();
    if (x < 0 || x >= pz.width || y < 0 || y >= pz.height) continue;
    const k = pk(x, y); if (!pz.fixed[k] && !bs.has(k) && !tm[k] && !tswitchMap[k] && !autoSwitchMap[k]) continue;
    const sk = `${x},${y},${re}`; if (v.has(sk)) continue; v.add(sk);
    if (!r[k]) r[k] = new Set(); r[k].add(re);

    if (tm[k]) {
      const p = tm[k].pair;
      const px = p.x + DELTA[p.facing][0], py = p.y + DELTA[p.facing][1], pe = OPPOSITE[p.facing];
      q.push([px, py, pe]);
      continue;
    }

    const ef = new Set();
    if (tswitchMap[k]) {
      for (const tr of tswitchTrackVariants(tswitchMap[k])) for (const d of ALL_DIRS) if (exitPort(tr, d) === re) ef.add(d);
    }
    else if (autoSwitchMap[k]) {
      for (const tr of tswitchTrackVariants(autoSwitchMap[k])) for (const d of ALL_DIRS) if (exitPort(tr, d) === re) ef.add(d);
    }
    else if (pz.fixed[k]) { for (const d of ALL_DIRS) if (exitPort(pz.fixed[k], d) === re) ef.add(d); }
    else { for (const { entry } of TRACKS_BY_EXIT[re]) ef.add(entry); }
    for (const en of ef) {
      const px = x + DELTA[en][0], py = y + DELTA[en][1], pe = OPPOSITE[en];
      q.push([px, py, pe]);
    }
  }
  return r;
}

function filterBlanks(pz) {
  const fwd = forwardReachable(pz), bwd = backwardReachable(pz), useful = [], meta = {};
  const hasZero = pz.cars.some(isZeroCar);
  for (const b of pz.blanks) {
    const k = pk(b[0], b[1]), fd = fwd[k], bd = bwd[k];
    if (!fd || (!bd && !hasZero)) continue; const vt = new Set();
    for (const en of fd) for (const tr of TRACKS_BY_ENTRY[en]) { const ex = exitPort(tr, en); if (ex && (!bd || bd.has(ex) || hasZero)) vt.add(tr); }
    const vb = new Set();
    for (const en of fd) for (const tr of BASIC_TRACKS) { const ex = exitPort(tr, en); if (ex && (!bd || bd.has(ex) || hasZero)) vb.add(tr); }
    if (vt.size) { useful.push(b); meta[k] = { fwd: [...fd], bwd: bd ? [...bd] : [], validTracks: [...vt], basicTracks: [...vb] }; }
  }
  return { useful, meta, fwd, bwd, pruned: pz.blanks.length - useful.length };
}

/* ═══════════════════════════════════════════════
 * Puzzle feature detection — used by solver to decide CSP eligibility
 * ═══════════════════════════════════════════════ */
function puzzleHasDynamicState(puzzle) {
  const hasAutoSwitch = !!(
    (puzzle.autoSwitches && puzzle.autoSwitches.length) ||
    (puzzle.auto_switches && puzzle.auto_switches.length)
  );
  const hasTSwitch = !!(puzzle.tswitches && puzzle.tswitches.length);
  const hasTSwTriggers = !!((puzzle.tsw_triggers || puzzle.tswTriggers || []).length);
  const hasBarrierTriggers = !!(
    (puzzle.barriers && puzzle.barriers.length) &&
    (puzzle.triggers && puzzle.triggers.length)
  );
  const hasZero = puzzle.cars.some(isZeroCar);
  const hasPlatforms = !!(puzzle.platforms && puzzle.platforms.length);
  const hasGlobalTriggers = hasTSwTriggers || hasBarrierTriggers;
  return {
    hasAutoSwitch,
    hasTSwitch,
    hasTSwTriggers,
    hasBarrierTriggers,
    hasGlobalTriggers,
    hasZero,
    hasPlatforms,
    isDynamic: hasAutoSwitch || hasTSwTriggers || hasBarrierTriggers,
    cspUnsafe: hasGlobalTriggers,
  };
}

export {
  TRACKS, T_META, T_SWITCH_PAIRS, OPPOSITE, DELTA, ALL_DIRS, BASIC_TRACKS, T_TRACKS, TRACK_NAMES, pk, exitPort,
  TRACKS_BY_ENTRY, BASIC_BY_ENTRY, TRACKS_BY_EXIT, TUNNEL_COLORS, BARRIER_COLORS, buildTunnelMap,
  buildTSwitchMap, buildAutoSwitchMap, effectiveTSwitchTrack, effectiveAutoSwitchTrack, effectiveTrackAt, tswitchTrackVariants,
  isCellBarrierBlocked,
  occupiedBarrierColors,
  buildPlatformState, platformPickupForCar, carNeedsPassengers, allPlatformsServed,
  isZeroCar, requiredOrder, zeroSafetySteps, zeroSafetyLookahead,
  detectSwapCollision,
  simulate, formatSimError, forwardReachable, backwardReachable, filterBlanks,
  blockedCellsForCar, carWaypoints, minRemainingDist,
  puzzleHasDynamicState,
};
