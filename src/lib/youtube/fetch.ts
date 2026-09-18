// Getting the words out of a YouTube video, on this machine, for free.
//
// Two roads, cheapest first. Almost every video already carries captions (the
// creator's own, or YouTube's automatic ones), and pulling those is a few
// seconds of text with no video downloaded at all. Only when a video has no
// caption track do we fall back to Whisper, which downloads the audio and
// listens to it on the GPU: minutes, not seconds, and it wants the whole card.
//
// Everything here shells out to Python rather than adding a package. yt-dlp is
// the tool that actually keeps up with YouTube's constant changes, and it is a
// Python program; wrapping it in an npm package would mean trusting a second
// maintainer to keep up with the first. So `py -m yt_dlp` it is, and nothing
// joins package.json (Principle 5).
//
// NO FFMPEG ANYWHERE, on purpose. We take the audio stream exactly as YouTube
// serves it and let Whisper decode it (faster-whisper bundles PyAV), which
// skips the conversion step that would otherwise make ffmpeg a hard install
// requirement on every machine that wants this.
//
// Every failure here becomes a sentence a person reads in their own item, so
// the thrown messages are written for that reader, not for a log.
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type FetchedTranscript = { text: string; source: "captions" | "whisper" };

// How Python is spelled here. Windows ships the `py` launcher and usually has
// no `python3` on PATH; everywhere else it is the other way round. One place,
// because getting this wrong looks exactly like "the tools are not installed".
function python(): string {
  return process.platform === "win32" ? "py" : "python3";
}

// A caption line every few seconds for an hour is a few hundred KB, and a
// Whisper transcript of a long video can pass a megabyte. execFile's 1MB
// default would truncate that into nonsense, so raise it well past anything a
// single video produces.
const MAX_OUTPUT = 64 * 1024 * 1024;

// Ninety seconds, and it used to be five minutes. A caption track is a few
// hundred KB of text and arrives in seconds; five minutes never meant "nearly
// there", it meant something was wrong, and it bought two of them (creator
// track then automatic) before giving up. That is how one saved page cost ten
// minutes on 2026-08-31. The address test now rejects the page that caused it,
// so this is the second line of defence rather than the first.
const CAPTION_TIMEOUT_MS = 90_000;
const AUDIO_TIMEOUT_MS = 20 * 60_000;
const WHISPER_TIMEOUT_MS = 30 * 60_000;

/**
 * The installed yt-dlp version, or null when this machine has none.
 *
 * NEVER THROWS: the Build page calls this to tell the owner whether this copy
 * can do the work, and "we could not even ask" is the same answer as "it is not
 * installed" as far as that card is concerned. A short timeout because a
 * missing interpreter can otherwise sit there.
 */
export async function ytDlpVersion(): Promise<string | null> {
  try {
    const { stdout } = await run(python(), ["-m", "yt_dlp", "--version"], {
      timeout: 10_000,
      windowsHide: true,
    });
    // pip warnings can precede it; the version is the last non-empty line.
    const version = stdout.trim().split(/\r?\n/).pop()?.trim();
    return version || null;
  } catch {
    return null;
  }
}

/**
 * The transcript of one YouTube video: captions if it has any, Whisper if not.
 *
 * Throws an Error whose message is a short sentence fit to show a person,
 * because that is exactly where it ends up (withFailure writes it into the
 * item body). Never leaks a stack trace or a yt-dlp argument list into it.
 */
export async function fetchTranscript(url: string): Promise<FetchedTranscript> {
  // One directory per video, deleted in the finally below whatever happens.
  // Whisper's audio file is the reason this matters: leaving those behind would
  // quietly fill the disk of the machine doing the work.
  const dir = await mkdtemp(join(tmpdir(), "ledgr-yt-"));
  try {
    const captions = await fetchCaptions(url, dir);
    if (captions) return { text: captions, source: "captions" };
    return { text: await fetchWhisper(url, dir), source: "whisper" };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {
      // A locked file is not worth failing a finished transcript over.
    });
  }
}

// The creator's own captions first, YouTube's automatic ones only if there are
// none. TWO CALLS, not one with both flags: asked for both at once, yt-dlp
// happily downloads a 171KB original AND a 27KB automatic track for the same
// video, and nothing in the filename reliably says which is which, so we would
// be picking blind between them. Asking in order means the better track wins by
// arriving first, and we know which one we got. (Measured on the real machine,
// 2026-08-30.)
//
// --sub-langs is exactly `en`, never `en.*`: the wildcard matches YouTube's
// dozens of auto-TRANSLATED tracks (en-de, en-fr, …), which yt-dlp then fetches
// one at a time until YouTube answers 429 Too Many Requests. Same measurement.
//
// Note --skip-download: no video is fetched on this path at all.
async function fetchCaptions(url: string, dir: string): Promise<string | null> {
  const ask = [
    "--skip-download",
    "--write-subs",
    "--sub-langs",
    "en",
    "--sub-format",
    "vtt",
    "--no-playlist",
    "-o",
    join(dir, "cap.%(ext)s"),
    url,
  ];
  let attempt = await ytDlp(ask, CAPTION_TIMEOUT_MS);
  let vtt = await largestVtt(dir);
  if (!vtt) {
    attempt = await ytDlp(["--write-auto-subs", ...ask], CAPTION_TIMEOUT_MS);
    vtt = await largestVtt(dir);
  }

  if (!vtt) {
    // A video with no caption track is not a failure: yt-dlp exits 0 and simply
    // writes nothing, and that silence is the signal to try Whisper. A video we
    // could not REACH is a different thing, and sending it to Whisper would
    // waste twenty minutes to arrive at the same "it is private" answer, so say
    // it now.
    if (attempt.failed) throw new Error(whyYtDlpFailed(attempt));
    return null;
  }
  const text = vttToText(await readFile(vtt, "utf8"));
  return text || null;
}

// The caption file that landed, whatever yt-dlp decided to call it. The name
// depends on the track (cap.en.vtt, cap.en-orig.vtt, …), so predicting it is a
// bug waiting to happen; the largest one wins if more than one is there.
async function largestVtt(dir: string): Promise<string | null> {
  const names = (await readdir(dir)).filter((f) => f.endsWith(".vtt"));
  let best: { path: string; size: number } | null = null;
  for (const name of names) {
    const path = join(dir, name);
    const { size } = await stat(path);
    if (!best || size > best.size) best = { path, size };
  }
  return best?.path ?? null;
}

// Audio only, as YouTube serves it, then hand the file to Whisper. No
// --audio-format and no post-processing, which is what keeps ffmpeg out of it.
async function fetchWhisper(url: string, dir: string): Promise<string> {
  const attempt = await ytDlp(
    ["-f", "bestaudio", "--no-playlist", "-o", join(dir, "audio.%(ext)s"), url],
    AUDIO_TIMEOUT_MS
  );
  const audio = (await readdir(dir)).find((f) => f.startsWith("audio."));
  if (!audio) throw new Error(whyYtDlpFailed(attempt));

  let stdout: string;
  try {
    ({ stdout } = await run(python(), [whisperScript(), join(dir, audio)], {
      timeout: WHISPER_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT,
      windowsHide: true,
    }));
  } catch {
    // The script installs its own dependencies on first run, so a failure here
    // is usually no Python, no network for that install, or no room for the
    // model. The owner does not need which one to know what to do about it.
    throw new Error(
      "this video has no captions and Whisper is not available on this machine"
    );
  }
  const text = stdout.trim();
  if (!text) throw new Error("Whisper heard no speech in this video");
  return text;
}

// scripts/whisper-transcribe.py, from wherever the app was started. The local
// peer runs Next from the repo, so the working directory is the repo root; if
// that ever stops being true the Whisper path reports "not available" rather
// than doing something surprising.
function whisperScript(): string {
  return join(process.cwd(), "scripts", "whisper-transcribe.py");
}

type Attempt = { failed: boolean; killed: boolean; stderr: string; message: string };

// One yt-dlp run, which NEVER throws by itself.
//
// A run that exits non-zero is not automatically a failed download: yt-dlp
// currently warns on every single call ("no impersonate target is available")
// and still returns the file. The caller decides what success means by looking
// for the file it asked for, and only reaches for `failed` to explain an
// absence. Judging by exit code or by an empty stderr would call every working
// download broken.
async function ytDlp(args: string[], timeout: number): Promise<Attempt> {
  try {
    const { stderr } = await run(python(), ["-m", "yt_dlp", ...args], {
      timeout,
      maxBuffer: MAX_OUTPUT,
      windowsHide: true,
    });
    return { failed: false, killed: false, stderr, message: "" };
  } catch (err) {
    const e = err as { stderr?: string; message?: string; killed?: boolean };
    return {
      failed: true,
      killed: e?.killed === true,
      stderr: `${e?.stderr ?? ""}`,
      message: `${e?.message ?? ""}`,
    };
  }
}

// yt-dlp's own words, turned into one sentence for a person. The cases listed
// are the ones that actually happen to a saved link: the video went away, it is
// someone's private upload, or YouTube decided this machine looks like a robot.
function whyYtDlpFailed(attempt: Attempt): string {
  const stderr = attempt.stderr;
  if (attempt.killed) return "this video took too long to fetch, so it was given up on";
  if (/private video/i.test(stderr)) return "the video is private or removed";
  if (/unavailable|has been removed|does not exist|has been terminated/i.test(stderr)) {
    return "the video is private or removed";
  }
  if (/sign in to confirm|age.?restricted|not a bot/i.test(stderr)) {
    return "YouTube would not serve this video to this machine without signing in";
  }
  if (/members.only|premium/i.test(stderr)) return "this video is for members only";
  const line = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => /^ERROR/i.test(l));
  const why = (line || attempt.message || "the video could not be fetched")
    .replace(/^ERROR:\s*/i, "")
    .slice(0, 160);
  return `the video could not be fetched: ${why}`;
}

// The entities a caption file actually carries. Not a general HTML decoder:
// captions are plain speech, so this list is the whole set in practice.
const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

// A cue timestamp in seconds. WebVTT allows both hh:mm:ss.mmm and mm:ss.mmm,
// and some writers use a comma for the decimal, so all three are accepted.
function cueSeconds(stamp: string): number {
  const parts = stamp.replace(",", ".").split(":").map(Number);
  return parts.reduce((total, n) => total * 60 + n, 0);
}

// Gap between one cue ending and the next starting that reads as a new thought.
const PAUSE_SECONDS = 2.5;
// A paragraph this long gets broken even without a pause, so a wall of speech
// still arrives as something readable.
const PARAGRAPH_CHARS = 700;

/**
 * A WebVTT caption file turned into plain reading text.
 *
 * The messy part is automatic captions. They scroll: each cue repeats the line
 * before it and adds one more, and each word carries its own inline timestamp
 * so the highlight can follow the speech. Pasted raw, an hour of that is the
 * same sentences three times over, wrapped in markup. So: drop the machinery,
 * drop a line we have just emitted, and group what is left into paragraphs.
 *
 * No timestamps in the output, deliberately (the plan's call): plain paragraphs
 * read better and search better, and nothing else in Ledgr wants to jump to a
 * moment in a video yet.
 */
export function vttToText(vtt: string): string {
  const paragraphs: string[] = [];
  let current: string[] = [];
  // The last few lines emitted. A rolling caption repeats the previous line,
  // and sometimes the one before that, so a small window catches it where
  // comparing against only the last line would not.
  const recent: string[] = [];
  let previousEnd = 0;

  const flush = () => {
    if (current.length) paragraphs.push(current.join(" "));
    current = [];
  };

  for (const raw of vtt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^WEBVTT/.test(line)) continue;
    if (/^(Kind|Language|NOTE|STYLE|REGION)\b/i.test(line)) continue;
    if (/^\d+$/.test(line)) continue; // a cue number

    // A timing line, with any cue settings (align:start position:0%) trailing
    // it. Only the two timestamps matter, and only for the pause between cues.
    const timing = /^((?:\d{1,3}:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d{1,3}:)?\d{1,2}:\d{2}[.,]\d{1,3})/.exec(
      line
    );
    if (timing) {
      const start = cueSeconds(timing[1]);
      if (previousEnd && start - previousEnd > PAUSE_SECONDS) flush();
      previousEnd = cueSeconds(timing[2]);
      continue;
    }

    let text = line.replace(/<[^>]*>/g, ""); // <00:00:01.234> and <c>…</c>
    for (const [entity, char] of Object.entries(ENTITIES)) {
      text = text.split(entity).join(char);
    }
    text = text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    // Sound cues ([Music], [Applause], [Laughter]) are dropped when they are the
    // whole line. They are not speech, and a music-heavy video would otherwise
    // read as a column of [Music]. A bracketed aside inside a spoken line stays,
    // since there it is usually part of the sentence.
    if (/^\[[^\]]*\]$/.test(text)) continue;
    if (recent.includes(text)) continue;

    recent.push(text);
    if (recent.length > 3) recent.shift();
    current.push(text);
    if (current.join(" ").length > PARAGRAPH_CHARS) flush();
  }
  flush();

  return paragraphs.join("\n\n").trim();
}
