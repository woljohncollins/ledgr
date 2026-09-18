import { NextResponse } from "next/server";
import { asUuid, errorResponse, parseItemPayload, requireOwner } from "@/lib/api";
import { ItemError } from "@/lib/items";
import { promoteActionItem } from "@/lib/meetings/promote";

// Promote a meeting action item into a task (slice 24, PRD §5.1). User-authed,
// owner-scoped. The new task is related to the meeting and its people.
//
// The body is the ordinary create payload (POST /api/items), because the client
// is the ordinary task capture card — so a promoted line's due date, priority,
// recurrence, tags and links all survive the trip (Brandon, 2026-08-28). Only
// `blockRef` is extra, and `type` is forced to task.
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const owner = await requireOwner();
  if (owner instanceof NextResponse) return owner;
  try {
    const { id } = await params;
    const raw = (await request.json().catch(() => {
      throw new ItemError("bad_request", "request body must be JSON");
    })) as Record<string, unknown>;
    const { blockRef } = raw;
    if (blockRef !== undefined && typeof blockRef !== "string") {
      throw new ItemError("bad_request", "blockRef must be a string");
    }
    const input = parseItemPayload({ ...raw, type: "task" }, "create");
    if (typeof input.title !== "string") {
      throw new ItemError("bad_request", "title must be a string");
    }
    const relateTo = Array.isArray(raw.relateTo)
      ? raw.relateTo.map((entry) => {
          const e = (entry ?? {}) as Record<string, unknown>;
          return {
            targetId: asUuid(e.targetId, "relateTo targetId"),
            role:
              typeof e.role === "string" && e.role.trim() ? e.role.trim() : undefined,
          };
        })
      : undefined;
    const { task, relateErrors } = await promoteActionItem(
      owner.id,
      asUuid(id, "id"),
      input,
      { blockRef, relateTo }
    );
    // `item` for the capture card (which reads the create route's shape),
    // `task` kept for anything still calling this the old way.
    return NextResponse.json(
      relateErrors.length > 0
        ? { item: task, task, relateErrors }
        : { item: task, task },
      { status: 201 }
    );
  } catch (err) {
    return errorResponse(err);
  }
}
