// The way out of "signed in, but not recognized" (src/app/_today-home.tsx).
//
// That state is a VALID session whose identity matches no users row, so the
// app renders empty and — because Nav draws nothing without an owner — there
// is no user menu to sign out from. The escape offered there was a link to
// /sign-in, which Clerk answers by redirecting an already-signed-in visitor
// straight back to "/": the click read as the page reloading itself, and a
// phone that had signed in with the wrong Google account had no way back
// (reported 2026-09-19). Ending the session is the only thing that changes
// the situation, so this is a button that signs out, not a link that asks.
"use client";

import { useState } from "react";
import { useSignOut } from "@/lib/auth/client";

export default function SwitchAccountButton() {
  const signOut = useSignOut();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => {
        // No finally-reset: on success the navigation replaces this page, so
        // the button stays disabled until it does. Only a failed sign-out
        // (offline) puts it back, which is exactly when a retry is wanted.
        setBusy(true);
        void signOut().catch(() => setBusy(false));
      }}
      className="text-sm text-[var(--accent)] hover:underline disabled:opacity-60"
    >
      {busy ? "Signing out…" : "Sign out and use a different account"}
    </button>
  );
}
