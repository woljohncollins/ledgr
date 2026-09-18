# Exploration: sync-node maturity (export from a local peer, plainer vocabulary, real cadences)

**Status: EVERY NUMBERED SECTION IS NOW BUILT.** §1 and §1b (ADR-218), §2 (ADR-219), and §3 + §4 (ADR-221, whose cadence half is CORE-adjacent and acked by Tyler). Of the options list below, #2 (job-ownership legibility) landed with §1 and #3 (local snapshots) landed as ADR-217. **What remains open is options #4, #5, #6 and #7 only** (#1 and the last of #2 landed as ADR-225), and this doc is kept for them plus the reasoning above. Anything still open here that touches the sync engine, the export contract, or ADR-206 vocabulary graduates through an ADR before it is built.

> **UPDATE, same day: §1's missing half is BUILT (ADR-220, Tyler acked).** The registry below is no longer hypothetical — `installs` is a synced table keyed by each copy's own `sync_device.id`, so the dropdown this doc asked for exists, and §3 and §4 are both cheaper than when they were written because the roster is the foundation they wanted. The paragraph below is kept because the id-space trap it records is the reason the first attempt could not work.
>
> **§1 shipped with one correction to its own design, and it is worth reading before building §3 or §4.** The dropdown this doc proposes ("Runs on: [this machine / BC-EDGEWOOD / Cloud / Nowhere], editable from any install") **cannot be built as written.** It rests on "every install already has a stable device identity from `sync_device`" — true — but the hub's list of *other* installs (`sync_peers`) is keyed by a uuid the **hub minted** at add-device time, which is never reconciled with that peer's own `sync_device.id`. The two id spaces never meet, so "assign the job to that row over there" needs either a new synced table or a wire change, both core. What shipped instead: the slot carries the claiming machine's own id **and its label**, so claiming is per-machine ("Run it here") while pausing and handing back work from anywhere. Exactly-one is unaffected. **A cross-install device registry is the follow-up that would restore this doc's shape, and it is core.**
>
> Also shipped, because moving the job without it would have been ceremony: export's per-run caps (30 items / 45s, sized for the 60s lambda) lift to 500 items / 20 minutes when the job runs on a supervised peer.

**Where it came from:** the first days of running two local peers (a prod-data hub and a dev-data hub on one machine) alongside the cloud. Four observations, then a list of maturity options worth weighing when this work is picked up.

## 1. The OneDrive export should run from a local peer — BUILT (ADR-218)

**The itch.** The cloud export runs in a 60-second Vercel lambda, capped at 30 items and 45 seconds per run (`src/lib/export/engine.ts`). Measured on 2026-08-25: the queue no longer drains. About 30 items export per night while more than 30 change per day, so `remaining` climbed from 24 to 38 in two days and `lastSuccessAt` (zero errors AND nothing remaining) stopped advancing. Nothing is failing; throughput fell behind the edit rate, which is exactly the ceiling the `ponytail:` comment in the engine predicted.

**What already exists (this is nearly config, not a build):**

- The supervisor's job runner already knows the export job and already treats it as exclusive: `crons.export` is off by default with the reason recorded in the README table ("One OneDrive folder, and `items.exported_at` is synced"). Turning it on is a config line: `"export": { "at": "04:10" }`.
- The engine already writes through an `ExportTarget` interface (`src/lib/export/target.ts`), and a `LocalExportTarget` (`local.ts`) already implements it against a plain folder. The Graph/OneDrive target is just the production binding.

**The GUI (the actual proposal).** One card, plain words, no new page. It lives on Build → Updates on a machine that could do the work (the same gating the other local sections already use), and the whole design goal is: the owner reads a sentence, clicks one button, and never learns the words "cron", "target", or "Graph".

The card, on the local machine:

> **Offline backup**
> Every night, Ledgr writes a copy of everything to your OneDrive as plain files. That copy is what you'd open if the internet were down.
>
> Runs from: **the cloud** · 38 items behind, catching up ~30 per night
>
> This machine has no time limit, so it can keep the backup fully current.
> **[ Move the nightly backup to this machine ]**

After clicking, the same card reads:

> Runs from: **this machine (BC-EDGEWOOD)** · up to date · last night: 412 items, 0 errors
> **[ Move it back to the cloud ]**

And on every *other* instance (the cloud, another peer), the card is one status line, no controls: "Offline backup runs from BC-EDGEWOOD · up to date." Nobody trips over a control that isn't theirs, and everybody can see who owns the job — which is the misconfiguration that actually hurts (two writers on one folder).

**The design center (Brandon, 2026-08-25, correcting two earlier drafts): this is a FEATURE with a picker, not an architecture change.** The owner should be able to point the backup at *any* install. The design challenge is that it can only ever be ONE install, so the system — not the owner's memory — must guarantee exactly-one. And the same guarantee generalizes: every exclusive job (email import, calendar sync, todoist, transcription, health-check) is the same feature with a different row.

**How exactly-one is guaranteed — make two owners unrepresentable, then verify liveness.** Three layers, cheapest first:

1. **The setting is a single slot, so a conflict cannot be stored.** Ownership lives in the synced settings (`users.settings` is already in the ADR-206 synced-table list; every install already has a stable device identity from `sync_device`): one field per job, holding one device id — `jobOwners: { export: <device>, "email-import": <device>, … }`. Choosing a new owner *is* removing the old one, because there is only one slot. The GUI matches: not a per-machine on/off toggle (two machines could both be "on"), but **one dropdown per job — "Runs on: [this machine / BC-EDGEWOOD / Cloud / Nowhere]"** — editable from any install, because the setting syncs everywhere.
2. **Every install re-reads ownership immediately before each run.** "Am I still the owner?" is one indexed read. This turns the one genuinely unpreventable race — two installs assigned while partitioned, resolved by LWW when they reconnect — into *at most one* duplicated run, after which the loser sees it lost and stands down. The loser also surfaces it: "Backups moved to BC-EDGEWOOD while this machine was offline."
3. **The network page verifies the owner is ALIVE, which is Brandon's "system checks all the installs" world.** No probing needed: the hub already records every peer's `last_seen_at`. The devices table grows an ownership column, and two warning states fall out of data that already exists — **"nobody owns backups"** (the slot is empty or the owner was revoked) and **"the owner hasn't been seen in 9 days"** (a job silently not running, which is the failure that actually hurts). Both are one sentence plus the fix: the same dropdown.

**Defaults keep today's behavior:** every slot starts pointed at the cloud, so an owner who never opens the picker changes nothing.

**Where the cloud's wake-cost fits (a consideration, not the driver):** an install that is not the owner skips the work but its schedule may still fire and wake Neon for the check. Fine to live with day one. If the wakes matter later, trimming the cloud's schedules once ownership has stably moved is an ops follow-up the feature enables — not something the feature requires.

**Per-job handoff notes (the part that is genuinely per-job):** `export` hands off cleanly because `items.exported_at` is synced — the new owner already knows what's been exported. `email-import` keeps its mailbox delta cursor in unsynced `job_state`, so a new owner starts a fresh delta; confirm re-import is idempotent before offering the dropdown for it. `calendar-sync`'s dedup across a handoff (matched events are synced items, but the match cache isn't) needs the same one-time verification. Ship the dropdown per job as each handoff is proven, export first — it is the one already failing, and the one whose late run is harmlessly recoverable.

**One collapsed detail, for exactly one person.** Behind a "Details" fold on that card, a single choice with honest labels:

- **Upload to OneDrive over the internet** (default — works the same way the cloud does it today)
- **Write straight into the OneDrive folder on this PC** — fastest; the OneDrive app on this computer finishes the upload. Only makes sense on a machine that runs the OneDrive app. [folder path field]

That second option exists because the export engine already knows how to write plain files to a folder (it's how the test suite runs it); pointing it at the folder the OneDrive app watches means no tokens, no rate limits, and the backup lands on disk *and* in the cloud. It's collapsed because Brandon is likely its only user — defer-by-hiding, but findable and explained where it lives.

**Recommendation when picked up:** ship the card with just the move-ownership button first (the synced-ownership flag is the one real piece of engineering); add the folder option inside Details second. The exclusivity rule is the whole safety story, and the card's design *is* the exclusivity rule made visible.

## 1b. The same feature covers every exclusive job — BUILT (ADR-218), export claimable, the other five read-only until each handoff is proven

Once the single-slot ownership exists, "which install runs the backup" and "which install reads the mailbox" are the same control. One **Scheduled work** card, one row per movable job, one dropdown each — and the exactly-one guarantee comes from the mechanism in §1, identically for all of them. For scale, measured from `vercel.json` and `.github/workflows/` on 2026-08-25, a weekday wakes the cloud database in **seven distinct windows** (autosuspend is 5 minutes, so each cron is its own wake unless two share a minute):

| Time | Job | Scheduled from | Exclusive? |
| --- | --- | --- | --- |
| 06:30 | export | Vercel | yes |
| 07:00 | neon-snapshot | Actions | cloud-specific |
| 08:00 | purge | Vercel | no — every instance must run its own |
| 09:00 | relatedness | Vercel | no — per-instance cache |
| 13:00 | calendar-sync + email-import | Actions | yes (both) |
| 18:00 | calendar-sync | Actions | yes |
| 22:00 | calendar-sync + email-import | Actions | yes |

(The 13:00 and 22:00 pairing is deliberate — the runbook notes the weekday shaping exists to share wake windows. `todoist-sync` and `transcription-poll` fire often but are config-gated no-ops that return before touching the database, so they are not wakes today.)

Four of those seven windows exist only for **exclusive** jobs — the ones ADR-214 already says exactly one peer may run. The feature makes each of them movable with the same dropdown, and an owner who moves them all leaves the cloud waking only for its own housekeeping (purge, relatedness, its snapshot) plus whenever a peer syncs to it or a human opens it. That is what "the cloud is a backup peer" (ADR-206 decision 4) looks like in practice — reached one deliberate dropdown at a time, never forced.

**The honest trade the picker should say out loud for calendar and email:** those jobs stop happening when the chosen machine is off. Today the cloud runs them whether or not any machine of Brandon's is awake. That is a reliability judgement the owner makes per job — which is exactly why the control is a per-job dropdown rather than a wholesale mode. The dropdown's row for a job can carry the one-line consequence ("runs only while BC-EDGEWOOD is on"), and the liveness warning from §1 layer 3 is the safety net when the judgement goes stale. Export is the safe first move because a late backup is recoverable; a missed email import silently consumes the mailbox.

## 2. The Network page needs a user-friendliness pass, not just decluttering — BUILT (ADR-219)

ADR-209 moved sync here; ADR-210 added per-hub cadence and fallback trust; ADR-212 added the addresses section; ADR-213 added retention holds to the devices table. Each earned its place, and together they are getting dense — but density is the smaller half of the problem. The page currently explains itself in the system's vocabulary (hubs, cursors, oplog, fallback trust, retention holds), and the owner's questions are simpler than that: *is my stuff safe, is everything talking, and what do I do if not?*

When this pass happens, the ideas to explore, roughly in order:

- **Answer-first layout.** The top of the page is one plain sentence, not a status grid: "Everything is syncing normally. Last change reached your other devices 2 minutes ago." Amber and red states swap in an equally plain sentence *plus the one action that fixes it* ("The cloud copy hasn't answered since 4pm. It usually fixes itself; if this persists past an hour, check your internet or [use the backup]"). The existing pill/dot grammar stays, but as decoration on the sentence, not the message itself.
- **Task-shaped flows over settings-shaped forms.** The real tasks are countable: add a device, retire a device, check on a device, move to a new primary. Each deserves a short guided flow (the add-device flow already half-exists via the token mint); the settings grid is what's left over for the rare manual tweak.
- **Progressive disclosure per row.** Cadence, fallback trust, retention, remove — fold behind the row (the RowMenu pattern the rest of the app already uses), so a row at rest is name + one status phrase + one timestamp.
- **A plain-language pass on every string**, applying the existing house rule ("standardized, generic language in the tool's UI") to sync: "fallback trust" becomes something like "use this backup automatically / ask me first"; "retention hold" becomes "keep changes for this device while it's away"; "pull-only" becomes "receive changes but never send". The concepts are fine; the words are engineering.
- **Explain-on-first-sight.** Each section keeps one collapsible "what is this?" written for a non-technical owner (the tooltip standard, or a details fold), so the page teaches itself instead of assuming ADR knowledge.
- **Resist a second page** until a real task can't be done on one screen; splitting status from configuration is the fallback shape if one screen genuinely fails.

## 3. Hub/spoke may be one layer of vocabulary too many — BUILT (ADR-221)

**Brandon's instinct:** "Really, it's just sync nodes and we determine which pushes and pulls to what."

**What the code says:** the instinct is nearly already true. `role` in the supervisor config is documented as "informational: it changes no behavior on its own." What actually distinguishes peers is three per-node or per-link facts:

- **Reachability:** does this node have a URL others can reach (published, always-on)?
- **Initiative:** who dials? The initiating side runs the sync loop; the listening side just answers `/api/machine/sync`. This asymmetry is real and worth keeping (it is what makes NAT and sleep a non-problem: the node behind the laptop lid always dials out).
- **Per-link posture:** cadence, fallback trust, pull-only mode, retention hold. All already per-hub (ADR-210/213).

So the simplification is mostly words, not wire: keep the initiator/listener protocol exactly as is, and let "hub" dissolve into "a peer that others point at." The Network page already speaks this language ("it can sync TO hubs, and other devices can sync FROM it"); the remaining hub/spoke vocabulary lives in docs, the wizard's role question, and ADR-206 prose. Renaming is cheap in UI copy, expensive in docs, and the docs can drift toward "peer" naturally as they are touched. One honest counterpoint before dropping the words entirely: "hub" compresses a real bundle (published + always-on + runs the exclusive jobs + others point at it), and a name for that bundle keeps the wizard's first question answerable by a non-technical owner. Candidate resolution: the wizard asks "will other devices sync from this machine?" instead of "hub or spoke?", and the word hub survives only as a label the UI derives, never a mode the owner sets.

**Built exactly that way (ADR-221).** Code identifiers, config fields and docs keep hub/spoke; the wizard asks the yes/no question and derives the role, with `--role hub|spoke` still working verbatim for unattended runs. The remaining owner-facing "hub" strings were the CONTROLS, since ADR-219 had already done the status half: Add a copy, "Web address of that copy", "Stop syncing to this copy?", "What your usual copies said". The residual "instance" leaks in the same files went with them.

## 4. Real cadence options (continuous/daily is too coarse) — BUILT (ADR-221, CORE-adjacent, Tyler acked)

`HubCadence` is a two-value enum today ("continuous" | "daily", `src/lib/sync/client.ts`). Brandon wants the ordinary ladder: continuous, 1 min, 5 min, 15 min, hourly, daily, weekly.

**Shape that fits the existing code:** store an interval, not an enum. `cadenceIntervalMs()` already reduces the enum to a number; let the config carry `{ everyMinutes: N }` with the presets as UI sugar, parse-tolerant so stored "continuous"/"daily" read as their equivalents (same tolerant-additive pattern as ADR-210's hub fields). The GUI stays a dropdown of presets; no cron expressions (the supervisor's job config already made that call and says why).

**The two interactions that make this more than a dropdown:**

- **Retention.** A weekly hub pins the oplog for a week (ADR-213 measured ~8.3 KB per op; ~25 MB/month per parked peer). The cadence picker should surface the consequence: choosing weekly on a device warns what it holds, and `grace_days` should default sensibly from cadence rather than requiring separate tuning.
- **Staleness.** A cursor older than `sync:prunedThrough` is refused with 410 (ADR-208). Long cadences raise the odds. The refusal is the safety working as designed, but the picker should keep the owner out of the trap: refuse or warn on any cadence longer than the effective retention window.

**Also worth deciding then:** anchored vs relative. "Daily" today means "24h after the last exchange," which drifts. An anchored form ("daily at 03:00", like the supervisor's `{ at: "HH:MM" }` jobs) is what people expect from the word; the interval form is what "every 15 minutes" expects. Supporting `{ everyMinutes }` OR `{ at }` per hub mirrors the jobs config exactly, one grammar across both systems.

**BUILT (ADR-221), and here is what the build changed about this section's own plan.** The interval shipped as proposed, tolerant of the stored strings. The two interactions resolved differently from the sketch:

- **Staleness became the cap rather than a warning.** The rule is "you must be able to miss ONE sync and still be inside the retention window", two intervals not one, because a machine off over a long weekend has missed exactly one. Against the default 14 days that lands on weekly, so the ladder stops there and anything longer is refused with the reason. No warning state was needed, because the picker cannot produce an unsafe value.
- **Retention did NOT need `grace_days` derived from cadence, and could not have had it cheaply.** The window lives on the HUB, per remote device; the cadence lives on the peer. Opposite machines, so deriving one from the other is a wire change, the same shape of finding as ADR-218's id-space trap. It is also moot while the cap holds: every offered cadence already fits the default window. **The trigger for revisiting is a preset longer than weekly.**
- **Anchored was decided AGAINST.** Sync is about how stale you are willing to be, not about when work is cheap, and the interval form self-heals across a sleeping laptop where an anchored one silently skips a day. The case that would justify it is "only sync overnight" for bandwidth, and that wants a window rather than an instant.
- **No wire field was needed at all**, because both peers run the same build (the version gate refuses otherwise), so the default window is a shared constant rather than a fact to fetch, and a hub-side override can only widen it. A local check can be wrong only in the safe direction.

## Other maturity options to weigh (the brainstorm answer)

Ordered roughly by value-for-effort as of today:

1. ~~**A per-hub "Sync now" button.**~~ **BUILT (ADR-225), as one button for every copy rather than one per hub.** The single most-wanted control on any sync UI, and it makes long cadences livable. It arrived because a long cadence turned out to be worse than this section assumed: the per-hub cadence gates the exchange in **both** directions, so an hourly copy was also holding its own writes for up to an hour, and nothing anywhere could ask it to hurry. **Check in now** on Build → Network sets a flag the loop reads on its next tick (~2s) and zeroes every hub's next-due, so it cannot race the cursors the way a second exchange path would. Per-hub was dropped deliberately: the owner's question is "am I up to date", not "am I up to date with copy 2 of 3".
2. ~~**Job-ownership legibility.**~~ **BUILT (ADR-218/219, and finished by ADR-225).** The slot made "two peers claim export" unrepresentable and the liveness warning covers "nobody runs export". What ADR-225 had to add was the case neither this section nor the build anticipated: **assigned to a machine that cannot run it.** Ownership was two switches (the synced slot, plus `crons` in the peer's config file, which defaulted exclusive jobs off), so naming a peer moved the permission to a machine with no trigger and the job ran on neither copy. The lesson worth carrying to anything else on this list: a permission and a trigger held in different layers is a misconfiguration waiting to happen, and the fix is to collapse them, not to detect the mismatch.
3. **Local snapshot + restore drill.** The snapshot half is **BUILT (ADR-217, and switched on from the GUI as of ADR-222** — the supervisor schedules it hourly on every peer and the endpoint reads an on/off setting, so turning restore points on is a checkbox rather than a config edit and a service restart). Hourly `pg_dump` thinned into a tiered spread, browse-only recovery, a Snapshot-now button. The DRILL is still open, and it is the half that matters most: a documented quarterly "prove the dump restores" is the difference between having backups and believing in them. Pairs with #1 in a "this machine owns the data safety" story.
4. **Staleness alerting on the owner's terms.** _(Partly reached from the other side by ADR-225: a job assigned to a copy nothing has heard from is called out at the moment of assignment, and a stood-down run is recorded as a stand-down rather than as work done. What is still missing is the push.)_ The weekly cloud health check exists; a local analog ("push me if any peer hasn't synced in N x its cadence") turns the quiet-hold problem into a notification instead of a page to remember to visit.
5. **Conflict visibility.** LWW merges are deterministic and silent by design; the "merged offline, check revisions" flag exists in the model but has no surface. A small "recent merges" list (item, when, which device lost) closes the loop without changing semantics.
6. **Attachment strategy for peers.** Blobs are R2-only through cutover (ADR-206 decision 8). When that reopens (the "Netflix model"), cadence and retention thinking from #4 above applies to blobs too; keep one vocabulary.
7. **Per-peer boot registration.** Already queued in next_steps: `STARTUP_TASK_NAME` is one constant, so one machine can boot-start only one peer. Small, and it unblocks the "two peers, one machine" rig from being fully hands-off.
8. **Wizard question rewrite** (from §3): replace "hub or spoke?" with "will other devices sync from this machine?" and derive the rest.

## What this doc deliberately does not propose

- No second sync protocol, no P2P mesh changes, no CRDTs. The initiator/listener shape and LWW merge semantics are locked (ADR-206) and nothing here strains them.
- No new settings surface for the export move (§1); config plus the existing jobs list is the whole UI.
- No immediate rename ("hub" stays in code identifiers; only owner-facing copy drifts toward "peer").
