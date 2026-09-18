// OAuth 2.1 shim for the MCP server (ADR-117). Consumer Claude's custom
// connectors (claude.ai web + the mobile apps) are OAuth-only — there is no
// field for a static Bearer token or a custom header (Anthropics
// claude-ai-mcp#112, "not planned") — so to reach the Ledgr MCP from a phone we
// front /api/mcp with the smallest OAuth surface a connector needs:
// discovery (RFC 9728 / RFC 8414), Dynamic Client Registration (RFC 7591), an
// authorization-code + PKCE flow, and refresh.
//
// The design choice that keeps this off the shared schema (ADR-117 Decision 7):
// nothing is stored. Authorization codes, access tokens, refresh tokens, and
// even the registered client are all HMAC-signed, self-describing blobs,
// validated by signature + expiry — the same "the secret in env IS the
// credential, no DB row" model as the static machine tokens (ADR-004). This
// module is PURE node:crypto (no DB, no Next, no Clerk): no new dependency
// (Principle 5), and revocation is rotating LEDGR_OAUTH_SECRET (ADR-117
// Decision 8). The OAuth path is ADDITIVE — /api/mcp still accepts the static
// LEDGR_API_TOKENS Bearer, so Claude Code/Desktop and the HTTP-API callers are
// untouched.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { verifyMachineToken, type MachineIdentity } from "@/lib/auth/machine";

// The single scope the MCP server grants. Mirrors the static token's `mcp`
// scope so both credential paths authorize the same capability.
export const MCP_SCOPE = "mcp";

// Lifetimes. Codes are single-use-ish and short (the client redeems
// immediately); access tokens are an hour (the client refreshes); refresh
// tokens are long-lived (a connected phone shouldn't re-consent often). All are
// bounded by the signing secret: rotate it and every issued token dies at once.
const CODE_TTL_SECONDS = 60;
const ACCESS_TTL_SECONDS = 60 * 60; // 1h
const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 90; // 90d

// Token "kinds" carried in the `t` claim so a code can never be replayed as an
// access token (or vice versa): verifyToken pins the expected kind.
type TokenKind = "code" | "access" | "refresh" | "client";

type BasePayload = {
  t: TokenKind;
  iat: number;
  exp: number;
};

export type ClientPayload = BasePayload & {
  t: "client";
  redirect_uris: string[];
  // Display name from DCR metadata (RFC 7591 client_name), shown on the
  // consent page. Optional: client_ids minted before it existed verify fine.
  client_name?: string;
};

export type CodePayload = BasePayload & {
  t: "code";
  redirect_uri: string;
  code_challenge: string; // S256 challenge from the authorize request
  scope: string;
  sub: string; // owner email, captured at authorize time (audit only)
};

export type AccessPayload = BasePayload & {
  t: "access";
  scope: string;
  sub: string;
  // Optional caller label carried by browser-minted app tokens (ADR-179), e.g.
  // "overtone". Purely for identification — it names the caller in machine-route
  // logs so a token is traceable to the app it was issued for. It is NOT a
  // revocation handle (these tokens stay stateless; revocation is still
  // rotate-the-purpose-secret). Absent on every pre-ADR-179 token, which keeps
  // verifying unchanged.
  lbl?: string;
};

export type RefreshPayload = BasePayload & {
  t: "refresh";
  scope: string;
  sub: string;
};

// --- secret + configured-ness ------------------------------------------------

function secret(): string | undefined {
  return process.env.LEDGR_OAUTH_SECRET || undefined;
}

// Whether the OAuth shim is wired up. When false, the discovery routes 404 and
// the MCP 401 stays flat (no resource_metadata hint) — there's no point
// advertising a flow that can't issue tokens. The /health and AI & MCP surfaces
// can use this the same way hasScopedToken reports the static path.
export function oauthConfigured(): boolean {
  return !!secret();
}

// --- compact signed tokens ---------------------------------------------------
// Format: base64url(JSON(payload)) "." base64url(HMAC-SHA256(payload, secret)).
// Not a full JWT (no alg-negotiation header) on purpose: one fixed algorithm,
// our own issuer and consumer, so there's no alg-confusion surface and no
// library. Comparable to the hand-rolled MCP protocol envelope (ADR-047).

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(body: string, key: string): string {
  return createHmac("sha256", key).update(body).digest("base64url");
}

// key defaults to the OAuth secret; the browser-minted-token path (below) passes
// a different per-purpose secret so those tokens have their own kill switch.
function signToken(payload: Record<string, unknown>, key = secret()): string {
  if (!key) throw new Error("signing secret not configured");
  const body = b64url(JSON.stringify(payload));
  return `${body}.${sign(body, key)}`;
}

// Verifies signature, kind, and expiry. Returns the payload or null — callers
// turn null into the right OAuth error and never explain which check failed
// (same discipline as verifyMachineToken).
function verifyToken<P extends BasePayload>(
  token: string | null | undefined,
  kind: TokenKind,
  key = secret()
): P | null {
  if (!key || !token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);
  const expectedSig = sign(body, key);
  // Constant-time compare; both are base64url of a 32-byte digest, equal length.
  const a = Buffer.from(providedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload: P;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as P;
  } catch {
    return null;
  }
  if (payload.t !== kind) return null;
  if (typeof payload.exp !== "number" || payload.exp < nowSeconds()) return null;
  return payload;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// --- client registration (stateless DCR, RFC 7591) ---------------------------
// The client_id IS a signed token carrying the registered redirect_uris, so
// there's no client store: /authorize and /token trust the signature, not a
// row. Single-user, so registration is permissive (any well-formed request
// succeeds); the signature is what binds the redirect_uri at authorize time.

export function issueClientId(redirectUris: string[], clientName?: string): string {
  const iat = nowSeconds();
  const payload: ClientPayload = {
    t: "client",
    iat,
    // Clients are effectively permanent; give a long horizon rather than no
    // exp so the same verify path (which requires exp) applies uniformly.
    exp: iat + REFRESH_TTL_SECONDS,
    redirect_uris: redirectUris,
    ...(clientName ? { client_name: clientName } : {}),
  };
  return signToken(payload);
}

export function verifyClientId(clientId: string | null | undefined): ClientPayload | null {
  return verifyToken<ClientPayload>(clientId, "client");
}

// --- authorization code ------------------------------------------------------

export function issueCode(args: {
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  sub: string;
}): string {
  const iat = nowSeconds();
  const payload: CodePayload = {
    t: "code",
    iat,
    exp: iat + CODE_TTL_SECONDS,
    redirect_uri: args.redirectUri,
    code_challenge: args.codeChallenge,
    scope: args.scope,
    sub: args.sub,
  };
  return signToken(payload);
}

export function verifyCode(code: string | null | undefined): CodePayload | null {
  return verifyToken<CodePayload>(code, "code");
}

// --- access + refresh tokens -------------------------------------------------

export function issueAccessToken(
  sub: string,
  scope: string,
  ttlSeconds = ACCESS_TTL_SECONDS,
  key = secret(),
  label?: string
): string {
  const iat = nowSeconds();
  const payload: AccessPayload = {
    t: "access",
    iat,
    exp: iat + ttlSeconds,
    scope,
    sub,
  };
  if (label) payload.lbl = label;
  return signToken(payload, key);
}

export function issueRefreshToken(sub: string, scope: string): string {
  const iat = nowSeconds();
  const payload: RefreshPayload = {
    t: "refresh",
    iat,
    exp: iat + REFRESH_TTL_SECONDS,
    scope,
    sub,
  };
  return signToken(payload);
}

export function verifyRefreshToken(token: string | null | undefined): RefreshPayload | null {
  return verifyToken<RefreshPayload>(token, "refresh");
}

// Verifies an OAuth access token from an incoming MCP request and checks it
// carries the required scope. Returns the payload or null. The MCP route tries
// this AFTER the static-token check, so the two credential paths coexist.
export function verifyAccessToken(
  authorizationHeader: string | null,
  requiredScope: string
): AccessPayload | null {
  if (!authorizationHeader?.startsWith("Bearer ")) return null;
  const token = authorizationHeader.slice("Bearer ".length).trim();
  const payload = verifyToken<AccessPayload>(token, "access");
  if (!payload) return null;
  if (!payload.scope.split(" ").includes(requiredScope)) return null;
  return payload;
}

export const ACCESS_TOKEN_TTL_SECONDS = ACCESS_TTL_SECONDS;

// --- browser-minted personal tokens (ADR-160) -------------------------------
// The AI & MCP page mints long-lived Bearer tokens in-browser instead of the
// make-token.mjs CLI + env edit + redeploy. Same signed-blob model as the OAuth
// flow (no DB, no new dependency), with two deliberately SEPARATE signing keys
// so the two purposes revoke independently:
//   - MCP token   → `access`/`mcp` signed with LEDGR_OAUTH_SECRET, so the
//     existing verifyAccessToken on /api/mcp accepts it with no route change.
//     Durable: revoking it means rotating LEDGR_OAUTH_SECRET, which also signs
//     out the phone/web OAuth connector — acceptable since MCP is rarely revoked.
//   - clipper token → `access`/`api` signed with LEDGR_CLIPPER_SECRET, its own
//     kill switch: rotate that to revoke every clipper token without touching
//     MCP or the phone connector.
// Minting is ADDITIVE — a new token never invalidates an old one (same secret
// signs both); only rotating a purpose's secret revokes, killing every token of
// that purpose at once. Long TTL because these are pasted into clients with no
// refresh path (Claude Code config, a bookmarklet); the secret, not the exp, is
// the real lifetime bound.
const MINTED_TTL_SECONDS = 60 * 60 * 24 * 365 * 10; // 10y

function clipperSecret(): string | undefined {
  return process.env.LEDGR_CLIPPER_SECRET || undefined;
}

// Whether the clipper minting/verification path is wired up (its secret is set),
// reported the same way oauthConfigured/hasScopedToken surface configured-ness.
export function clipperConfigured(): boolean {
  return !!clipperSecret();
}

export function signMcpToken(sub: string): string {
  return issueAccessToken(sub, MCP_SCOPE, MINTED_TTL_SECONDS);
}

export function signClipperToken(sub: string): string {
  const key = clipperSecret();
  if (!key) throw new Error("LEDGR_CLIPPER_SECRET not configured");
  return issueAccessToken(sub, "api", MINTED_TTL_SECONDS, key);
}

// Verifies a browser-minted clipper token: an `api`-scoped access token signed
// with the clipper secret. Null (→ the caller's 401) when the secret is unset,
// the signature/kind/expiry fail, or the `api` scope is absent.
export function verifyClipperToken(
  authorizationHeader: string | null
): AccessPayload | null {
  const key = clipperSecret();
  if (!key || !authorizationHeader?.startsWith("Bearer ")) return null;
  const token = authorizationHeader.slice("Bearer ".length).trim();
  const payload = verifyToken<AccessPayload>(token, "access", key);
  if (!payload) return null;
  if (!payload.scope.split(" ").includes("api")) return null;
  return payload;
}

// --- browser-minted app tokens (ADR-179) ------------------------------------
// The third purpose, for external apps that push data into Ledgr over the HTTP
// API (the first is Overtone). Same `access`/`api` shape as the clipper token,
// but signed with its OWN secret so an app is revocable without killing the
// clipper — the separation Brandon asked for between the two, extended to a
// third caller. Carries an optional label naming the app, so machine-route logs
// read "app:overtone" rather than an anonymous api caller.

function appSecret(): string | undefined {
  return process.env.LEDGR_APP_SECRET || undefined;
}

// Whether the app-token minting/verification path is wired up, reported the same
// way oauthConfigured/clipperConfigured/hasScopedToken surface configured-ness.
export function appConfigured(): boolean {
  return !!appSecret();
}

// Label rule mirrors make-token.mjs's name rule (lowercase, digits, hyphens) so
// a minted token's label and a CLI entry's name read the same in logs.
export function isValidTokenLabel(label: string): boolean {
  return /^[a-z0-9-]{1,32}$/.test(label);
}

export function signAppToken(sub: string, label: string): string {
  const key = appSecret();
  if (!key) throw new Error("LEDGR_APP_SECRET not configured");
  if (!isValidTokenLabel(label)) throw new Error("invalid token label");
  return issueAccessToken(sub, "api", MINTED_TTL_SECONDS, key, label);
}

// Verifies a browser-minted app token: an `api`-scoped access token signed with
// the app secret. Null (→ the caller's 401) when the secret is unset, the
// signature/kind/expiry fail, or the `api` scope is absent.
export function verifyAppToken(
  authorizationHeader: string | null
): AccessPayload | null {
  const key = appSecret();
  if (!key || !authorizationHeader?.startsWith("Bearer ")) return null;
  const token = authorizationHeader.slice("Bearer ".length).trim();
  const payload = verifyToken<AccessPayload>(token, "access", key);
  if (!payload) return null;
  if (!payload.scope.split(" ").includes("api")) return null;
  return payload;
}

// The `api`-scope credential check for the HTTP API + web-clipper routes: the
// static env token (Savor / CLI-minted, ADR-004) OR a browser-minted clipper
// token OR a browser-minted app token. Returns an identity-or-null with the same
// contract as verifyMachineToken, so the routes only swap which function they
// call. Each path is tried in turn and the first match wins; they can't collide,
// since a token only verifies under the one secret that signed it.
export function verifyApiToken(
  authorizationHeader: string | null
): MachineIdentity | null {
  const machine = verifyMachineToken(authorizationHeader, "api");
  if (machine) return machine;
  const clipper = verifyClipperToken(authorizationHeader);
  if (clipper) return { name: "clipper", scopes: clipper.scope.split(" ") };
  const app = verifyAppToken(authorizationHeader);
  if (app)
    return {
      name: app.lbl ? `app:${app.lbl}` : "app",
      scopes: app.scope.split(" "),
    };
  return null;
}

// --- PKCE (S256 only) --------------------------------------------------------
// RFC 7636: challenge = base64url(SHA256(verifier)). We require S256 (the
// metadata advertises only it), so `plain` is never accepted.

export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (!verifier || !challenge) return false;
  const computed = createHash("sha256").update(verifier).digest("base64url");
  const a = Buffer.from(computed);
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

// --- discovery metadata builders ---------------------------------------------
// Pure shapes; the routes wrap them with the request origin.

export function protectedResourceMetadata(origin: string) {
  return {
    resource: `${origin}/api/mcp`,
    authorization_servers: [origin],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ["header"],
  };
}

export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/api/oauth/authorize`,
    token_endpoint: `${origin}/api/oauth/token`,
    registration_endpoint: `${origin}/api/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [MCP_SCOPE],
  };
}

// The WWW-Authenticate value the MCP 401 carries so a connector can discover
// the flow (RFC 9728 §5.1). Only emitted when OAuth is configured.
export function wwwAuthenticate(origin: string): string {
  return `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`;
}

// Request origin (preview / prod / localhost) from the forwarded headers, the
// same resolution the AI & MCP page uses so the advertised endpoints always
// match the host the client reached us on — no env var needed.
export function originFromRequest(request: Request): string {
  const h = request.headers;
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  const proto =
    h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return host ? `${proto}://${host}` : (process.env.NEXT_PUBLIC_APP_URL ?? "");
}
