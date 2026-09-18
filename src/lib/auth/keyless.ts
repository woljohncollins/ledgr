// Is Clerk configured, and is running WITHOUT it allowed here?
//
// The keyless fallback is deliberate and load-bearing: a fresh clone and a CI
// `next build` must run before Clerk is set up (and a Phase 4 local build stands
// its own provider in). The hazard is that TWO call sites read the same env var
// and, when it's absent, fail in OPPOSITE directions:
//   - src/proxy.ts        → no key means no clerkMiddleware, so nothing is protected
//   - src/lib/auth/index.ts → no key means nullAuthProvider, so nobody is signed in
// The door stands open while the server believes every caller is anonymous. On a
// deployment holding real data that's a fail-open, and its only visible symptom
// is cosmetic: `Nav.tsx` renders no nav (no owner resolved), so a missing user
// menu is the entire tell. Diagnosed 2026-08-11 (ADR-184) after exactly that.
//
// So: keyless is allowed everywhere EXCEPT a deployed environment, where a
// missing key is a misconfiguration to fail loudly on rather than serve through.
//
// Deliberately imports NOTHING — not @clerk/nextjs (scripts/verify-provider-seams
// asserts Clerk appears in exactly four files, and this must not become a fifth),
// and not src/lib/log.ts (which pulls in the DB client; middleware shouldn't).

// Vercel sets VERCEL_ENV to production | preview | development on every
// deployment. Unset means we're not on a deployment at all: local dev, a fresh
// clone, or a CI build — the cases the fallback exists for.
export function isDeployedEnv(): boolean {
  const env = process.env.VERCEL_ENV;
  return env === "production" || env === "preview";
}

export function isClerkConfigured(): boolean {
  return !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
}

// May this process serve requests with no auth provider configured?
export function keylessAllowed(): boolean {
  return !isDeployedEnv();
}
