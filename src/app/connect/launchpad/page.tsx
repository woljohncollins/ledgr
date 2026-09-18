// One-click authorize for Launchpad (the local-first browser homepage's task
// tile). Launchpad opens this page in a popup; the signed-in owner clicks
// Authorize, we mint a DB-backed `api`-scoped credential (ADR-224), and the
// client component hands the keyId+secret back to the opener via postMessage.
// The Microsoft/Clerk login IS the consent gate (same single-user reasoning
// as the OAuth shim's authorize route); the button click is the approval.
//
// Not the OAuth shim: that flow is mcp-scope-only, redirect-URI-based, and
// rejects file:// clients — Launchpad runs off a local file, so a popup +
// postMessage is the only shape that works (see the client component for the
// targetOrigin tradeoff that follows from that).
import { redirect } from "next/navigation";
import { resolveOwnerState } from "@/lib/owner";
import LaunchpadAuthorize from "@/components/connect/LaunchpadAuthorize";

export const dynamic = "force-dynamic";

export default async function ConnectLaunchpad() {
  const state = await resolveOwnerState();
  // signed-out is normally intercepted by the middleware (auth.protect sends
  // the visitor to sign-in and back here); this is belt-and-suspenders.
  if (state.kind === "signed-out") redirect("/sign-in");
  if (state.kind === "unrecognized") {
    // Do NOT redirect to /sign-in here — an authenticated session with no
    // users row would loop (see OwnerState's comment). Shown, not retried.
    return (
      <div className="mx-auto max-w-md px-5 py-16">
        <h1 className="ui-title">Can&apos;t authorize</h1>
        <p className="mt-3 text-sm text-ink-muted">
          You&apos;re signed in{state.email ? ` as ${state.email}` : ""}, but
          this account doesn&apos;t match this Ledgr&apos;s owner, so it can&apos;t
          mint API credentials. Close this window.
        </p>
      </div>
    );
  }
  return <LaunchpadAuthorize />;
}
