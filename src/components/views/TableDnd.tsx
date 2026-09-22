// Hand-ordered table rows (2026-09-22, John: "move [projects] in order of how
// they show up by drag and drop"). A table view whose effective sort is a NUMERIC
// custom property ascending renders its body through this client component: rows
// are draggable, a drop above/below another row rewrites the sort property as the
// midpoint of its new neighbours (renumbering the lot when the gap is gone), and
// the server's own sort then keeps the order. The cells themselves are prebuilt
// server nodes — this component owns only the <tr> and the drag gestures.
"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

export type TableDndRow = {
  id: string;
  order: number | null;
  cells: ReactNode;
};

export default function TableDnd({ rows, orderKey }: { rows: TableDndRow[]; orderKey: string }) {
  const router = useRouter();
  const [local, setLocal] = useState<{ src: TableDndRow[]; ids: string[] } | null>(null);
  const [hint, setHint] = useState<{ id: string; side: "above" | "below" } | null>(null);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ids = local && local.src === rows ? local.ids : rows.map((r) => r.id);
  const ordered = ids.map((id) => byId.get(id)).filter((r): r is TableDndRow => !!r);

  const patch = (id: string, value: number) =>
    fetch(`/api/items/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ propertyPatch: { [orderKey]: value } }),
    });

  const moveTo = (dragId: string, index: number) => {
    const next = ids.filter((x) => x !== dragId);
    const at = Math.max(0, Math.min(index, next.length));
    next.splice(at, 0, dragId);
    if (next.join() === ids.join()) return;
    setLocal({ src: rows, ids: next });
    const prev = byId.get(next[at - 1] ?? "")?.order ?? null;
    const after = byId.get(next[at + 1] ?? "")?.order ?? null;
    let writes: Promise<Response>[];
    if (at === 0 && after != null) writes = [patch(dragId, after - 1000)];
    else if (at === next.length - 1 && prev != null) writes = [patch(dragId, prev + 1000)];
    else if (prev != null && after != null && after - prev > 1e-6) writes = [patch(dragId, (prev + after) / 2)];
    else writes = next.map((id, i) => patch(id, (i + 1) * 1000));
    Promise.all(writes)
      .then(() => router.refresh())
      .catch(() => {});
  };

  const sideOf = (e: React.DragEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientY < r.top + r.height / 2 ? "above" : "below";
  };

  return (
    <tbody
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }}
      onDrop={(e) => {
        // A drop on the body but not on a row (below the last row) → append.
        e.preventDefault();
        setHint(null);
        const dragId = e.dataTransfer.getData("text/plain");
        if (!dragId || !byId.has(dragId)) return;
        moveTo(dragId, ids.length);
      }}
      onDragLeave={() => setHint(null)}
    >
      {ordered.map((row) => {
        const side = hint?.id === row.id ? hint.side : null;
        return (
          <tr
            key={row.id}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData("text/plain", row.id);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
              e.dataTransfer.dropEffect = "move";
              const s = sideOf(e);
              if (!hint || hint.id !== row.id || hint.side !== s) setHint({ id: row.id, side: s });
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setHint(null);
              const dragId = e.dataTransfer.getData("text/plain");
              if (!dragId || !byId.has(dragId) || dragId === row.id) return;
              const before = sideOf(e) === "above";
              const idx = ids.filter((x) => x !== dragId).indexOf(row.id);
              moveTo(dragId, before ? idx : idx + 1);
            }}
            className={`group cursor-grab border-b border-neutral-900 hover:bg-neutral-800/40 active:cursor-grabbing ${
              side === "above"
                ? "shadow-[inset_0_2px_0_0_var(--color-accent,#3b82f6)]"
                : side === "below"
                  ? "shadow-[inset_0_-2px_0_0_var(--color-accent,#3b82f6)]"
                  : ""
            }`}
          >
            {row.cells}
          </tr>
        );
      })}
    </tbody>
  );
}
