// Library panel → "Remove unused media…" (the head button, or a right-click in
// the library): a strip under the panel head that lists what nothing in the
// project uses, from a remove_unused_media dry run, and removes it. ZabsReel's
// own bakes (and built-in bleep sounds) are selected; the user's imported
// media only when they tick it. One undo step; files stay on disk (the storage
// clean-up trashes a bake's file once nothing uses it).
import { useEffect, useState } from "react";
import type { CoreApi } from "./api";
import { fmtBytes } from "./storagedialog";
import "./unusedmedia.css";

interface Item {
  assetId: string;
  name: string;
  kind: "generated" | "imported";
  bytes: number;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const total = (xs: Item[]) => xs.reduce((n, x) => n + x.bytes, 0);

export function UnusedMediaStrip({ api, onClose }: { api: CoreApi; onClose: () => void }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [withImported, setWithImported] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .rpc<{ removed: Item[] }>("remove_unused_media", { dryRun: true, includeImported: true })
      .then((r) => { if (live) setItems(r.removed); })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [api]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const generated = items?.filter((i) => i.kind === "generated") ?? [];
  const imported = items?.filter((i) => i.kind === "imported") ?? [];
  const count = generated.length + (withImported ? imported.length : 0);

  const remove = async () => {
    setBusy(true);
    try {
      await api.rpc("remove_unused_media", { includeImported: withImported });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="unused-strip" role="group" aria-label="Remove unused media">
      {!items && !error && <span className="muted">Looking for unused media…</span>}
      {items && items.length === 0 && <span>Everything in the library is used in the project.</span>}
      {items && items.length > 0 && (
        <>
          <span>
            {generated.length > 0
              ? <>{plural(generated.length, "bake")} ZabsReel made ({fmtBytes(total(generated))}) — nothing in the project uses {generated.length === 1 ? "it" : "them"}.</>
              : "No unused bakes."}
          </span>
          {imported.length > 0 && (
            <label className="check-row">
              <input type="checkbox" checked={withImported} onChange={(e) => setWithImported(e.target.checked)} />
              Also remove {plural(imported.length, "unused imported file")} (your files stay on disk)
            </label>
          )}
          <span className="muted">Undo brings them back. Disk space comes back with the next storage clean-up.</span>
        </>
      )}
      {error && <span className="unused-error" role="alert">{error}</span>}
      <div className="unused-actions">
        <button className="btn btn-sm" onClick={onClose}>{items && items.length === 0 ? "Close" : "Cancel"}</button>
        {items && items.length > 0 && (
          <button className="btn btn-sm btn-danger" onClick={remove} disabled={busy || count === 0}>
            Remove {count > 0 ? count : ""} from library
          </button>
        )}
      </div>
    </div>
  );
}
