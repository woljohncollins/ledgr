// The job: saved YouTube links that have no transcript yet get one written into
// their body.
//
// Nothing new is stored to make this work. "Needs a transcript" is not a queue,
// a flag, or a column; it is simply a saved link whose address is ONE YouTube
// VIDEO (not a channel or a playlist, see isYoutubeVideoUrl for why that
// distinction is load-bearing) and whose body carries no transcript marker. That is why a month of videos
// saved on the cloud, where this cannot run, costs nothing: come back to the
// machine that can do the work and the first run picks all of them up, oldest
// first. There is nothing to drain and nothing to expire.
//
// The marker is an HTML comment in the body, which the body format already
// allows, so it travels to every copy with the text it belongs to. It is also
// what stops the work being redone forever, including for a video that CANNOT
// be transcribed: a failure writes its own marker plus one visible line saying
// why, so a private video says so in the item instead of being retried every
// ten minutes for the rest of its life. Trying again means deleting that line.
import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { items } from "@/db/schema";
import { bodyMarkdown, makeMarkdownBody } from "@/lib/body";
import { getItem } from "@/lib/items";
import { updateItem } from "@/lib/item-mutations";
import { captureError, createLogger } from "@/lib/log";
import { getSettings } from "@/lib/settings";
import { fetchTranscript, ytDlpVersion } from "@/lib/youtube/fetch";

// The hosts a YouTube video can be saved from. youtu.be is the share-sheet form,
// which is what the phone actually sends, so leaving it out would miss the most
// common way a video gets here.
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtu.be",
]);

/** The literal that says "this body has been through the job". */
const MARKER = "<!-- transcript:";

/**
 * Is this address ONE YouTube VIDEO? Junk in, false out, never a throw.
 *
 * The "one video" half is load-bearing, and it cost us a real failure to learn
 * it (2026-08-31, first run). Plenty of saved links are YouTube CHANNEL pages
 * (`youtube.com/@someone`, `/c/name`, `/user/name`) or playlists rather than
 * videos. Handed one of those, yt-dlp does not decline: it starts enumerating
 * everything the channel has ever posted, which never finishes inside a
 * timeout. One saved channel page burned ten minutes across two attempts and
 * then wrote "took too long to fetch" into the item, and it was never going to
 * be transcribable at all.
 *
 * So a candidate needs an actual video id: youtu.be/ID, /watch?v=ID, /shorts/,
 * /live/, or /embed/. Anything else is not a video and never enters the list.
 */
export function isYoutubeVideoUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!YOUTUBE_HOSTS.has(parsed.hostname.toLowerCase())) return false;
  const path = parsed.pathname;
  // youtu.be/<id> — the share-sheet form, where the id IS the whole path.
  if (parsed.hostname.toLowerCase().endsWith("youtu.be")) {
    return /^\/[\w-]{6,}\/?$/.test(path);
  }
  if (path === "/watch") return !!parsed.searchParams.get("v");
  return /^\/(shorts|live|embed|v)\/[\w-]{6,}/.test(path);
}

/** Has this body already been through the job, either way? */
export function hasTranscriptMarker(bodyText: string | null | undefined): boolean {
  return (bodyText ?? "").includes(MARKER);
}

/** The existing body plus a block, with no leading blank line on an empty body. */
function appended(existingBody: string, block: string): string {
  const base = existingBody.replace(/\s+$/, "");
  return `${base ? `${base}\n\n` : ""}${block}\n`;
}

/** The transcript, under its own heading, appended to what the item already says. */
export function withTranscript(
  existingBody: string,
  t: { text: string; source: string; date: string }
): string {
  return appended(
    existingBody,
    `## Transcript\n${MARKER}${t.source} ${t.date} -->\n\n${t.text.trim()}`
  );
}

/**
 * The same marker, plus one line a person can read, for a video that could not
 * be transcribed. The blank line after the marker is load-bearing: an HTML
 * comment runs to the next blank line in markdown, so without it the quote
 * below would be swallowed into the comment and the reader would see nothing.
 */
export function withFailure(existingBody: string, reason: string, date: string): string {
  return appended(
    existingBody,
    `${MARKER}failed ${date} -->\n\n> Transcript unavailable: ${reason}`
  );
}

/** Today, where the machine doing the work is. */
function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The same question isYoutubeVideoUrl answers, asked in Postgres.
 *
 * IT HAS TO BE ASKED HERE, and a jammed queue is why. The test used to be
 * `url ilike '%youtu%'`, which is true of any address with those six letters in
 * it anywhere: a reddit thread in r/youtube, a sponsor link with
 * `utm_source=Youtube`, an article about YouTube url tricks. Those are not
 * videos, so the pass threw them out — and threw them out again every ten
 * minutes forever, because only a video ever gets the marker that would remove
 * it from this list. They sat at the front of the queue by age and never moved.
 * On 2026-09-01 the three oldest survivors happened to be three such links, the
 * batch of three filled up with them, the pass attempted nothing, and the loop
 * read "attempted nothing" as "nothing left to do". Eighteen real videos behind
 * them waited a day and a half for a run that was doing this every ten minutes
 * and reporting success.
 *
 * So a link that is not a video never enters the list at all. isYoutubeVideoUrl
 * is still the final say (it is stricter about paths than one regex should try
 * to be); this is only here so the batch cannot fill with things that can never
 * be worked on. scripts/verify-youtube-transcripts.mts holds the two to the
 * same answers so they cannot drift.
 *
 * `~*` is case-insensitive, matching the lowercased hostname test in the code.
 */
export const VIDEO_URL_SQL_PATTERN = String.raw`^https?://((www\.|m\.|music\.)?youtube\.com/(watch\?(.*&)?v=|(shorts|live|embed|v)/[\w-]{6,})|(www\.)?youtu\.be/[\w-]{6,})`;

/**
 * Saved links that still want a transcript: mine, live, a YouTube video's
 * address, and no marker in the body.
 *
 * The marker test is SQL rather than JavaScript on purpose. Bodies are the one
 * thing this table is heavy with, and an owner with hundreds of transcribed
 * videos would otherwise drag every finished transcript into memory to discover
 * they are all finished.
 */
function pendingWhere(ownerId: string) {
  return and(
    eq(items.ownerId, ownerId),
    eq(items.type, "link"),
    isNull(items.deletedAt),
    sql`${items.url} ~* ${VIDEO_URL_SQL_PATTERN}`,
    sql`coalesce(${items.body}->>'text', '') not like '%<!-- transcript:%'`
  );
}

/**
 * How many saved videos are waiting. For the Build card.
 *
 * Counts what the job would actually attempt, which means paying for the same
 * narrowing the passes do: the query is precise about addresses now, but
 * isYoutubeVideoUrl is still the final say, and a card promising a number the
 * job will not reach is a small lie that would never resolve itself. Urls only,
 * never bodies, so this stays a cheap read.
 */
export async function pendingVideoCount(ownerId: string): Promise<number> {
  const rows = await getDb()
    .select({ url: items.url })
    .from(items)
    .where(pendingWhere(ownerId));
  return rows.filter((r) => isYoutubeVideoUrl(r.url)).length;
}

export type TranscriptRun = {
  skipped?: string;
  /** A detached caller got this: the passes were started, not waited for. */
  started?: boolean;
  scanned: number;
  done: number;
  failed: number;
};

const NOTHING: TranscriptRun = { scanned: 0, done: 0, failed: 0 };

// ONE AT A TIME, and this is the whole reason the flags exist.
//
// Whisper wants the entire graphics card. Share five videos in a row and, with
// nothing here, five Whisper runs would start beside each other and the machine
// would grind for an hour to do twenty minutes of work. So a second call does
// not start a second run: it leaves a note (`rerun`) and returns, and the run
// already in flight does another pass before it lets go. Videos saved during a
// long transcription are therefore picked up immediately after it, not ten
// minutes later, and never alongside it.
//
// ponytail: the ceiling is one run per PROCESS, not per machine. Two Ledgr
// processes against the same database could still overlap. That is not a real
// shape here (one local peer runs one app), and the fix if it ever becomes one
// is a claim row in job_state rather than a module variable.
let running = false;
let rerun = false;

/**
 * Transcribe the saved videos that are waiting. Safe to call from anywhere: the
 * ten-minute scheduled run and the "you just saved a video" trigger are the same
 * call, so neither path can drift from the other.
 *
 * Never throws. One unreachable video must not stop the ones behind it, and a
 * scheduled job that cannot work here (no yt-dlp, switch off) reports a clean
 * skip rather than an error every ten minutes.
 */
export async function runYoutubeTranscripts(
  ownerId: string,
  opts?: { limit?: number; detach?: boolean }
): Promise<TranscriptRun> {
  // The owner's switch (ADR-222), so turning this on is a checkbox rather than
  // a config file and a restart. Off means off: no process is touched.
  if (!(await getSettings(ownerId)).youtubeTranscripts.enabled) {
    return { ...NOTHING, skipped: "switched off" };
  }

  // Checked before asking whether the tools exist, so a burst of saves during a
  // long Whisper run does not spawn a version check per save.
  if (running) {
    rerun = true;
    return { ...NOTHING, skipped: "already running" };
  }

  // The cloud's answer, and Tyler's until he installs anything. Not an error:
  // this copy simply cannot do the work, and the Build card says so on the page
  // rather than leaving it to a log.
  if (!(await ytDlpVersion())) {
    return { ...NOTHING, skipped: "yt-dlp is not installed on this copy" };
  }

  running = true;
  const log = createLogger("youtube-transcript");

  // THE WORK MUST NOT LIVE INSIDE THE REQUEST THAT ASKED FOR IT.
  //
  // Measured on the hub PC 2026-08-31, on the very first real run: Node's HTTP
  // server destroys a connection whose request has been open for five minutes
  // (`server.requestTimeout`, 300s by default), so the scheduler's call came
  // back as "fetch failed" after 306 seconds and the run was recorded as a
  // failure. The work itself had been fine and carried on to completion. What
  // took so long was legitimate: the first video without captions made Whisper
  // download its 3.5GB model once.
  //
  // So a caller that says `detach` gets an answer as soon as the fast checks
  // above have passed, and the passes run on behind it. Nothing is lost by
  // returning early: the single-flight guard is what prevents overlap, results
  // are logged by the loop itself, and a failure is captured into error_log
  // where every other job's failures already surface. Waiting for the total
  // instead would only mean choosing between a false failure every ten minutes
  // and a batch small enough to fit in five minutes, which no single long video
  // can be made to fit anyway.
  if (opts?.detach) {
    void drain(ownerId, opts.limit ?? 3, log).catch((err) =>
      captureError("youtube-transcript", err, { correlationId: log.correlationId })
    );
    return { ...NOTHING, started: true };
  }
  return drain(ownerId, opts?.limit ?? 3, log);
}

/**
 * The passes themselves. Assumes the caller has already claimed the
 * single-flight flag, and always releases it.
 */
async function drain(
  ownerId: string,
  limit: number,
  log: ReturnType<typeof createLogger>
): Promise<TranscriptRun> {
  const total: TranscriptRun = { scanned: 0, done: 0, failed: 0 };
  // KEEP GOING UNTIL THE WAITING LIST IS EMPTY, not just one batch of it. The
  // promise made to the owner is that a month of videos saved where this cannot
  // run (the cloud) is picked up by the first run on the machine that can, and
  // three at a time would instead have dribbled them out over hours. Captions
  // are seconds each, so a real backlog drains in one go.
  //
  // The budget is what keeps that honest: passes stop after twenty minutes and
  // the rest wait for the next tick, so a queue of Whisper-length videos hands
  // control back regularly instead of running for an hour unwatched.
  const deadline = Date.now() + 20 * 60_000;
  try {
    for (;;) {
      const pass = await transcribePass(ownerId, limit, log);
      total.scanned += pass.scanned;
      total.done += pass.done;
      total.failed += pass.failed;
      // A pass that found nothing, and nobody asking again while it ran, means
      // the list is empty.
      const more = pass.scanned > 0 || rerun;
      rerun = false;
      if (!more || Date.now() > deadline) break;
    }
    if (total.scanned > 0) log.info("youtube transcripts", { ...total });
    return total;
  } finally {
    running = false;
    rerun = false;
  }
}

async function transcribePass(
  ownerId: string,
  limit: number,
  log: ReturnType<typeof createLogger>
): Promise<TranscriptRun> {
  const rows = await getDb()
    .select({ id: items.id, url: items.url })
    .from(items)
    .where(pendingWhere(ownerId))
    .orderBy(items.createdAt)
    .limit(limit);

  // A batch that is full of things the code then refuses to work on is the
  // shape of a jammed queue: the loop below counts only what it attempts, the
  // drain reads a count of zero as an empty list, and everything behind these
  // rows waits forever. The query is supposed to make that impossible now, so
  // if it happens anyway, say which addresses did it. A day and a half of
  // "youtube transcripts started, ok" with nothing transcribed is what the
  // absence of this line cost (2026-09-02).
  if (rows.length > 0 && !rows.some((r) => isYoutubeVideoUrl(r.url))) {
    log.warn("youtube transcript queue is jammed: no candidate is a video", {
      urls: rows.map((r) => r.url),
    });
  }

  const date = today();
  const result: TranscriptRun = { scanned: 0, done: 0, failed: 0 };
  for (const row of rows) {
    if (!isYoutubeVideoUrl(row.url)) continue; // stricter than the query, by design
    result.scanned++;
    let existing = "";
    try {
      // Read the body now rather than in the list query: the invariant is that
      // list queries never select body, and by here we are down to one item we
      // are about to rewrite anyway. Inside the try because an item can be
      // deleted between the scan and this read, and one vanished video must not
      // take down the pass around it.
      existing = bodyMarkdown((await getItem(ownerId, row.id)).body);
      const t = await fetchTranscript(row.url as string);
      await updateItem(ownerId, row.id, {
        body: makeMarkdownBody(withTranscript(existing, { ...t, date })),
      });
      result.done++;
    } catch (err) {
      // The reason goes in the item, where the person who saved the video will
      // see it, AND in the errors list, because a job that fails silently is
      // indistinguishable from one that never ran (Principle 9). The next video
      // still gets its turn.
      const reason = err instanceof Error ? err.message : String(err);
      await captureError("youtube-transcript", err, {
        correlationId: log.correlationId,
        detail: { itemId: row.id },
      });
      await updateItem(ownerId, row.id, {
        body: makeMarkdownBody(withFailure(existing, reason, date)),
      }).catch(() => {
        // If even the failure note cannot be written, the marker is absent and
        // this video comes round again next run. Acceptable: the alternative is
        // taking the whole pass down over one item.
      });
      result.failed++;
    }
  }
  return result;
}
