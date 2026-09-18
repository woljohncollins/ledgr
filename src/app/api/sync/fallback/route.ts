import { NextResponse } from "next/server";
import { errorResponse, requireOwner } from "@/lib/api";
import {
  hubFallback,
  readFallbackApproval,
  readSyncHubs,
  writeFallbackApproval,
} from "@/lib/sync/client";

export const dynamic = "force-dynamic";

// The owner's answer to the fallback prompt (ADR-210). The sync loop runs
// server-side and cannot ask anything, so it records a pending decision in
// its status and this route is where the answer arrives — the same shape as
// the held-push release.
//
// POST {url, promoteCadence?} approves PULLING from an emergency hub.
// DELETE clears the approval by hand (it also auto-clears the moment an
// automatic hub is fully caught up again, which is the normal ending).

export async function POST(request: Request) {
  const owner = await requireOwner();
  if (owner instanceof NextResponse) return owner;
  try {
    const body = (await request.json()) as { url?: unknown; promoteCadence?: unknown };
    const url = typeof body.url === "string" ? body.url.trim().replace(/\/$/, "") : "";
    if (!url) return NextResponse.json({ error: "hub URL is required" }, { status: 400 });

    const hubs = await readSyncHubs();
    const hub = hubs.find((h) => h.url === url);
    if (!hub) return NextResponse.json({ error: "no such hub" }, { status: 404 });
    // Approving an automatic hub is meaningless: it is already pulled from.
    // Refuse rather than store a no-op the owner would have to un-store.
    if (hubFallback(hub) === "automatic") {
      return NextResponse.json(
        { error: "that hub is already automatic — this instance pulls from it anyway" },
        { status: 400 }
      );
    }
    await writeFallbackApproval({
      url,
      // Brandon chose "ask each time" for cadence: approving permits pulling,
      // and only promotes the schedule if the owner says so here. Either way
      // it reverts when the approval clears, since promotion lives on the
      // approval and never on the hub's configured cadence.
      promoteCadence: body.promoteCadence === true,
      approvedAt: new Date().toISOString(),
    });
    return NextResponse.json({ approval: await readFallbackApproval(hubs.map((h) => h.url)) });
  } catch (err) {
    if (err instanceof SyntaxError) {
      return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
    }
    return errorResponse(err);
  }
}

export async function DELETE() {
  const owner = await requireOwner();
  if (owner instanceof NextResponse) return owner;
  try {
    await writeFallbackApproval(null);
    return NextResponse.json({ approval: null });
  } catch (err) {
    return errorResponse(err);
  }
}
