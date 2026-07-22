import React, { useEffect, useMemo, useRef, useState } from "react";
import PuzzleThumbnail from "./PuzzleThumbnail.jsx";
import {
  defaultPuzzleName, downloadPuzzle, ensureLibraryPermission, getRememberedLibraryRoot,
  listPuzzleLibrary, PUZZLE_LIBRARY_FOLDERS, readPuzzleFiles, savePuzzleToLibrary,
  selectLibraryRoot, supportsDirectoryLibrary,
} from "./puzzle-library.js";

const colors = { bg: "#12100e", panel: "#17140f", raised: "#211c15", border: "#3a3228", hi: "#d4a256", text: "#d0c7b9", muted: "#807361", bad: "#e17a72" };

function Button({ children, onClick, primary = false, disabled = false }) {
  return <button type="button" onClick={onClick} disabled={disabled} style={{
    padding: "7px 11px", borderRadius: 4, cursor: disabled ? "not-allowed" : "pointer", fontFamily: "inherit", fontSize: 11,
    background: primary ? "#332610" : colors.raised, color: disabled ? "#655d51" : primary ? colors.hi : colors.text,
    border: `1px solid ${primary ? colors.hi : colors.border}`, opacity: disabled ? .7 : 1,
  }}>{children}</button>;
}

export default function PuzzleLibraryDialog({ mode, puzzle, onClose, onLoad, onMessage }) {
  const [root, setRoot] = useState(null);
  const [entries, setEntries] = useState([]);
  const [category, setCategory] = useState("normal");
  const [name, setName] = useState(() => puzzle ? defaultPuzzleName(puzzle) : "");
  const [status, setStatus] = useState("正在连接本地关卡库…");
  const [busy, setBusy] = useState(false);
  const folderInputRef = useRef(null);
  const canUseDirectory = supportsDirectoryLibrary();

  async function refresh(handle) {
    setBusy(true);
    try {
      const nextEntries = await listPuzzleLibrary(handle);
      setEntries(nextEntries);
      if (!nextEntries.some(entry => entry.category === "normal") && nextEntries.some(entry => entry.category === "test")) setCategory("test");
      setStatus(nextEntries.length ? `已读取 ${nextEntries.length} 个 JSON 文件` : "关卡库为空；保存时会自动创建“普通”和“测试”文件夹");
    } catch (error) {
      setStatus(error.message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    let live = true;
    (async () => {
      if (!canUseDirectory) {
        if (live) setStatus("当前浏览器不支持直接读写目录，可下载 JSON 或选择文件夹读取");
        return;
      }
      const remembered = await getRememberedLibraryRoot();
      if (!live) return;
      if (!remembered) {
        setStatus("请选择一个关卡库根目录；应用将在其中使用“普通”和“测试”子目录");
        return;
      }
      setRoot(remembered);
      if (await ensureLibraryPermission(remembered, false)) await refresh(remembered);
      else setStatus(`已记住“${remembered.name}”，点击“授权此目录”后读取`);
    })().catch(error => live && setStatus(error.message));
    return () => { live = false; };
  }, [canUseDirectory]);

  async function chooseRoot() {
    try {
      const handle = await selectLibraryRoot();
      setRoot(handle);
      await refresh(handle);
    } catch (error) {
      if (error?.name !== "AbortError") setStatus(error.message);
    }
  }

  async function authorizeRoot() {
    if (!root) return chooseRoot();
    try {
      if (!await ensureLibraryPermission(root, true)) throw new Error("目录授权未通过");
      await refresh(root);
    } catch (error) {
      setStatus(error.message);
    }
  }

  async function save() {
    setBusy(true);
    try {
      let handle = root;
      if (!handle) handle = await selectLibraryRoot();
      setRoot(handle);
      const saved = await savePuzzleToLibrary(handle, { puzzle, name, category });
      const message = `已保存到 ${saved.folderName}/${saved.fileName}`;
      setStatus(message);
      onMessage(message);
      await refresh(handle);
    } catch (error) {
      if (error?.name !== "AbortError") setStatus(`保存失败：${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function loadFallbackFiles(event) {
    setBusy(true);
    try {
      const nextEntries = await readPuzzleFiles(event.target.files);
      setEntries(nextEntries);
      setStatus(`已读取 ${nextEntries.length} 个 JSON 文件`);
    } catch (error) {
      setStatus(`读取失败：${error.message}`);
    } finally {
      setBusy(false);
      event.target.value = "";
    }
  }

  const filteredEntries = useMemo(() => entries.filter(entry => entry.category === category), [entries, category]);

  return <div role="dialog" aria-modal="true" aria-label={mode === "save" ? "保存关卡" : "关卡库"} onMouseDown={event => event.target === event.currentTarget && onClose()} style={{
    position: "fixed", inset: 0, zIndex: 100, background: "rgba(4,3,2,.78)", display: "flex", alignItems: "center", justifyContent: "center", padding: 18,
  }}>
    <div style={{ width: "min(760px, 96vw)", maxHeight: "88vh", overflow: "auto", background: colors.panel, border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: "0 22px 70px #000", color: colors.text }}>
      <div style={{ position: "sticky", top: 0, zIndex: 2, display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", background: colors.panel, borderBottom: `1px solid ${colors.border}` }}>
        <strong style={{ color: colors.hi, fontSize: 14 }}>{mode === "save" ? "保存关卡 JSON" : "本地关卡库"}</strong>
        <span style={{ color: colors.muted, fontSize: 10 }}>{root ? `目录：${root.name}` : "尚未选择根目录"}</span>
        <div style={{ flex: 1 }} />
        <Button onClick={onClose}>关闭</Button>
      </div>

      <div style={{ padding: 14 }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 7, marginBottom: 10 }}>
          {canUseDirectory && <Button onClick={root ? authorizeRoot : chooseRoot}>{root ? "授权此目录" : "选择关卡库目录"}</Button>}
          {canUseDirectory && root && <Button onClick={chooseRoot}>更换目录</Button>}
          {mode === "load" && <>
            <Button onClick={() => folderInputRef.current?.click()}>临时读取文件夹</Button>
            <input ref={folderInputRef} type="file" accept="application/json,.json" multiple directory="" webkitdirectory="" onChange={loadFallbackFiles} style={{ display: "none" }} />
          </>}
          <span style={{ color: status.startsWith("保存失败") ? colors.bad : colors.muted, fontSize: 10 }}>{busy ? "处理中…" : status}</span>
        </div>

        {mode === "save" && <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: 12, alignItems: "end", padding: 12, background: colors.bg, border: `1px solid ${colors.border}`, borderRadius: 6 }}>
          <label style={{ display: "grid", gap: 5, minWidth: 0 }}>
            <span style={{ color: colors.muted, fontSize: 10 }}>文件名</span>
            <input autoFocus value={name} onChange={event => setName(event.target.value)} onKeyDown={event => event.key === "Enter" && save()} style={{ boxSizing: "border-box", width: "100%", padding: "8px 9px", background: colors.panel, border: `1px solid ${colors.border}`, borderRadius: 4, color: colors.text, fontFamily: "inherit" }} />
          </label>
          <Button primary onClick={canUseDirectory ? save : () => { downloadPuzzle(puzzle, name); onMessage("JSON 已下载到浏览器下载目录"); }} disabled={busy}>
            {canUseDirectory ? "保存 JSON" : "下载 JSON"}
          </Button>
          <div style={{ gridColumn: "1 / -1", display: "flex", gap: 6 }}>
            {Object.entries(PUZZLE_LIBRARY_FOLDERS).map(([id, label]) => <button key={id} type="button" onClick={() => setCategory(id)} style={{
              flex: 1, padding: 8, cursor: "pointer", borderRadius: 4, fontFamily: "inherit", fontSize: 11,
              background: category === id ? "#332610" : colors.panel, color: category === id ? colors.hi : colors.muted,
              border: `1px solid ${category === id ? colors.hi : colors.border}`,
            }}>{label}文件夹</button>)}
          </div>
        </div>}

        {mode === "load" && <>
          <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
            {Object.entries(PUZZLE_LIBRARY_FOLDERS).map(([id, label]) => <button key={id} type="button" onClick={() => setCategory(id)} style={{
              padding: "6px 12px", cursor: "pointer", borderRadius: 999, fontFamily: "inherit", fontSize: 11,
              background: category === id ? "#332610" : colors.raised, color: category === id ? colors.hi : colors.muted,
              border: `1px solid ${category === id ? colors.hi : colors.border}`,
            }}>{label} · {entries.filter(entry => entry.category === id).length}</button>)}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 10 }}>
            {filteredEntries.map(entry => <button key={entry.id} type="button" disabled={!entry.puzzle} onClick={() => entry.puzzle && onLoad(entry.puzzle, entry.name)} style={{
              padding: 0, overflow: "hidden", textAlign: "left", cursor: entry.puzzle ? "pointer" : "not-allowed", background: colors.bg,
              border: `1px solid ${entry.error ? colors.bad : entry.issue ? "#8a7344" : colors.border}`, borderRadius: 6, color: colors.text, fontFamily: "inherit", opacity: 1,
            }}>
              {entry.preview ? <PuzzleThumbnail puzzle={entry.preview} /> : <div style={{ height: 112, display: "grid", placeItems: "center", padding: 10, color: entry.fixture ? colors.hi : colors.bad, fontSize: 10, textAlign: "center" }}>{entry.fixture ? "🧪 Helper 测试夹具\n无棋盘预览" : `JSON 无效\n${entry.error}`}</div>}
              <div style={{ padding: "8px 9px" }}>
                <div title={`${entry.name} · ${entry.fileName}`} style={{ overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", fontSize: 11 }}>{entry.name}</div>
                <div style={{ marginTop: 3, color: entry.issue ? colors.hi : colors.muted, fontSize: 9 }}>
                  {entry.fixture ? `测试夹具 · ${entry.puzzle ? "可载入" : "仅预览"}` : entry.puzzle ? "普通关卡" : "无法读取"}
                  {entry.preview && ` · ${entry.preview.width}×${entry.preview.height} · ${entry.preview.cars.length} 辆车`}
                </div>
                {entry.suiteCategory && <div title={entry.suiteCategory} style={{ marginTop: 4, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", color: "#9c8d78", fontSize: 9 }}>{entry.suiteCategory}</div>}
                {entry.description && <div title={entry.description} style={{ marginTop: 4, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", color: colors.muted, fontSize: 9, lineHeight: 1.4 }}>{entry.description}</div>}
                {entry.issue && <div title={entry.issue} style={{ marginTop: 5, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", color: colors.hi, fontSize: 9 }}>不可载入：{entry.issue}</div>}
              </div>
            </button>)}
          </div>
          {!busy && filteredEntries.length === 0 && <div style={{ padding: 28, textAlign: "center", color: colors.muted }}>这个文件夹里还没有关卡 JSON</div>}
        </>}
      </div>
    </div>
  </div>;
}
