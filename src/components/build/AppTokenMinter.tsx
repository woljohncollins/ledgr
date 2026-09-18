// Mint-a-token form for an external app (ADR-179). Unlike TokenMinter (one
// click, one purpose), an app token is named — you type the app's label first,
// so the token identifies its caller in machine-route logs. The label is the
// only input; the server action does the owner-gated signing and re-validates.
//
// Shown once and never stored (stateless model, oauth.ts), so the copy field
// carries the same "copy it now" warning as the other minters.
"use client";

import { useState } from "react";
import CopyField from "@/components/build/CopyField";
import { mintAppToken } from "@/lib/auth/mint-actions";

type Minted = { label: string; token: string };

export default function AppTokenMinter({
  disabled,
  disabledHint,
}: {
  disabled?: boolean;
  disabledHint?: string;
}) {
  const [label, setLabel] = useState("");
  const [minted, setMinted] = useState<Minted | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Mirrors isValidTokenLabel in oauth.ts — this only gates the button so the
  // rule is visible while typing; the server action is the real check.
  const trimmed = label.trim().toLowerCase();
  const valid = /^[a-z0-9-]{1,32}$/.test(trimmed);

  async function mint() {
    setBusy(true);
    setError(null);
    try {
      const res = await mintAppToken(trimmed);
      if ("token" in res) {
        setMinted({ label: trimmed, token: res.token });
        setLabel("");
      } else {
        setError(res.error);
      }
    } catch {
      setError("Couldn't generate a token — try again.");
    } finally {
      setBusy(false);
    }
  }

  if (disabled) {
    return <p className="text-xs text-amber-500/90">{disabledHint}</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1">
          <label
            htmlFor="app-token-label"
            className="mb-1 block text-xs text-ink-subtle"
          >
            App name
          </label>
          <input
            id="app-token-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && valid && !busy) void mint();
            }}
            placeholder="overtone"
            spellCheck={false}
            autoComplete="off"
            className="w-full rounded-card border border-line bg-surface-2 px-2.5 py-1.5 font-mono text-sm text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
          />
        </div>
        <button
          onClick={() => void mint()}
          disabled={busy || !valid}
          className="shrink-0 rounded-lg border border-[var(--accent)]/40 bg-[var(--accent)]/15 px-3.5 py-2 text-sm font-semibold text-[var(--accent)] hover:bg-[var(--accent)]/25 disabled:opacity-50"
        >
          {busy ? "Generating…" : "Generate token"}
        </button>
      </div>
      <p className="text-xs text-ink-faint">
        Lowercase letters, digits, and hyphens, up to 32 characters. The name
        rides inside the token and labels the caller in logs.
      </p>

      {error && <p className="text-xs text-red-400">{error}</p>}

      {minted && (
        <div className="rounded-card border border-line bg-surface-2 p-3">
          <p className="mb-1.5 text-xs text-ink-muted">
            Token for{" "}
            <code className="font-mono text-ink">{minted.label}</code>
          </p>
          <CopyField value={minted.token} label="API token" />
          <p className="mt-1.5 text-xs text-amber-500/90">
            Copy this now — it&rsquo;s shown only once. Generating another
            token won&rsquo;t affect this one.
          </p>
        </div>
      )}
    </div>
  );
}
