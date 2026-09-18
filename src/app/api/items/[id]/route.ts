import { NextResponse } from "next/server";
import {
  asUuid,
  errorResponse,
  parseItemPayload,
  requireOwner,
} from "@/lib/api";
import { getItem } from "@/lib/items";
import { resolveSurfaces } from "@/lib/item-surfaces";
import { softDeleteItem, updateItem } from "@/lib/item-mutations";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

// GET /api/items/[id] — the one place a body is read.
//
// Also returns `surfaces` (ADR-260): the named places this type's content lives,
// each with what belongs there and what is stored in it. A paper returns Notes,
// Shape, Quote Bank, Outline and Draft; a song returns Notes and Chart; an
// ordinary type returns its single body surface. The DATA was always here — the
// item carries `properties` wholesale — but nothing named it, so a caller had an
// untyped blob and no way to tell a paper's draft from its scratch notes. Same
// resolver MCP's get_item uses, so the two can't drift.
export async function GET(_request: Request, context: Context) {
  const owner = await requireOwner();
  if (owner instanceof NextResponse) return owner;

  try {
    const id = asUuid((await context.params).id, "id");
    const item = await getItem(owner.id, id);
    return NextResponse.json({ item, surfaces: await resolveSurfaces(item) });
  } catch (err) {
    return errorResponse(err);
  }
}

// PATCH /api/items/[id] — partial update; a body change snapshots a revision
// (debounced) and refreshes body_text for search.
export async function PATCH(request: Request, context: Context) {
  const owner = await requireOwner();
  if (owner instanceof NextResponse) return owner;

  try {
    const id = asUuid((await context.params).id, "id");
    const patch = parseItemPayload(await request.json(), "patch");
    return NextResponse.json({ item: await updateItem(owner.id, id, patch) });
  } catch (err) {
    if (err instanceof SyntaxError) {
      return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
    }
    return errorResponse(err);
  }
}

// DELETE /api/items/[id] — soft delete to Trash; cascades to live children.
export async function DELETE(_request: Request, context: Context) {
  const owner = await requireOwner();
  if (owner instanceof NextResponse) return owner;

  try {
    const id = asUuid((await context.params).id, "id");
    return NextResponse.json(await softDeleteItem(owner.id, id));
  } catch (err) {
    return errorResponse(err);
  }
}
