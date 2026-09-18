// "Offer as a tool" endpoint (2026-08-17). A focused route like /toc and
// /cards: writes only this type's membership in the owner's settings.toolTypes,
// never the type definition. Body: { enabled: boolean }. Guarded: the type must
// exist and not already be covered by a built-in catalog tool (task, note,
// event, milestone, link, person, mindmap), which would render the card twice.
import { NextResponse } from "next/server";
import { errorResponse, requireOwner } from "@/lib/api";
import { getSettings, updateSettings } from "@/lib/settings";
import { getType } from "@/lib/types";
import { BUILTIN_TOOL_TYPE_KEYS } from "@/lib/widgets";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ key: string }> };

export async function PATCH(request: Request, context: Context) {
  const owner = await requireOwner();
  if (owner instanceof NextResponse) return owner;
  try {
    const { key } = await context.params;
    const body = (await request.json()) as { enabled?: unknown };
    const enabled = body.enabled === true;
    if (enabled) {
      await getType(key); // 404s via errorResponse if the type doesn't exist
      if (BUILTIN_TOOL_TYPE_KEYS.has(key)) {
        return NextResponse.json(
          { error: "this type already has a built-in tool" },
          { status: 400 }
        );
      }
    }
    const settings = await getSettings(owner.id);
    const toolTypes = settings.toolTypes.filter((k) => k !== key);
    if (enabled) toolTypes.push(key);
    await updateSettings(owner.id, { toolTypes });
    return NextResponse.json({ ok: true, enabled });
  } catch (err) {
    if (err instanceof SyntaxError) {
      return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
    }
    return errorResponse(err);
  }
}
