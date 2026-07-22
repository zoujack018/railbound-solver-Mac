import { parsePuzzleDocument, toPortablePuzzle } from "./puzzle-io.js";

export const PUZZLE_LIBRARY_FOLDERS = {
  normal: "普通",
  test: "测试",
};

/* test/puzzle-cases.json 是逐题回归的测试契约清单，不是关卡文件；
   所有目录扫描都应跳过它，避免显示成"JSON 无效"卡片。 */
export const PUZZLE_TEST_MANIFEST = "puzzle-cases.json";

export function isPuzzleManifestFileName(name) {
  return String(name).toLowerCase() === PUZZLE_TEST_MANIFEST;
}

const DB_NAME = "railbound-local-library";
const STORE_NAME = "handles";
const ROOT_HANDLE_KEY = "puzzle-root";

export function supportsDirectoryLibrary() {
  return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
}

export function sanitizePuzzleFileName(value) {
  const safe = String(value ?? "")
    .trim()
    .replace(/\.json$/i, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 80);
  return safe || "未命名关卡";
}

export function defaultPuzzleName(puzzle) {
  const now = new Date();
  const stamp = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("");
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()].map(value => String(value).padStart(2, "0")).join("");
  return `关卡-${puzzle.width}x${puzzle.height}-${stamp}-${time}`;
}

export function inferPuzzleCategory(path = "") {
  const segments = String(path).split(/[\\/]/).map(segment => segment.toLowerCase());
  return segments.some(segment => segment === PUZZLE_LIBRARY_FOLDERS.test || segment === "test" || segment === "tests") ? "test" : "normal";
}

function openHandleDatabase() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) return resolve(null);
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function useHandleStore(mode, action) {
  const db = await openHandleDatabase();
  if (!db) return null;
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      const request = action(tx.objectStore(STORE_NAME));
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function rememberLibraryRoot(handle) {
  await useHandleStore("readwrite", store => store.put(handle, ROOT_HANDLE_KEY));
  return handle;
}

export async function getRememberedLibraryRoot() {
  try {
    return await useHandleStore("readonly", store => store.get(ROOT_HANDLE_KEY));
  } catch {
    return null;
  }
}

export async function selectLibraryRoot() {
  if (!supportsDirectoryLibrary()) throw new Error("当前浏览器不支持直接读写本地文件夹");
  const handle = await window.showDirectoryPicker({ id: "railbound-puzzles", mode: "readwrite" });
  await rememberLibraryRoot(handle);
  return handle;
}

export async function ensureLibraryPermission(handle, request = false) {
  if (!handle) return false;
  const options = { mode: "readwrite" };
  if (await handle.queryPermission(options) === "granted") return true;
  return request && await handle.requestPermission(options) === "granted";
}

async function getCategoryDirectory(root, category, create = false) {
  const folderName = PUZZLE_LIBRARY_FOLDERS[category];
  if (!folderName) throw new Error(`未知关卡分类：${category}`);
  return root.getDirectoryHandle(folderName, { create });
}

export async function savePuzzleToLibrary(root, { puzzle, name, category = "normal" }) {
  if (!await ensureLibraryPermission(root, true)) throw new Error("没有所选文件夹的写入权限");
  const folder = await getCategoryDirectory(root, category, true);
  const baseName = sanitizePuzzleFileName(name);
  const fileName = `${baseName}.json`;
  const fileHandle = await folder.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(`${JSON.stringify(toPortablePuzzle(puzzle), null, 2)}\n`);
  } finally {
    await writable.close();
  }
  return { name: baseName, fileName, category, folderName: PUZZLE_LIBRARY_FOLDERS[category] };
}

async function readLibraryDirectory(root, category) {
  let folder;
  try {
    folder = await getCategoryDirectory(root, category, false);
  } catch (error) {
    if (error?.name === "NotFoundError") return [];
    throw error;
  }
  const entries = [];
  for await (const handle of folder.values()) {
    if (handle.kind !== "file" || !handle.name.toLowerCase().endsWith(".json") || isPuzzleManifestFileName(handle.name)) continue;
    const file = await handle.getFile();
    entries.push(await puzzleEntryFromFile(file, { id: `${category}/${handle.name}`, category }));
  }
  return entries;
}

async function puzzleEntryFromFile(file, { id, category }) {
  const base = {
    id,
    category,
    name: file.name.replace(/\.json$/i, ""),
    fileName: file.name,
    lastModified: file.lastModified,
    size: file.size,
  };
  try {
    const document = parsePuzzleDocument(await file.text());
    return {
      ...base,
      category: document.isFixture ? "test" : category,
      name: document.metadata?.name || base.name,
      description: document.metadata?.description || "",
      suiteCategory: document.metadata?.category || "",
      puzzle: document.puzzle,
      preview: document.preview,
      fixture: document.isFixture,
      issue: document.issue,
    };
  } catch (error) {
    return { ...base, error: error.message };
  }
}

async function readRootLibraryFiles(root) {
  if (typeof root?.values !== "function") return [];
  const entries = [];
  for await (const handle of root.values()) {
    if (handle.kind !== "file" || !handle.name.toLowerCase().endsWith(".json") || isPuzzleManifestFileName(handle.name)) continue;
    const file = await handle.getFile();
    entries.push(await puzzleEntryFromFile(file, { id: `root/${handle.name}`, category: "normal" }));
  }
  return entries;
}

export async function listPuzzleLibrary(root) {
  if (!await ensureLibraryPermission(root, false)) throw new Error("需要重新授权关卡库文件夹");
  const categories = Object.keys(PUZZLE_LIBRARY_FOLDERS);
  await Promise.all(categories.map(category => getCategoryDirectory(root, category, true)));
  const entries = [...(await Promise.all(categories.map(category => readLibraryDirectory(root, category)))).flat(), ...await readRootLibraryFiles(root)];
  return entries.sort((a, b) => b.lastModified - a.lastModified || a.name.localeCompare(b.name, "zh-CN"));
}

export async function readPuzzleFiles(fileList) {
  const entries = [];
  for (const file of Array.from(fileList || [])) {
    if (!file.name.toLowerCase().endsWith(".json") || isPuzzleManifestFileName(file.name)) continue;
    const path = file.webkitRelativePath || file.name;
    entries.push(await puzzleEntryFromFile(file, { id: path, category: inferPuzzleCategory(path) }));
  }
  return entries.sort((a, b) => b.lastModified - a.lastModified || a.name.localeCompare(b.name, "zh-CN"));
}

export function downloadPuzzle(puzzle, name) {
  const blob = new Blob([`${JSON.stringify(toPortablePuzzle(puzzle), null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${sanitizePuzzleFileName(name)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
