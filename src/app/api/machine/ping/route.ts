import { NextResponse } from "next/server";
import { verifyMachineRequest } from "@/lib/auth/credentials";

// Diagnostic machine route: proves a token authenticates and shows what it
// can do. Any valid token may ping; the response only echoes the caller's
// own identity. Real machine routes require a specific scope.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const identity = await verifyMachineRequest(request.headers.get("authorization"));
  if (!identity) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({
    ok: true,
    token: identity.name,
    scopes: identity.scopes,
    timestamp: new Date().toISOString(),
  });
}
