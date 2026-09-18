import { NextResponse } from "next/server";
import { asUuid, errorResponse, requireOwner } from "@/lib/api";
import { restoreChildDates, type ShiftedChild } from "@/lib/relative-subtask-service";

export const dynamic = "force-dynamic";

// POST /api/tasks/restore-dates — the undo half of date anchoring (ADR-253).
// Moving a task's plan date carries every unpinned dated descendant with it, so
// a single click can rewrite dates on items the owner never opened. `updateItem`
// hands back those rows AS THEY WERE, and this puts them back.
//
// Owner-scoped per row (restoreChildDates filters on owner_id), so a forged id
// writes nothing rather than reaching another owner's item. Dates arrive as ISO
// strings or null; anything else in the payload is ignored.
type Body = { rows?: unknown };

function parseRows(raw: unknown): ShiftedChild[] {
  if (!Array.isArray(raw)) return [];
  const out: ShiftedChild[] = [];
  for (const r of raw.slice(0, 500)) {
    if (typeof r !== "object" || r === null) continue;
    const o = r as Record<string, unknown>;
    if (typeof o.id !== "string") continue;
    out.push({
      id: asUuid(o.id, "id"),
      scheduledDate: typeof o.scheduledDate === "string" ? new Date(o.scheduledDate) : null,
      dueDate: typeof o.dueDate === "string" ? new Date(o.dueDate) : null,
    });
  }
  return out;
}

export async function POST(request: Request) {
  const owner = await requireOwner();
  if (owner instanceof NextResponse) return owner;
  try {
    const body = (await request.json()) as Body;
    const rows = parseRows(body.rows);
    if (rows.length === 0) return NextResponse.json({ restored: 0 });
    return NextResponse.json({ restored: await restoreChildDates(owner.id, rows) });
  } catch (err) {
    if (err instanceof SyntaxError) {
      return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
    }
    return errorResponse(err);
  }
}
