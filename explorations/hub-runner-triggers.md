# Exploration: hub runner + triggers (YouTube transcripts first)

**Status:** **slice 1 is BUILT (2026-08-30, ADR-242), and it did not need the runner.** Slices 2 to 5 remain agreed direction, in order. Build happens on the always-on hub PC (BC-EDGEWOOD); this doc is the handoff.

> **Read this before building slices 2 to 5.** The runner service below is the one part of this doc that did not survive contact with the repo. It was designed on 2026-08-29, one day before Ledgr's supervisor made it redundant: the supervisor already runs a long-lived process on the hub PC, already fires `GET /api/machine/<job>` on a timer with its own minted token, already picks exactly one machine per job through job ownership, and already reports a failure into the errors list and `/health`. So slice 1 shipped as an ordinary Ledgr scheduled job, and the runner, the queue, the public `/hooks` path, the shared bearer secret, and the heartbeat were all deleted rather than built. Instant capture did not need the hook URL either: the save already runs on the machine that does the work, so one guard in `createItem` starts the job by calling a function.
>
> **Slices 2 to 5 should start from the same question:** what does the supervisor plus a machine endpoint already give us, and what is genuinely left? The Graph webhook slices (2 to 4) do still need a public address to receive notifications, but the local Ledgr is already public over the Funnel and already authenticates machine callers, so the honest shape is probably a Ledgr route, not a second service. Slice 5 (on-demand buttons) is nearly free for the same reason.

## The itch that started it

Brandon wants to hit one button on a YouTube video (desktop or phone) and end up with a Ledgr `link` item holding the video URL **and the full transcript** in its markdown body. Free, deterministic, no model in the loop (Principle 3). During brainstorming this generalized: the same machinery answers "ping the PC when an email lands in a folder," "process a meeting transcript minutes after it exists," and several other parked wishes. This is the `local-pc-hub.md` idea arriving through the side door as a *feature*, not an architecture change.

## What already exists (do not rebuild)

- **Capture buttons.** The PWA share target (ADR-016) catches a shared YouTube URL on Android and files a `link` item into the Inbox. The desktop bookmarklet (ADR-100, Build → AI & MCP) does the same via `POST /api/machine/capture`. Both surfaces are done.
- **The public front door.** Tailscale Funnel is **already live** on the hub PC at `https://bc-edgewood.char-arcturus.ts.net` (root → local Ledgr on port 3000; `/mailMCP` → the mail MCP on 3002). A new service is one `tailscale funnel --bg --set-path "/<path>" http://127.0.0.1:<port>` away. Constraints learned the hard way: **port 443 only** for anything claude.ai must reach, and OAuth `/.well-known` discovery always hits the hostname root (irrelevant here, the runner uses a bearer token, not OAuth). Details live in the Ledgr memory "Tailscale Funnel is LIVE on the always-on hub PC".
- **Prior art for the runner shape.** logos-sync (`~/code/logos-sync` style: small script, machine token, writes via the machine API) and the Whisper machinery from the `transcribe-media` skill (faster-whisper, NVIDIA GPU).

## The design

### The hub runner

One long-lived process on the hub PC (Node; same supervisor/scheduled-task pattern as the mail MCP), listening on a local port, exposed publicly as a Funnel path (e.g. `/hooks`). One route:

```
POST /hooks/{jobType}   Authorization: Bearer <shared secret>
```

The handler validates the token, enqueues `{jobType, payload}`, returns 202 immediately. A worker loop runs jobs one at a time (ponytail: single queue, no concurrency until a job proves slow enough to need it). Each job type is a module: `youtube-transcript`, later `email-capture`, `meeting-transcript`, `drive-drop`, `on-demand` (drain/backup).

**Triggers are hints, not contracts.** Every job type also has a slow poll (30–60 min) that does the same scan the trigger would have caused. A missed ping (reboot, Funnel hiccup, Ledgr deploy) means slower, never lost. Trigger for latency, poll for correctness.

**Liveness.** The runner heartbeats into Ledgr (a timestamp the Network/Build surface can warn on, same spirit as `sync_peers.last_seen_at` in `sync-node-maturity.md`). "Runner unseen for 6h" must be visible, not silent (Principle 9).

### Slice 1: the YouTube transcript job

1. **Scan:** via the machine API / MCP, list `link` items whose URL matches `youtube.com` / `youtu.be` / `music.youtube.com` and whose body lacks the transcript marker (see format below). Triggered by the ping; also found by the poll.
2. **Captions first:** `yt-dlp` (or `youtube-transcript-api`) pulls the caption track — creator captions preferred, auto-generated accepted. No video download. Seconds per item. This *must* run from the PC's residential IP; YouTube blocks datacenter IPs, which is why none of this can live on Vercel.
3. **Whisper fallback:** no caption track → `yt-dlp -x` audio-only download → faster-whisper on the GPU → text. Minutes per item, still free. Delete the audio file after.
4. **Write back:** update the item body (which snapshots a revision) to:

   ```markdown
   [Video Title](https://www.youtube.com/watch?v=…)

   ## Transcript
   <!-- transcript:yt-dlp-captions 2026-08-29 -->

   …full transcript as plain paragraphs…
   ```

   The HTML comment is the idempotency marker (already valid in the body dialect; it is not a new element). Timestamps stripped by default; keep them only if Brandon asks. Item stays a `link`, stays in the Inbox for normal triage.
5. **Failure:** after N attempts, write a short `> Transcript unavailable: <reason>` line into the body instead, so failures surface in the item rather than a log nobody reads (Principle 9). The very last resort, per Brandon: a Claude agent pass over items that carry that marker — manual or scheduled, never the default path.

Because yt-dlp is the fetcher, the same job already covers Vimeo, podcast pages, and most other video platforms with caption tracks — the "other platforms" wish costs nothing extra.

### The trigger from Ledgr (the only Ledgr-side change)

`POST /api/machine/capture` and the share-target save path gain a fire-and-forget `fetch()` to a **hook URL stored as an owner setting in the GUI** (ADR-222 posture: a Build-surface field, takes effect immediately, no env var, no redeploy; empty = feature off). Send `{jobType: "youtube-transcript", itemId}`, 1–2s timeout, failures ignored (the poll catches them). Purely additive; not core.

### Slices 2–5 (agreed direction, in rough order)

2. **Email into a folder.** Microsoft Graph change notification on a designated mail folder ("→ Ledgr"), webhook pointed straight at the Funnel path. Runner pulls the message via Graph (the Entra app + local-secret pattern from the mail MCP is the template) and files a Ledgr item. Graph mail subscriptions expire in ~3 days; subscription renewal is just another scheduled job on the runner. Note: Ledgr's existing email-capture job may partially overlap; reconcile before building (ownership per job, `sync-node-maturity.md` style).
3. **Meeting transcript ready.** Graph notification when a Teams recording/transcript becomes available → runner pulls it → files a meeting note minutes after the meeting ends. This is the front half of `meeting-recording.md`.
4. **OneDrive drop folder.** Graph notification on a designated folder; any audio/video file dropped there gets Whisper-transcribed into an Inbox item. Turns the phone voice recorder into a capture device with zero new UI.
5. **On-demand jobs.** Build-surface buttons (export drain, backup now, Logos sync now) ping the runner instead of `gh workflow run`. This is where this doc merges into `sync-node-maturity.md`'s per-job-ownership feature.

## Security

- The `/hooks` path is public (Funnel). Bearer token required on every request; requests carry only `{jobType, itemId}`-shaped hints, never content, so a forged ping can at worst cause a scan that finds nothing.
- Graph webhooks authenticate with the standard `clientState` secret + validation handshake.
- All writes into Ledgr go through the existing machine-token API; the runner holds one machine token and (for slices 2–4) one Graph app secret, stored like `C:\dev\ms365-mcp\client-secret.txt` (ACL'd to Brandon's account).

## What this is not

- Not the hub/spoke cutover (`local-pc-hub.md`); the runner is a sidecar, Vercel+Neon stay canonical.
- No schema change, no new table, no body-dialect change. The Ledgr-side diff is one setting + one fire-and-forget fetch, so nothing here is core (the setting/UI bit is ordinary solo work). If slice 5 later formalizes job ownership, that piece goes through the `sync-node-maturity.md` ADR path.
- No AI in the loop. Claude touches this only as the last-resort pass over `Transcript unavailable` items.

## Open questions for the builder

- Long transcripts: an hour of video is ~10k words in one `link` body. Fine for v1 (bodies never load in lists); revisit `link`→`note` promotion (parked in `web-clipper.md`) only if it annoys in practice.
- Runner runtime: Node service vs. PowerShell + node one-shots. Recommend Node matching the supervisor pattern already on the box.
- Where the runner code lives: its own small repo beside logos-sync (recommended; it deploys to one machine and versions independently of Ledgr) vs. a folder in this repo.
