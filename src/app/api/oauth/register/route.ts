import { NextResponse } from "next/server";
import { issueClientId, oauthConfigured } from "@/lib/auth/oauth";

// Dynamic Client Registration (RFC 7591), stateless (ADR-117 Decision 3). A
// connector POSTs its metadata (chiefly redirect_uris); we return a client_id
// that is itself a signed token carrying those redirect_uris, so there's no
// client store — /authorize and /token trust the signature, not a row. Public:
// registration happens before any credential exists. Single-user, so this is
// permissive (any well-formed request succeeds); the real gate is that
// /authorize requires the owner's Clerk session.
export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version",
};

function isValidRedirectUri(value: unknown): value is string {
  if (typeof value !== "string") return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  // https everywhere, except http on loopback for local clients.
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
}

export async function POST(request: Request) {
  if (!oauthConfigured()) {
    return NextResponse.json({ error: "oauth not configured" }, { status: 404, headers: CORS });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: "invalid_client_metadata", error_description: "invalid JSON" },
      { status: 400, headers: CORS }
    );
  }

  const raw = body.redirect_uris;
  const redirectUris = Array.isArray(raw) ? raw : [];
  if (redirectUris.length === 0 || !redirectUris.every(isValidRedirectUri)) {
    return NextResponse.json(
      {
        error: "invalid_redirect_uri",
        error_description: "redirect_uris must be a non-empty array of https (or loopback http) URLs",
      },
      { status: 400, headers: CORS }
    );
  }

  // client_name (RFC 7591) is display-only metadata for the consent page;
  // absent or junk just means the page falls back to the redirect host.
  const clientName =
    typeof body.client_name === "string" ? body.client_name.trim().slice(0, 64) : "";

  const clientId = issueClientId(redirectUris as string[], clientName || undefined);
  // RFC 7591 registration response. Public client (PKCE), so no secret.
  return NextResponse.json(
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      ...(clientName ? { client_name: clientName } : {}),
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    { status: 201, headers: CORS }
  );
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
