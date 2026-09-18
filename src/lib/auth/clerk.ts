import { auth, currentUser } from "@clerk/nextjs/server";
import type { AuthProvider } from "./types";

export const clerkAuthProvider: AuthProvider = {
  async getCurrentUser() {
    // auth() is a local JWT verification — no network. It alone decides
    // signed-in vs signed-out.
    const { userId } = await auth();
    if (!userId) return null;
    // currentUser() is a NETWORK call to Clerk's Backend API, wanted only for
    // the email — which resolveOwnerState needs only on its clerk_id-miss
    // fallback path. A transient Clerk API failure must therefore never read
    // as "signed out" (a flavor of the 2026-08-19 vanished-chrome incident):
    // fall back to a null email and let the clerk_id lookup decide.
    let email: string | null = null;
    try {
      const user = await currentUser();
      email = user?.primaryEmailAddress?.emailAddress ?? null;
    } catch {
      // transient Clerk API failure; the clerk_id lookup still resolves
    }
    return { externalId: userId, email };
  },
};
