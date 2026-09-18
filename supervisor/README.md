# Ledgr local-peer supervisor (LH2, ADR-206)

One long-running Node process that owns everything a local Ledgr peer needs:
embedded Postgres, the app (`next start`), and the update apply path. No
system Postgres install, no service wiring beyond registering this one
process to run at boot.

## Run, stop, and check it

```
npm run local:supervisor          # start it (foreground; this is the process)
npm run local:status              # is it running? serving? which build? at boot?
npm run local:status -- --json    # the same, for a script or an install agent
npm run local:stop                # stop it cleanly
npm run local:startup             # show or change "start when Windows starts"
```

Any of these takes `--config=<path>` when the config is not
`supervisor/config.json` (useful when one machine hosts more than one peer).

`status` separates two facts that fail independently: whether the **supervisor
process** is alive, and whether the **app actually answers** on its port — a
supervisor can be up while a bad build is down. It also reports the boot
registration by asking Windows, not by trusting what we last wrote. Its exit
code is 0 when running and 1 when not, so an install script can branch on it.

`stop` asks through a file (`stop-requested`) rather than signalling the
process. On Windows a termination signal from another process is not something
Node can catch: it terminates outright, so the shutdown path never runs,
Postgres is killed rather than shut down, and the lock file is left behind
looking like a live owner. Asking lets the process stop itself the same way
Ctrl-C does. An update already in flight is not interrupted, so a stop during a
build waits for it.

### Start when Windows starts

The ordinary desktop-app checkbox, and it is a real choice:

| Scope | What it means |
| --- | --- |
| `--logon` | Starts when you sign in. **No administrator prompt.** Right for a laptop or desktop you use. |
| `--always` | Starts at boot, before anyone signs in. What a **hub** needs, since your phone and Claude reach it whether or not you are at the desk. Expect an administrator prompt. The task is registered the passwordless way (S4U), so it runs with nobody signed in and needs no saved Windows password. The service also re-checks this registration with Windows on every start and refreshes its recorded state, so a stale warning from an older build clears itself on the next restart instead of lingering. |

```
npm run local:startup -- --logon
npm run local:startup -- --always
npm run local:startup -- --disable
```

The same setting is a toggle in the app at **Build → Updates → Start with the
computer**. The app cannot register a scheduled task itself, so it writes a
request (`startup-requested`) that the supervisor carries out, then reports what
happened — including a failure, with the exact command to run in an
Administrator prompt instead. A silent failure here is the expensive kind: you
would believe your hub survives a reboot when it does not.

**macOS and Linux are still by hand.** The wizard prints the launchd plist and
the systemd user unit to create; `npm run local:startup` says so rather than
pretending. Automating those is queued.

### The tray icon (Windows)

`npm run local:tray` puts a small icon in the notification area: green when
Ledgr is running, amber while it starts up or the app is down with a healthy
database, red when nothing is running. Right-click it to open Ledgr, start,
restart, or stop the service, or open **Ledgr status…**, a window with two
tabs. **Status** is read-only: run state, the build version and when it last
updated, the update policy, disk use per data folder, the scheduled jobs
table, and this machine's role in the sync network, plus buttons to open
Ledgr, its data folder, and its logs. **Settings** edits the update policy
(auto-check cadence, branch, repository) — the same `update-policy.json` the
service itself reads every minute, so a saved change there needs no restart.
It is the only thing the tray writes: it never touches `config.json` and
never restarts anything on its own. Turn the icon off with the same command
and `-- --uninstall`; the service itself is untouched either way.

## Configure

```
cp supervisor/config.example.json supervisor/config.json   # gitignored
```

| Key | Meaning |
| --- | --- |
| `role` | `hub` or `spoke`. Informational: it changes no behavior on its own. What a hub actually does differently is get published (the Funnel); which copy runs the shared scheduled jobs is set in the app, not by this field (ADR-225). |
| `dataDir` | Where everything lives: `pg/` (the database cluster), `builds/` (app builds), `live.json` (which build serves), `update-requested` (the signal file), `update-policy.json` (the owner's update-check settings; see `branch` and `update.mode` below). Outside the repo. |
| `repoDir` | The git clone the supervisor fetches and builds from. Defaults to the repo this file lives in. It only ever **fetches** and adds detached worktrees, so sharing the clone with a checkout somebody develops in is safe: the working tree, the current branch and any staged changes are never touched or read. |
| `branch` | Branch to track, only at install time (default `main`). The service writes this into `update-policy.json` the first time it starts, then re-reads that file every minute and ignores this key from then on. To change the branch afterwards, use **Build → Updates → Update policy** in the app (or the tray icon's Settings tab), not this file. The supervisor builds **`origin/<branch>`** from the policy, not the clone's `HEAD` — so a peer tracking a release branch (`prod-brandon`) keeps serving that release while the shared clone sits on `main`. Also passed to the app as `GITHUB_BRANCH`, so Build → Updates asks "am I current?" about the same ref. |
| `appPort` / `dbPort` | The app and Postgres ports (defaults 3000 / 5433). |
| `ownerEmail` | Becomes `LEDGR_LOCAL_OWNER_EMAIL`: the no-login local owner identity (plan decision 5). Must match the owner's `users.email`. |
| `hubs` / `deviceToken` | Ordered hub URLs plus this device's sync token (minted on the hub). Both set arms the in-app sync loop; either missing leaves sync off. |
| `syncMode` | The **initial** push mode only: `full` (default) pushes and pulls, `pull-only` never sends this device's own changes. Threaded through as `LEDGR_SYNC_MODE`. Once the app is running, the owner changes it from **Build → Network**, which stores an override in `job_state` that the sync loop re-reads every tick — so arming or disarming a peer needs no config edit and no restart, and this key stops being consulted. See "Arming sync safely" below. |
| `update.mode` / `update.pollIntervalMs` | The install-time SEED only, same as `branch` above: the service writes them into `update-policy.json` on first start, then re-reads that file every minute and ignores these keys. `mode: "prompted"` (default) means the file starts as manual — only the app's Update button applies an update. `mode: "auto"` seeds the file to check on its own every `pollIntervalMs`. After that first write, change how often and whether it checks on its own from **Build → Updates → Update policy** in the app, or the tray icon's Settings tab — not this file. Pair an auto policy with a **release** branch rather than `main` if you want the peer to move only when you deliberately ship — `branch: "prod-brandon"` + auto checking makes a local peer track the same commits as the cloud deployment, arriving within its check interval of each `npm run release:prod`. Keep-last-good still applies: a failed migrate or build leaves the previous build serving. |
| `crons` | Which scheduled jobs this peer triggers for itself (ADR-214). The default set is right for every install and needs no entry here; the app decides which machine actually does the shared ones (ADR-225). A testing escape hatch, not the owner's switch. See "Scheduled jobs" below. |
| `tunePostgres` | RAM-sized Postgres settings (ADR-215), on by default: `shared_buffers` = RAM/8 clamped 128MB–1GB (a real Ledgr database fits entirely, so page-heavy queries stop evicting themselves), SSD `random_page_cost` 1.1, `work_mem` 16MB. `false` restores the library's stock settings on the next restart; nothing on disk changes either way. |
| `postgresFlags` | Extra raw server flags, appended AFTER the tuned set (e.g. `["-c", "random_page_cost=4"]` on a spinning disk). For a repeated `-c`, Postgres takes the last one, so a manual flag always beats its tuned counterpart. |
| `cadence` | Sync knobs, passed through as `LEDGR_SYNC_PUSH_DEBOUNCE_MS` / `LEDGR_SYNC_PULL_MS`. |
| `syncGuardrails.maxFirstPush` | This device's very first push (this process's lifetime) is held rather than sent if the pending oplog exceeds this count (default 500) — the guard against a bad restore or bug dumping the whole database at the hub as edits. Only the first push is gated; a busy device that's been syncing fine is never throttled. Threaded as `LEDGR_SYNC_MAX_FIRST_PUSH`. |
| `syncGuardrails.confirmLargePush` | Set `true` (after looking at what's pending) to release a held first push without raising the limit. Threaded as `LEDGR_SYNC_CONFIRM_LARGE_PUSH`. Usually unnecessary now: a held push shows a **"Send anyway (N changes)"** button on Build → Network, which releases one-shot with no config edit or restart. |
| `syncGuardrails.skewWarnMs` / `skewHoldMs` | Clock-skew thresholds (ms) against the hub's reported time. Past `skewWarnMs` (default 5000) the Sync section and pill turn amber but syncing continues; past `skewHoldMs` (default 60000) pushes are held — last-writer-wins can't be trusted at that much drift — while pulling keeps working. Threaded as `LEDGR_SYNC_SKEW_WARN_MS` / `LEDGR_SYNC_SKEW_HOLD_MS`. |
| `extraEnv` | Any additional env for the app (R2 keys, Graph secrets, machine tokens), passed through verbatim. |

### Scheduled jobs (ADR-214)

Every scheduled job in Ledgr is triggered from **outside** the app: `vercel.json`
points Vercel cron at three endpoints, GitHub Actions hits the sub-daily ones,
and both just `GET /api/machine/<job>` with a cron-scoped token. A local peer has
no scheduler at all, so the supervisor is it: one 60s timer calls the same
endpoints over loopback. It mints its own cron token per process (in memory,
appended to the app's `LEDGR_API_TOKENS`, never written to disk), so there is
nothing to configure and no second auth path.

**The one that matters is `purge`** — it runs `pruneSyncOps`, and only the
instance it runs on. A peer that never purges never prunes its own sync log, and
the per-device retention holds (ADR-213) decide nothing.

| Job | Default | Safe on more than one peer? |
| --- | --- | --- |
| `purge` | **on**, 03:10 | Yes, and required on each. `pruneSyncOps` only prunes the local oplog; the hard deletes are the same decision from the same data everywhere, and re-deleting a gone row is a no-op. |
| `relatedness` | **on**, 03:40 | Yes. `item_relatedness` is a per-instance cache (outside the synced-table list), so Discover and Loose Ends stay empty on a peer that never computes its own. |
| `snapshot` | **scheduled**, hourly | Yes. It dumps THIS peer's cluster to THIS peer's disk, so two peers snapshotting is two independent backups. Scheduled always, but it does nothing until restore points are switched on **in the app** (ADR-222) — see "Snapshots" below. |
| `export` | **scheduled**, 04:10 | **No.** One OneDrive folder, and `items.exported_at` is synced. Scheduled always; it runs only on the copy named in the app (ADR-225). |
| `calendar-sync` | **scheduled**, every 240 min | **No.** Two peers match the same event into two rows, and sync propagates both. Scheduled always; owner decided in the app. |
| `email-import` | **scheduled**, every 240 min | **No.** Consumes the mailbox: the second peer silently imports nothing. Scheduled always; owner decided in the app. |
| `todoist-sync` | off | **No.** Bidirectional against one account. |
| `transcription-poll` | off | **No.** Two pollers race for one job. |
| `health-check` | off | **No.** Per-instance push subscriptions, and a doubled alert where they exist. |

**The app decides whether the work happens, and since ADR-225 it decides alone.**
Which install owns an exclusive job is one slot in the synced settings, edited at
**Build → Updates → Scheduled work**, and every install re-reads it before each
run. This used to be two switches: the timer here and the slot there, both
needed. That combination could hand a job to nobody — name a peer whose `crons`
had the job off and the cloud stood down while the peer was never called, so the
backup ran on neither machine — so the three movable exclusive jobs
(`export`, `calendar-sync`, `email-import`) are now scheduled on **every** peer
and the endpoint's ownership gate is the only switch. A peer that is not the owner
answers `200 {ok, skipped}` with which machine has it, and the supervisor records
that as a stand-down rather than as work done.

A slot nobody has set means the **cloud copy does it** and a supervised peer
stands down, which is exactly where an owner who never opens the picker already
was. The three jobs the picker refuses to move (`todoist-sync`,
`transcription-poll`, `health-check`) are still unscheduled here, because
scheduling a job that can never be named on this machine would only ever fire an
endpoint that stands down.

So there is normally **nothing to put in `crons`**. It remains an escape hatch for
taking a job out of this machine's schedule while testing:

```json
"crons": {
  "export": false,
  "calendar-sync": { "everyMinutes": 60 }
}
```

A value is `true` (the job's own default schedule), `false` (off), or an override
of `{ "at": "HH:MM" }` (daily, **local** time) or `{ "everyMinutes": N }`. Absent
keys keep the default. `"crons": false` turns everything off, which is what a dev
rig wants. A mistyped job name **fails at startup** rather than silently
scheduling nothing. Deliberately no cron expressions: the weekday shaping in the
GitHub workflows exists to cut Neon compute by sharing wake windows, and a local
Postgres that is already running has nothing to save.

**When a job fails**, three things happen and none of them is silence: the
outcome is written to `<dataDir>/cron-state.json`, the failure is POSTed to
`/api/machine/report-error` so it lands in `error_log` and counts on `/health`
exactly like a cloud failure, and the job is retried in 10 minutes (clamped to
its next slot, so a failing job never runs more often than its schedule allows).
Nothing fires while an update is in flight. A job overdue by more than its own
period runs a few minutes after startup rather than waiting for a slot it keeps
missing — a laptop asleep every night at 03:10 would otherwise never purge.

### Restarting it (ADR-227)

`npm run local:restart`, or the **Restart** button in Build → Updates. Both use
the same mechanism, because the app cannot restart its own parent: the request is
a file (`restart-requested`), the supervisor honours it by shutting down cleanly
and then **spawning its successor**, and the successor waits for the outgoing pid
to exit before claiming the lock. Neither reports success until something is
actually serving again — a changed pid answering on the app port, not merely a
request that was accepted.

Two failure modes are handled rather than hoped about. Postgres start **retries**
(0/2/5/10s), because a supervisor that died without a clean shutdown can leave an
orphaned backend holding the cluster's shared memory and Windows keeps that
segment attached until the last one exits; a single attempt into that window
fails with *pre-existing shared memory block is still in use*, which is exactly
how one hard kill kept a peer down for ten minutes. And every phase is written to
`supervisor-state.json` — `handing-off` is the outgoing process's last word, so
a state stuck there is the evidence that a successor never came up.

**When a restart is actually needed:** an update to Ledgr itself is applied to the
app without one. A restart is only required when the update changed the
supervisor's own files, because a running process holds the code it started with.
It fingerprints its own source and Build → Updates says so when they differ, so
this is not something to keep in your head.

**Where to look:** `Build → Updates` → "Scheduled jobs on this machine" shows
each job's state, last success, next run and any failure detail, and flags an
exclusive job as one only this device should run. `npm run local:status` prints
the same list (`--json` for an install agent).

### Snapshots: point-in-time recovery on this machine (ADR-217)

Between the `revisions` table (one item's body history) and the weekly OneDrive
`pg_dump` (exact, but weekly) there was nothing. `snapshot` fills it: a
custom-format `pg_dump` of this peer's own cluster, hourly, thinned into a tiered
spread so a fixed number of files covers weeks.

**Both settings live in the app, not here (ADR-222).** The supervisor schedules
this job hourly on every peer and the endpoint asks the database whether to do
anything, so **Build → Updates → Snapshots** owns the whole feature: an on/off
switch (default **off**, because it costs disk) and *how many restore points to
keep* (default 30). Nothing in `config.json` is involved, and neither setting
needs a restart. Setting `"crons": { "snapshot": false }` still stops the job
being scheduled at all, which is a testing lever rather than the owner's switch.

The keep number is the interesting one. The spread is
computed from that number — dense recent, sparse old — and the page says it in
words, alongside the disk it costs, what is on disk now, and every restore point
with its timestamp, plus a **Snapshot now** button for the moment before
something risky. It is stored in `job_state` like the sync-mode override, so
changing it needs no config edit and no restart. The section renders only on a
local peer; a cloud deployment has no disk to write to.

Files land in `<dataDir>/snapshots/<timestamp>.dump`. The dump runs against the
**running** cluster (`pg_dump` is consistent by design, so nothing stops), never
while an update is in flight, and a failure reports itself through the ordinary
cron path: `cron-state.json`, `POST /api/machine/report-error`, `/health`.

**`pg_dump` is a real external dependency here.** The embedded-postgres packages
ship the server only (`postgres`, `initdb`, `pg_ctl`), so snapshots need the
Postgres client tools, the same ones the restore-from-file path already needs
(`winget install PostgreSQL.PostgreSQL.18`, or `brew install libpq`). They do not
have to be on PATH: the lookup also checks `C:\Program Files\PostgreSQL\*\bin`,
which is where winget leaves them, and `install.ps1` installs them already. When
they are genuinely missing, the Snapshots section says so instead of quietly
never snapshotting.

**Restoring is browse-only, deliberately.** From a terminal on the machine:

```
npm run local:snapshot -- list                        # what there is, and what the next prune keeps
npm run local:snapshot -- now                         # take one right now, before something risky
npm run local:snapshot -- browse 2026-08-25T14        # open one in a throwaway cluster
```

`browse` starts a second, disposable Postgres on `dbPort + 1000`, restores the
dump into it, prints the connection string, and deletes the whole thing when you
press Ctrl+C. If a session ended some other way (the window closed, a reboot, a
crash), the next `browse` stops the orphaned postmaster with `pg_ctl` and removes
its directory before starting — deleting the directory alone is not enough, since
the orphan still holds files inside it. Nothing here ever restores **over** the live cluster, and that is
the load-bearing part: on an armed peer every write fires the `sync_ops`
triggers, so rewinding in place would replay weeks-old rows to the hub as fresh
edits and last-writer-wins would let them win. In-place restore stays what it
already is: the deliberate `npm run local:restore`, which resets this peer's sync
identity on the way through and is gated by `maxFirstPush`.

### Arming sync safely

The first time a device syncs against your **production** hub, prove data
flows the right way before letting it push:

1. On the hub's `/build/updates` → Synced devices, **Add device** with the
   "Pull-only" checkbox on (the default for a new device). Paste the token
   into this device's `deviceToken`.
2. Start this device and confirm data arrives correctly — it can only pull,
   so nothing it does can touch the hub's data.
   Before you trust that flag, prove it on this machine. The hub half of sync
   is the same code on every peer, so a local instance proves the same
   guarantees with nothing at stake:

   ```
   PEER_URL=http://localhost:3000 \
     PEER_DB=postgresql://postgres:postgres@127.0.0.1:5433/ledgr \
     npx tsx scripts/verify-sync-guards-live.mts
   ```

   It registers throwaway devices and cleans them up, and checks that a
   pull-only device's push is refused with 403 **before any op is applied**,
   that the same device can still pull, that a schema-version mismatch is a
   409 naming both versions, and that revoked and unknown tokens are refused.
3. Once you're satisfied, flip it to full. **Both sides have a say, and both
   have a button:**
   - the **hub**, per device: `/build/updates` → Synced devices → "Allow push"
     (confirms with the consequences). This is the authoritative one — it takes
     effect immediately even if the device is offline or misconfigured.
   - the **spoke**, for itself: `/build/updates` → Sync → Mode → "Allow push
     from this device". Stored in `job_state` and re-read every tick, so it
     applies within seconds without a restart.

   A spoke set to full still gets a 403 if the hub has not allowed that device,
   so the safe order is: prove the pull direction, then allow it on the hub,
   then allow it on the spoke.

## Run

```
npm run local:supervisor
```

**One supervisor per `dataDir`, enforced.** It takes
`<dataDir>/supervisor.lock` before starting Postgres; a second start refuses
and names the owning pid. A stale lock (any hard kill, any reboot) is taken
over automatically. So if you register the boot task below AND run it in a
terminal, the second one exits instead of fighting the first over the ports,
the cluster and the update signal. Note the supervisor does not restart
*itself* when an update changes `supervisor/*.mjs` — the app flips, but the
supervisor process keeps running its old code until you restart it.

First run: initdb, then a full build of the repo's current HEAD (npm ci +
`next build` + migrate), then the app serves on `appPort`. Ctrl+C stops the
app, then Postgres, in order.

First **data**: fill it before first use, either from the weekly backup —

```
npm run local:restore -- /path/to/ledgr-YYYY-MM-DD.dump
```

— or straight from the live database (fresher, no file to find; any Neon
connection string works, pooled or direct, and this path needs no extra
tools at all — it copies rows natively with the `pg` driver, since the
schema comes from running our own migrations rather than pg_dump):

```
npm run local:restore -- --from-url "postgresql://...neon.tech/ledgr"
```

(The backup-file form above still needs `pg_restore` on PATH; the embedded
binaries ship the server only. Stop the supervisor first, either way.) Both
forms clear the sync state that must not be cloned from the hub — the
oplog, peer registrations, and cursors always come out fresh, and the local
device identity is simply this peer's own (never the hub's) either way. If
this peer syncs against a hub, its first pull/push cycle reconciles
everything newer than the fill.

### Parking a peer, and why you cannot simply revoke it

Pruning keeps every op above `min(last_pulled_seq)` across non-revoked peers,
so:

- **Leave a parked device registered** and the hub's oplog grows for as long as
  it sleeps, holding whole body text per op. It can rejoin and catch up.
- **Revoke it** and the prune is free to delete exactly the ops it had not
  pulled. It is inert while parked, which is what you wanted, but it can no
  longer catch up by pulling.

**The hub now refuses that second peer instead of quietly under-serving it
(ADR-208):** a returning peer whose cursor predates the oldest pruned op gets
HTTP 410 and shows "too far behind this hub … re-fill required" in the Sync
section, rather than pulling a partial stream and reporting synced. Its
pushes still land first — local edits made while parked drain to the hub
before you re-fill, so nothing unpushed is lost. The remedy is what it always
was: `npm run local:restore -- --from-url <hub db>` (~4 minutes for a full
copy); the difference is the system now tells you. A middle path that
reconciles only what differs instead of re-copying everything is designed
(ADR-208) but not yet built, as is a real "paused" device state that drops
the retention hold without revoking.

### After an update, check what a PUSHING peer is about to send

Reads are safe: six real pages (Today, Tasks, search, an item, Build, home)
were measured on 2026-08-23 and produced **zero** pushable ops, so browsing a
peer never queues anything.

**Volume is not the hazard; redundancy is.** A genuine import of 5,000 new
items on a spoke SHOULD push all 5,000 to the hub, and it will — those are real
new rows the hub has never seen, so there is nothing to conflict with. It takes
as long as it takes. (What it runs into is the first-push size guard and
throughput, both covered in `next_steps.md` under large imports.)

Migrations are the exception, and the reason this section exists. A data
migration runs against **this peer's own database** and its writes are this
peer's OWN ops, so they push. `0052` (`UPDATE types SET is_system = true`) and
`0053` (appending a property to `person`) are exactly that shape: harmless on
a pull-only peer, but on a peer with push enabled they queue one op per row
touched and send them to the hub, where the same migration has already run.
The merge is field-level last-writer-wins, so the peer's copy would win on
timestamp even though the hub's value is identical or newer.

Nothing has gone wrong from this yet. The habit that prevents it, on any peer
whose `syncMode` is `full`:

```sql
-- run against the peer, right after an update completes
select seq, tbl, kind, row_id from sync_ops
 where origin_device_id is null
   and seq > (select (value->>'push')::bigint from job_state
               where key like 'sync:cursor:%')
 order by seq;
```

Zero rows is the expected answer. A row per migrated record means the
migration queued a push: decide whether the hub wants those writes before the
next exchange sends them, and remember `syncGuardrails.maxFirstPush` only
gates the FIRST push of a process lifetime, so a restart is what arms that
guard again.

## Update flow and keep-last-good

"Update now" in the app (or the auto poll) writes `<dataDir>/update-requested`.
The supervisor then:

1. `git pull --ff-only` in `repoDir`.
2. Fresh checkout of the new commit into `builds/<sha>/` (a git worktree).
   The directory the running app serves from is never touched — required on
   Windows, where you cannot swap files out from under a running process.
3. `npm ci` in the new build only if `package-lock.json` changed; otherwise
   the live build's `node_modules` is copied.
4. `next build`, then `scripts/migrate.mjs` against the local database.
5. Only if **both** succeeded: stop the app, point `live.json` at the new
   build, start the app from it. Any failure at any step leaves the previous
   build serving, untouched, and removes the failed attempt.
6. Prune to the last 2 builds (live + one fallback).

`live.json` is a plain pointer file rather than a symlink/junction: it works
identically on every platform, needs no privileges, and the supervisor reads
it once at spawn.

## Set up a new machine: download `install.cmd` (LH4)

On Windows, the whole bring-up below collapses to one downloaded file:
**download `install.cmd` and double-click it.** (Windows won't run a `.ps1`
on double-click — it opens an editor instead — so `install.cmd` is the file
to actually download; it's a tiny wrapper that runs `install.ps1` and keeps
the window open so you can read the result. If `install.ps1` isn't sitting
next to it, it fetches that too.)

The PowerShell invocation still works directly, if you'd rather:

```
powershell -ExecutionPolicy Bypass -File install.ps1
```

It installs git, Node LTS, and the Postgres client tools via winget if
missing (the Postgres tools warn-and-continue rather than blocking, since
starting empty doesn't need them), clones the repo into
`%LOCALAPPDATA%\Ledgr\app` (override with `-InstallDir`), runs `npm ci`, and
hands off to the cross-platform wizard — `npm run local:setup` — which asks
hub-or-spoke, fills the initial data, asks which branch to follow and how it
should check for updates, writes `supervisor/config.json` (never clobbering
without `--force`), and offers the Task Scheduler registration. Every prompt
has a flag override (`node scripts/local-setup.mjs --help`), so it also runs
unattended:

- `--branch <name>` — the git branch this install follows (default `main`).
- `--auto-update yes|no` — check for and apply new versions on its own
  (default `yes`).
- `--update-every <minutes>` — minutes between those checks (default `15`).

These three seed `update-policy.json` on first start (see `branch` and
`update.mode` above); afterwards they are changed from **Build → Updates →
Update policy** in the app or the tray icon's Settings tab, not by re-running
the wizard. On macOS/Linux the wizard is the same; only the bootstrap differs
(`install.sh` is deferred to post-cutover — clone + `npm ci` by hand, then
`npm run local:setup`).

**Initial data, three ways** (the wizard's "Initial data" question):

- **Restore a backup file** — the fast path when you already have one.
  Download the newest `ledgr-*.dump` from OneDrive `/Ledgr/Backups/`, then
  point `--backup` at it (or answer the prompt with its path).
- **Pull from the live database** — fresher than the weekly backup, no
  hunting for a file, and **no extra tools needed at all**. Any Neon
  connection string works, the pooled one included, since this path copies
  rows natively with the `pg` driver the app already ships rather than
  shelling out to `pg_dump` (the schema comes from running our own
  migrations, not from a portable dump).
- **Start empty** — migrate + seed a fresh database. **For a HUB, or a peer
  you intend to fill by hand, only.** A spoke that starts empty does NOT
  fill itself from the hub: see the warning below.

> **⚠️ Start-empty does not fill a spoke, and this file used to say it did.**
> Sync ships `sync_ops` rows and nothing else — there is no snapshot path in
> the protocol — so a spoke can only ever receive **what the oplog still
> holds**. The oplog begins at migration `0054` (2026-08-22) and is pruned at
> `SYNC_OPS_RETENTION_DAYS` (14 days), so a spoke that starts empty ends up
> with a permanently partial database, **silently**. Verified on Brandon's
> laptop on 2026-08-23: the whole prod oplog was 5 rows spanning a few hours,
> against 23,462 items. Fill a spoke from a backup file or a live pull, and
> check that the fill is newer than the oplog's own start; if it is not, the
> gap between them is lost. Until a hub-side bootstrap endpoint exists (see
> `next_steps.md`), the **live pull is the only fill that is both complete
> and current**, because the newest weekly dump can be older than the oplog.

Of the three, only the restore-from-file path needs the Postgres client tools
(`pg_restore`) — `winget install PostgreSQL.PostgreSQL.18` on Windows,
`brew install libpq` on macOS. The wizard's data-fill step says so if it's
missing; the live pull needs nothing beyond `npm ci`. **Snapshots** need the same
tools (`pg_dump` to take one, `pg_restore` to open one), so a peer that will keep
restore points wants them installed whichever fill it used. They do not have to
be on PATH for snapshots: the lookup also checks `C:\Program
Files\PostgreSQL\*\bin`.

## Windows bring-up checklist (manual fallback; also what install.ps1 does)

Run these on the always-on PC, in order:

1. **Install the tools** (PowerShell, admin not required for winget):
   - `winget install Git.Git`
   - `winget install OpenJS.NodeJS.LTS`
   - `winget install PostgreSQL.PostgreSQL.18` (the client tools. Needed for
     restoring from a backup FILE via `pg_restore`, and for **snapshots**,
     which need `pg_dump` to take one and `pg_restore` to open one — the
     embedded package ships the server only. The live database pull needs
     none of this. The installer does NOT add itself to PATH — unlike Git and
     Node — so add its `bin` folder yourself if you go this route;
     `install.ps1` and the snapshot lookup both also find it automatically)
2. **Clone and install:**
   - `git clone https://github.com/strategicli/ledgr.git C:\ledgr`
   - `cd C:\ledgr && npm ci`
   - Watch: `npm ci` fetches the **win32-x64 embedded-postgres binaries**
     (`@embedded-postgres/windows-x64`); confirm the package landed.
3. **Configure:** copy `supervisor\config.example.json` to
   `supervisor\config.json`; set `dataDir` (e.g. `C:/ledgr-data`),
   `ownerEmail`, and (for a syncing spoke) `hubs` + `deviceToken` minted on
   the hub's Synced-devices section. (Steps 3-4 and 7 are the wizard's job:
   `npm run local:setup`.)
4. **Fill the data:** either download the newest `ledgr-*.dump` from OneDrive
   `/Ledgr/Backups/` and `npm run local:restore -- C:\path\to\ledgr-....dump`
   (watch: `pg_restore` must be on PATH and be the PG 17+ client — `pg_restore
   --version`), or pull straight from the live database — any connection
   string works, pooled included — with `npm run local:restore -- --from-url
   "..."` (no client tools needed for this path at all).
5. **First supervisor run, in a terminal** (not the service yet):
   `npm run local:supervisor`. Watch for:
   - **initdb succeeds** (embedded-postgres win32 binaries actually run;
     antivirus can quarantine `postgres.exe` — allowlist `dataDir` if so).
   - **The Windows Firewall prompt** for node.exe on the app port — allow on
     private networks, or nothing off-machine (Tailscale included) can reach it.
   - The app answering at `http://localhost:3000` and signing you in as the
     local owner with your real data.
6. **Prove keep-last-good on the PC:** press Update now (or create
   `update-requested` in `dataDir`) once a newer commit exists; then break a
   build deliberately (e.g. point `branch` at a known-bad commit) and confirm
   the old version keeps serving. This is the **file-locks** test: the swap
   must succeed while the old app is running (nothing writes into the serving
   directory, but Windows will surface any violation here, not on the Mac).
7. **Register at boot (Task Scheduler):**
   ```
   schtasks /Create /TN "Ledgr Supervisor" /SC ONSTART /RU "%USERNAME%" /NP ^
     /TR "\"C:\Program Files\nodejs\node.exe\" C:\ledgr\supervisor\ledgr-supervisor.mjs C:\ledgr\supervisor\config.json"
   ```
   Then `schtasks /Run /TN "Ledgr Supervisor"` to start it without rebooting.
   `/NP` is the "Do not store password" option: the task runs with nobody
   signed in and needs no Windows credential, which matters because a
   Microsoft-account login has no password Task Scheduler will accept anyway.
   It trades away NETWORK credentials only, and this peer uses none (public
   HTTPS git remote, localhost job calls). Scheduled tasks get no firewall
   prompt, so do step 5 in a terminal first.
8. **Reboot once** and confirm the app comes back on its own.

Windows-specific unknowns to watch overall: file locks during the build swap
(step 6), the embedded-postgres win32 binaries under antivirus (step 5), and
the firewall prompt for the app port (step 5).

## Register at boot (macOS / Linux)

The wizard prints these rather than executing them (Windows is the only
platform where it offers to run the registration itself):

- **macOS (launchd):** `~/Library/LaunchAgents/org.ledgr.supervisor.plist`
  with `RunAtLoad` true and `ProgramArguments` =
  `[node, <repo>/supervisor/ledgr-supervisor.mjs, <repo>/supervisor/config.json]`,
  then `launchctl load` it.
- **Linux (systemd user unit):**
  `~/.config/systemd/user/ledgr-supervisor.service` with
  `ExecStart=node <repo>/supervisor/ledgr-supervisor.mjs <repo>/supervisor/config.json`
  and `Restart=always`, then `systemctl --user enable --now ledgr-supervisor`.
