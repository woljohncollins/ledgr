"use client";

// The Synced devices manager on /build/updates (plan decision 15). One client
// island: the table of registered devices, the Add-device flow (the token is
// shown exactly once), Revoke/Restore, and Delete for revoked rows.
//
// Deliberately NOT a multi-select list surface: this is a small management
// table (a handful of rows, each action per-device and deliberate), one of
// ADR-118's management-shaped exceptions, like Trash.
import { useState } from "react";
import ConfirmButton from "@/components/ui/ConfirmButton";
import { badgeCount } from "@/lib/format-count";
import { relativeTime } from "@/lib/relative-time";
import type { HoldMode, PeerSummary } from "@/lib/sync/peers";

type Minted = { name: string; token: string };

export default function SyncedDevices({ initialPeers }: { initialPeers: PeerSummary[] }) {
  const [peers, setPeers] = useState<PeerSummary[]>(initialPeers);
  const [name, setName] = useState("");
  const [pullOnlyNew, setPullOnlyNew] = useState(true);
  const [minted, setMinted] = useState<Minted | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    const res = await fetch("/api/sync/peers", { cache: "no-store" });
    if (res.ok) {
      const data = (await res.json()) as { peers: PeerSummary[] };
      setPeers(data.peers);
    }
  }

  async function addDevice() {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/sync/peers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: trimmed, pullOnly: pullOnlyNew }),
      });
      const data = (await res.json()) as { token?: string; error?: string };
      if (!res.ok || !data.token) {
        setError(data.error ?? "The device could not be added.");
        return;
      }
      setMinted({ name: trimmed, token: data.token });
      setCopied(false);
      setName("");
      setPullOnlyNew(true);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The device could not be added.");
    } finally {
      setBusy(false);
    }
  }

  // Revoke/restore/delete. Thrown errors surface inside ConfirmButton's
  // popover; the restore button reports through the shared error line.
  async function mutate(deviceId: string, init: RequestInit) {
    const res = await fetch(`/api/sync/peers/${deviceId}`, init);
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error ?? "That did not work.");
    }
    await refresh();
  }

  const setRevoked = (deviceId: string, revoked: boolean) =>
    mutate(deviceId, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revoked }),
    });

  // Guardrail 1's "arming sync safely" lever: flip a device between
  // pull-only and full from the hub, correctable even if the spoke can't be
  // reached.
  const setPullOnly = (deviceId: string, pullOnly: boolean) =>
    mutate(deviceId, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pullOnly }),
    });

  // ADR-213: the retention hold. NOT access — it decides only whether this
  // device's cursor keeps the hub's oplog alive.
  const setHold = (deviceId: string, patch: { holdMode?: HoldMode; graceDays?: number | null }) =>
    mutate(deviceId, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });

  // Devices worth telling the owner about right now: approaching their window,
  // or already past it. A device that syncs daily never appears here.
  const needsAttention = peers.filter((p) => !p.revoked && (p.hold.warn || p.hold.lapsed));

  const rowButton =
    "rounded-card border border-line-strong bg-surface-2 px-2.5 py-1 text-xs text-ink hover:bg-surface-3";

  return (
    <div>
      {/* The warning Brandon asked for: said before it happens, with both
          answers to hand, rather than discovered at a refusal weeks later. */}
      {needsAttention.length > 0 && (
        <div className="mb-4 rounded-card border border-amber-700/60 bg-amber-950/20 p-3">
          <p className="text-sm font-medium text-amber-300">
            {needsAttention.some((p) => p.hold.lapsed)
              ? "A device has been away too long to come back the easy way"
              : "A device has nearly been away too long"}
          </p>
          <ul className="mt-2 space-y-2">
            {needsAttention.map((p) => (
              <li key={p.deviceId} className="text-sm text-ink-muted">
                <span className="text-ink">{p.name}</span>{" "}
                {p.hold.lapsed ? (
                  <>
                    has not checked in for over {p.hold.graceDays} days, so this instance stopped
                    keeping the history it missed. It can still come back, but it will need a
                    full re-fill from this one rather than just reconnecting.
                  </>
                ) : (
                  <>
                    has not checked in for a while. In about {p.hold.daysLeft}{" "}
                    {p.hold.daysLeft === 1 ? "day" : "days"} this instance stops keeping the
                    history it missed, and after that it would need a full needs a fresh copy to return
                    instead of just reconnecting.
                  </>
                )}
                <span className="mt-1 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={rowButton}
                    onClick={() =>
                      void setHold(p.deviceId, { holdMode: "warm" }).catch((err) =>
                        setError(err instanceof Error ? err.message : String(err))
                      )
                    }
                  >
                    Keep its history (it is coming back)
                  </button>
                  <button
                    type="button"
                    className={rowButton}
                    onClick={() =>
                      void setHold(p.deviceId, { holdMode: "cold" }).catch((err) =>
                        setError(err instanceof Error ? err.message : String(err))
                      )
                    }
                  >
                    Let it go
                  </button>
                </span>
              </li>
            ))}
          </ul>
          <p className="ui-meta mt-2 text-ink-subtle">
            Keeping a device&apos;s history costs this instance a little storage that can never be
            cleaned up while it waits — a few tens of megabytes a month. Letting it go frees that
            immediately, and the device can still be brought back with a re-fill.
          </p>
        </div>
      )}
      {peers.length === 0 ? (
        <p className="text-sm text-ink-muted">
          No devices sync against this instance yet.
        </p>
      ) : (
        // No overflow wrapper here on purpose: `overflow-x-auto` computes
        // overflow-y to `auto` as well (one non-visible axis forces the other),
        // which clipped the Revoke/Allow-push confirmation popover inside the
        // table and put a stray scrollbar on the card. This table is four
        // narrow columns on a desktop-first Build surface, so it never needed
        // horizontal scrolling; long device names wrap instead (break-words on
        // the name cell). ponytail: if a Build table ever genuinely needs BOTH
        // horizontal scrolling and a popover, ConfirmButton needs to render in
        // a portal — that is the real fix, and this is not that case.
        <div>
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="ui-meta text-ink-subtle">
                <th className="py-1.5 pr-4 font-normal">Device</th>
                <th className="py-1.5 pr-4 font-normal">Last heard from</th>
                <th className="py-1.5 pr-4 font-normal">Not received yet</th>
                <th className="py-1.5 pr-4 font-normal">Changes kept for it</th>
                <th className="py-1.5 font-normal" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {peers.map((p) => (
                <tr key={p.deviceId} className={p.revoked ? "opacity-60" : undefined}>
                  <td className="py-2 pr-4 break-words text-ink">
                    {p.name}
                    {p.revoked && (
                      <span className="ui-meta ml-2 rounded bg-surface-2 px-1.5 py-0.5 text-ink-subtle">
                        revoked
                      </span>
                    )}
                    {p.pullOnly && (
                      <span className="ui-meta ml-2 rounded bg-surface-2 px-1.5 py-0.5 text-ink-subtle">
                        receives only
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-4 text-ink-muted">
                    {p.lastSeenAt ? relativeTime(p.lastSeenAt) : "never"}
                  </td>
                  <td className="py-2 pr-4 text-ink-muted tabular-nums">
                    {p.opsBehind === 0 ? (
                      "up to date"
                    ) : (
                      <>{badgeCount(p.opsBehind, 999)} changes</>
                    )}
                  </td>
                  <td className="py-2 pr-4 text-ink-muted">
                    {p.hold.mode === "warm" ? (
                      <>
                        <span className="text-ink">Always</span>
                        {p.bindingHold && <span className="ui-meta block text-ink-subtle">using storage here</span>}
                      </>
                    ) : p.hold.mode === "cold" ? (
                      <>
                        <span className="text-amber-400">Not kept</span>
                        <span className="ui-meta block text-ink-subtle">needs a fresh copy to return</span>
                      </>
                    ) : p.hold.lapsed ? (
                      <>
                        <span className="text-amber-400">Lapsed</span>
                        <span className="ui-meta block text-ink-subtle">needs a fresh copy to return</span>
                      </>
                    ) : (
                      <>
                        <span className={p.hold.warn ? "text-amber-400" : undefined}>
                          {p.hold.daysLeft} {p.hold.daysLeft === 1 ? "day" : "days"} left
                        </span>
                        {p.bindingHold && <span className="ui-meta block text-ink-subtle">using storage here</span>}
                      </>
                    )}
                    {!p.revoked && (
                      <select
                        className="ui-meta mt-1 block rounded-card border border-line bg-surface-0 px-1 py-0.5 text-ink"
                        aria-label={`How long to keep history for ${p.name}`}
                        value={p.hold.mode === "auto" ? String(p.hold.graceDays) : p.hold.mode}
                        onChange={(e) => {
                          const v = e.target.value;
                          const patch =
                            v === "warm" || v === "cold"
                              ? { holdMode: v as HoldMode }
                              : { holdMode: "auto" as HoldMode, graceDays: Number(v) };
                          void setHold(p.deviceId, patch).catch((err) =>
                            setError(err instanceof Error ? err.message : String(err))
                          );
                        }}
                      >
                        <option value="14">14 days</option>
                        <option value="30">30 days</option>
                        <option value="60">60 days</option>
                        <option value="90">90 days</option>
                        <option value="warm">Always keep</option>
                        <option value="cold">Do not keep</option>
                      </select>
                    )}
                  </td>
                  <td className="py-2">
                    <div className="flex justify-end gap-2">
                      {p.revoked ? (
                        <>
                          <button
                            type="button"
                            className={rowButton}
                            onClick={() =>
                              void setRevoked(p.deviceId, false).catch((err) =>
                                setError(err instanceof Error ? err.message : String(err))
                              )
                            }
                          >
                            Restore
                          </button>
                          <ConfirmButton
                            title={`Delete ${p.name}?`}
                            description="Removes the device and its token for good. It can be added again later with a new token."
                            confirmLabel="Delete"
                            align="right"
                            trigger={<span>Delete</span>}
                            triggerClassName={rowButton}
                            onConfirm={() => mutate(p.deviceId, { method: "DELETE" })}
                          />
                        </>
                      ) : (
                        <>
                          {p.pullOnly ? (
                            <ConfirmButton
                              title={`Let ${p.name} push to this hub?`}
                              description="Its own edits start flowing here on its next sync. Until now it could only receive."
                              confirmLabel="Allow push"
                              align="right"
                              panelClassName="w-80"
                              trigger={<span>Allow push</span>}
                              triggerClassName={rowButton}
                              onConfirm={() => setPullOnly(p.deviceId, false)}
                            >
                              <ul className="ui-meta list-disc space-y-1 pl-4 text-ink-muted">
                                <li>
                                  Conflicts resolve per field by whichever write is newer, so a
                                  device with a wrong clock or a stale copy can overwrite values
                                  here.
                                </li>
                                <li>
                                  A losing body is kept in that item&apos;s revisions and flagged,
                                  so body edits are recoverable. Other fields are not.
                                </li>
                                <li>
                                  Its first push is held if it has more than a few hundred pending
                                  changes, which is the guard against a bad restore.
                                </li>
                                <li>Reversible here at any time, even while that device is offline.</li>
                              </ul>
                            </ConfirmButton>
                          ) : (
                            <button
                              type="button"
                              className={rowButton}
                              onClick={() =>
                                void setPullOnly(p.deviceId, true).catch((err) =>
                                  setError(err instanceof Error ? err.message : String(err))
                                )
                              }
                            >
                              Stop it sending
                            </button>
                          )}
                          <ConfirmButton
                            title={`Revoke ${p.name}?`}
                            description="Its next sync will be refused. You can restore it later."
                            confirmLabel="Revoke"
                            align="right"
                            trigger={<span>Revoke</span>}
                            triggerClassName={rowButton}
                            onConfirm={() => setRevoked(p.deviceId, true)}
                          />
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Add-device flow: name → token, shown exactly once. */}
      {minted && (
        <div className="mt-4 rounded-card border border-amber-500/40 bg-surface-2 p-3">
          <p className="text-sm text-ink">
            Token for <strong className="font-medium">{minted.name}</strong>:
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="break-all rounded bg-surface-3 px-2 py-1 font-mono text-xs text-ink">
              {minted.token}
            </code>
            <button
              type="button"
              className={rowButton}
              onClick={() => {
                void navigator.clipboard.writeText(minted.token);
                setCopied(true);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="ui-meta mt-2 text-amber-400">
            You will not see this token again. Paste it into the device&apos;s setup
            before closing this.
          </p>
          <button
            type="button"
            className="ui-meta mt-2 text-ink-subtle hover:text-ink"
            onClick={() => setMinted(null)}
          >
            Done, hide it
          </button>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void addDevice();
          }}
          placeholder="Device name (e.g. Study PC)"
          className="w-56 rounded-card border border-line bg-surface-0 px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
        />
        <label className="ui-meta flex items-center gap-1.5 text-ink-muted">
          <input
            type="checkbox"
            checked={pullOnlyNew}
            onChange={(e) => setPullOnlyNew(e.target.checked)}
          />
          Receive only, do not send (the safe way to start)
        </label>
        <button
          type="button"
          onClick={() => void addDevice()}
          disabled={busy || !name.trim()}
          className="rounded-card border border-line-strong bg-surface-2 px-3 py-1.5 text-sm text-ink hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? "Adding…" : "Add device"}
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-rose-400">{error}</p>}
    </div>
  );
}
