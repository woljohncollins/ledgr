"use client";
// The Authorize step of /connect/launchpad. On click: mint an `api`-scoped
// credential named for Launchpad, then deliver the pair to the window that
// opened this popup.
//
// Delivery is postMessage with targetOrigin "*" — deliberate, and worth the
// paragraph: Launchpad is a local-first page usually served from file://,
// whose origin is the literal string "null", so there is no concrete origin
// to pin. The mitigations that remain: the pair only exists after the OWNER
// (Clerk-authenticated, owner-row-matched) clicks Authorize inside this
// window, the message goes only to window.opener (the window the user just
// came from), and this is a single-user instance. A user who finds this page
// with no opener just gets the pair on screen to copy by hand — same as
// minting in User Settings.
//
// Each click mints a fresh credential (named with the date) rather than
// revoking prior "Launchpad" ones — other browsers/machines running Launchpad
// hold their own credentials and revoking by name would sever them. Prune old
// ones in User Settings → API credentials.
import { useState } from "react";
import { createApiCredential } from "@/lib/auth/credential-actions";

type Minted = { keyId: string; secret: string };

export default function LaunchpadAuthorize() {
  const [busy, setBusy] = useState(false);
  const [minted, setMinted] = useState<Minted | null>(null);
  const [delivered, setDelivered] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function authorize() {
    setBusy(true);
    setError(null);
    try {
      const name = `Launchpad (${new Date().toISOString().slice(0, 10)})`;
      const res = await createApiCredential(name, ["api"]);
      if ("error" in res) {
        setError(res.error);
        return;
      }
      const pair = { keyId: res.keyId, secret: res.secret };
      setMinted(pair);
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage(
          { type: "ledgr-launchpad-credential", keyId: pair.keyId, secret: pair.secret },
          "*"
        );
        setDelivered(true);
        // Give the opener a beat to store it, then close ourselves.
        setTimeout(() => window.close(), 1200);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-md px-5 py-16">
      <h1 className="ui-title">Connect Launchpad</h1>

      {!minted && (
        <>
          <p className="mt-3 text-sm text-ink-muted">
            Launchpad is asking for an API credential with the{" "}
            <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-xs">api</code>{" "}
            permission — it can read and write your items (tasks, projects,
            tags), and nothing else. The credential appears in User Settings →
            API credentials, where you can revoke it any time.
          </p>
          <p className="mt-2 text-sm text-ink-muted">
            Only continue if you just clicked{" "}
            <span className="text-ink">Connect with Ledgr</span> in Launchpad.
          </p>
          {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
          <button
            type="button"
            onClick={authorize}
            disabled={busy}
            className="mt-5 rounded-lg border border-[var(--accent)]/40 bg-[var(--accent)]/15 px-3.5 py-2 text-sm font-semibold text-[var(--accent)] hover:bg-[var(--accent)]/25 disabled:opacity-50"
          >
            {busy ? "Authorizing…" : "Authorize"}
          </button>
        </>
      )}

      {minted && delivered && (
        <p className="mt-3 text-sm text-ink-muted">
          Connected — Launchpad received the credential. This window will close
          itself.
        </p>
      )}

      {minted && !delivered && (
        <div className="mt-3">
          <p className="text-sm text-ink-muted">
            Launchpad&apos;s window wasn&apos;t reachable, so paste these into its
            connect screen yourself. The secret is shown only this once.
          </p>
          <pre className="mt-3 overflow-x-auto rounded-card border border-line bg-surface-2 p-3 font-mono text-xs text-ink">
            {`Key ID:  ${minted.keyId}\nSecret:  ${minted.secret}`}
          </pre>
        </div>
      )}
    </div>
  );
}
