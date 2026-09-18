import { NextResponse } from "next/server";
import { resolveOwner } from "@/lib/owner";
import {
  MCP_SCOPE,
  issueCode,
  oauthConfigured,
  verifyClientId,
  type ClientPayload,
} from "@/lib/auth/oauth";

// The OAuth authorization endpoint (ADR-117 Decision 4). This is the ONE OAuth
// route that stays Clerk-protected (it is NOT in the proxy.ts public set): an
// unauthenticated request is bounced to sign-in by the middleware and returns
// here after login, so reaching either handler means the owner is signed in.
// The sign-in authenticates; consent is a separate, explicit step (ADR-117
// addendum, 2026-08-31): GET renders an approval page naming the client, and
// only the page's POST issues the short-lived PKCE-bound code and redirects.
// The old behavior (sign-in IS consent, instant silent redirect) read as
// "nothing happened" and gave the owner no moment to say no.
export const dynamic = "force-dynamic";

// OAuth errors redirect back to a *validated* redirect_uri with error params
// (so the client surfaces them); only an invalid/unregistered redirect_uri or
// client is shown inline, never bounced to an untrusted URL.
function redirectError(redirectUri: string, state: string | null, error: string, desc: string) {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", desc);
  if (state) url.searchParams.set("state", state);
  return NextResponse.redirect(url);
}

type AuthorizeParams = {
  clientId: string;
  client: ClientPayload;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
};

// Shared by GET (consent page) and POST (code issuance): both must run the
// full validation, because the POST's hidden fields are client-controlled.
function validateAuthorize(params: URLSearchParams): AuthorizeParams | NextResponse {
  const clientId = params.get("client_id");
  const redirectUri = params.get("redirect_uri");
  const responseType = params.get("response_type");
  const codeChallenge = params.get("code_challenge");
  const codeChallengeMethod = params.get("code_challenge_method");
  const state = params.get("state");
  const requestedScope = params.get("scope");

  // Validate the client + redirect_uri first: these errors can't safely
  // redirect, so they render inline.
  const client = verifyClientId(clientId);
  if (!client) {
    return NextResponse.json(
      { error: "invalid_client", error_description: "unknown or expired client_id" },
      { status: 400 }
    );
  }
  if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
    return NextResponse.json(
      { error: "invalid_request", error_description: "redirect_uri not registered for this client" },
      { status: 400 }
    );
  }

  // From here, errors redirect back to the (validated) redirect_uri.
  if (responseType !== "code") {
    return redirectError(redirectUri, state, "unsupported_response_type", "only response_type=code is supported");
  }
  if (!codeChallenge || codeChallengeMethod !== "S256") {
    return redirectError(redirectUri, state, "invalid_request", "PKCE with code_challenge_method=S256 is required");
  }
  // Only the mcp scope exists; reject anything else explicitly rather than
  // silently narrowing.
  if (requestedScope && !requestedScope.split(" ").every((s) => s === MCP_SCOPE)) {
    return redirectError(redirectUri, state, "invalid_scope", `only the '${MCP_SCOPE}' scope is available`);
  }

  return { clientId: clientId as string, client, redirectUri, codeChallenge, state };
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// The consent page. Standalone HTML (this is a route handler, not the app
// shell) with the validated request echoed as hidden fields; POST re-validates
// everything, so the page carries no trust. Two submit buttons share one form:
// action=authorize issues the code, action=deny returns access_denied to the
// client, which is the spec's way to say "the user said no".
function consentPage(p: AuthorizeParams): NextResponse {
  const name = p.client.client_name?.trim() || "An application";
  const host = new URL(p.redirectUri).host;
  const hidden = [
    ["client_id", p.clientId],
    ["redirect_uri", p.redirectUri],
    ["response_type", "code"],
    ["code_challenge", p.codeChallenge],
    ["code_challenge_method", "S256"],
    ["scope", MCP_SCOPE],
    ...(p.state ? [["state", p.state] as [string, string]] : []),
  ]
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("\n      ");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Authorize access · Ledgr</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: #0b0b0c; color: #ededed;
         font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .card { width: min(420px, calc(100vw - 32px)); background: #161618;
          border: 1px solid #2a2a2c; border-radius: 10px; padding: 28px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .app { font-weight: 600; }
  p { color: #9a9a9f; margin: 8px 0; }
  ul { color: #9a9a9f; margin: 12px 0; padding-left: 20px; }
  li { margin: 4px 0; }
  .host { color: #6e6e73; font-size: 13px; margin-top: 16px; }
  .buttons { display: flex; gap: 10px; justify-content: flex-end; margin-top: 24px; }
  button { font: inherit; border-radius: 8px; padding: 8px 18px; cursor: pointer; }
  .deny { background: transparent; color: #9a9a9f; border: 1px solid #2a2a2c; }
  .deny:hover { color: #ededed; border-color: #3a3a3c; }
  .allow { background: #ededed; color: #0b0b0c; border: 1px solid #ededed; font-weight: 600; }
  .allow:hover { background: #ffffff; }
</style>
</head>
<body>
  <main class="card">
    <h1><span class="app">${esc(name)}</span> wants to connect to your Ledgr</h1>
    <p>Authorizing gives it:</p>
    <ul>
      <li>Full access to your workspace through the MCP API</li>
      <li>Search, read, create, and update your items</li>
    </ul>
    <form method="post">
      ${hidden}
      <p class="host">After you choose, you'll be sent back to <strong>${esc(host)}</strong>.</p>
      <div class="buttons">
        <button class="deny" name="action" value="deny">Cancel</button>
        <button class="allow" name="action" value="authorize">Authorize</button>
      </div>
    </form>
  </main>
</body>
</html>`;

  return new NextResponse(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

// GET: validate the request and show the consent page. No code is issued here.
export async function GET(request: Request) {
  if (!oauthConfigured()) {
    return NextResponse.json({ error: "oauth not configured" }, { status: 404 });
  }

  const validated = validateAuthorize(new URL(request.url).searchParams);
  if (validated instanceof NextResponse) return validated;

  // Owner gate: middleware guarantees a Clerk session here, but a signed-in
  // non-owner (belt-and-suspenders) is denied before any page renders.
  const owner = await resolveOwner();
  if (!owner) {
    return redirectError(validated.redirectUri, validated.state, "access_denied", "not the owner of this Ledgr");
  }

  return consentPage(validated);
}

// POST: the consent form's answer. Re-validates everything (hidden fields are
// client-controlled), then issues the code or reports the denial. Clerk's
// SameSite session cookie doesn't ride a cross-site POST, so a forged form on
// another origin bounces at the middleware instead of consenting silently.
export async function POST(request: Request) {
  if (!oauthConfigured()) {
    return NextResponse.json({ error: "oauth not configured" }, { status: 404 });
  }

  const form = await request.formData();
  const params = new URLSearchParams();
  for (const [k, v] of form.entries()) {
    if (typeof v === "string") params.set(k, v);
  }

  const validated = validateAuthorize(params);
  if (validated instanceof NextResponse) return validated;

  const owner = await resolveOwner();
  if (!owner) {
    return redirectError(validated.redirectUri, validated.state, "access_denied", "not the owner of this Ledgr");
  }

  if (form.get("action") !== "authorize") {
    return redirectError(validated.redirectUri, validated.state, "access_denied", "the owner declined the request");
  }

  const code = issueCode({
    redirectUri: validated.redirectUri,
    codeChallenge: validated.codeChallenge,
    scope: MCP_SCOPE,
    sub: owner.email,
  });

  const dest = new URL(validated.redirectUri);
  dest.searchParams.set("code", code);
  if (validated.state) dest.searchParams.set("state", validated.state);
  // 303 so the browser follows the redirect with a GET, not a re-POST.
  return NextResponse.redirect(dest, 303);
}
