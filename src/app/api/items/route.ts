import { NextResponse } from "next/server";
import { asUuid, errorResponse, parseItemPayload, requireOwner } from "@/lib/api";
import {
  listItems,
  type ItemStatus,
  type ListOptions,
} from "@/lib/items";
import { createItem } from "@/lib/item-mutations";
import { relateItems } from "@/lib/relations";
import { resolveMentions } from "@/lib/mentions";

export const dynamic = "force-dynamic";

// Cap on a single ?ids= batch resolve (matches the list window VIEW_LIMIT).
const MAX_RESOLVE_IDS = 200;

// GET /api/items — owner-scoped list, never includes body. Filters:
// ?type= &status= &parentId= &inbox= &q= &trash=true &limit= &offset=
// q is a title substring match (the @-mention picker); trash=true is the
// Trash view: deleted items only, newest deletion first.
export async function GET(request: Request) {
  const owner = await requireOwner();
  if (owner instanceof NextResponse) return owner;

  try {
    const params = new URL(request.url).searchParams;

    // ?ids=a,b,c — type-aware mention resolve (the editor's chip backfill). Owner
    // -scoped, body-free; returns { type, icon, statusCategory } per live id, so
    // a mention chip can show the right glyph and a task's open/done checkbox.
    const idsParam = params.get("ids");
    if (idsParam !== null) {
      const ids = idsParam
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, MAX_RESOLVE_IDS);
      const map = await resolveMentions(owner.id, ids);
      return NextResponse.json({ items: [...map.values()] });
    }

    const opts: ListOptions = {
      type: params.get("type") ?? undefined,
      parentId: params.get("parentId") ?? undefined,
      q: params.get("q") ?? undefined,
      trash: params.get("trash") === "true",
    };
    const inbox = params.get("inbox");
    if (inbox !== null) opts.inbox = inbox === "true";
    const status = params.get("status");
    if (status !== null) {
      // A status KEY, not the inherited default set (ADR-243): statuses are
      // user-defined per type, so gating this on ITEM_STATUSES made every custom
      // stage unfilterable. Shape-check only — an unknown key just matches
      // nothing, which is the honest answer for a filter.
      if (!/^[a-z][a-z0-9_]*$/.test(status) || status.length > 40) {
        return NextResponse.json(
          { error: "status must be a status key (a slug: letters, digits, _)" },
          { status: 400 }
        );
      }
      opts.status = status as ItemStatus;
    }
    const limit = params.get("limit");
    if (limit !== null) opts.limit = Number(limit) || undefined;
    const offset = params.get("offset");
    if (offset !== null) opts.offset = Number(offset) || undefined;

    return NextResponse.json({ items: await listItems(owner.id, opts) });
  } catch (err) {
    return errorResponse(err);
  }
}

// POST /api/items — create; body fields per parseItemPayload.
export async function POST(request: Request) {
  const owner = await requireOwner();
  if (owner instanceof NextResponse) return owner;

  try {
    const raw = (await request.json()) as Record<string, unknown>;
    const input = parseItemPayload(raw, "create");
    const item = await createItem(owner.id, input);
    // Atomic relate (ADR-202 addendum 5, additive — the ADR-183 carve-out):
    // optional `relateTo: [{ targetId, role? }]` writes the edges in the SAME
    // request as the create. The old client flow POSTed relations afterwards
    // and swallowed failures, so a task could exist without its project — and
    // the offline outbox replayed the bare create, dropping the association
    // entirely. Edge failures don't undo the create; they come back as
    // `relateErrors` so the client can say so.
    const relateErrors: string[] = [];
    if (Array.isArray(raw?.relateTo)) {
      for (const entry of raw.relateTo.slice(0, 20)) {
        const e = entry as Record<string, unknown>;
        try {
          const targetId = asUuid(e?.targetId, "relateTo targetId");
          const role =
            typeof e?.role === "string" && e.role.trim() ? e.role.trim() : undefined;
          await relateItems(owner.id, item.id, targetId, role);
        } catch (err) {
          relateErrors.push(err instanceof Error ? err.message : "relate failed");
        }
      }
    }
    return NextResponse.json(
      relateErrors.length > 0 ? { item, relateErrors } : { item },
      { status: 201 }
    );
  } catch (err) {
    if (err instanceof SyntaxError) {
      return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
    }
    return errorResponse(err);
  }
}
