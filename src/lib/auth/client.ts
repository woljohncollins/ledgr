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
import { useAuth } from "@clerk/nextjs";

export type ClientSessionState = {
  // False until the provider has hydrated; callers must not act before this.
  isLoaded: boolean;
  isSignedIn: boolean;
};

export function useClientSession(): ClientSessionState {
  const { isLoaded, isSignedIn } = useAuth();
  return { isLoaded, isSignedIn: !!isSignedIn };
}
