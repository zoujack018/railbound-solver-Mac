import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parsePuzzleDocument, parsePuzzleJSON } from "../puzzle-io.js";
import { inferPuzzleCategory, isPuzzleManifestFileName, listPuzzleLibrary, readPuzzleFiles } from "../puzzle-library.js";

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${message}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${message}`);
  }
}

function findJSONFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...findJSONFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith(".json") && !isPuzzleManifestFileName(entry.name)) files.push(fullPath);
  }
  return files.sort((a, b) => a.localeCompare(b, "zh-CN"));
}

const testDirectory = fileURLToPath(new URL("./", import.meta.url));
const projectDirectory = path.dirname(testDirectory);
const fixturePaths = findJSONFiles(testDirectory);
const fixtureFiles = fixturePaths.map(filePath => ({
  name: path.basename(filePath),
  webkitRelativePath: path.relative(projectDirectory, filePath),
  lastModified: 1,
  size: fs.statSync(filePath).size,
  async text() { return fs.readFileSync(filePath, "utf8"); },
}));

console.log("\n[Format 1] Current puzzle corpus recognition");
const documents = fixturePaths.map(filePath => parsePuzzleDocument(fs.readFileSync(filePath, "utf8")));
/* 计数从目录推导，避免硬编码总数随语料增长而腐烂：
   scratch_* 是带 puzzle/expected 包装的夹具文档，其余是正式 Puzzle。 */
const expectedFixtureCount = fixturePaths.filter(filePath => path.basename(filePath).startsWith("scratch_")).length;
assert(fixtureFiles.length >= 15 && expectedFixtureCount >= 3, `Corpus discovered recursively (${fixtureFiles.length} files, ${expectedFixtureCount} scratch fixtures)`);
assert(documents.every(document => document.puzzle), "Every current case is a strictly loadable puzzle");
assert(documents.filter(document => document.isFixture).length === expectedFixtureCount, "All scratch_* cases retain their fixture envelopes");
assert(documents.filter(document => !document.isFixture).length === fixtureFiles.length - expectedFixtureCount, "All non-scratch cases remain portable Puzzle documents");

const oneDimensionalFixture = JSON.stringify({
  id: "one_dimensional_autoswitch",
  name: "One-dimensional auto-switch fixture",
  expected: { hasSolution: true },
  puzzle: {
    width: 3,
    height: 1,
    fixed: { "0,0": "-", "1,0": "-" },
    blanks: [],
    cars: [{ name: "1", x: 0, y: 0, entry: "W" }],
    goal: [2, 0],
    goal_entry: "W",
    order: ["1"],
    autoSwitches: [{ x: 1, y: 0, track: "T_ES_W" }],
  },
});
const oneDimensionalPuzzle = parsePuzzleJSON(oneDimensionalFixture);
assert(oneDimensionalPuzzle.width === 3 && oneDimensionalPuzzle.height === 1, "One-dimensional fixture boards are accepted");
assert(oneDimensionalPuzzle.fixed["1,0"] === "-" && oneDimensionalPuzzle.autoSwitches.length === 1, "Redundant fixed underlay beneath an auto-switch is loadable");

console.log("\n[Format 2] Folder import classification and metadata");
const importedEntries = await readPuzzleFiles(fixtureFiles);
assert(importedEntries.length === fixtureFiles.length, "Folder import returns one card per JSON file");
assert(importedEntries.every(entry => entry.category === "test"), "English and Chinese test paths use the test library tab");
assert(importedEntries.every(entry => !entry.error && entry.puzzle), "Current cases are not mislabeled as malformed or preview-only");
assert(importedEntries.some(entry => entry.name === "8x8 Extreme Benchmark Puzzle"), "Fixture display names come from envelope metadata");
assert(importedEntries.filter(entry => entry.fixture).length === expectedFixtureCount, "Fixture markers survive folder import");
assert(inferPuzzleCategory("project/test/demo.json") === "test", "test/ is recognized as a test category path");
assert(inferPuzzleCategory("project/测试/demo.json") === "test", "测试/ is recognized as a test category path");

console.log("\n[Format 3] Root-level directory scanning");
const subdirectories = new Map();
function emptyDirectory(name) {
  return { kind: "directory", name, async *values() {} };
}
const rootFile = fixtureFiles.find(file => file.name === "scratch_solve_7x7.json") || fixtureFiles[0];
const rootFileHandle = { kind: "file", name: rootFile.name, async getFile() { return rootFile; } };
const root = {
  name: "test",
  async queryPermission() { return "granted"; },
  async requestPermission() { return "granted"; },
  async getDirectoryHandle(name, { create } = {}) {
    if (!subdirectories.has(name) && !create) throw Object.assign(new Error("missing"), { name: "NotFoundError" });
    if (!subdirectories.has(name)) subdirectories.set(name, emptyDirectory(name));
    return subdirectories.get(name);
  },
  async *values() { yield rootFileHandle; yield* subdirectories.values(); },
};
const rootEntries = await listPuzzleLibrary(root);
assert(rootEntries.length === 1, "A JSON file directly inside the selected library root is scanned");
assert(rootEntries[0].puzzle && rootEntries[0].category === "test", "Root-level test puzzle is loadable from the test tab");

console.log(`\n═══════════ Format adapter: ${passed} passed, ${failed} failed ═══════════\n`);
process.exit(failed ? 1 : 0);
