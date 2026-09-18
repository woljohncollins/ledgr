import { cache } from "react";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { authProvider } from "@/lib/auth";
import { createLogger } from "@/lib/log";

export type Owner = {
  id: string;
  email: string;
};

// "Signed out" and "signed in as somebody this Ledgr doesn't know" are different
// failures with different fixes, and collapsing both to `null` is what made the
// 2026-08-11 incident (ADR-184) read as a missing user menu instead of an auth
// problem: an unresolvable session rendered the app with no nav and no
// explanation. resolveOwner keeps returning Owner | null so its ~80 callers are
// untouched; callers that want to TELL the two apart use resolveOwnerState.
export type OwnerState =
  | { kind: "signed-out" }
  // A valid auth session that matches no users row. Not recoverable by signing in
  // again as the same identity, so a redirect to /sign-in would loop (Clerk sends
  // an already-signed-in visitor straight back). Needs to be shown, not retried.
  | { kind: "unrecognized"; email: string | null }
  | { kind: "owner"; owner: Owner };

// Resolves the signed-in user to their users row; owner-scoped queries start
// from the returned id. First sign-in finds the seeded row by email and
// backfills clerk_id (the seed can't know it); after that the clerk_id
// lookup hits. No row is created here: v1 is single-user, and an
// authenticated stranger (sign-ups are restricted in Clerk, so this is
// belt-and-suspenders) gets null, same as signed out.
export async function resolveOwner(): Promise<Owner | null> {
  const state = await resolveOwnerState();
  return state.kind === "owner" ? state.owner : null;
}

// One transient-failure retry for the resolution's first DB read. The first
// query of a request against a cold (autosuspended) Neon compute is the one
// that flakes; a single short-backoff retry turns "the chrome rendered
// signed-out this morning" into ~300ms of extra latency once a day.
async function retryOnce<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    await new Promise((r) => setTimeout(r, 300));
    return await fn();
  }
}

// Wrapped in React cache(): the root layout, the Nav, and the page each resolve
// the owner during ONE request, and three independent resolutions are three
// chances to disagree — which is exactly the 2026-08-19 incident (Tyler, after
// a cold Safari start on prod): the page rendered his tasks while the layout
// wore default-blue and the Nav rendered null, because their resolutions came
// out differently. cache() makes every caller in a request await the SAME
// resolution, so the chrome and the content can never again tell two stories.
// (In route handlers cache() is a passthrough — same behavior as before.)
export const resolveOwnerState = cache(async (): Promise<OwnerState> => {
  const authUser = await authProvider.getCurrentUser();
  if (!authUser) return { kind: "signed-out" };

  const db = getDb();
  const byClerkId = await retryOnce(() =>
    db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.clerkId, authUser.externalId))
  );
  if (byClerkId.length > 0) return { kind: "owner", owner: byClerkId[0] };

  // Past here the caller IS authenticated but no row matched, which is always a
  // misconfiguration (a re-created Clerk user, a changed primary email, a restore
  // that lost the clerk_id link). Rule 9, no silent failures: say so once per
  // request, with the identity that failed, so it's greppable in the log drain
  // instead of only visible as an app with no navigation.
  const log = createLogger("auth.owner");
  const unrecognized = (reason: string): OwnerState => {
    log.warn("authenticated session matched no owner row", {
      reason,
      externalId: authUser.externalId,
      email: authUser.email,
    });
    return { kind: "unrecognized", email: authUser.email };
  };

  if (!authUser.email) return unrecognized("no email on the auth identity");
  const byEmail = await db
    .select({ id: users.id, email: users.email, clerkId: users.clerkId })
    .from(users)
    .where(eq(users.email, authUser.email));
  if (byEmail.length === 0) return unrecognized("no users row for that email");

  // Backfill fills an empty clerk_id only, never overwrites an existing
  // link: a second provider identity with a matching email (the dev
  // stand-in, a re-created Clerk user) must not silently steal the row.
  if (!byEmail[0].clerkId) {
    await db
      .update(users)
      .set({ clerkId: authUser.externalId })
      .where(and(eq(users.id, byEmail[0].id), isNull(users.clerkId)));
  }
  return {
    kind: "owner",
    owner: { id: byEmail[0].id, email: byEmail[0].email },
  };
});
