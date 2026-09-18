import { NextResponse } from "next/server";
import { asUuid } from "@/lib/api";
import { verifyApiRequest } from "@/lib/auth/credentials";
import { ItemError } from "@/lib/items";
import { relateItems } from "@/lib/relations";
import { resolveMachineOwner } from "@/lib/machine/owner";
import { captureError } from "@/lib/log";

// POST /api/machine/relations — batch-create relation edges with an `api`-scoped
// machine token (ADR-112). Mirrors POST /api/machine/items: a bare edge or
// { relations: [...] }, each edge { sourceId, targetId, role? }. A bad edge is
// reported in `errors` and skipped, never failing the rest. Idempotent via the
// unique (source_id, target_id, role) constraint (relateItems onConflictDoUpdate).
// Both endpoints exist so the migration can wire tags/attendees/threading/sub-pages
// that POST /api/machine/items can't carry.
export const dynamic = "force-dynamic";

const MAX_BATCH = 100;

// CORS is open for the same reason /api/machine/capture's is (see the comment
// there): the token IS the credential, no cookies to protect. A browser client
// (Launchpad's task tile) posts a tag/project edge right after creating a task.
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
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

export function OPTIONS() {
  return cors(new NextResponse(null, { status: 204 }));
}

export async function POST(request: Request) {
  const identity = await verifyApiRequest(request.headers.get("authorization"));
  if (!identity) {
    return json({ error: "unauthorized" }, 401);
  }

  const ownerId = await resolveMachineOwner();
  if (!ownerId) {
    return json({ error: "owner not configured" }, 503);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  const batch = (body as { relations?: unknown })?.relations;
  const rawEdges = Array.isArray(batch) ? batch : [body];
  if (rawEdges.length === 0) {
    return json({ count: 0, created: [], errors: [] });
  }
  if (rawEdges.length > MAX_BATCH) {
    return json({ error: `too many edges (max ${MAX_BATCH} per request)` }, 400);
  }

  const created: unknown[] = [];
  const errors: { index: number; error: string }[] = [];
  for (let i = 0; i < rawEdges.length; i++) {
    try {
      const e = rawEdges[i] as Record<string, unknown>;
      const sourceId = asUuid(e.sourceId ?? e.source, "sourceId");
      const targetId = asUuid(e.targetId ?? e.target, "targetId");
      const role =
        typeof e.role === "string" && e.role.trim() ? e.role.trim() : "related";
      created.push(await relateItems(ownerId, sourceId, targetId, role));
    } catch (err) {
      if (err instanceof ItemError) {
        errors.push({ index: i, error: err.message });
      } else {
        const correlationId = crypto.randomUUID();
        await captureError("machine-relations", err, { correlationId, detail: { index: i } });
        errors.push({ index: i, error: `internal error (correlationId ${correlationId})` });
      }
    }
  }

  return json({ count: created.length, created, errors }, created.length > 0 ? 201 : 400);
}
