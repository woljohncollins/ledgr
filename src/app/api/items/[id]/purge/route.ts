import { NextResponse } from "next/server";
import { asUuid, errorResponse, requireOwner } from "@/lib/api";
import { purgeAllTrash, purgeTrashedItem } from "@/lib/item-mutations";

export const dynamic = "force-dynamic";

// POST /api/items/[id]/purge — permanently delete an item that is already in
// the Trash (John, 2026-10-08: "make it possible to permanently delete the
// deleted notes"). Refuses live items. `id` = "all" empties the whole Trash.
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const owner = await requireOwner();
  if (owner instanceof NextResponse) return owner;

  try {
    const raw = (await context.params).id;
    if (raw === "all") return NextResponse.json(await purgeAllTrash(owner.id));
    const id = asUuid(raw, "id");
    return NextResponse.json(await purgeTrashedItem(owner.id, id));
  } catch (err) {
    return errorResponse(err);
  }
}
