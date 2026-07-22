import { TRACKS, T_SWITCH_PAIRS, DELTA } from "./railbound-rules.js";

export const PUZZLE_FORMAT_VERSION = 1;
export const MAX_GRID_SIZE = 64;

const DIRECTIONS = new Set(["N", "E", "S", "W"]);
const OLD_T_MAP = {
  T_NS_E: "T_NE_S",
  T_NS_W: "T_WN_S",
  T_NW_E: "T_WN_E",
  T_NW_S: "T_SW_N",
  T_EW_N: "T_NE_W",
  T_EW_S: "T_ES_W",
};

export class PuzzleValidationError extends Error {
  constructor(path, message) {
    super(`${path}: ${message}`);
    this.name = "PuzzleValidationError";
    this.path = path;
  }
}

function fail(path, message) {
  throw new PuzzleValidationError(path, message);
}

function asRecord(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "必须是对象");
  return value;
}

function asArray(value, path, fallback = []) {
  if (value == null) return fallback;
  if (!Array.isArray(value)) fail(path, "必须是数组");
  return value;
}

function asInteger(value, path, min, max, fallback) {
  const resolved = value == null ? fallback : value;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    fail(path, `必须是 ${min}–${max} 的整数`);
  }
  return resolved;
}

function asString(value, path, fallback) {
  const resolved = value == null ? fallback : value;
  if (typeof resolved !== "string" || !resolved.trim()) fail(path, "必须是非空字符串");
  return resolved.trim();
}

function asName(value, path) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return asString(value, path);
}

function asDirection(value, path, fallback) {
  const resolved = value == null ? fallback : value;
  if (!DIRECTIONS.has(resolved)) fail(path, "必须是 N、E、S、W 之一");
  return resolved;
}

function normalizeTrack(value, path, fallback) {
  const raw = value == null ? fallback : value;
  const normalized = OLD_T_MAP[raw] || raw;
  if (!TRACKS[normalized]) fail(path, `未知轨道 ${String(raw)}`);
  return normalized;
}

function normalizeTSwitchTrack(value, path, fallback = "T_NE_S") {
  const track = normalizeTrack(value, path, fallback);
  if (!T_SWITCH_PAIRS[track]) fail(path, "必须是可切换的 T 轨");
  return track;
}

function coordinate(x, y, path, width, height) {
  if (!Number.isInteger(x) || !Number.isInteger(y)) fail(path, "坐标必须是整数");
  if (x < 0 || x >= width || y < 0 || y >= height) fail(path, `坐标 (${x},${y}) 越界`);
  return { x, y, key: `${x},${y}` };
}

function coordinatePair(value, path, width, height) {
  if (!Array.isArray(value) || value.length !== 2) fail(path, "必须是 [x, y]");
  return coordinate(value[0], value[1], path, width, height);
}

function coordinateObject(value, path, width, height) {
  const item = asRecord(value, path);
  return { item, ...coordinate(item.x, item.y, path, width, height) };
}

function parseFixed(source, width, height) {
  const fixedSource = source.fixed == null ? {} : asRecord(source.fixed, "$.fixed");
  const fixed = {};
  for (const [key, value] of Object.entries(fixedSource)) {
    const match = /^(-?\d+),(-?\d+)$/.exec(key);
    if (!match) fail(`$.fixed.${key}`, "key 必须是 x,y 坐标");
    const cell = coordinate(Number(match[1]), Number(match[2]), `$.fixed.${key}`, width, height);
    fixed[cell.key] = normalizeTrack(value, `$.fixed.${key}`);
  }
  return fixed;
}

function normalizeColoredCells(value, path, width, height) {
  const output = [];
  const seen = new Map();
  for (const [index, raw] of asArray(value, path).entries()) {
    const itemPath = `${path}[${index}]`;
    const { item, x, y, key } = coordinateObject(raw, itemPath, width, height);
    const color = asString(item.color, `${itemPath}.color`);
    if (seen.has(key)) {
      if (seen.get(key) !== color) fail(itemPath, `坐标 ${key} 使用了冲突颜色`);
      continue;
    }
    seen.set(key, color);
    output.push({ x, y, color });
  }
  return output;
}

function isZeroCar(car) {
  return car.role === "zero" || String(car.name) === "0";
}

export function normalizePuzzle(input) {
  const source = asRecord(input, "$"), rawVersion = source.formatVersion ?? source.format_version ?? 0;
  if (!Number.isInteger(rawVersion) || rawVersion < 0) fail("$.formatVersion", "必须是非负整数");
  if (rawVersion > PUZZLE_FORMAT_VERSION) {
    fail("$.formatVersion", `当前仅支持至版本 ${PUZZLE_FORMAT_VERSION}`);
  }

  const width = asInteger(source.width, "$.width", 1, MAX_GRID_SIZE);
  const height = asInteger(source.height, "$.height", 1, MAX_GRID_SIZE);
  const fixed = parseFixed(source, width, height);

  const blanks = [];
  const blankKeys = new Set();
  for (const [index, raw] of asArray(source.blanks, "$.blanks").entries()) {
    const cell = coordinatePair(raw, `$.blanks[${index}]`, width, height);
    if (blankKeys.has(cell.key)) fail(`$.blanks[${index}]`, `重复坐标 ${cell.key}`);
    blankKeys.add(cell.key);
    blanks.push([cell.x, cell.y]);
  }

  const cars = [];
  const carNames = new Set();
  for (const [index, raw] of asArray(source.cars, "$.cars").entries()) {
    const itemPath = `$.cars[${index}]`;
    const { item, x, y, key } = coordinateObject(raw, itemPath, width, height);
    const name = asName(item.name, `${itemPath}.name`);
    if (carNames.has(name)) fail(`${itemPath}.name`, `重复车号 ${name}`);
    carNames.add(name);
    const entry = asDirection(item.entry, `${itemPath}.entry`);
    const car = { name, x, y, entry };
    if (item.role === "zero" || name === "0") car.role = "zero";
    if (!isZeroCar(car) && !/^[1-9]\d*$/.test(name)) fail(`${itemPath}.name`, "普通火车车号必须是正整数");
    cars.push(car);
    if (!fixed[key]) fixed[key] = entry === "N" || entry === "S" ? "|" : "-";
  }
  if (!cars.length) fail("$.cars", "至少需要一辆火车");
  const normalCars = cars.filter(car => !isZeroCar(car));
  if (!normalCars.length) fail("$.cars", "至少需要一辆普通火车");

  const goalCell = coordinatePair(source.goal, "$.goal", width, height);
  const goal = [goalCell.x, goalCell.y];
  const goalEntry = asDirection(source.goalEntry ?? source.goal_entry, "$.goalEntry", "W");

  const normalNames = normalCars.map(car => car.name);
  const rawOrder = source.order == null ? normalNames : asArray(source.order, "$.order");
  const order = rawOrder.map((name, index) => asName(name, `$.order[${index}]`));
  const orderSet = new Set(order);
  if (orderSet.size !== order.length) fail("$.order", "不能包含重复车号");
  if (order.length !== normalNames.length || normalNames.some(name => !orderSet.has(name))) {
    fail("$.order", "必须且只能包含全部普通火车");
  }

  const maxSteps = asInteger(source.maxSteps ?? source.max_steps, "$.maxSteps", 1, 100000, 50);
  const zeroSafetySteps = asInteger(source.zeroSafetySteps ?? source.zero_safety_steps, "$.zeroSafetySteps", 0, 1000, 3);

  const tunnels = [];
  const tunnelColors = new Set();
  for (const [index, raw] of asArray(source.tunnels, "$.tunnels").entries()) {
    const itemPath = `$.tunnels[${index}]`, item = asRecord(raw, itemPath);
    const color = asString(item.color, `${itemPath}.color`);
    if (tunnelColors.has(color)) fail(`${itemPath}.color`, `重复隧道颜色 ${color}`);
    tunnelColors.add(color);
    const rawCells = asArray(item.cells, `${itemPath}.cells`);
    if (rawCells.length !== 2) fail(`${itemPath}.cells`, "隧道必须恰好有两个端点");
    const cells = rawCells.map((cellRaw, cellIndex) => {
      const cellPath = `${itemPath}.cells[${cellIndex}]`;
      const { item: cell, x, y } = coordinateObject(cellRaw, cellPath, width, height);
      return { x, y, facing: asDirection(cell.facing, `${cellPath}.facing`) };
    });
    tunnels.push({ color, cells });
  }

  const triggers = normalizeColoredCells(source.triggers, "$.triggers", width, height);
  const tswTriggers = normalizeColoredCells(source.tsw_triggers ?? source.tswTriggers, "$.tswTriggers", width, height);
  const barriers = [];
  for (const [index, raw] of asArray(source.barriers, "$.barriers").entries()) {
    const itemPath = `$.barriers[${index}]`;
    const { item, x, y } = coordinateObject(raw, itemPath, width, height);
    const initialState = item.initialState ?? item.initial_state ?? "closed";
    if (initialState !== "closed" && initialState !== "open") fail(`${itemPath}.initialState`, "必须是 closed 或 open");
    barriers.push({ x, y, color: asString(item.color, `${itemPath}.color`), initialState });
  }

  const tswitches = [];
  for (const [index, raw] of asArray(source.tswitches, "$.tswitches").entries()) {
    const itemPath = `$.tswitches[${index}]`;
    const { item, x, y } = coordinateObject(raw, itemPath, width, height);
    tswitches.push({ x, y, color: asString(item.color, `${itemPath}.color`), track: normalizeTSwitchTrack(item.track, `${itemPath}.track`) });
  }

  const autoSwitches = [];
  for (const [index, raw] of asArray(source.autoSwitches ?? source.auto_switches, "$.autoSwitches").entries()) {
    const itemPath = `$.autoSwitches[${index}]`;
    const { item, x, y } = coordinateObject(raw, itemPath, width, height);
    autoSwitches.push({ x, y, track: normalizeTSwitchTrack(item.track, `${itemPath}.track`) });
  }

  const platforms = [];
  for (const [index, raw] of asArray(source.platforms, "$.platforms").entries()) {
    const itemPath = `$.platforms[${index}]`;
    const { item, x, y } = coordinateObject(raw, itemPath, width, height);
    const car = asName(item.car ?? item.carName ?? item.name ?? item.demand, `${itemPath}.car`);
    if (!normalNames.includes(car)) fail(`${itemPath}.car`, `未知普通火车 ${car}`);
    platforms.push({ x, y, dir: asDirection(item.dir ?? item.facing ?? item.direction, `${itemPath}.dir`, "E"), car });
  }

  const occupied = new Map();
  function claim(key, kind, path) {
    const previous = occupied.get(key);
    if (previous) fail(path, `坐标 ${key} 与 ${previous} 冲突`);
    occupied.set(key, kind);
  }
  for (const [index, cell] of blanks.entries()) claim(`${cell[0]},${cell[1]}`, "可铺设格", `$.blanks[${index}]`);
  for (const [index, car] of cars.entries()) claim(`${car.x},${car.y}`, "火车", `$.cars[${index}]`);
  claim(goalCell.key, "终点", "$.goal");
  for (const [index, tunnel] of tunnels.entries()) for (const [cellIndex, cell] of tunnel.cells.entries()) claim(`${cell.x},${cell.y}`, "隧道", `$.tunnels[${index}].cells[${cellIndex}]`);
  for (const [index, platform] of platforms.entries()) claim(`${platform.x},${platform.y}`, "站台", `$.platforms[${index}]`);

  const triggerCells = new Map();
  for (const [kind, items, path] of [["触发器", triggers, "$.triggers"], ["变轨触发器", tswTriggers, "$.tswTriggers"]]) {
    for (const [index, item] of items.entries()) {
      const key = `${item.x},${item.y}`, previous = triggerCells.get(key);
      if (previous && previous.color !== item.color) fail(`${path}[${index}]`, `坐标 ${key} 的触发器颜色冲突`);
      if (!previous) triggerCells.set(key, { color: item.color, kind, path: `${path}[${index}]` });
    }
  }
  for (const [key, trigger] of triggerCells) claim(key, trigger.kind, trigger.path);
  for (const [index, barrier] of barriers.entries()) claim(`${barrier.x},${barrier.y}`, "关卡", `$.barriers[${index}]`);
  for (const [index, sw] of tswitches.entries()) claim(`${sw.x},${sw.y}`, "变轨 T", `$.tswitches[${index}]`);
  for (const [index, sw] of autoSwitches.entries()) claim(`${sw.x},${sw.y}`, "自变 T", `$.autoSwitches[${index}]`);

  const fixedOverlayKinds = new Set(["火车", "触发器", "变轨触发器", "关卡", "变轨 T", "自变 T"]);
  for (const key of Object.keys(fixed)) {
    const occupant = occupied.get(key);
    if (occupant && !fixedOverlayKinds.has(occupant)) fail(`$.fixed.${key}`, `不能与${occupant}重叠`);
  }
  for (const key of triggerCells.keys()) if (!fixed[key]) fixed[key] = "|";
  for (const barrier of barriers) {
    const key = `${barrier.x},${barrier.y}`;
    if (!fixed[key]) fixed[key] = "|";
  }

  const roadKeys = new Set(Object.keys(fixed));
  for (const sw of [...tswitches, ...autoSwitches]) roadKeys.add(`${sw.x},${sw.y}`);
  for (const [index, platform] of platforms.entries()) {
    const delta = DELTA[platform.dir];
    const targetX = platform.x + delta[0], targetY = platform.y + delta[1];
    if (targetX < 0 || targetX >= width || targetY < 0 || targetY >= height || !roadKeys.has(`${targetX},${targetY}`)) {
      fail(`$.platforms[${index}]`, "必须指向相邻的固定道路或变轨 T");
    }
  }

  return {
    formatVersion: PUZZLE_FORMAT_VERSION,
    width,
    height,
    fixed,
    blanks,
    cars,
    goal,
    goalEntry,
    order,
    maxSteps,
    zeroSafetySteps,
    tunnels,
    triggers,
    barriers,
    tswTriggers,
    tswitches,
    autoSwitches,
    platforms,
  };
}

function parseJSONValue(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new PuzzleValidationError("$", `JSON 解析失败：${error.message}`);
  }
  return parsed;
}

function isTestFixtureDocument(value) {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && !!value.puzzle && typeof value.puzzle === "object" && !Array.isArray(value.puzzle)
    && ["id", "name", "category", "description", "expected", "placed"].some(key => key in value);
}

function previewCoordinate(value, width, height) {
  return Number.isInteger(value?.x) && Number.isInteger(value?.y)
    && value.x >= 0 && value.x < width && value.y >= 0 && value.y < height;
}

function buildFixturePreview(source) {
  if (!Number.isInteger(source?.width) || !Number.isInteger(source?.height)
    || source.width < 1 || source.width > MAX_GRID_SIZE || source.height < 1 || source.height > MAX_GRID_SIZE) return null;
  const width = source.width, height = source.height;
  const fixed = {};
  if (source.fixed && typeof source.fixed === "object" && !Array.isArray(source.fixed)) {
    for (const [key, track] of Object.entries(source.fixed)) {
      const match = /^(\d+),(\d+)$/.exec(key);
      if (match && Number(match[1]) < width && Number(match[2]) < height && TRACKS[OLD_T_MAP[track] || track]) fixed[key] = OLD_T_MAP[track] || track;
    }
  }
  const blanks = Array.isArray(source.blanks) ? source.blanks.filter(cell => Array.isArray(cell) && cell.length === 2
    && Number.isInteger(cell[0]) && Number.isInteger(cell[1]) && cell[0] >= 0 && cell[0] < width && cell[1] >= 0 && cell[1] < height) : [];
  const cars = Array.isArray(source.cars) ? source.cars.filter(car => previewCoordinate(car, width, height)).map(car => ({ ...car, name: String(car.name ?? "?") })) : [];
  const rawGoal = source.goal;
  const goal = Array.isArray(rawGoal) && rawGoal.length === 2 && Number.isInteger(rawGoal[0]) && Number.isInteger(rawGoal[1])
    && rawGoal[0] >= 0 && rawGoal[0] < width && rawGoal[1] >= 0 && rawGoal[1] < height ? rawGoal : null;
  const tunnels = Array.isArray(source.tunnels) ? source.tunnels.map(tunnel => ({
    color: typeof tunnel?.color === "string" ? tunnel.color : "#9b59b6",
    cells: Array.isArray(tunnel?.cells) ? tunnel.cells.filter(cell => previewCoordinate(cell, width, height)) : [],
  })).filter(tunnel => tunnel.cells.length) : [];
  return { width, height, fixed, blanks, cars, goal, tunnels };
}

/**
 * Parse either a portable Puzzle JSON file or a test-fixture document whose
 * actual puzzle lives under `puzzle`. Test-only helper fixtures may be
 * previewable without being loadable in the editor.
 */
export function parsePuzzleDocument(raw) {
  const parsed = parseJSONValue(raw);
  const isFixture = isTestFixtureDocument(parsed);
  const source = isFixture ? parsed.puzzle : parsed;
  const metadata = isFixture ? {
    id: typeof parsed.id === "string" ? parsed.id : "",
    name: typeof parsed.name === "string" ? parsed.name : "",
    category: typeof parsed.category === "string" ? parsed.category : "",
    description: typeof parsed.description === "string" ? parsed.description : "",
    expected: parsed.expected,
    placed: parsed.placed,
  } : null;
  try {
    const puzzle = normalizePuzzle(source);
    return { puzzle, preview: puzzle, metadata, isFixture, issue: null };
  } catch (error) {
    if (!isFixture) throw error;
    return { puzzle: null, preview: buildFixturePreview(source), metadata, isFixture: true, issue: error.message };
  }
}

export function parsePuzzleJSON(raw) {
  const document = parsePuzzleDocument(raw);
  if (document.puzzle) return document.puzzle;
  throw new PuzzleValidationError("$.puzzle", document.issue || "测试夹具不是完整可载入关卡");
}

export function toPortablePuzzle(puzzle) {
  return {
    formatVersion: PUZZLE_FORMAT_VERSION,
    width: puzzle.width,
    height: puzzle.height,
    fixed: puzzle.fixed,
    blanks: puzzle.blanks,
    cars: puzzle.cars,
    goal: puzzle.goal,
    goal_entry: puzzle.goalEntry ?? puzzle.goal_entry,
    order: puzzle.order,
    max_steps: puzzle.maxSteps ?? puzzle.max_steps,
    zero_safety_steps: puzzle.zeroSafetySteps ?? puzzle.zero_safety_steps,
    tunnels: puzzle.tunnels || [],
    triggers: puzzle.triggers || [],
    barriers: puzzle.barriers || [],
    tsw_triggers: puzzle.tsw_triggers || puzzle.tswTriggers || [],
    tswitches: puzzle.tswitches || [],
    autoSwitches: puzzle.autoSwitches || puzzle.auto_switches || [],
    platforms: puzzle.platforms || [],
  };
}
