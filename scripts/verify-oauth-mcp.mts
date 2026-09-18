// OAuth-shim verification (ADR-117). Pure — no DB, no Next. Covers the signed-
// token crypto (sign/verify round-trip, kind-pinning, expiry, tamper), PKCE
// S256, the client_id / code / access / refresh helpers, scope enforcement, the
// discovery metadata shapes, and the configured/unconfigured gate. The live
// HTTP flow (discovery → register → authorize → token → /api/mcp) is exercised
// separately against a running server; this guards the logic the routes lean
// on. Run: npx tsx scripts/verify-oauth-mcp.mts
import { createHash } from "node:crypto";

process.env.LEDGR_OAUTH_SECRET = "test-secret-do-not-use-in-prod";

const oauth = await import("../src/lib/auth/oauth");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

// --- configured gate ------------------------------------------------------
check("oauthConfigured true when secret set", oauth.oauthConfigured() === true);

// --- client_id (stateless DCR) -------------------------------------------
const redirectUris = ["https://claude.ai/api/mcp/auth_callback"];
const clientId = oauth.issueClientId(redirectUris);
const client = oauth.verifyClientId(clientId);
check("client_id verifies", client !== null);
check("client_id carries redirect_uris", JSON.stringify(client?.redirect_uris) === JSON.stringify(redirectUris));
check("tampered client_id rejected", oauth.verifyClientId(clientId.slice(0, -2) + "xy") === null);
const namedClientId = oauth.issueClientId(redirectUris, "Claude");
check("client_id carries client_name when given", oauth.verifyClientId(namedClientId)?.client_name === "Claude");
check("client_id without a name has none", oauth.verifyClientId(clientId)?.client_name === undefined);
check("garbage client_id rejected", oauth.verifyClientId("not-a-token") === null);
check("null client_id rejected", oauth.verifyClientId(null) === null);

// --- authorization code + PKCE -------------------------------------------
const verifier = "abc123def456ghi789jkl012mno345pqr678stu901vwx234"; // 48 chars
const challenge = createHash("sha256").update(verifier).digest("base64url");
check("PKCE S256 matches", oauth.verifyPkceS256(verifier, challenge) === true);
check("PKCE wrong verifier fails", oauth.verifyPkceS256("wrong", challenge) === false);
check("PKCE empty fails", oauth.verifyPkceS256("", challenge) === false);

const code = oauth.issueCode({
  redirectUri: redirectUris[0],
  codeChallenge: challenge,
  scope: oauth.MCP_SCOPE,
  sub: "owner@example.com",
});
const codePayload = oauth.verifyCode(code);
check("code verifies", codePayload !== null);
check("code carries redirect_uri", codePayload?.redirect_uri === redirectUris[0]);
check("code carries challenge", codePayload?.code_challenge === challenge);
check("code carries sub", codePayload?.sub === "owner@example.com");
check("code kind-pinned (not an access token)", oauth.verifyAccessToken(`Bearer ${code}`, oauth.MCP_SCOPE) === null);

// --- access token + scope -------------------------------------------------
const access = oauth.issueAccessToken("owner@example.com", oauth.MCP_SCOPE);
check("access token verifies with mcp scope", oauth.verifyAccessToken(`Bearer ${access}`, oauth.MCP_SCOPE) !== null);
check("access token rejected for other scope", oauth.verifyAccessToken(`Bearer ${access}`, "admin") === null);
check("access token needs Bearer prefix", oauth.verifyAccessToken(access, oauth.MCP_SCOPE) === null);
check("tampered access token rejected", oauth.verifyAccessToken(`Bearer ${access.slice(0, -2)}xy`, oauth.MCP_SCOPE) === null);
check("access token kind-pinned (not a code)", oauth.verifyCode(access) === null);

// --- refresh token --------------------------------------------------------
const refresh = oauth.issueRefreshToken("owner@example.com", oauth.MCP_SCOPE);
check("refresh token verifies", oauth.verifyRefreshToken(refresh) !== null);
check("access token is not a refresh token", oauth.verifyRefreshToken(access) === null);

// --- expiry ---------------------------------------------------------------
const realNow = Date.now;
Date.now = () => realNow() + 2 * 60 * 60 * 1000; // +2h, past the 1h access TTL
check("expired access token rejected", oauth.verifyAccessToken(`Bearer ${access}`, oauth.MCP_SCOPE) === null);
check("expired code rejected", oauth.verifyCode(code) === null);
Date.now = realNow;
check("token valid again once clock restored", oauth.verifyAccessToken(`Bearer ${access}`, oauth.MCP_SCOPE) !== null);

// --- cross-secret isolation (revocation = rotate the secret) --------------
process.env.LEDGR_OAUTH_SECRET = "a-different-secret";
check("token signed under the old secret is rejected after rotation", oauth.verifyAccessToken(`Bearer ${access}`, oauth.MCP_SCOPE) === null);
process.env.LEDGR_OAUTH_SECRET = "test-secret-do-not-use-in-prod";

// --- discovery metadata ---------------------------------------------------
const origin = "https://ledgr.example.com";
const prm = oauth.protectedResourceMetadata(origin);
check("PRM resource is the MCP endpoint", prm.resource === `${origin}/api/mcp`);
check("PRM authorization_servers points at origin", JSON.stringify(prm.authorization_servers) === JSON.stringify([origin]));
const asm = oauth.authorizationServerMetadata(origin);
check("ASM issuer is origin", asm.issuer === origin);
check("ASM authorize endpoint", asm.authorization_endpoint === `${origin}/api/oauth/authorize`);
check("ASM token endpoint", asm.token_endpoint === `${origin}/api/oauth/token`);
check("ASM register endpoint", asm.registration_endpoint === `${origin}/api/oauth/register`);
check("ASM requires S256 PKCE", JSON.stringify(asm.code_challenge_methods_supported) === JSON.stringify(["S256"]));
check("ASM is a public client (auth method none)", asm.token_endpoint_auth_methods_supported.includes("none"));
check("WWW-Authenticate points at the PRM", oauth.wwwAuthenticate(origin) === `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`);

// --- originFromRequest ----------------------------------------------------
const req = new Request("https://ignored.example/api/oauth/authorize", {
  headers: { "x-forwarded-host": "ledgr.example.com", "x-forwarded-proto": "https" },
});
check("originFromRequest uses forwarded headers", oauth.originFromRequest(req) === "https://ledgr.example.com");

// --- unconfigured gate ----------------------------------------------------
delete process.env.LEDGR_OAUTH_SECRET;
check("oauthConfigured false when secret unset", oauth.oauthConfigured() === false);
check("verify returns null when unconfigured", oauth.verifyAccessToken(`Bearer ${access}`, oauth.MCP_SCOPE) === null);

console.log("");
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
