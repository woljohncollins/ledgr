import { NextResponse } from "next/server";
import { asUuid, errorResponse } from "@/lib/api";
import { verifyApiRequest } from "@/lib/auth/credentials";
import { getItem } from "@/lib/items";
import { resolveSurfaces } from "@/lib/item-surfaces";
import { resolveMachineOwner } from "@/lib/machine/owner";
import { unknownParams } from "@/lib/machine/query";

// GET /api/machine/items/[id] — one item as JSON, with its body, its custom
// `properties`, and its resolved `surfaces` (ADR-262).
//
// The token half of GET /api/items/[id], and the read the machine API was
// missing: it could write a body but never read one, so moving content between
// items came down to whatever was holding the request retyping it. It reads the
// same row through the same getItem, and names its surfaces through the same
// resolveSurfaces (ADR-260), so a paper's Notes, Shape, Quote Bank, Outline and
// Draft arrive labelled instead of buried in an untyped properties blob — which
// matters here more than in the app, because `properties` is where a bespoke
// type's real content lives and a copy that misses it copies half the record.
//
// `body` is the stored `{ format, text }` object, exactly what PATCH
// /api/machine/items accepts, so a read result feeds back into a write with no
// reshaping. It is null on an item that has never had one.
//
// A missing or mistyped id answers with JSON, never the app's HTML shell: this
// path used to fall through to the Next.js page tree, and HTML behind a 200 is
// indistinguishable from success to any client that doesn't sniff content types.
export const dynamic = "force-dynamic";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

function cors(res: NextResponse): NextResponse {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
  return res;
}

function json(body: unknown, status = 200): NextResponse {
  return cors(NextResponse.json(body, { status }));
}

// This route reads one whole item, so there is nothing to filter and nothing to
// page. An empty accepted-set still means a stray `?includeBody=true` (a fair
// guess, carried over from the list route) gets told it was unnecessary rather
// than ignored.
const ITEM_PARAMS: ReadonlySet<string> = new Set<string>();

export function OPTIONS() {
  return cors(new NextResponse(null, { status: 204 }));
}

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  const identity = await verifyApiRequest(request.headers.get("authorization"));
  if (!identity) {
    return json({ error: "unauthorized" }, 401);
  }

  const ownerId = await resolveMachineOwner();
  if (!ownerId) {
    return json({ error: "owner not configured" }, 503);
  }

  try {
    const params = new URL(request.url).searchParams;
    const unknown = unknownParams(params, ITEM_PARAMS);
    if (unknown.length > 0) {
      return json(
        {
          error: `unknown query parameter${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. This route returns the whole item, body and properties included, and takes no parameters.`,
        },
        400
      );
    }

    const id = asUuid((await context.params).id, "id");
    const item = await getItem(ownerId, id);
    return json({ item, surfaces: await resolveSurfaces(item) });
  } catch (err) {
    // errorResponse maps ItemError("not_found") to a JSON 404 and captures
    // anything else with a correlation id (rule 9).
    return cors(await errorResponse(err));
  }
}
