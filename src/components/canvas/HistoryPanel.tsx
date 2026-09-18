// Version history panel (Track changes chunk): the user-facing surface over the
// revision snapshots that every save already writes (debounced, capped ~50 —
// PRD §4.6). Lists snapshots newest-first, renders a word-level diff between any
// version and the current body ("Show changes"), and restores a prior version
// (the general item-view "undo" — restore force-snapshots the current body
// first server-side, so the restore is itself undoable).
//
// Lazy: the revision list is fetched only when the panel is first expanded, so
// opening an item never costs a revisions query (Principle 8). Restore does a
// full reload because the markdown editor seeds its content from the body once
// on mount; a reload re-seeds it from the restored body.
"use client";

import { useCallback, useRef, useState } from "react";
import ConfirmButton from "@/components/ui/ConfirmButton";
import { diffStats, diffWords, type DiffSegment } from "@/lib/diff";

type RevMeta = { id: string; createdAt: string };

// The synthetic left/right diff endpoint for the live (unsaved-snapshot) body.
const CURRENT = "current";

// Relative "2h ago" with an absolute tooltip. Client-only (real wall clock).
function formatWhen(iso: string): { rel: string; abs: string } {
  const then = new Date(iso);
  const abs = then.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const secs = Math.round((Date.now() - then.getTime()) / 1000);
  let rel: string;
  if (secs < 45) rel = "just now";
  else if (secs < 3600) rel = `${Math.round(secs / 60)}m ago`;
  else if (secs < 86400) rel = `${Math.round(secs / 3600)}h ago`;
  else if (secs < 86400 * 7) rel = `${Math.round(secs / 86400)}d ago`;
  else rel = abs;
  return { rel, abs };
}

function DiffView({ segments }: { segments: DiffSegment[] }) {
  if (segments.length === 0 || segments.every((s) => s.op === "eq")) {
    return (
      <p className="px-2 py-3 text-xs text-neutral-500">
        No changes between these versions.
      </p>
    );
  }
  return (
    <div className="max-h-80 overflow-y-auto whitespace-pre-wrap break-words px-2 py-2 text-sm leading-relaxed text-neutral-400">
      {segments.map((seg, i) => {
        if (seg.op === "eq") return <span key={i}>{seg.text}</span>;
        if (seg.op === "add")
          return (
            <span key={i} className="rounded-sm bg-green-950/50 text-green-300">
              {seg.text}
            </span>
          );
        return (
          <span
            key={i}
            className="rounded-sm bg-red-950/50 text-red-300/90 line-through decoration-red-500/50"
          >
            {seg.text}
          </span>
        );
      })}
    </div>
  );
}

export default function HistoryPanel({
  itemId,
  currentText,
  bare = false,
}: {
  itemId: string;
  currentText: string;
  // Drop the centered reading column, for hosts that already provide one — the
  // task canvas renders this inside its two-pane main column, where the inner
  // `mx-auto max-w-3xl` would re-center it against the wrong width and push it
  // visibly out of line with the body above (the misalignment Tyler flagged,
  // 2026-09-11). Matches CanvasSection/ItemFilesSection's `bare`.
  bare?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [revisions, setRevisions] = useState<RevMeta[] | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [listError, setListError] = useState("");

  // The open comparison: `fromId` is a revision id (the older side), `toId` is
  // a revision id or CURRENT (the newer side, defaulting to the live body).
  const [fromId, setFromId] = useState<string | null>(null);
  const [toId, setToId] = useState<string>(CURRENT);
  const [diff, setDiff] = useState<DiffSegment[] | null>(null);
  const [diffBusy, setDiffBusy] = useState(false);
  const [diffError, setDiffError] = useState("");

  // Cache fetched revision texts so re-pointing the comparison is instant.
  const textCache = useRef<Map<string, string>>(new Map());

  const loadList = useCallback(async () => {
    setLoadingList(true);
    setListError("");
    try {
      const res = await fetch(`/api/items/${itemId}/revisions`);
      if (!res.ok) throw new Error(`failed (${res.status})`);
      const { revisions: rows } = (await res.json()) as { revisions: RevMeta[] };
      setRevisions(rows);
    } catch (err) {
      setListError(err instanceof Error ? err.message : "could not load history");
    } finally {
      setLoadingList(false);
    }
  }, [itemId]);

  function toggle() {
    setExpanded((e) => !e);
    if (!revisions && !loadingList) void loadList();
  }

  const getText = useCallback(
    async (key: string): Promise<string> => {
      if (key === CURRENT) return currentText;
      const cached = textCache.current.get(key);
      if (cached !== undefined) return cached;
      const res = await fetch(`/api/items/${itemId}/revisions/${key}`);
      if (!res.ok) throw new Error(`failed (${res.status})`);
      const { revision } = (await res.json()) as { revision: { text: string } };
      const text = revision.text ?? "";
      textCache.current.set(key, text);
      return text;
    },
    [itemId, currentText]
  );

  const showChanges = useCallback(
    async (from: string, to: string) => {
      setFromId(from);
      setToId(to);
      setDiffBusy(true);
      setDiffError("");
      setDiff(null);
      try {
        const [a, b] = await Promise.all([getText(from), getText(to)]);
        setDiff(diffWords(a, b));
      } catch (err) {
        setDiffError(err instanceof Error ? err.message : "could not load diff");
      } finally {
        setDiffBusy(false);
      }
    },
    [getText]
  );

  async function restore(id: string) {
    const res = await fetch(`/api/items/${itemId}/revisions/${id}/restore`, {
      method: "POST",
    });
    if (!res.ok) throw new Error(`restore failed (${res.status})`);
    // The editor seeds from the body on mount; reload to re-seed it restored.
    window.location.reload();
  }

  const stats = diff ? diffStats(diff) : null;
  const fromWhen = fromId
    ? revisions?.find((r) => r.id === fromId)?.createdAt
    : null;

  const panel = (
    <section className={`canvas-section ${bare ? "canvas-section-bare" : ""}`}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={expanded}
        className="canvas-section-title hover:text-neutral-300"
      >
        <span className={`canvas-section-icon transition-transform ${expanded ? "rotate-90" : ""}`}>
          ▸
        </span>
        Version history
        {revisions && <span className="canvas-section-count">{revisions.length}</span>}
      </button>

      {expanded && (
        <div className="mt-2">
          {loadingList && (
            <p className="px-2 text-xs text-neutral-500">Loading…</p>
          )}
          {listError && (
            <p className="px-2 text-xs text-red-400">{listError}</p>
          )}
          {revisions && revisions.length === 0 && (
            <p className="px-2 text-xs text-neutral-500">
              No saved versions yet. Edits are snapshotted as you work.
            </p>
          )}

          {/* The open diff, above the list so the layout stays stable. */}
          {fromId && (
            <div className="mb-3 rounded-lg border border-neutral-800 bg-neutral-900/40">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-neutral-800 px-2 py-1.5 text-xs text-neutral-500">
                <span className="text-neutral-400">
                  Changes from {fromWhen ? formatWhen(fromWhen).rel : "version"}
                </span>
                <span>→</span>
                <select
                  value={toId}
                  onChange={(e) => void showChanges(fromId, e.target.value)}
                  className="rounded border border-neutral-700 bg-neutral-800 px-1 py-0.5 text-neutral-300"
                >
                  <option value={CURRENT}>Current</option>
                  {revisions
                    ?.filter((r) => r.id !== fromId)
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {formatWhen(r.createdAt).rel}
                      </option>
                    ))}
                </select>
                {stats && (stats.added > 0 || stats.removed > 0) && (
                  <span className="ml-auto tabular-nums">
                    <span className="text-green-400">+{stats.added}</span>{" "}
                    <span className="text-red-400">−{stats.removed}</span>
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setFromId(null);
                    setDiff(null);
                  }}
                  className="text-neutral-600 hover:text-neutral-300"
                  aria-label="Close changes"
                >
                  ✕
                </button>
              </div>
              {diffBusy && (
                <p className="px-2 py-3 text-xs text-neutral-500">Loading…</p>
              )}
              {diffError && (
                <p className="px-2 py-3 text-xs text-red-400">{diffError}</p>
              )}
              {diff && <DiffView segments={diff} />}
            </div>
          )}

          {revisions && revisions.length > 0 && (
            <ul className="flex flex-col">
              {revisions.map((r, i) => {
                const when = formatWhen(r.createdAt);
                return (
                  <li
                    key={r.id}
                    className={`flex items-center gap-3 rounded px-2 py-1.5 text-sm ${
                      fromId === r.id ? "bg-neutral-800/60" : ""
                    }`}
                  >
                    <span className="text-neutral-300" title={when.abs}>
                      {when.rel}
                    </span>
                    {i === 0 && (
                      <span className="text-xs text-neutral-600">latest</span>
                    )}
                    <button
                      type="button"
                      onClick={() => void showChanges(r.id, CURRENT)}
                      className="ml-auto shrink-0 text-xs text-neutral-500 hover:text-neutral-200"
                    >
                      Show changes
                    </button>
                    <ConfirmButton
                      onConfirm={() => restore(r.id)}
                      title="Restore this version?"
                      description="The current body becomes a new version first, so this is undoable."
                      confirmLabel="Restore"
                      trigger="Restore"
                      triggerClassName="shrink-0 text-xs text-neutral-500 hover:text-[var(--accent)]"
                      align="right"
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
  return bare ? (
    panel
  ) : (
    <div className="canvas-section-wrap mx-auto w-full max-w-3xl px-2 sm:px-8 md:px-12">
      {panel}
    </div>
  );
}
