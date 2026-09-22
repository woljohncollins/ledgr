// POST /api/import/ledgr { text } → creates the item described by a Ledgr
// Markdown share file (front matter + body). Plain Markdown with no header
// imports as a note. Returns { item: { id, title, type, tags } }.
import { NextResponse } from "next/server";
import { errorResponse, requireOwner } from "@/lib/api";
import { importLedgrMarkdown } from "@/lib/share-markdown";

export const dynamic = "force-dynamic";

const MAX_CHARS = 2_000_000;

export async function POST(req: Request) {
  const owner = await requireOwner();
  if (owner instanceof NextResponse) return owner;
  let text: unknown;
  try {
    const ct = req.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      text = ((await req.json()) as { text?: unknown }).text;
    } else {
      text = await req.text();
    }
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  if (typeof text !== "string" || !text.trim()) {
    return NextResponse.json({ error: "text is required" }, { status: 400 });
  }
  if (text.length > MAX_CHARS) {
    return NextResponse.json({ error: "file too large" }, { status: 413 });
  }
  try {
    const item = await importLedgrMarkdown(owner.id, text);
    return NextResponse.json({ item });
  } catch (e) {
    return errorResponse(e);
  }
}
