"use client";
// Client half of the auth seam: the one hook that reports whether the BROWSER
// believes a session exists, for the rare component that has to compare the
// client's view against what the server rendered (NavAuthHeal, ADR-216).
//
// It exists so that check goes through the seam like every other identity read
// (provider-interface discipline, CLAUDE.md): a Phase 4 local single-user mode
// swaps this file the way it swaps clerk.ts, instead of every caller importing
// Clerk directly. Deliberately narrow — two booleans, no user object — because
// the server render is still the authority on identity; this only answers "does
// the client disagree?".
import { useAuth, useClerk } from "@clerk/nextjs";

export type ClientSessionState = {
  // False until the provider has hydrated; callers must not act before this.
  isLoaded: boolean;
  isSignedIn: boolean;
};

export function useClientSession(): ClientSessionState {
  const { isLoaded, isSignedIn } = useAuth();
  return { isLoaded, isSignedIn: !!isSignedIn };
}

// Sign the browser out and land on /sign-in, for the one screen that needs it:
// "signed in, but not recognized" (src/app/_today-home.tsx). That screen used
// to offer a plain <Link href="/sign-in">, which cannot work — the session is
// VALID, so Clerk's <SignIn/> sees an active session and bounces straight back
// to "/", i.e. the click looks like the page reloading itself and the visitor
// is stuck in an account they can't use with no way out (no user menu renders
// in that state either, since Nav draws nothing without an owner). Ending the
// session first is the only exit; it belongs behind the seam like every other
// identity operation, so a Phase 4 local mode swaps this file, not its callers.
//
// The destination is passed to Clerk rather than navigated to afterwards: its
// default post-sign-out target is "/", and a manual redirect racing Clerk's own
// would be two navigations fighting. One call, one destination.
export function useSignOut(): () => Promise<void> {
  const { signOut } = useClerk();
  return () => signOut({ redirectUrl: "/sign-in" });
}
