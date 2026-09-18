// Per-type project-card elements endpoint (2026-08-17). A focused route like
// /toc and /list-tabs: it writes only this type's entry in the owner's
// settings.cardsByType, never the type definition. Body:
//   { config }       → save this type's card config { show: [...] }
//   { config: null } → reset to the default card (drop the override)
// Validated by parseProjectCardConfig; a malformed shape resets rather than
// wedging a save. Owner-guarded.
import { NextResponse } from "next/server";
import { errorResponse, requireOwner } from "@/lib/api";
import { getSettings, updateSettings } from "@/lib/settings";
import { parseProjectCardConfig } from "@/lib/project-card-config";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ key: string }> };

export async function PATCH(request: Request, context: Context) {
  const owner = await requireOwner();
  if (owner instanceof NextResponse) return owner;
  try {
    const { key } = await context.params;
    const body = (await request.json()) as { config?: unknown };
    const config = body.config == null ? null : parseProjectCardConfig(body.config);
    const settings = await getSettings(owner.id);
    const cardsByType = { ...settings.cardsByType };
    if (config) {
      cardsByType[key] = config;
    } else {
      delete cardsByType[key];
    }
    await updateSettings(owner.id, { cardsByType });
    return NextResponse.json({ ok: true, config: cardsByType[key] ?? null });
  } catch (err) {
    if (err instanceof SyntaxError) {
      return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
    }
    return errorResponse(err);
  }
}
