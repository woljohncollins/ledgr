// GET /api/command-index — the owner's dynamic command-palette entries (types,
// views, templates) in minimal form (ADR-063). The palette fetches this once on
// open; the static entries (pages, Build sections, settings) live client-side in
// command-index.ts and need no round-trip. Owner-scoped like every read.
import { NextResponse } from "next/server";
import { errorResponse, requireOwner } from "@/lib/api";
import { listTemplates } from "@/lib/templates";
import { listTypes } from "@/lib/types";
import { listViews } from "@/lib/views";

export const dynamic = "force-dynamic";

export async function GET() {
  const owner = await requireOwner();
  if (owner instanceof NextResponse) return owner;

  try {
    const [types, views, templates] = await Promise.all([
      listTypes(),
      listViews(owner.id),
      listTemplates(owner.id),
    ]);
    return NextResponse.json({
      types: types.map((t) => ({ key: t.key, label: t.label, icon: t.icon })),
      views: views.map((v) => ({ id: v.id, name: v.name })),
      templates: templates.map((t) => ({
        id: t.id,
        name: t.name,
        type: t.type,
        prototypeItemId: t.prototypeItemId,
      })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
