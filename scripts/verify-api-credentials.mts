// ADR-224 verification: the minted API-credential system, exercised against the
// live dev DB through the real lib (no HTTP, no mocks), cleaning up after
// itself. DB-backed, so it stays a local/manual step (verify-ci.mjs skips it).
//   npx tsx scripts/verify-api-credentials.mts
//
// What it pins down, in order: the credential shape and that only a hash is
// stored; Basic and Bearer both authenticate; a wrong secret, an unheld scope,
// a bad key id and a revoked row all fail closed; last_used_at advances; the
// env path still resolves through the new async resolver; and the active cap
// refuses rather than silently allowing an unbounded set.
import { readFileSync } from "node:fs";

// Minimal .env.local loader (DATABASE_URL only); no dotenv dependency.
for (const line of readFileSync(".env.local", "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) {
    process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

const { createHash } = await import("node:crypto");
const { eq, inArray } = await import("drizzle-orm");
const { getDb } = await import("../src/db");
const { apiCredentials, users } = await import("../src/db/schema");
const {
  MAX_ACTIVE_CREDENTIALS,
  createCredential,
  hasActiveCredential,
  listCredentials,
  parseCredentialHeader,
  revokeCredential,
  verifyApiRequest,
  verifyMachineRequest,
  verifyMintedCredential,
} = await import("../src/lib/auth/credentials");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

const db = getDb();
const owner = (await db.select({ id: users.id }).from(users).limit(1))[0];
if (!owner) {
  console.error("No users row to own the test credentials. Seed the dev DB first.");
  process.exit(1);
}

const basic = (keyId: string, secret: string) =>
  `Basic ${Buffer.from(`${keyId}:${secret}`).toString("base64")}`;

const created: string[] = [];

try {
  // --- shape + storage ------------------------------------------------------
  const made = await createCredential(owner.id, "verify-api-scoped", ["api"]);
  if (!made.ok) throw new Error(`create failed: ${made.error}`);
  created.push(made.credential.id);
  check("key id is public and prefixed", /^lgrk_[0-9a-f]{24}$/.test(made.keyId), made.keyId);
  check("secret is prefixed and long", /^lgrs_[0-9a-f]{48}$/.test(made.secret));

  const row = (
    await db
      .select({ secretHash: apiCredentials.secretHash, keyId: apiCredentials.keyId })
      .from(apiCredentials)
      .where(eq(apiCredentials.id, made.credential.id))
  )[0];
  check("the row stores the key id in plaintext", row.keyId === made.keyId);
  check(
    "the row stores only the secret's sha256, never the secret",
    row.secretHash === createHash("sha256").update(made.secret).digest("hex") &&
      !row.secretHash.includes(made.secret)
  );

  // --- both header forms authenticate ---------------------------------------
  const viaBasic = await verifyMintedCredential(basic(made.keyId, made.secret), "api");
  check("Basic authenticates and carries the scopes", viaBasic?.name === "verify-api-scoped" &&
    viaBasic?.scopes.join() === "api", JSON.stringify(viaBasic));
  const viaBearer = await verifyMintedCredential(
    `Bearer ${made.keyId}:${made.secret}`,
    "api"
  );
  check("Bearer keyId:secret authenticates too", viaBearer?.name === "verify-api-scoped");
  check(
    "verifyApiRequest (the route entry point) accepts it",
    (await verifyApiRequest(basic(made.keyId, made.secret)))?.name === "verify-api-scoped"
  );

  // --- everything that must fail closed -------------------------------------
  check(
    "a wrong secret fails",
    (await verifyMintedCredential(basic(made.keyId, "lgrs_" + "0".repeat(48)))) === null
  );
  check(
    "an unknown key id fails",
    (await verifyMintedCredential(basic("lgrk_" + "0".repeat(24), made.secret))) === null
  );
  check(
    "a scope the credential does not hold fails",
    (await verifyMintedCredential(basic(made.keyId, made.secret), "cron")) === null
  );
  check(
    "a credential cannot widen itself: api-only is refused on an mcp check",
    (await verifyMachineRequest(basic(made.keyId, made.secret), "mcp")) === null
  );
  check("a bare opaque Bearer is not read as a pair", parseCredentialHeader("Bearer lgr_abc") === null);
  check("a secret containing a colon still splits on the first one",
    parseCredentialHeader(basic("lgrk_x", "a:b"))?.secret === "a:b");
  check("no header fails", (await verifyMintedCredential(null)) === null);

  // --- last_used_at ---------------------------------------------------------
  // The write is detached (after() outside a request scope falls back to a
  // plain promise), so give it a moment before reading it back.
  await new Promise((r) => setTimeout(r, 1500));
  const touched = (await listCredentials(owner.id)).find((c) => c.id === made.credential.id);
  check("last used advances on successful auth", !!touched?.lastUsedAt, String(touched?.lastUsedAt));

  // --- the capability probe -------------------------------------------------
  check("hasActiveCredential sees the live api credential", await hasActiveCredential("api"));
  check("hasActiveCredential does not invent scopes", !(await hasActiveCredential("nonsense")));

  // --- revocation ----------------------------------------------------------
  check("revoke reports success", await revokeCredential(owner.id, made.credential.id));
  check(
    "a revoked credential fails on the next request, with no redeploy",
    (await verifyMintedCredential(basic(made.keyId, made.secret), "api")) === null
  );
  check("revoking twice reports no-op", !(await revokeCredential(owner.id, made.credential.id)));
  check(
    "another owner's id cannot revoke it",
    !(await revokeCredential(crypto.randomUUID(), made.credential.id))
  );
  check(
    "the revoked row stays in the list, stamped",
    !!(await listCredentials(owner.id)).find((c) => c.id === made.credential.id)?.revokedAt
  );

  // --- the env path is untouched -------------------------------------------
  const envToken = "lgr_verify_env_path";
  const envHash = createHash("sha256").update(envToken).digest("hex");
  const before = process.env.LEDGR_API_TOKENS;
  process.env.LEDGR_API_TOKENS = `verify-env:cron:${envHash}`;
  const envIdentity = await verifyMachineRequest(`Bearer ${envToken}`, "cron");
  check(
    "an existing LEDGR_API_TOKENS entry still resolves through the new resolver",
    envIdentity?.name === "verify-env" && envIdentity.scopes.join() === "cron",
    JSON.stringify(envIdentity)
  );
  check(
    "an env entry without the scope is still refused",
    (await verifyMachineRequest(`Bearer ${envToken}`, "mcp")) === null
  );
  if (before === undefined) delete process.env.LEDGR_API_TOKENS;
  else process.env.LEDGR_API_TOKENS = before;

  // --- validation + caps ---------------------------------------------------
  const unnamed = await createCredential(owner.id, "   ", ["api"]);
  check("an empty name is refused", !unnamed.ok);
  const scopeless = await createCredential(owner.id, "verify-scopeless", []);
  check("no permissions is refused", !scopeless.ok);
  const bogus = await createCredential(owner.id, "verify-bogus", ["api", "root"]);
  check("an unknown permission is refused, not silently dropped", !bogus.ok);

  // Fill to the active cap, then confirm the next one is refused. Uses the
  // real path so the cap is proven, not assumed.
  const existingActive = (await listCredentials(owner.id)).filter((c) => !c.revokedAt).length;
  let capHit = false;
  for (let i = existingActive; i < MAX_ACTIVE_CREDENTIALS + 1; i++) {
    const r = await createCredential(owner.id, `verify-cap-${i}`, ["diag"]);
    if (r.ok) created.push(r.credential.id);
    else {
      capHit = r.error.includes("active credentials") || r.error.includes("Too many");
      break;
    }
  }
  check("the active cap refuses rather than growing without bound", capHit);
} finally {
  if (created.length) {
    await db.delete(apiCredentials).where(inArray(apiCredentials.id, created));
  }
  console.log(
    failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`
  );
  process.exit(failures === 0 ? 0 : 1);
}
