import { NextResponse } from "next/server";
import { errorResponse, requireOwner } from "@/lib/api";
import { createPeer, listPeers } from "@/lib/sync/peers";

export const dynamic = "force-dynamic";

// Synced-devices management (plan decision 15), owner-authed — the owner
// manages devices from the hub's /build/updates page. Machine auth stays only
// on /api/machine/sync.

// GET /api/sync/peers — every registered device with liveness + cursor lag.
export async function GET() {
  const owner = await requireOwner();
  if (owner instanceof NextResponse) return owner;
  try {
    return NextResponse.json({ peers: await listPeers() });
  } catch (err) {
    return errorResponse(err);
  }
}

// POST /api/sync/peers {name} — mint a device + its token. The response is
// the only time the plaintext token exists outside the caller's clipboard.
export async function POST(request: Request) {
  const owner = await requireOwner();
  if (owner instanceof NextResponse) return owner;
  try {
    const body = (await request.json()) as { name?: unknown; pullOnly?: unknown };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    return NextResponse.json(
      await createPeer(name.slice(0, 80), { pullOnly: body.pullOnly === true })
    );
  } catch (err) {
    if (err instanceof SyntaxError) {
      return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
    }
    return errorResponse(err);
  }
}
