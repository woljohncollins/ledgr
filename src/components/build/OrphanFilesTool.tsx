// The unused-files sweep (ADR-237; widened same day at Tyler's call): one Scan,
// two findings. UNLINKED files still belong to an item but nothing in it
// points at them anymore ("there's a note out there with a file attached that
// isn't being used") — listed with their item, per-row Delete. ORPHANED files
// have no item at all (pre-cleanup purges, interrupted uploads) — Recover all
// turns each into a note linking it; Delete all reclaims the storage. The
// orphan half can refuse on a syncing install (attachments aren't in sync);
// the unlinked half works everywhere, so its rows still render then.
"use client";

import { useState } from "react";
import Link from "next/link";
import { attachmentUrl } from "@/lib/attachment-url";
import { announceAttachmentRemoved } from "@/components/attachments/upload";
import { showToast } from "@/components/ui/ActionToast";
import ConfirmButton from "@/components/ui/ConfirmButton";
import { formatBytes } from "@/lib/format-count";

type Orphan = { key: string; sizeBytes: number };
type UnlinkedFile = {
  id: string;
  filename: string;
  sizeBytes: number;
  parent: { id: string; title: string; type: string };
};
type Scan = {
  unlinked: UnlinkedFile[];
  orphans: Orphan[] | null; // null = the orphan scan refused (message in orphanError)
  orphanBytes: number;
  orphanError: string;
};


// The key is `${ownerId}/${attachmentId}/${filename}` — show the filename.
function filenameOf(key: string): string {
  return key.split("/").slice(2).join("/") || key;
}

export default function OrphanFilesTool() {
  const [scan, setScan] = useState<Scan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const runScan = async () => {
    setBusy(true);
    setError("");
    try {
      const [filesRes, orphanRes] = await Promise.all([
        fetch("/api/hygiene/files"),
        fetch("/api/hygiene/orphan-files"),
      ]);
      if (!filesRes.ok) {
        const detail = await filesRes.json().catch(() => null);
        throw new Error(detail?.error ?? `scan failed (${filesRes.status})`);
      }
      const all = (await filesRes.json()) as {
        files: (UnlinkedFile & { referenced: boolean })[];
      };
      let orphans: Orphan[] | null = null;
      let orphanBytes = 0;
      let orphanError = "";
      if (orphanRes.ok) {
        const d = await orphanRes.json();
        orphans = d.orphans as Orphan[];
        orphanBytes = d.totalBytes as number;
      } else {
        const detail = await orphanRes.json().catch(() => null);
        orphanError = detail?.error ?? `orphan scan failed (${orphanRes.status})`;
      }
      setScan({
        unlinked: all.files.filter((f) => !f.referenced),
        orphans,
        orphanBytes,
        orphanError,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Scan failed");
    } finally {
      setBusy(false);
    }
  };

  const removeUnlinked = async (f: UnlinkedFile) => {
    const res = await fetch(`/api/attachments/${f.id}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`delete failed (${res.status})`);
    announceAttachmentRemoved({ itemId: f.parent.id, id: f.id });
    setScan((prev) =>
      prev ? { ...prev, unlinked: prev.unlinked.filter((u) => u.id !== f.id) } : prev
    );
    showToast("File deleted from storage");
  };

  const purge = async () => {
    const res = await fetch("/api/hygiene/orphan-files", { method: "DELETE" });
    if (!res.ok) {
      const detail = await res.json().catch(() => null);
      throw new Error(detail?.error ?? `delete failed (${res.status})`);
    }
    const { deleted, freedBytes, failed } = await res.json();
    showToast(
      `Deleted ${deleted} orphaned file${deleted === 1 ? "" : "s"} (${formatBytes(freedBytes)} freed)` +
        (failed > 0 ? ` — ${failed} failed, scan again` : "")
    );
    setScan(null);
  };

  const recover = async () => {
    const res = await fetch("/api/hygiene/orphan-files", { method: "POST" });
    if (!res.ok) {
      const detail = await res.json().catch(() => null);
      throw new Error(detail?.error ?? `recover failed (${res.status})`);
    }
    const { recovered, skipped } = await res.json();
    showToast(
      `Recovered ${recovered} file${recovered === 1 ? "" : "s"} — each is now a note linking it` +
        (skipped > 0 ? ` (${skipped} skipped)` : "")
    );
    setScan(null);
  };

  const orphanCount = scan?.orphans?.length ?? 0;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void runScan()}
          disabled={busy}
          className="rounded border border-neutral-700 bg-neutral-800 px-2.5 py-1 text-xs font-medium text-neutral-200 hover:bg-neutral-700 disabled:opacity-50"
        >
          {busy ? "Scanning…" : "Scan for unused files"}
        </button>
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>

      {scan && (
        <div className="flex flex-col gap-1.5">
          <p className="ui-section-label">Not linked from their item</p>
          {scan.unlinked.length === 0 ? (
            <p className="text-sm text-ink-subtle">
              None — every file is pointed at by its item.
            </p>
          ) : (
            <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto">
              {scan.unlinked.map((f) => (
                <li key={f.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
                  <a
                    href={attachmentUrl(f.id)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="truncate text-ink hover:text-[var(--accent)]"
                  >
                    {f.filename}
                  </a>
                  <span className="shrink-0 text-xs text-ink-faint">{formatBytes(f.sizeBytes)}</span>
                  <span className="shrink-0 text-xs text-ink-subtle">
                    on{" "}
                    <Link
                      href={`/items/${f.parent.id}`}
                      className="underline decoration-dotted underline-offset-2 hover:text-ink"
                    >
                      {f.parent.title || "Untitled"}
                    </Link>
                  </span>
                  <span className="ml-auto shrink-0">
                    <ConfirmButton
                      title="Delete this file?"
                      description="Deletes it from storage for good."
                      confirmLabel="Delete"
                      trigger={<span>Delete</span>}
                      triggerLabel={`Delete ${f.filename}`}
                      triggerClassName="rounded px-1.5 py-0.5 text-xs text-ink-subtle hover:bg-surface-2 hover:text-red-400"
                      align="right"
                      onConfirm={() => removeUnlinked(f)}
                    />
                  </span>
                </li>
              ))}
            </ul>
          )}

          <p className="ui-section-label mt-3">Orphaned — no item at all</p>
          {scan.orphans === null ? (
            <p className="text-sm text-ink-subtle">{scan.orphanError}</p>
          ) : orphanCount === 0 ? (
            <p className="text-sm text-ink-subtle">
              None — everything in storage belongs to an item.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <ConfirmButton
                  title={`Recover ${orphanCount} orphaned file${orphanCount === 1 ? "" : "s"}?`}
                  description="Creates one note per file, with the file re-attached and linked in the note's body, so each is reachable in Ledgr again."
                  confirmLabel="Recover all"
                  tone="primary"
                  trigger={<span>Recover all</span>}
                  triggerClassName="rounded border border-neutral-700 bg-neutral-800 px-2.5 py-1 text-xs font-medium text-neutral-200 hover:bg-neutral-700"
                  onConfirm={recover}
                />
                <ConfirmButton
                  title={`Delete ${orphanCount} orphaned file${orphanCount === 1 ? "" : "s"}?`}
                  description={`Frees ${formatBytes(scan.orphanBytes)} of storage. These files have no item behind them anymore; nothing in Ledgr links to them.`}
                  confirmLabel="Delete all"
                  trigger={<span>Delete all ({formatBytes(scan.orphanBytes)})</span>}
                  triggerClassName="rounded border border-red-900/60 bg-red-950/40 px-2.5 py-1 text-xs font-medium text-red-300 hover:bg-red-900/40"
                  onConfirm={purge}
                />
              </div>
              <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto">
                {(scan.orphans ?? []).map((o) => (
                  <li key={o.key} className="flex items-center gap-2 text-sm">
                    <span className="truncate text-ink-muted">{filenameOf(o.key)}</span>
                    <span className="ml-auto shrink-0 text-xs text-ink-faint">
                      {formatBytes(o.sizeBytes)}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
