import { NextResponse } from "next/server";
import { errorResponse, requireOwner } from "@/lib/api";
import {
  deletePeer,
  parseHoldMode,
  setPeerHold,
  setPeerPullOnly,
  setPeerRevoked,
} from "@/lib/sync/peers";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ deviceId: string }> };

// PATCH /api/sync/peers/[deviceId] {revoked?, pullOnly?, holdMode?, graceDays?}
// — revoke (the hub refuses the device's next sync) or restore, flip
// pull-only/full (guardrail 1's "arming sync safely" lever), and set the
// retention hold or its window (ADR-213). Any combination may be sent in one
// call; at least one is required. Owner-authed, like the collection route.
//
// The hold is NOT access control: it only decides whether this device's cursor
// keeps the hub's oplog alive. Conflating the two is what made "park it" and
// "let it come back" mutually exclusive in the first place.
export async function PATCH(request: Request, context: Context) {
  const owner = await requireOwner();
  if (owner instanceof NextResponse) return owner;
  try {
    const { deviceId } = await context.params;
    const body = (await request.json()) as {
      revoked?: unknown;
      pullOnly?: unknown;
      holdMode?: unknown;
      graceDays?: unknown;
    };
    let requested = false;
    let found = true;
    if (typeof body.revoked === "boolean") {
      requested = true;
      found = (await setPeerRevoked(deviceId, body.revoked)) && found;
    }
    if (typeof body.pullOnly === "boolean") {
      requested = true;
      found = (await setPeerPullOnly(deviceId, body.pullOnly)) && found;
    }
    // ADR-213: the retention hold, which is deliberately NOT an access
    // control — it only decides whether this device's cursor keeps the hub's
    // oplog alive.
    if (body.holdMode !== undefined) {
      if (body.holdMode !== "auto" && body.holdMode !== "warm" && body.holdMode !== "cold") {
        return NextResponse.json(
          { error: 'holdMode must be "auto", "warm" or "cold"' },
          { status: 400 }
        );
      }
      requested = true;
      found = (await setPeerHold(deviceId, { mode: parseHoldMode(body.holdMode) })) && found;
    }
    if (body.graceDays !== undefined) {
      const g = body.graceDays;
      const ok =
        g === null || (typeof g === "number" && Number.isFinite(g) && g >= 1 && g <= 3650);
      if (!ok) {
        return NextResponse.json(
          { error: "graceDays must be a number of days between 1 and 3650, or null for the default" },
          { status: 400 }
        );
      }
      requested = true;
      found =
        (await setPeerHold(deviceId, { graceDays: g === null ? null : Math.floor(g) })) && found;
    }
    if (!requested) {
      return NextResponse.json(
        { error: "revoked, pullOnly, holdMode or graceDays is required" },
        { status: 400 }
      );
    }
    if (!found) {
      return NextResponse.json({ error: "no such device" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof SyntaxError) {
      return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
    }
    return errorResponse(err);
  }
}

// DELETE /api/sync/peers/[deviceId] — only for revoked devices (deleteRefusal
// in peers.ts is the rule); a live device must be revoked first.
export async function DELETE(_request: Request, context: Context) {
  const owner = await requireOwner();
  if (owner instanceof NextResponse) return owner;
  try {
    const { deviceId } = await context.params;
    const result = await deletePeer(deviceId);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
