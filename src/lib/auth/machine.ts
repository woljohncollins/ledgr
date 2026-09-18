// Machine-to-machine auth (MCP, cron, webhooks): scoped API tokens, separate
// from Clerk (CLAUDE.md). Tokens live hashed in LEDGR_API_TOKENS, so a leaked
// env dump never yields a usable credential. No DB table: single user, a
// handful of tokens, revocation is an env edit + redeploy (runbook.md §3).
//
// LEDGR_API_TOKENS format, comma-separated entries of
//   name:scope1+scope2:sha256hex
// e.g. gh-actions-cron:cron:9f86d0…  Generate entries with
//   node scripts/make-token.mjs <name> <scope,scope,…>
import { createHash, timingSafeEqual } from "node:crypto";

export type MachineIdentity = {
  name: string;
  scopes: string[];
};

type TokenEntry = MachineIdentity & { hash: string };

function parseEntries(raw: string | undefined): TokenEntry[] {
  if (!raw) return [];
  const entries: TokenEntry[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const fields = trimmed.split(":");
    if (fields.length !== 3) {
      console.error(
        JSON.stringify({
          source: "machine-auth",
          message: "malformed LEDGR_API_TOKENS entry skipped",
          entry: trimmed.slice(0, 16),
        })
      );
      continue;
    }
    const [name, scopes, hash] = fields;
    entries.push({ name, scopes: scopes.split("+").filter(Boolean), hash });
  }
  return entries;
}

// Exported for the sync-peer device tokens (src/lib/sync/auth.ts), which
// reuse this exact hash + compare but store the hash in sync_peers rather
// than env (plan decision 15: revocation is a row flip, not a redeploy).
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Constant-time compare over hex digests; length is always 64 so the
// timingSafeEqual length precondition holds.
export function digestsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

// Verifies a Bearer token from an incoming machine request. Returns the
// token's identity when valid (and holding requiredScope, if given), else
// null. Callers turn null into a 401; they never explain which check failed.
export function verifyMachineToken(
  authorizationHeader: string | null,
  requiredScope?: string
): MachineIdentity | null {
  if (!authorizationHeader?.startsWith("Bearer ")) return null;
  const token = authorizationHeader.slice("Bearer ".length).trim();
  if (!token) return null;

  const digest = hashToken(token);
  for (const entry of parseEntries(process.env.LEDGR_API_TOKENS)) {
    if (!digestsMatch(digest, entry.hash)) continue;
    if (requiredScope && !entry.scopes.includes(requiredScope)) return null;
    return { name: entry.name, scopes: entry.scopes };
  }
  return null;
}

// Whether any configured token carries the given scope. Env-only (no token in
// hand), so it's a cheap "is this capability wired up" check — the /health MCP
// canary uses it (a `mcp`-scoped token must exist for the MCP server to be
// reachable), the same way the Graph/push checks report configured-ness.
export function hasScopedToken(scope: string): boolean {
  return parseEntries(process.env.LEDGR_API_TOKENS).some((e) =>
    e.scopes.includes(scope)
  );
}
