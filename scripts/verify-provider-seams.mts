// Slice 32 verification: the provider-interface discipline (CLAUDE.md) that
// keeps a Phase 4 local/self-hosted build a packaging exercise, not a rewrite.
// This is a static guard, not a DB test — it asserts the three embedded cloud
// dependencies stay behind their seams so a future swap touches only the seam:
//   (1) auth   — only the auth seam imports @clerk/nextjs; everything else
//                goes through authProvider / resolveOwner / requireOwner.
//   (2) storage— only src/lib/storage imports the R2 client (aws4fetch).
//   (3) sched. — every /api/machine endpoint authenticates with a machine
//                token, so any scheduler (Vercel cron, GitHub Actions, a local
//                cron) reaches it the same way: an authenticated HTTP call.
// It fails loudly if a new file breaks a boundary. Run:
//   npx tsx scripts/verify-provider-seams.mts
import { readdirSync, readFileSync, existsSync } from "node:fs";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

const files = (readdirSync("src", { recursive: true }) as string[])
  .map((p) => `src/${p.replace(/\\/g, "/")}`)
  .filter((p) => p.endsWith(".ts") || p.endsWith(".tsx"));

const read = (p: string) => readFileSync(p, "utf8");

// --- (1) auth seam ---------------------------------------------------------
// The only files allowed to import Clerk directly: the provider implementation,
// its React wrapper, the provider selector's neighbours (middleware), and the
// sign-in page. Anything else must use the AuthProvider interface.
const CLERK_ALLOWED = new Set([
  "src/proxy.ts",
  "src/lib/auth/clerk.ts",
  "src/lib/auth/provider.tsx",
  // The client half of the seam: the one hook reporting whether the BROWSER
  // thinks a session exists, for the server/client disagreement check
  // (NavAuthHeal, ADR-216). It landed importing Clerk directly and tripped
  // this guard; the fix was a seam file, not a wider allowlist.
  "src/lib/auth/client.ts",
  "src/app/sign-in/[[...sign-in]]/page.tsx",
]);
const clerkImporters = files.filter((p) => /from\s+["']@clerk\/nextjs/.test(read(p)));
const clerkLeaks = clerkImporters.filter((p) => !CLERK_ALLOWED.has(p));
check(
  "only the auth seam imports @clerk/nextjs",
  clerkLeaks.length === 0,
  clerkLeaks.length ? `leaks: ${clerkLeaks.join(", ")}` : `${clerkImporters.length} seam file(s)`
);

// The seam interface and its single switch point exist and are real.
check("AuthProvider interface exists", existsSync("src/lib/auth/types.ts") && /interface AuthProvider/.test(read("src/lib/auth/types.ts")));
check(
  "the active provider is chosen in one place (lib/auth/index.ts)",
  /export const authProvider/.test(read("src/lib/auth/index.ts"))
);
// resolveOwner is the one owner gate, and it goes through the interface.
check(
  "resolveOwner uses authProvider, not Clerk",
  /authProvider\.getCurrentUser/.test(read("src/lib/owner.ts")) &&
    !/@clerk\/nextjs/.test(read("src/lib/owner.ts"))
);

// --- (2) storage seam ------------------------------------------------------
const storageImporters = files.filter((p) => /from\s+["']aws4fetch/.test(read(p)));
const storageLeaks = storageImporters.filter((p) => !p.startsWith("src/lib/storage/"));
check(
  "only src/lib/storage imports the R2 client (aws4fetch)",
  storageLeaks.length === 0,
  storageLeaks.length ? `leaks: ${storageLeaks.join(", ")}` : `${storageImporters.length} file(s) in the seam`
);
check("StorageProvider interface exists", existsSync("src/lib/storage/types.ts"));

// --- (3) scheduler-auth contract ------------------------------------------
// Every machine endpoint must gate on a machine token. This is what makes the
// scheduler swappable: Vercel cron / GitHub Actions / a local cron all call
// the same authenticated URL. A new unauthenticated machine route would both
// be a security hole and break the local-cron swap.
//
// There are THREE machine-auth helpers, and this guard once only knew one: the
// original `verifyMachineToken()`; `verifyApiToken()` + `resolveMachineOwner`
// (the ADR-117 OAuth shim, added in db6ae4b — four routes use it and were
// reported as unauthenticated for months, a false alarm a security guard can't
// afford, so it was taught); and `verifySyncDevice()` (the sync spine's
// DB-backed device tokens, src/lib/sync/auth.ts — same sha256 +
// timingSafeEqual as machine.ts, hash stored on a revocable sync_peers row per
// the plan's decision 15). ADR-224 added the last two: `verifyMachineRequest()`
// and `verifyApiRequest()` (src/lib/auth/credentials.ts), the async resolvers
// that try the env token first and then a minted api_credentials row — the
// routes now call these, and the two sync names remain because /api/mcp and
// the sync route still call them directly. Accept exactly these names, nothing
// looser: a new machine route must use one of them or extend this list
// deliberately.
//
// Checked PER EXPORTED HANDLER rather than per file, which is stricter than
// before: the old file-level grep would pass a file whose GET was gated and whose
// newly-added POST was not. Segmenting on `export async function` is enough
// because each machine handler authenticates inline, at its top.
const AUTH_HELPER =
  /verifyMachineRequest\s*\(|verifyApiRequest\s*\(|verifyMachineToken\s*\(|verifyApiToken\s*\(|verifySyncDevice\s*\(/;
const machineRoutes = files.filter((p) => /^src\/app\/api\/machine\/.*\/route\.ts$/.test(p));
const unauthedHandlers: string[] = [];
let handlerCount = 0;
for (const p of machineRoutes) {
  const src = read(p);
  // [0] is the imports/preamble before the first handler — not a handler itself.
  const segments = src.split(/export\s+async\s+function\s+/).slice(1);
  for (const seg of segments) {
    const verb = /^([A-Z]+)/.exec(seg)?.[1] ?? "?";
    handlerCount++;
    if (!AUTH_HELPER.test(seg)) unauthedHandlers.push(`${p}:${verb}`);
  }
}
check(
  "every /api/machine handler verifies a machine token",
  machineRoutes.length > 0 && handlerCount > 0 && unauthedHandlers.length === 0,
  unauthedHandlers.length
    ? `missing: ${unauthedHandlers.join(", ")}`
    : `${handlerCount} handlers across ${machineRoutes.length} routes`
);

// The scheduled jobs all point at machine endpoints (the scheduler interface).
// Cross-check the two schedulers reference machine paths only.
const vercel = JSON.parse(read("vercel.json")) as { crons: { path: string }[] };
check(
  "all Vercel crons target /api/machine endpoints",
  vercel.crons.every((c) => c.path.startsWith("/api/machine/")),
  vercel.crons.map((c) => c.path).join(", ")
);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
