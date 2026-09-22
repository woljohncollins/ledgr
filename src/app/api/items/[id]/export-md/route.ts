// GET /api/items/[id]/export-md → the item as portable Ledgr Markdown (see
// src/lib/share-markdown.ts). ?download=1 returns the .md file itself.
// (The sibling /share route is the public read-only link issuer.)
import { NextResponse } from "next/server";
import { errorResponse, requireOwner } from "@/lib/api";
import { exportItemMarkdown } from "@/lib/share-markdown";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const owner = await requireOwner();
  if (owner instanceof NextResponse) return owner;
  const { id } = await ctx.params;
  try {
    const bundle = await exportItemMarkdown(owner.id, id);
    const url = new URL(req.url);
    if (url.searchParams.get("download") === "1") {
      return new Response(bundle.markdown, {
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": `attachment; filename="${bundle.filename.replace(/"/g, "")}"`,
        },
      });
    }
    return NextResponse.json(bundle);
  } catch (e) {
    return errorResponse(e);
  }
}
