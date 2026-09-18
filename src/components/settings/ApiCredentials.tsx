"use client";

// The API-credentials manager on User Settings (ADR-224). One client island:
// the create form (name + permission checkboxes), the shown-once result panel
// carrying the key id and the secret, and the table of existing credentials
// with a per-row Revoke.
//
// Deliberately NOT a multi-select list surface: it's a small management table
// where each action is per-credential and deliberate, the same ADR-118
// exception SyncedDevices and Trash take.
import { useState } from "react";
import CopyField from "@/components/build/CopyField";
import ConfirmButton from "@/components/ui/ConfirmButton";
import {
  createApiCredential,
  revokeApiCredential,
} from "@/lib/auth/credential-actions";
import type { CredentialSummary, ScopeDef } from "@/lib/auth/credentials";
import { relativeTime } from "@/lib/relative-time";

type Minted = { name: string; keyId: string; secret: string };

export default function ApiCredentials({
  initial,
  scopes,
  origin,
}: {
  initial: CredentialSummary[];
  scopes: ScopeDef[];
  origin: string;
}) {
  const [credentials, setCredentials] = useState(initial);
  const [name, setName] = useState("");
  // Least privilege by default: nothing pre-ticked, so a credential only ever
  // carries a permission the owner chose on purpose.
  const [picked, setPicked] = useState<string[]>([]);
  const [minted, setMinted] = useState<Minted | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const trimmed = name.trim();
  const canCreate = trimmed.length > 0 && picked.length > 0 && !busy;

  function toggle(scope: string) {
    setPicked((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]
    );
  }

  async function create() {
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    try {
      const res = await createApiCredential(trimmed, picked);
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setMinted({ name: trimmed, keyId: res.keyId, secret: res.secret });
      setCredentials(res.credentials);
      setName("");
      setPicked([]);
    } catch {
      setError("Couldn't create the credential. Try again.");
    } finally {
      setBusy(false);
    }
  }

  // Thrown errors surface inside ConfirmButton's popover, which is why this
  // throws rather than setting the shared error line.
  async function revoke(id: string) {
    const res = await revokeApiCredential(id);
    if ("error" in res) throw new Error(res.error);
    setCredentials(res.credentials);
  }

  const active = credentials.filter((c) => !c.revokedAt);

  return (
    <section className="mt-10 border-t border-line pt-6">
      <h2 className="ui-section-label">API credentials</h2>
      <p className="mt-1 text-sm text-ink-muted">
        A credential lets an outside app, a script, or an AI assistant reach your
        Ledgr data over HTTP with no sign-in. You get a key ID and a secret; the
        app sends both. Creating and revoking take effect immediately, with no
        redeploy.
      </p>

      {/* Create */}
      <div className="mt-4 rounded-card border border-line bg-surface-1 p-4">
        <label htmlFor="cred-name" className="mb-1 block ui-meta">
          What is it for?
        </label>
        <input
          id="cred-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canCreate) void create();
          }}
          placeholder="Overtone, my laptop script, Claude on my phone…"
          spellCheck={false}
          autoComplete="off"
          maxLength={60}
          className="w-full rounded-card border border-line bg-surface-2 px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
        />

        <p className="mt-4 mb-2 ui-meta">What is it allowed to do?</p>
        <div className="flex flex-col gap-2.5">
          {scopes.map((s) => (
            <label
              key={s.scope}
              className="flex cursor-pointer items-start gap-2.5"
            >
              <input
                type="checkbox"
                checked={picked.includes(s.scope)}
                onChange={() => toggle(s.scope)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
              />
              <span className="min-w-0">
                <span className="block ui-row text-ink">{s.label}</span>
                <span className="block font-mono text-xs text-ink-faint">
                  {s.scope}
                </span>
                <span className="mt-0.5 block text-xs text-ink-subtle">
                  {s.detail}
                </span>
              </span>
            </label>
          ))}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void create()}
            disabled={!canCreate}
            className="rounded-lg border border-[var(--accent)]/40 bg-[var(--accent)]/15 px-3.5 py-2 text-sm font-semibold text-[var(--accent)] hover:bg-[var(--accent)]/25 disabled:opacity-50"
          >
            {busy ? "Creating…" : "Create credential"}
          </button>
          <span className="ui-meta">
            {picked.length === 0
              ? "Tick at least one permission."
              : trimmed.length === 0
                ? "Give it a name."
                : "Grant only what this app actually needs."}
          </span>
        </div>
        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
      </div>

      {/* The shown-once result */}
      {minted && (
        <div className="mt-4 rounded-card border border-amber-700/60 bg-amber-950/20 p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm font-medium text-amber-300">
              Copy the secret now: it is shown once and cannot be recovered.
            </p>
            <button
              type="button"
              onClick={() => setMinted(null)}
              className="rounded-card border border-line-strong bg-surface-2 px-2.5 py-1 text-xs text-ink hover:bg-surface-3"
            >
              I&rsquo;ve copied it
            </button>
          </div>
          <p className="mt-1 text-xs text-ink-muted">
            Credential for <span className="text-ink">{minted.name}</span>. If
            you lose the secret, revoke this credential and create another,
            since there is no way to read it back.
          </p>
          <div className="mt-3 space-y-2">
            <div>
              <p className="mb-1 ui-meta">Key ID (public, safe to keep)</p>
              <CopyField value={minted.keyId} label="key ID" />
            </div>
            <div>
              <p className="mb-1 ui-meta">Secret (shown once)</p>
              <CopyField value={minted.secret} label="secret" />
            </div>
          </div>
          {origin && (
            <div className="mt-3">
              <p className="mb-1 ui-meta">Try it</p>
              <pre className="overflow-x-auto rounded-card border border-line bg-surface-2 p-3 font-mono text-xs text-ink-muted">
                {`curl -u "${minted.keyId}:${minted.secret}" \\\n  ${origin}/api/machine/items`}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* The list */}
      <div className="mt-6">
        <p className="ui-meta">
          {credentials.length === 0
            ? "No credentials yet."
            : `${active.length} active${
                credentials.length > active.length
                  ? `, ${credentials.length - active.length} revoked`
                  : ""
              }`}
        </p>
        {credentials.length > 0 && (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[40rem] border-collapse text-left">
              <thead>
                <tr className="border-b border-line">
                  <th className="py-2 pr-3 ui-meta font-medium">Name</th>
                  <th className="py-2 pr-3 ui-meta font-medium">Key ID</th>
                  <th className="py-2 pr-3 ui-meta font-medium">Permissions</th>
                  <th className="py-2 pr-3 ui-meta font-medium">Created</th>
                  <th className="py-2 pr-3 ui-meta font-medium">Last used</th>
                  <th className="py-2 ui-meta font-medium" />
                </tr>
              </thead>
              <tbody>
                {credentials.map((c) => (
                  <tr
                    key={c.id}
                    className={`border-b border-line/60 ${
                      c.revokedAt ? "opacity-50" : ""
                    }`}
                  >
                    <td className="py-2 pr-3 ui-row text-ink">
                      {c.name}
                      {c.revokedAt && (
                        <span className="ml-2 rounded bg-surface-3 px-1.5 py-0.5 text-[11px] text-ink-subtle">
                          revoked {relativeTime(c.revokedAt)}
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3 font-mono text-xs text-ink-subtle">
                      {c.keyId}
                    </td>
                    <td className="py-2 pr-3 font-mono text-xs text-ink-subtle">
                      {c.scopes.join(", ")}
                    </td>
                    <td className="py-2 pr-3 ui-meta">
                      {relativeTime(c.createdAt)}
                    </td>
                    <td className="py-2 pr-3 ui-meta">
                      {c.lastUsedAt ? relativeTime(c.lastUsedAt) : "never"}
                    </td>
                    <td className="py-2 text-right">
                      {!c.revokedAt && (
                        <ConfirmButton
                          onConfirm={() => revoke(c.id)}
                          title={`Revoke "${c.name}"?`}
                          description="Whatever is using it stops working on its very next request. This cannot be undone; you would create a new credential instead."
                          confirmLabel="Revoke"
                          panelClassName="w-72"
                          align="right"
                          trigger="Revoke"
                          triggerClassName="rounded-card border border-line-strong bg-surface-2 px-2.5 py-1 text-xs text-ink hover:bg-surface-3"
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="mt-3 text-xs text-ink-subtle">
        Send both parts as HTTP Basic auth:{" "}
        <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[11px] text-ink-muted">
          Authorization: Basic base64(keyID:secret)
        </code>{" "}
        (with curl, <code className="font-mono text-[11px]">-u
        &quot;keyID:secret&quot;</code>). A client that only speaks bearer tokens
        can send{" "}
        <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[11px] text-ink-muted">
          Bearer keyID:secret
        </code>{" "}
        instead. Treat the secret like a password: it acts as you. Full details
        are at <span className="font-mono text-[11px]">/build/api</span>.
      </p>
    </section>
  );
}
