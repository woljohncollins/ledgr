import { NextResponse } from "next/server";
import { verifyApiRequest } from "@/lib/auth/credentials";
import { listTypes } from "@/lib/types";

// GET /api/machine/types — the type registry for token clients (same door as
// /api/machine/items; ADR-066 posture). Exists because a machine client can't
// otherwise learn which types are "project-shaped": the widget-home capability
// (ADR-204's "Project-style page" checkbox) is the marker that a custom type
// like "Seminary Class" behaves as a project, and neither the session-only
// GET /api/types nor the MCP list_types tool is reachable with an `api`
// credential (and list_types omits capability anyway). Launchpad filters on
// capability === "widget-home" and then queries items with ?type=a,b,c.
// Types are instance-global, so no owner scoping — the credential is the gate.
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

export function OPTIONS() {
  return cors(new NextResponse(null, { status: 204 }));
}

export async function GET(request: Request) {
  const identity = await verifyApiRequest(request.headers.get("authorization"));
  if (!identity) {
    return cors(NextResponse.json({ error: "unauthorized" }, { status: 401 }));
  }
  const types = await listTypes();
  return cors(
    NextResponse.json({
      types: types.map((t) => ({
        key: t.key,
        label: t.label,
        icon: t.icon ?? null,
        isSystem: t.isSystem,
        statusMode: t.statusMode ?? null,
        capability: t.capability ?? null,
      })),
    })
  );
}
