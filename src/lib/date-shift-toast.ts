// The undo toast for date anchoring (ADR-253). Moving a task's plan date carries
// every unpinned dated descendant with it, which is the point — but it is still a
// write to items the owner never opened, and the house rule (ADR-142) is that a
// one-way-feeling action says what it did and offers a way back.
//
// `updateItem` returns the descendants AS THEY WERE in an additive `datesShifted`
// field, which rides through the item PATCH response. Every client that moves a
// scheduled date passes its response JSON here; when nothing moved, this does
// nothing at all, so callers can hand it every response unconditionally.
import { showToast } from "@/components/ui/ActionToast";

type ShiftedRow = { id: string; scheduledDate: string | null; dueDate: string | null };

function rowsOf(json: unknown): ShiftedRow[] {
  const item = (json as { item?: { datesShifted?: unknown } } | null)?.item;
  const raw = item?.datesShifted;
  return Array.isArray(raw) ? (raw as ShiftedRow[]) : [];
}

// Raise "Moved N subtasks · Undo" if this response moved any. `onUndone` lets the
// caller re-sync whatever it renders (a router.refresh, or a subtree refetch for
// the client-state trees router.refresh can't reach).
export function reportDateShift(json: unknown, onUndone?: () => void) {
  const rows = rowsOf(json);
  if (rows.length === 0) return;
  showToast(
    `Moved ${rows.length} subtask${rows.length === 1 ? "" : "s"}`,
    () => {
      void fetch("/api/tasks/restore-dates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows }),
      })
        .then(() => onUndone?.())
        // A failed undo must not look like a success; the dates simply stay put
        // and the owner can move them back by hand.
        .catch(() => {});
    }
  );
}
