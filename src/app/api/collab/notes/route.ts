// The shared collab-notes file, read and committed through GitHub (the medium
// both deploys share — see src/lib/github/client.ts). GET returns the current
// markdown + its blob sha; PUT commits new content (Save) or empty (Clear),
// passing the sha back so a stale write surfaces as 409 instead of clobbering a
// concurrent edit. Owner-guarded like every other route.
import { NextResponse } from "next/server";
import { errorResponse, requireOwner } from "@/lib/api";
import { hasGithubToken, readNotes, writeNotes, GithubError } from "@/lib/github/client";

export const dynamic = "force-dynamic";

export async function GET() {
  const owner = await requireOwner();
  if (owner instanceof NextResponse) return owner;
  // Notes are shared by COMMITTING them, so reading them without a token would
  // show a scratchpad nobody here can write to; keep the whole surface gated.
  if (!hasGithubToken()) return NextResponse.json({ configured: false, markdown: "", sha: null });
  try {
    const notes = await readNotes();
    return NextResponse.json({ configured: true, ...notes });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PUT(request: Request) {
  const owner = await requireOwner();
  if (owner instanceof NextResponse) return owner;
  if (!hasGithubToken()) {
    return NextResponse.json({ error: "GitHub not configured" }, { status: 503 });
  }
  let body: { markdown?: unknown; sha?: unknown };
  try {
    body = (await request.json()) as { markdown?: unknown; sha?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (typeof body.markdown !== "string") {
    return NextResponse.json({ error: "markdown must be a string" }, { status: 400 });
  }
  const priorSha = typeof body.sha === "string" ? body.sha : null;
  try {
    const result = await writeNotes(body.markdown, priorSha, owner.email);
    return NextResponse.json(result);
  } catch (err) {
    // GitHub returns 409 (Conflict) / 422 when the sha is stale; pass that
    // through so the client can tell the user to reload rather than clobber.
    if (err instanceof GithubError && (err.status === 409 || err.status === 422)) {
      return NextResponse.json({ error: "stale" }, { status: 409 });
    }
    return errorResponse(err);
  }
}
