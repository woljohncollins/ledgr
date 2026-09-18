import { NextResponse } from "next/server";
import { errorResponse, requireOwner } from "@/lib/api";
import { setTypeListenEnabled, setTypeListenOpenInEdge } from "@/lib/types";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ key: string }> };

// POST /api/types/[key]/listen  { listenEnabled?: boolean, listenOpenInEdge?:
// boolean } — flip whether the type's items get a Listen (read-aloud) control,
// and/or whether Listen redirects to Microsoft Edge, from the Build → Types
// "Listen" column. Either field may be sent alone; whichever is present (a
// boolean, not undefined) is the one that's set. Nothing else about the type
// changes.
export async function POST(request: Request, context: Context) {
  const owner = await requireOwner();
  if (owner instanceof NextResponse) return owner;
  try {
    const { key } = await context.params;
    const body = (await request.json().catch(() => ({}))) as {
      listenEnabled?: unknown;
      listenOpenInEdge?: unknown;
    };
    const result: { listenEnabled?: boolean; listenOpenInEdge?: boolean } = {};
    if (typeof body.listenEnabled === "boolean") {
      await setTypeListenEnabled(key, body.listenEnabled);
      result.listenEnabled = body.listenEnabled;
    }
    if (typeof body.listenOpenInEdge === "boolean") {
      await setTypeListenOpenInEdge(key, body.listenOpenInEdge);
      result.listenOpenInEdge = body.listenOpenInEdge;
    }
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof SyntaxError) {
      return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
    }
    return errorResponse(err);
  }
}
