// Minted API credentials (ADR-224): the DB-backed machine credential the owner
// creates in User Settings, in place of `node scripts/make-token.mjs` + an env
// edit + a redeploy per credential (and per revocation).
//
// The credential is two parts, the Planning Center / Stripe / AWS shape:
//   key id  — `lgrk_…`, PUBLIC, stored in plaintext. The lookup handle.
//   secret  — `lgrs_…`, hashed at rest, shown to the owner exactly once.
// Auth is HTTP Basic over the pair (`Basic base64(keyId:secret)`), with
// `Bearer <keyId>:<secret>` accepted for clients that only speak bearer.
//
// Hashing and comparison are machine.ts's — one hashing path across every
// machine credential — and the hash lives on a row rather than in env, which
// is the sync_peers arrangement (plan decision 15: revocation is a row flip,
// not a redeploy). It sits in its own module rather than inside machine.ts so
// machine.ts and oauth.ts stay pure node:crypto with no DB import; this is the
// same layering src/lib/sync/auth.ts already uses for device tokens.
//
// The env path is untouched and still tried FIRST by the resolvers at the
// bottom, so CRON_SECRET and every existing LEDGR_API_TOKENS entry keep
// working byte for byte.
import { randomBytes } from "node:crypto";
import { after } from "next/server";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { apiCredentials } from "@/db/schema";
import {
  digestsMatch,
  hashToken,
  verifyMachineToken,
  type MachineIdentity,
} from "@/lib/auth/machine";
import { verifyApiToken } from "@/lib/auth/oauth";

// --- the scope vocabulary ----------------------------------------------------
// The scopes a minted credential may carry, in plain language for the
// permission checkboxes. Same strings the env entries use, so a minted
// credential and a CLI entry authorize identically. `cron` is listed because a
// self-hosted peer runs its own scheduled jobs (ADR-214) and needs a
// credential without a redeploy; `diag` grants nothing but /api/machine/ping.

export type ScopeDef = {
  scope: string;
  label: string;
  detail: string;
};

export const API_SCOPES: ScopeDef[] = [
  {
    scope: "api",
    label: "Read and write your items",
    detail:
      "The HTTP API: list and read items, create and update them, link them together, upload files, and capture a URL into your Inbox.",
  },
  {
    scope: "mcp",
    label: "Act as an AI assistant",
    detail:
      "The MCP endpoint, so Claude or another MCP client can work with your data on your behalf.",
  },
  {
    scope: "cron",
    label: "Run scheduled jobs",
    detail:
      "Trigger calendar sync, email import, the OneDrive export, digests, and the Trash purge. For a scheduler, not an app.",
  },
  {
    scope: "diag",
    label: "Check that this credential works",
    detail:
      "Nothing but the ping endpoint, which echoes the credential's own name and permissions. Useful for a smoke test.",
  },
];

const KNOWN_SCOPES = new Set(API_SCOPES.map((s) => s.scope));

// --- shape rules -------------------------------------------------------------

const KEY_ID_PREFIX = "lgrk_";
const SECRET_PREFIX = "lgrs_";

// Caps. Not abuse defence at one user so much as a guard against a runaway
// client looping the create action: an unbounded table of live credentials is
// a security surface nobody is auditing.
export const MAX_ACTIVE_CREDENTIALS = 25;
export const MAX_CREATED_PER_HOUR = 10;

// Names are free-form (a person reads them in the list, unlike the env
// entries' log labels) but bounded and non-empty.
const MAX_NAME_LENGTH = 60;

export function isValidCredentialName(name: string): boolean {
  return name.trim().length > 0 && name.trim().length <= MAX_NAME_LENGTH;
}

// --- generation --------------------------------------------------------------
// Key ids are shown in the UI and in logs, so they are shorter; the secret
// carries the entropy (24 bytes, matching scripts/make-token.mjs).

function generateKeyId(): string {
  return `${KEY_ID_PREFIX}${randomBytes(12).toString("hex")}`;
}

function generateSecret(): string {
  return `${SECRET_PREFIX}${randomBytes(24).toString("hex")}`;
}

// --- reading -----------------------------------------------------------------

export type CredentialSummary = {
  id: string;
  name: string;
  keyId: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

/** Every credential this owner has minted, newest first, revoked ones kept
 * (the list is the record of what existed, not only of what still works). */
export async function listCredentials(ownerId: string): Promise<CredentialSummary[]> {
  const rows = await getDb()
    .select({
      id: apiCredentials.id,
      name: apiCredentials.name,
      keyId: apiCredentials.keyId,
      scopes: apiCredentials.scopes,
      createdAt: apiCredentials.createdAt,
      lastUsedAt: apiCredentials.lastUsedAt,
      revokedAt: apiCredentials.revokedAt,
    })
    .from(apiCredentials)
    .where(eq(apiCredentials.ownerId, ownerId))
    .orderBy(desc(apiCredentials.createdAt));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    keyId: r.keyId,
    scopes: r.scopes ?? [],
    createdAt: r.createdAt.toISOString(),
    lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
    revokedAt: r.revokedAt?.toISOString() ?? null,
  }));
}

/** Whether a live minted credential carries this scope. The DB-backed twin of
 * machine.ts's hasScopedToken — the "is this capability wired up" check the
 * /health MCP canary and the settings surfaces read, which would otherwise
 * report a minted-only instance as having no credential at all. */
export async function hasActiveCredential(scope: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: apiCredentials.id })
    .from(apiCredentials)
    .where(
      and(
        isNull(apiCredentials.revokedAt),
        sql`${apiCredentials.scopes} @> ${JSON.stringify([scope])}::jsonb`
      )
    )
    .limit(1);
  return rows.length > 0;
}

// --- creating ----------------------------------------------------------------

export type CreateResult =
  | { ok: true; keyId: string; secret: string; credential: CredentialSummary }
  | { ok: false; error: string };

/**
 * Mints a credential and returns the plaintext secret ONCE. The row keeps only
 * its sha256 hash, so this return value is the only copy that will ever exist
 * — the caller shows it and drops it.
 *
 * Scopes are validated against API_SCOPES here, not just in the form: a server
 * action is a public entry point, and a credential must not be able to name a
 * permission the UI never offered.
 */
export async function createCredential(
  ownerId: string,
  name: string,
  scopes: string[]
): Promise<CreateResult> {
  const trimmed = name.trim();
  if (!isValidCredentialName(trimmed)) {
    return { ok: false, error: `Give it a name, up to ${MAX_NAME_LENGTH} characters.` };
  }
  const asked = [...new Set(scopes)];
  const requested = asked.filter((s) => KNOWN_SCOPES.has(s));
  if (requested.length !== asked.length) {
    return { ok: false, error: "That is not a permission this app grants." };
  }
  if (requested.length === 0) {
    return { ok: false, error: "Tick at least one permission." };
  }

  const db = getDb();
  const active = await db
    .select({ id: apiCredentials.id })
    .from(apiCredentials)
    .where(and(eq(apiCredentials.ownerId, ownerId), isNull(apiCredentials.revokedAt)));
  if (active.length >= MAX_ACTIVE_CREDENTIALS) {
    return {
      ok: false,
      error: `You already have ${MAX_ACTIVE_CREDENTIALS} active credentials. Revoke one you no longer use first.`,
    };
  }
  // Rate limit by counting what this owner minted in the last hour. Counted in
  // the DB rather than in process memory on purpose: serverless instances come
  // and go, so an in-memory counter would reset on every cold start.
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const recent = await db
    .select({ id: apiCredentials.id })
    .from(apiCredentials)
    .where(
      and(eq(apiCredentials.ownerId, ownerId), gt(apiCredentials.createdAt, hourAgo))
    );
  if (recent.length >= MAX_CREATED_PER_HOUR) {
    return {
      ok: false,
      error: "Too many credentials created in the last hour. Try again later.",
    };
  }

  const keyId = generateKeyId();
  const secret = generateSecret();
  const rows = await db
    .insert(apiCredentials)
    .values({
      ownerId,
      name: trimmed,
      keyId,
      secretHash: hashToken(secret),
      scopes: requested,
    })
    .returning({ id: apiCredentials.id, createdAt: apiCredentials.createdAt });
  const row = rows[0];
  return {
    ok: true,
    keyId,
    secret,
    credential: {
      id: row.id,
      name: trimmed,
      keyId,
      scopes: requested,
      createdAt: row.createdAt.toISOString(),
      lastUsedAt: null,
      revokedAt: null,
    },
  };
}

// --- revoking ----------------------------------------------------------------

/** Stamps revoked_at. Takes effect on the next request: verification reads the
 * row every time and nothing about it is cached. Returns false when the id is
 * not this owner's (the owner filter is the authorization check). */
export async function revokeCredential(ownerId: string, id: string): Promise<boolean> {
  const rows = await getDb()
    .update(apiCredentials)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(apiCredentials.id, id),
        eq(apiCredentials.ownerId, ownerId),
        isNull(apiCredentials.revokedAt)
      )
    )
    .returning({ id: apiCredentials.id });
  return rows.length > 0;
}

// --- verifying ---------------------------------------------------------------

type Pair = { keyId: string; secret: string };

// Splits `keyId:secret` on the FIRST colon, so a secret containing one is
// still handled. Requires the key-id prefix, which is what keeps this path
// from ever mistaking an existing opaque Bearer token (no colon, no prefix)
// for a credential pair.
function splitPair(raw: string): Pair | null {
  const colon = raw.indexOf(":");
  if (colon <= 0) return null;
  const keyId = raw.slice(0, colon);
  const secret = raw.slice(colon + 1);
  if (!keyId.startsWith(KEY_ID_PREFIX) || !secret) return null;
  return { keyId, secret };
}

/** Pulls the pair out of an Authorization header. Basic is the documented
 * path; Bearer `keyId:secret` is accepted for clients that only do bearer. */
export function parseCredentialHeader(header: string | null): Pair | null {
  if (!header) return null;
  if (header.startsWith("Basic ")) {
    const encoded = header.slice("Basic ".length).trim();
    if (!encoded) return null;
    let decoded: string;
    try {
      decoded = Buffer.from(encoded, "base64").toString("utf8");
    } catch {
      return null;
    }
    return splitPair(decoded);
  }
  if (header.startsWith("Bearer ")) {
    return splitPair(header.slice("Bearer ".length).trim());
  }
  return null;
}

// How stale last_used_at may get before a successful auth writes it again. A
// credential polled every few seconds shouldn't cost an UPDATE per request
// (Principle 8); a minute's resolution is plenty for "is this still in use?".
const TOUCH_INTERVAL_MS = 60_000;

// Advances last_used_at without the request waiting on it. `after()` is the
// right primitive (the write runs once the response is out, and the platform
// keeps the instance alive for it); outside a request scope it throws, so the
// fallback is a plain detached promise. Either way a failure here is swallowed
// — a missed usage stamp must never turn a valid credential into a 401.
function touchLastUsed(id: string, lastUsedAt: Date | null): void {
  if (lastUsedAt && Date.now() - lastUsedAt.getTime() < TOUCH_INTERVAL_MS) return;
  const write = async () => {
    try {
      await getDb()
        .update(apiCredentials)
        .set({ lastUsedAt: new Date() })
        .where(eq(apiCredentials.id, id));
    } catch {
      // Cosmetic field; never surfaced as an auth failure.
    }
  };
  try {
    after(write);
  } catch {
    void write();
  }
}

/**
 * Verifies a minted credential from an incoming machine request: one indexed
 * lookup by key id, then one constant-time compare of the secret hash (versus
 * the env path, which has to walk every entry). Returns the credential's
 * identity when valid and holding requiredScope, else null — callers turn null
 * into a 401 and never explain which check failed.
 */
export async function verifyMintedCredential(
  authorizationHeader: string | null,
  requiredScope?: string
): Promise<MachineIdentity | null> {
  const pair = parseCredentialHeader(authorizationHeader);
  if (!pair) return null;

  const rows = await getDb()
    .select({
      id: apiCredentials.id,
      name: apiCredentials.name,
      secretHash: apiCredentials.secretHash,
      scopes: apiCredentials.scopes,
      lastUsedAt: apiCredentials.lastUsedAt,
      revokedAt: apiCredentials.revokedAt,
    })
    .from(apiCredentials)
    .where(eq(apiCredentials.keyId, pair.keyId))
    .limit(1);
  const row = rows[0];
  if (!row || row.revokedAt) return null;
  if (!digestsMatch(hashToken(pair.secret), row.secretHash)) return null;
  const scopes = row.scopes ?? [];
  if (requiredScope && !scopes.includes(requiredScope)) return null;

  touchLastUsed(row.id, row.lastUsedAt);
  return { name: row.name, scopes };
}

// --- the resolvers routes call ----------------------------------------------
// Two async entry points that try every credential path in turn. The env path
// goes FIRST and is unchanged, so an existing caller's request resolves
// exactly as it did before this module existed; the DB lookup only happens
// when no env token matched, which is also the only case that costs a query.

/**
 * The general machine-credential check: a static env token (ADR-004) OR a
 * minted credential. Same contract as verifyMachineToken, so a route only
 * swaps which function it awaits.
 */
export async function verifyMachineRequest(
  authorizationHeader: string | null,
  requiredScope?: string
): Promise<MachineIdentity | null> {
  return (
    verifyMachineToken(authorizationHeader, requiredScope) ??
    (await verifyMintedCredential(authorizationHeader, requiredScope))
  );
}

/**
 * The `api`-scope check for the HTTP API + web-clipper routes: everything
 * verifyApiToken already accepts (static env, clipper, app token) OR a minted
 * credential carrying `api`. Same contract as verifyApiToken.
 */
export async function verifyApiRequest(
  authorizationHeader: string | null
): Promise<MachineIdentity | null> {
  return (
    verifyApiToken(authorizationHeader) ??
    (await verifyMintedCredential(authorizationHeader, "api"))
  );
}
