import { NextResponse } from "next/server";
import { errorResponse, requireOwner } from "@/lib/api";
import { setTypeDefaultWidgets } from "@/lib/types";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ key: string }> };

// PATCH /api/types/[key]/widgets  { composition: Composition | null } — save a
// type's DEFAULT SECTIONS: Layer 2 of the composition model (ADR-111/PJ3), i.e.
// what every record of this type shows before an individual record diverges.
// A focused route like /statuses + /layout + /quick-capture, so the sections
// editor can't clobber a whole-definition builder edit.
//
// null clears the type default (records fall back to the built-in starting set
// for that type). setTypeDefaultWidgets validates the shape and rejects one it
// can't parse rather than silently storing nothing (ADR-181).
export async function PATCH(request: Request, context: Context) {
  const owner = await requireOwner();
  if (owner instanceof NextResponse) return owner;
  try {
    const { key } = await context.params;
    const body = (await request.json().catch(() => ({}))) as {
      composition?: unknown;
    };
    const def = await setTypeDefaultWidgets(key, body.composition ?? null);
    return NextResponse.json({ defaultWidgets: def.defaultWidgets });
  } catch (err) {
    if (err instanceof SyntaxError) {
      return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
    }
    return errorResponse(err);
  }
}
