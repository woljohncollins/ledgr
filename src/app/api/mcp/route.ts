import { NextResponse } from "next/server";
import { verifyMintedCredential } from "@/lib/auth/credentials";
import { verifyMachineToken } from "@/lib/auth/machine";
import {
  MCP_SCOPE,
  oauthConfigured,
  originFromRequest,
  verifyAccessToken,
  wwwAuthenticate,
} from "@/lib/auth/oauth";
import {
  JSONRPC,
  classifyMessage,
  isSupportedProtocolVersion,
  rpcError,
} from "@/lib/mcp/protocol";
import { resolveMcpOwner } from "@/lib/mcp/owner";
import { handleMcpMessage } from "@/lib/mcp/server";
import { captureError, createLogger } from "@/lib/log";

// The MCP endpoint (ADR-047, PRD §5.5): a thin Streamable HTTP server letting
// Claude search/read/create/update items over a personal API token. Stateless
// (no Mcp-Session-Id) — every call re-authenticates and re-resolves the owner,
// so there's no per-connection state to keep. No Clerk on this path (proxy.ts
// public set); the machine token IS the credential, which also makes the spec's
// DNS-rebinding Origin check moot — a forged origin can't forge the bearer.
export const dynamic = "force-dynamic";

type WithId = { id?: string | number | null };

export async function POST(request: Request) {
  // Auth first, three credential paths, all granting the `mcp` scope: the
  // static machine token (ADR-004, used by Claude Code/Desktop + machine
  // callers), an OAuth access token (ADR-117, used by claude.ai web + the
  // mobile apps, which only speak OAuth), OR a minted credential from User
  // Settings (ADR-224, a key id + secret over Basic). A bad or unscoped
  // credential gets a flat 401; we never say which check failed. When the OAuth
  // shim is configured, the 401 carries a WWW-Authenticate hint (RFC 9728) so a
  // connector can discover the flow instead of just failing. The two stateless
  // checks run first, so the DB lookup only happens when neither matched.
  const authz = request.headers.get("authorization");
  const authorized =
    verifyMachineToken(authz, "mcp") ||
    verifyAccessToken(authz, MCP_SCOPE) ||
    (await verifyMintedCredential(authz, "mcp"));
  if (!authorized) {
    const headers: Record<string, string> = {};
    if (oauthConfigured()) {
      headers["WWW-Authenticate"] = wwwAuthenticate(originFromRequest(request));
    }
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers });
  }

  // The MCP-Protocol-Version header rides every post-initialize request. The
  // spec says reject an unsupported value with 400; stay lenient when it's
  // absent (the initialize call, or a client that omits it) since version
  // negotiation happens inside initialize.
  const version = request.headers.get("mcp-protocol-version");
  if (version && !isSupportedProtocolVersion(version)) {
    return NextResponse.json(
      { error: `unsupported MCP-Protocol-Version '${version}'` },
      { status: 400 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      rpcError(null, JSONRPC.PARSE_ERROR, "invalid JSON"),
      { status: 400 }
    );
  }

  // A notification or response expects no reply: 202 Accepted, empty body
  // (Streamable HTTP). notifications/initialized lands here.
  const kind = classifyMessage(body);
  if (kind === "notification" || kind === "response") {
    return new NextResponse(null, { status: 202 });
  }

  const id = (body as WithId).id ?? null;
  const log = createLogger("mcp");
  try {
    const ownerId = await resolveMcpOwner();
    if (!ownerId) {
      // Valid token, but no owner configured (LEDGR_MCP_OWNER_UPN /
      // ONEDRIVE_EXPORT_UPN unset, or no matching users row). Answer in-band
      // so the client sees the reason rather than a bare 500.
      log.warn("MCP owner unresolved (set LEDGR_MCP_OWNER_UPN, runbook §1f)");
      return NextResponse.json(
        rpcError(id, JSONRPC.INTERNAL_ERROR, "MCP owner not configured (runbook §1f)")
      );
    }
    const response = await handleMcpMessage(body, ownerId);
    return NextResponse.json(response);
  } catch (err) {
    await captureError("mcp", err, { correlationId: log.correlationId });
    return NextResponse.json(
      rpcError(id, JSONRPC.INTERNAL_ERROR, `internal error (correlationId ${log.correlationId})`)
    );
  }
}

// We offer no server-initiated SSE stream, so a GET on the endpoint is 405 (the
// client then uses POST only — all these tools need). DELETE would end a
// session; we keep none.
export function GET() {
  return new NextResponse("Method Not Allowed", { status: 405 });
}

export function DELETE() {
  return new NextResponse("Method Not Allowed", { status: 405 });
}
