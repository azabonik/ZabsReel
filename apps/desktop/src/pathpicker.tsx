// In-app file picker for the web shell. Browsers never reveal a file's absolute
// path, but the core imports, streams and exports by absolute path — so instead
// of <input type=file> (which would mean uploading multi-GB footage to a server
// on the same machine) this browses the disk through the shell's token-gated
// /api/fs/list and hands back real paths, exactly like Electron's native dialogs.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { api, getSnapshot, subscribe, type FileFilter, type FsEntry, type FsListing, type PendingPick, type WebConfig } from "./platform";
import { Alert, ArrowUp, File, Folder, X } from "./icons";

/** Mounted once beside <App/>: renders the picker on demand and the expired-session notice. */
export function PlatformHost() {
  const { status, config, pending } = useSyncExternalStore(subscribe, getSnapshot);
  return (
    <>
      {status === "expired" && <SessionNotice />}
      {pending && config && <PathPicker key={pending.id} request={pending} config={config} />}
    </>
  );
}

function SessionNotice() {
  return (
    <>
      <div className="scrim" />
      <div className="session-notice" role="alertdialog" aria-labelledby="session-notice-title">
        <h3 id="session-notice-title"><Alert size={16} /> This tab is not connected to the editor</h3>
        <p>
          The link that opens SynthCut carries the session key for the current run. Only the tab that
          opened the link keeps the key, so a new tab has none. This tab has no key, or a key from an
          earlier run.
        </p>
        <p>Open the link printed in the terminal where you ran <code>npm run web</code>.</p>
      </div>
    </>
  );
}

function fmtSize(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function fmtDate(ms: number | null): string {
  return ms === null ? "" : new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function matches(name: string, filter: FileFilter | undefined): boolean {
  if (!filter || filter.extensions.includes("*")) return true;
  const dot = name.lastIndexOf(".");
  return dot > 0 && filter.extensions.includes(name.slice(dot + 1).toLowerCase());
}

function joinPath(dir: string, name: string, sep: string): string {
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}

function isAbsolute(p: string): boolean {
  return p.startsWith("/") || p.startsWith("\\\\") || /^[a-zA-Z]:[\\/]/.test(p);
}

function remember(key: string, dir: string): void {
  try { localStorage.setItem(`aive.picker.${key}`, dir); } catch { /* ignore */ }
}

function PathPicker({ request, config }: { request: PendingPick; config: WebConfig }) {
  const save = request.mode === "save";
  const multiple = request.mode === "open" && request.multiple;
  const [listing, setListing] = useState<FsListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [cursor, setCursor] = useState(0);
  const [filterIdx, setFilterIdx] = useState(0);
  const [showHidden, setShowHidden] = useState(false);
  const [name, setName] = useState(request.mode === "save" ? request.defaultName : "");
  const listRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const loadSeq = useRef(0);

  const cancel = useCallback(() => request.resolve(null), [request]);

  /** Show `dir`. Resolves with the error (status + message) if it can't be listed. */
  const load = useCallback(async (dir: string): Promise<{ status?: number; message: string } | null> => {
    const seq = ++loadSeq.current;
    setLoading(true);
    try {
      const next = await api<FsListing>(`/api/fs/list?path=${encodeURIComponent(dir)}`);
      if (seq !== loadSeq.current) return null;
      setListing(next);
      setPathInput(next.path);
      setSelected([]);
      setAnchor(null);
      setCursor(0);
      setError(null);
      return null;
    } catch (err) {
      const e = err as Error & { status?: number };
      if (seq === loadSeq.current) setError(e.message);
      return { status: e.status, message: e.message };
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, []);

  // Start where this kind of pick last finished, else in the home folder.
  useEffect(() => {
    let start = config.home;
    try { start = localStorage.getItem(`aive.picker.${request.key}`) || config.home; } catch { /* ignore */ }
    load(start).then((err) => { if (err && start !== config.home) load(config.home); });
    if (save) {
      const input = nameRef.current;
      if (input) {
        input.focus();
        const dot = input.value.lastIndexOf(".");
        input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
      }
    } else {
      listRef.current?.focus();
    }
  }, [config.home, load, request.key, save]);

  const filter = request.filters[filterIdx] ?? request.filters[0];
  const visible = useMemo(
    () => (listing?.entries ?? []).filter((e) => (showHidden || !e.hidden) && (e.dir || matches(e.name, filter))),
    [listing, showHidden, filter],
  );

  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const sep = listing?.sep ?? config.sep;
  const pathOf = (entry: FsEntry) => joinPath(listing!.path, entry.name, sep);

  const confirmOpen = (names: string[] = selected) => {
    if (!listing) return;
    const picked = names.map((n) => visible.find((e) => e.name === n)).filter((e): e is FsEntry => !!e);
    // Like native dialogs: "Open" on a single folder goes into it.
    if (picked.length === 1 && picked[0].dir) { load(pathOf(picked[0])); return; }
    const files = picked.filter((e) => !e.dir);
    if (!files.length) return;
    remember(request.key, listing.path);
    request.resolve(files.map(pathOf));
  };

  const confirmSave = (typed: string = name) => {
    if (!listing) return;
    let n = typed.trim();
    if (!n) return;
    if (isAbsolute(n)) {
      // A typed absolute path wins over the folder being shown.
      const ext = request.filters[0]?.extensions[0];
      if (ext && ext !== "*" && !n.toLowerCase().endsWith(`.${ext}`)) n += `.${ext}`;
      const cut = Math.max(n.lastIndexOf("/"), n.lastIndexOf("\\"));
      remember(request.key, n.slice(0, cut > 0 ? cut : 1));
      request.resolve([n]);
      return;
    }
    const folder = listing.entries.find((e) => e.dir && e.name === n);
    if (folder) { load(pathOf(folder)); setName(request.mode === "save" ? request.defaultName : ""); return; }
    const ext = request.filters[0]?.extensions[0];
    if (ext && ext !== "*" && !n.toLowerCase().endsWith(`.${ext}`)) n += `.${ext}`;
    // Case-insensitive on purpose: Windows drives (and /mnt/c under WSL) are.
    const clash = listing.entries.find((e) => !e.dir && e.name.toLowerCase() === n.toLowerCase());
    if (clash && !window.confirm(`"${clash.name}" already exists. Replace it?`)) return;
    remember(request.key, listing.path);
    request.resolve([joinPath(listing.path, clash ? clash.name : n, sep)]);
  };

  const confirm = () => (save ? confirmSave() : confirmOpen());

  const select = (idx: number, e?: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => {
    const entry = visible[idx];
    if (!entry) return;
    setCursor(idx);
    if (save) {
      setSelected([entry.name]);
      if (!entry.dir) setName(entry.name);
      return;
    }
    if (multiple && e && (e.ctrlKey || e.metaKey)) {
      setSelected((s) => (s.includes(entry.name) ? s.filter((n) => n !== entry.name) : [...s, entry.name]));
      setAnchor(idx);
    } else if (multiple && e?.shiftKey && anchor !== null) {
      const [a, b] = anchor < idx ? [anchor, idx] : [idx, anchor];
      setSelected(visible.slice(a, b + 1).filter((v) => !v.dir).map((v) => v.name));
    } else {
      setSelected([entry.name]);
      setAnchor(idx);
    }
  };

  const activate = (idx: number) => {
    const entry = visible[idx];
    if (!entry) return;
    if (entry.dir) load(pathOf(entry));
    else if (save) confirmSave(entry.name);
    else confirmOpen([entry.name]);
  };

  const onListKey = (e: ReactKeyboardEvent) => {
    const last = visible.length - 1;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (last < 0) return;
      const next = Math.min(last, Math.max(0, cursor + (e.key === "ArrowDown" ? 1 : -1)));
      select(next, { ctrlKey: false, metaKey: false, shiftKey: e.shiftKey });
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      if (last >= 0) select(e.key === "Home" ? 0 : last);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const entry = visible[cursor];
      if (entry?.dir || save || selected.length <= 1) activate(cursor);
      else confirmOpen();
    } else if (e.key === "Backspace") {
      e.preventDefault();
      if (listing?.parent) load(listing.parent);
    }
  };

  const onPathKey = async (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const target = pathInput.trim();
    if (!target) return;
    const err = await load(target);
    // A file path typed into an open dialog picks that file directly.
    if (err && err.status === 400 && /^Not a folder/.test(err.message) && !save) {
      const cut = Math.max(target.lastIndexOf("/"), target.lastIndexOf("\\"));
      remember(request.key, target.slice(0, cut > 0 ? cut : 1));
      request.resolve([target]);
    }
  };

  // Keys pressed in the picker must never reach the editor's window-level
  // shortcuts (Space plays, Backspace deletes the selected clip, Ctrl+S saves).
  // React's root listener sits below window, so stopping here is enough.
  const onDialogKey = (e: ReactKeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); cancel(); }
  };

  const selectedFiles = selected.filter((n) => visible.some((v) => v.name === n && !v.dir)).length;
  const canConfirm = save ? !!name.trim() && !!listing : selected.length > 0;

  return (
    <>
      <div className="scrim" onClick={cancel} />
      {/* tabIndex -1: a click anywhere inside keeps focus in the dialog, so its keys stay here */}
      <div className="picker" role="dialog" aria-modal="true" aria-label={request.title} tabIndex={-1} onKeyDown={onDialogKey}>
        <div className="picker-head">
          <h3>{request.title}</h3>
          <button className="icon-btn" onClick={cancel} aria-label="Close"><X /></button>
        </div>

        <div className="picker-bar">
          <button
            className="icon-btn"
            onClick={() => listing?.parent && load(listing.parent)}
            disabled={!listing?.parent}
            aria-label="Up one folder"
            title="Up one folder (Backspace)"
          >
            <ArrowUp />
          </button>
          <input
            className="field-input picker-path"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={onPathKey}
            spellCheck={false}
            aria-label="Folder path"
            title="Type a folder (or file) path and press Enter"
          />
          {request.filters.length > 1 && (
            <select value={filterIdx} onChange={(e) => setFilterIdx(Number(e.target.value))} aria-label="File type">
              {request.filters.map((f, i) => <option key={f.name} value={i}>{f.name}</option>)}
            </select>
          )}
          <label className="picker-toggle">
            <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
            Hidden files
          </label>
        </div>

        <div className="picker-body">
          <nav className="picker-places" aria-label="Places">
            {config.places.map((p) => (
              <button
                key={p.path}
                className={`picker-place${listing?.path === p.path ? " on" : ""}`}
                onClick={() => load(p.path)}
                title={p.path}
              >
                <Folder size={14} /> <span>{p.label}</span>
              </button>
            ))}
          </nav>

          <div
            className="picker-list"
            ref={listRef}
            tabIndex={0}
            role="listbox"
            aria-label="Files"
            aria-multiselectable={multiple}
            aria-busy={loading}
            onKeyDown={onListKey}
          >
            {error && <div className="picker-error"><Alert size={14} /> {error}</div>}
            {!error && listing && visible.length === 0 && (
              <div className="picker-empty">No {filter && !filter.extensions.includes("*") ? `${filter.name.toLowerCase()} files` : "files"} in this folder.</div>
            )}
            {visible.map((entry, i) => (
              <div
                key={entry.name}
                data-idx={i}
                role="option"
                aria-selected={selected.includes(entry.name)}
                className={`picker-row${entry.dir ? " dir" : ""}${selected.includes(entry.name) ? " sel" : ""}${i === cursor ? " cursor" : ""}`}
                onClick={(e: ReactMouseEvent) => select(i, e)}
                onDoubleClick={() => activate(i)}
                title={entry.name}
              >
                <span className="picker-icon">{entry.dir ? <Folder size={15} /> : <File size={15} />}</span>
                <span className="picker-name">{entry.name}</span>
                <span className="picker-size">{entry.dir ? "" : fmtSize(entry.size)}</span>
                <span className="picker-date">{fmtDate(entry.mtime)}</span>
              </div>
            ))}
            {listing?.truncated && <div className="picker-empty">Showing the first 10,000 items.</div>}
          </div>
        </div>

        <div className="picker-foot">
          {save ? (
            <label className="picker-filename">
              File name
              <input
                ref={nameRef}
                className="field-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); confirmSave(); } }}
                spellCheck={false}
              />
            </label>
          ) : (
            <span className="picker-count muted">
              {selectedFiles > 0
                ? `${selectedFiles} file${selectedFiles === 1 ? "" : "s"} selected`
                : multiple ? "Select files (Ctrl or Shift to pick several)" : "Select a file"}
            </span>
          )}
          <div className="picker-actions">
            <button className="btn btn-ghost" onClick={cancel}>Cancel</button>
            <button className="btn btn-primary" onClick={confirm} disabled={!canConfirm}>{request.confirmLabel}</button>
          </div>
        </div>
      </div>
    </>
  );
}
