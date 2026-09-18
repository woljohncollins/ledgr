// Network (Build → MAINTAIN): where your changes go, and what syncs from here.
//
// HISTORY, because the shape of this page is a reaction to it. ADR-209 moved
// sync here; ADR-210 added per-hub cadence and fallback trust; ADR-212 added the
// addresses; ADR-213 added retention. Every part earned its place, and together
// they answered the SYSTEM's questions in the system's vocabulary. The owner's
// questions are simpler: is my stuff safe, is everything talking, and what do I
// do if not?
//
// So (exploration `sync-node-maturity.md` §2) the page now opens with the
// answer, in one sentence, plus the one action that fixes it when there is one
// (`summarizeSync`). Everything below it is the evidence, and per-row settings
// fold away so a row at rest is a name, a status phrase and a time. The status
// dots stay exactly as they were, as decoration on a sentence rather than as the
// message itself.
//
// Disclosure is native `<details>` rather than the app's RowMenu: RowMenu's
// actions are item mutations (Complete, Focus, Schedule, Trash) and these rows
// are not items. `<details>` is keyboard-reachable for free, needs no JS, and
// works in a server component.
//
// Everything is read server-side; the client islands are unchanged.
import Link from "next/link";
import { redirect } from "next/navigation";
import { resolveOwner } from "@/lib/owner";
import { nextDueSuffix, relativeTime } from "@/lib/relative-time";
import {
  gatherSyncStatus,
  hubCadence,
  hubFallback,
  hubOnChange,
  readSyncHubs,
  type FullSyncStatus,
  type HubConfig,
} from "@/lib/sync/client";
import { summarizeSync } from "@/lib/sync/summary";
import { listPeers, type PeerSummary } from "@/lib/sync/peers";
import { readJobOwners } from "@/lib/job-owners-store";
import { listInstalls } from "@/lib/installs";
import { MOVABLE_JOB_NAMES, ownershipWarning } from "@/lib/job-owners";
import SyncedDevices from "@/components/updates/SyncedDevices";
import SyncModeToggle from "@/components/updates/SyncModeToggle";
import { AddHub, HubSettings, RemoveHub } from "@/components/network/HubActions";
import CopyAddress from "@/components/network/CopyAddress";
import CopiesList from "@/components/network/CopiesList";
import {
  readLanIps,
  readTailscaleState,
  reachableAddresses,
  TAILSCALE_ABSENT,
} from "@/lib/network-addresses";
import ReleasePushButton from "@/components/network/ReleasePushButton";
import CheckInButton from "@/components/network/CheckInButton";
import {
  FallbackApprovalBlock,
  FallbackPromptBlock,
} from "@/components/network/FallbackPrompt";

export const dynamic = "force-dynamic";

function StatusDot({ tone }: { tone: "ok" | "warn" | "bad" | "info" }) {
  const color =
    tone === "ok"
      ? "bg-emerald-500"
      : tone === "warn"
        ? "bg-amber-500"
        : tone === "bad"
          ? "bg-rose-500"
          : "bg-neutral-500";
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${color}`} aria-hidden />;
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="mt-3 rounded-card border border-line bg-surface-1 p-4">{children}</div>;
}

function Mono({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-xs text-ink">{children}</code>
  );
}

/**
 * The "what is this?" fold every section carries, so the page teaches itself
 * instead of assuming the reader has read an ADR.
 */
function WhatIsThis({ children }: { children: React.ReactNode }) {
  return (
    <details className="mt-3 rounded-card border border-line bg-surface-2 p-3">
      <summary className="ui-meta cursor-pointer text-ink-subtle">What is this?</summary>
      <div className="mt-2 space-y-2 text-sm text-ink-muted">{children}</div>
    </details>
  );
}

export default async function Network() {
  const owner = await resolveOwner();
  if (!owner) redirect("/sign-in");

  let sync: FullSyncStatus = { enabled: false };
  let hubs: HubConfig[] = [];
  try {
    sync = await gatherSyncStatus();
    // Tokens are never rendered; only url + the two ADR-210 axes are read.
    hubs = await readSyncHubs();
  } catch {
    // A database without the sync tables just shows the empty states.
  }
  // This copy's own reachable addresses (ADR-212), so adding a device is
  // copy-from-here, paste-into-there. Only meaningful on a local peer: a cloud
  // deploy's address is its domain and nobody needs telling.
  const isLocal = !!process.env.LEDGR_SUPERVISOR_DIR;
  const tailscale = isLocal ? await readTailscaleState() : TAILSCALE_ABSENT;
  const myAddresses = isLocal
    ? reachableAddresses({
        tailscale,
        lanIps: await readLanIps(),
        port: Number(process.env.PORT) || 3000,
        // Bracket access on purpose: Next inlines the dotted form of a
        // NEXT_PUBLIC_* var at build time, and the supervisor builds with its own
        // environment rather than the app's, so the dotted form can bake in as
        // undefined here. The supervisor DOES pass it to `next start`.
        publicUrl: process.env["NEXT_PUBLIC_APP_URL"],
      })
    : [];

  let peers: PeerSummary[] = [];
  try {
    peers = await listPeers();
  } catch {
    // Same posture.
  }

  const hubStatusByUrl = new Map((sync.enabled ? sync.hubs : []).map((h) => [h.url, h] as const));

  // The headline reaches past sync on purpose: a job silently not running is the
  // same class of problem as a device silently not syncing, and the owner should
  // not have to visit two pages to learn either.
  const now = new Date();
  const jobOwners = await readJobOwners(owner.id);
  const roster = await listInstalls(owner.id);
  const jobWarnings = MOVABLE_JOB_NAMES.flatMap((job) => {
    const w = ownershipWarning({ owners: jobOwners, job, now });
    return w ? [w.text] : [];
  });
  const devicesNeedingAttention = peers.filter((p) => !p.revoked && p.hold.warn).length;
  // The inbound half. A revoked peer is shut out and a pull-only one never
  // sends, so neither counts as a device that pushes changes into this copy.
  const inboundDevices = peers.filter((p) => !p.revoked && !p.pullOnly).length;
  const summary = summarizeSync({
    sync,
    now,
    devicesNeedingAttention,
    jobWarnings,
    inboundDevices,
  });

  // The engine's blended `state` calls a hub that is merely NOT DUE "offline".
  // Presentation-only correction, the same distinction summarizeSync makes:
  // only a hub that was attempted and failed counts as unreachable here.
  const anyHubFailing = sync.enabled && sync.hubs.some((h) => h.lastError);

  return (
    <div className="mx-auto max-w-3xl px-5 py-8">
      <h1 className="ui-title">Network</h1>

      {/* ── The answer, first ───────────────────────────────────────────── */}
      <div
        className={`mt-4 rounded-card border p-4 ${
          summary.tone === "bad"
            ? "border-rose-900/60 bg-rose-950/20"
            : summary.tone === "warn"
              ? "border-amber-900/60 bg-amber-950/20"
              : "border-line bg-surface-1"
        }`}
      >
        <p className="flex items-start gap-2">
          <span className="mt-1.5">
            <StatusDot tone={summary.tone} />
          </span>
          <span>
            <span className="text-sm font-medium text-ink">{summary.headline}</span>
            {summary.detail && (
              <span className="mt-0.5 block text-sm text-ink-muted">{summary.detail}</span>
            )}
            {summary.action && (
              <a
                href={summary.action.href ?? "#hubs"}
                className="ui-meta mt-1.5 inline-block text-ink underline decoration-dotted underline-offset-2 hover:decoration-solid"
              >
                {summary.action.label}
              </a>
            )}
          </span>
        </p>
      </div>

      {/* ── The fallback decision, when there is one (ADR-210) ──────────── */}
      {sync.enabled && sync.fallbackPrompt && (
        <section className="mt-8" id="decision">
          <h2 className="ui-section-label">Needs your decision</h2>
          <FallbackPromptBlock prompt={sync.fallbackPrompt} />
        </section>
      )}
      {sync.enabled && !sync.fallbackPrompt && sync.fallbackApproval && (
        <section className="mt-8" id="decision">
          <h2 className="ui-section-label">Working from a backup</h2>
          <FallbackApprovalBlock approval={sync.fallbackApproval} />
        </section>
      )}

      {/* ── Where this copy sends its changes ───────────────────────────── */}
      <section className="mt-8" id="hubs">
        <h2 className="ui-section-label">Where your changes go</h2>
        <Card>
          {hubs.length === 0 ? (
            <p className="text-sm text-ink-muted">
              Nothing. This copy sends its changes nowhere.{" "}
              {inboundDevices > 0 ? (
                <>
                  It is a main copy: {inboundDevices}{" "}
                  {inboundDevices === 1 ? "device sends" : "devices send"} their changes{" "}
                  <a href="#devices" className="underline decoration-dotted underline-offset-2">
                    here
                  </a>{" "}
                  instead, and everything written on any of them arrives here.
                </>
              ) : (
                <>
                  Everything you write stays on this device only. Add another copy of
                  Ledgr and the two keep each other up to date; you will need a
                  one-time code from that copy&apos;s Devices list.
                </>
              )}
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {hubs.map((hub, i) => {
                const url = hub.url;
                const h = hubStatusByUrl.get(url);
                const reading = h?.pulling ?? hubFallback(hub) === "automatic";
                const isActive =
                  sync.enabled && sync.activeHubIndex === i && sync.state !== "offline";
                let host = url;
                try {
                  host = new URL(url).hostname;
                } catch {
                  // an unparseable URL shows as typed
                }
                return (
                  <li key={url} className="py-2.5">
                    {/* A row at rest: name, one status phrase, one time. */}
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <StatusDot tone={h?.lastError ? "warn" : h?.lastSyncAt ? "ok" : "info"} />
                      <span className="min-w-0 flex-1 basis-64">
                        <span className="block truncate text-sm text-ink">
                          {host}
                          {i === 0 && hubs.length > 1 && (
                            <span className="ui-meta ml-2 text-ink-subtle">main copy</span>
                          )}
                          {isActive && <span className="ui-meta ml-2 text-ink-subtle">in use</span>}
                        </span>
                        <span className="ui-meta block text-ink-subtle">
                          {h?.lastSyncAt ? `synced ${relativeTime(h.lastSyncAt)}` : "not yet synced"}
                          {/* A once-a-day copy is idle almost all the time. Saying
                              when it next runs is what makes the quiet legible
                              instead of looking like something is wrong. */}
                          {nextDueSuffix(h?.nextDueAt)}
                          {h?.behindOps !== null && h?.behindOps !== undefined && h.behindOps > 0
                            ? ` · ${h.behindOps} of your changes not there yet`
                            : ""}
                          {!reading ? " · receiving from it is off" : ""}
                        </span>
                        {h?.lastError && (
                          <span className="ui-meta block text-amber-400">{h.lastError}</span>
                        )}
                      </span>
                    </div>

                    {/* Everything you can change about this copy, folded away. */}
                    <details className="mt-1.5">
                      <summary className="ui-meta cursor-pointer text-ink-faint hover:text-ink-subtle">
                        Settings
                      </summary>
                      <div className="mt-2 flex flex-wrap items-center gap-3">
                        <HubSettings
                          url={url}
                          cadence={hubCadence(hub)}
                          fallback={hubFallback(hub)}
                          onChange={hubOnChange(hub)}
                          canMoveUp={i > 0}
                          canMoveDown={i < hubs.length - 1}
                        />
                        <RemoveHub url={url} />
                      </div>
                      <p className="ui-meta mt-2 break-all text-ink-faint">{url}</p>
                    </details>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <AddHub />
            {hubs.length > 0 && <CheckInButton />}
          </div>
          {hubs.length > 0 && (
            <p className="ui-meta mt-2 text-ink-subtle">
              A schedule works both ways: between check-ins, your changes wait here
              and changes made on another copy have not arrived yet. Checking in now
              settles both immediately, whatever the schedule says.
            </p>
          )}

          <WhatIsThis>
            <p>
              Every copy listed here receives everything you write, each on its own
              schedule. A backup that stops receiving is not a backup, so they all
              get your changes even when one is slow.
            </p>
            <p>
              The order matters for <em>reading</em>: Ledgr reads from the first one
              that answers, and the top of the list is your main copy. A copy set to
              &ldquo;ask me first&rdquo; is written to but never read from until you
              say so, because reading from a day-old copy makes everything look
              fresher than it is.
            </p>
          </WhatIsThis>

          {hubs.length > 0 && (
            <details className="mt-3 rounded-card border border-line bg-surface-2 p-3">
              <summary className="ui-meta cursor-pointer text-ink-subtle">
                Moving to a different main copy
              </summary>
              <div className="mt-2 space-y-2 text-sm text-ink-muted">
                <p>
                  This is not a setting, and changing the address alone would be the
                  wrong thing: two copies that have drifted apart would merge field
                  by field, mixing them together. The new main copy has to be filled
                  from the old one first.
                </p>
                <ol className="list-decimal space-y-1 pl-5">
                  <li>Stop Ledgr on this machine.</li>
                  <li>
                    Fill it from the copy you are moving to:{" "}
                    <Mono>npm run local:restore -- --from-url &lt;its database&gt;</Mono>
                  </li>
                  <li>Start Ledgr again, then add that copy here and remove the old one.</li>
                </ol>
              </div>
            </details>
          )}
        </Card>
      </section>

      {/* ── This copy's own link state ──────────────────────────────────── */}
      {sync.enabled && (
        <section className="mt-8" id="state">
          <h2 className="ui-section-label">This device</h2>
          <Card>
            <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[9rem_1fr]">
              <dt className="ui-meta text-ink-subtle">Sending</dt>
              <dd className="text-sm text-ink">
                {sync.mode === "pull-only"
                  ? "Off. This device receives changes but never sends its own."
                  : "On. Changes you make here go to your other copies."}
                <SyncModeToggle mode={sync.mode} />
              </dd>

              <dt className="ui-meta text-ink-subtle">Right now</dt>
              <dd className="flex items-center gap-2 text-sm text-ink">
                <StatusDot
                  tone={
                    sync.state === "synced" && sync.activeHubIndex === 0
                      ? "ok"
                      : sync.state === "held" || (sync.state === "offline" && anyHubFailing)
                        ? "warn"
                        : sync.state === "offline"
                          ? "ok"
                          : "info"
                  }
                />
                {sync.state === "synced"
                  ? "Up to date"
                  : sync.state === "pending"
                    ? "Sending your latest changes"
                    : sync.state === "held"
                      ? "Not sending (still receiving)"
                      : anyHubFailing
                        ? "Nothing is answering"
                        : "Nothing due right now"}
              </dd>

              {sync.state === "held" && (
                <>
                  <dt className="ui-meta text-ink-subtle">Why</dt>
                  <dd className="text-sm text-amber-400">
                    {sync.holdReason === "first_push_size" ? (
                      <>
                        {sync.heldOpsCount} change
                        {sync.heldOpsCount === 1 ? "" : "s"} is more than Ledgr sends
                        without asking. That guard exists because a bad restore looks
                        exactly like thousands of edits. If these are real (an import,
                        a bulk edit), send them:
                        <br />
                        <ReleasePushButton heldOpsCount={sync.heldOpsCount ?? 0} />
                      </>
                    ) : (
                      `This device's clock is about ${Math.round(Math.abs(sync.skewMs ?? 0) / 1000)} seconds out, which is too far to tell which edit is newer. Fix the clock, then restart Ledgr.`
                    )}
                  </dd>
                </>
              )}

              {sync.state !== "held" && sync.skewWarn && (
                <>
                  <dt className="ui-meta text-ink-subtle">Clock</dt>
                  <dd className="text-sm text-amber-400">
                    About {Math.round(Math.abs(sync.skewMs ?? 0) / 1000)} seconds out.
                    Still syncing, but worth fixing.
                  </dd>
                </>
              )}

              <dt className="ui-meta text-ink-subtle">Waiting to send</dt>
              <dd className="text-sm text-ink tabular-nums">
                {sync.pendingOps === 0
                  ? "Nothing"
                  : `${sync.pendingOps} change${sync.pendingOps === 1 ? "" : "s"}`}
              </dd>

              <dt className="ui-meta text-ink-subtle">Last exchange</dt>
              <dd className="text-sm text-ink">
                {sync.lastSyncAt ? relativeTime(sync.lastSyncAt) : "Not yet since starting up"}
              </dd>

              {sync.lastError && (
                <>
                  <dt className="ui-meta text-ink-subtle">Last problem</dt>
                  <dd className="text-sm text-amber-400">{sync.lastError}</dd>
                </>
              )}
            </dl>

            <WhatIsThis>
              <p>
                Conflicts never need your attention: when the same field is changed
                in two places, the newer edit wins, and the one that lost is kept in
                that item&apos;s history. That is why a wrong clock matters more here
                than it looks like it should.
              </p>
              <p>
                Turning sending off is the safe way to try a new device: let it
                receive everything first, confirm it looks right, then turn sending
                on.
              </p>
            </WhatIsThis>
          </Card>
        </section>
      )}

      {/* ── This copy's own addresses (ADR-212) ─────────────────────────── */}
      {isLocal && (
        <section className="mt-8" id="addresses">
          <h2 className="ui-section-label">How other devices reach this one</h2>
          <Card>
            {myAddresses.length === 0 ? (
              <p className="text-sm text-ink-muted">
                No address to hand out yet. {tailscale.detail ?? "Tailscale is not installed here."}{" "}
                The easy path is Tailscale on both machines, signed into the same
                network: the address then becomes{" "}
                <Mono>http://&lt;machine&gt;.&lt;your-tailnet&gt;.ts.net:3000</Mono> from
                anywhere, with nothing exposed to the internet.
              </p>
            ) : (
              <ul className="divide-y divide-line">
                {myAddresses.map((a) => (
                  <li key={a.url} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
                    <StatusDot tone={a.preferred ? "ok" : "info"} />
                    <span className="min-w-0 flex-1 basis-64">
                      <span className="block truncate font-mono text-sm text-ink">{a.url}</span>
                      <span className="ui-meta block text-ink-subtle">
                        {a.label} · {a.note}
                      </span>
                    </span>
                    <CopyAddress value={a.url} />
                  </li>
                ))}
              </ul>
            )}
            <WhatIsThis>
              <p>
                Paste one of these into the other device&apos;s{" "}
                <strong className="font-medium text-ink-muted">Add copy</strong> field,
                along with a one-time code from the Devices list below.
              </p>
              <p>
                A phone or laptop on your own private network needs nothing more than
                this, and nothing is exposed to the internet. Publishing this machine
                publicly is only needed for something that cannot join that network,
                and the one that matters is the Claude connector, because its requests
                come from Anthropic&apos;s servers rather than from a device of yours.
              </p>
            </WhatIsThis>
          </Card>
        </section>
      )}

      {/* ── The roster: every copy the owner runs (ADR-220) ─────────────── */}
      <section className="mt-8" id="copies">
        <h2 className="ui-section-label">Your copies of Ledgr</h2>
        <Card>
          <CopiesList installs={roster} />
          <WhatIsThis>
            <p>
              Every copy of Ledgr you run adds itself to this list and checks in
              once a day, so this is the one place that knows about all of them at
              once. It is how the scheduled-work picker on{" "}
              <Link href="/build/jobs#scheduled-work" className="hover:underline">
                Scheduled Jobs
              </Link>{" "}
              can send a job to a machine you are not sitting at.
            </p>
            <p>
              Names are yours to set. Each machine is named when it is set up, and
              you can rename any of them from here, including ones that are
              switched off. Removing a copy only removes it from this list; if that
              machine is still running Ledgr it will add itself back tomorrow.
            </p>
          </WhatIsThis>
        </Card>
      </section>

      {/* ── Devices that sync from this copy (hub side) ─────────────────── */}
      <section className="mt-8" id="devices">
        <h2 className="ui-section-label">Devices that sync from here</h2>
        <Card>
          <SyncedDevices initialPeers={peers} />
          <WhatIsThis>
            <p>
              Adding a device gives you a one-time code to paste into it. New devices
              start out receiving only, which is the safe order: let it fill up,
              check it looks right, then allow it to send.
            </p>
            <p>
              A device that has been away a long time is the one case that needs a
              decision. Ledgr keeps the changes it missed so it can catch up, and
              that storage cannot be reclaimed while it waits, so after a while it
              stops keeping them and that device needs a fresh copy to return
              instead. This list warns you before that happens.
            </p>
          </WhatIsThis>
        </Card>
      </section>

      <p className="mt-8 text-sm text-ink-muted">
        Which machine runs the shared scheduled jobs lives on{" "}
        <Link href="/build/jobs" className="hover:underline">
          Scheduled Jobs
        </Link>
        . Whether this copy is running the latest Ledgr lives on{" "}
        <Link href="/build/updates" className="hover:underline">
          Updates
        </Link>
        .
      </p>
    </div>
  );
}
