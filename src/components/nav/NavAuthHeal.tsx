// Self-heal for stale signed-out chrome (ADR-216, the third door into the
// ADR-184/ADR-203 "vanished nav" symptom). The login flow's LAST document
// render happens while signed out — /sign-in, then the OAuth SSO callback
// (Google on Tyler's instance, Microsoft on Brandon's; the flow is identical) —
// so the root layout (accent, body padding) and Nav render their signed-out
// forms. Clerk then completes the session entirely client-side and soft-
// navigates to "/": the App Router keeps the shared root layout from that
// signed-out render, so the page shows the owner's tasks while the nav and
// accent are missing. Clerk's own compensating router.refresh() (fired in
// __internal_onAfterSetActive) races its own navigation and is dropped, so the
// stale chrome sticks until the next full document load.
//
// Nav renders this component ONLY when the request resolved as signed-out, so
// its presence in the tree literally means "this chrome believes nobody is
// signed in." When the client-side Clerk session disagrees — and we're not
// mid-flow on a /sign-in route — one router.refresh() re-renders the tree with
// the session cookie, the real chrome replaces this, and the component unmounts
// with the signed-out render it rode in on. A healthy signed-in render never
// mounts it, so it can't loop; the throttle below guards the pathological case
// where server and client persistently disagree (e.g. a cookie that isn't
// reaching the server).
"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useClientSession } from "@/lib/auth/client";

// Module-level (not a ref): survives a remount of this component within the
// same document, so even a refresh that re-renders back into the signed-out
// state can't fire more than once per window.
let lastHealAt = 0;
const HEAL_THROTTLE_MS = 5000;

export default function NavAuthHeal() {
  const { isLoaded, isSignedIn } = useClientSession();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    // Don't refresh mid-sign-in-flow: Clerk is about to navigate away from
    // /sign-in/* itself; the post-navigation pathname change re-runs this
    // effect on the destination, which is where the heal belongs.
    if (pathname.startsWith("/sign-in")) return;
    const now = Date.now();
    if (now - lastHealAt < HEAL_THROTTLE_MS) return;
    lastHealAt = now;
    router.refresh();
  }, [isLoaded, isSignedIn, pathname, router]);

  return null;
}
