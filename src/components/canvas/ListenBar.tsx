// Listen (read-aloud) control (per-type opt-in, Build → Types "Listen"
// column). Mounted once per item from ItemCanvas (not any per-type canvas —
// that way it works identically on every canvas: default markdown, tabs,
// two-pane, module canvases), with the item's speech text (already
// CriticMarkup/code-stripped server-side by speechTextFor). Zero deps: the
// browser's own speechSynthesis engine.
//
// No idle button (Brandon, 2026-08-15): the entry point is the item's ⋯ menu
// ("Listen", ItemActionsMenu), which dispatches a `ledgr:listen` window
// CustomEvent. This component renders NOTHING until it hears that event (or
// arms via ?listen=1) — the menu stays dumb, this owns the decision:
//  - listenOpenInEdge off (default), or already Edge, or no redirect on this
//    platform (iOS has no Edge deep link): arm and start speaking immediately
//    (the menu click IS the user gesture speechSynthesis needs).
//  - listenOpenInEdge on, not already Edge, redirect available: navigate to
//    this item's URL with ?listen=1 in Edge (better free voices) instead of
//    arming here. Landing back already-in-Edge falls through to the first case.
//
// Chunking: split into sentence-ish pieces, hard-capped so Chrome's "long
// utterance gets silently killed" bug (arbitrary-length utterances can just
// stop) never bites, queued one at a time via each utterance's onend — never
// all queued at once. Pause is implemented as cancel + remember the chunk
// index, not the native pause(), which is unreliable on Android.
"use client";

import { useEffect, useRef, useState } from "react";

// Up to 3x: speechSynthesis caps rate at 10, but voices vary in how gracefully
// they hold together past ~2x, so the ceiling here is "still intelligible for
// skimming," not the API limit.
const RATE_OPTIONS = [0.8, 1, 1.2, 1.5, 2, 2.5, 3] as const;
const RATE_STORAGE_KEY = "ledgr.listen.rate";
const VOICE_STORAGE_KEY = "ledgr.listen.voice";
const MAX_CHUNK_CHARS = 250;

// Picking a voice is the whole point of the Edge trip, and it has to be
// explicit: an utterance with no `voice` set gets the platform default, which
// on Windows is a legacy SAPI voice (the "Microsoft Sam" experience) even in a
// browser that also offers far better ones. Edge exposes Microsoft's neural
// voices to the same Web Speech API for free, named "… Online (Natural)".
// Higher score wins; ties keep the browser's own order.
function voiceScore(v: SpeechSynthesisVoice): number {
  let score = 0;
  if (/natural/i.test(v.name)) score += 8; // Edge's neural voices
  if (/online/i.test(v.name)) score += 4; // server-side, better than local SAPI
  if (!v.localService) score += 2;
  if (/google/i.test(v.name)) score += 3; // Chrome/Android's better-than-default set
  if (/^Microsoft (Sam|David|Mark|Zira|Hazel)\b/i.test(v.name)) score -= 4; // legacy SAPI
  if (v.default) score += 1;
  return score;
}

// Same language family as the page, so a US reader never lands on a French
// voice reading English. Falls back to every voice if nothing matches.
function pickableVoices(all: SpeechSynthesisVoice[]): SpeechSynthesisVoice[] {
  const lang = (typeof document !== "undefined" && document.documentElement.lang) || "en";
  const base = lang.split("-")[0].toLowerCase();
  const matching = all.filter((v) => v.lang.split("-")[0].toLowerCase() === base);
  const pool = matching.length > 0 ? matching : all;
  return [...pool].sort((a, b) => voiceScore(b) - voiceScore(a));
}

function chunkText(text: string, maxLen = MAX_CHUNK_CHARS): string[] {
  const sentences = text.match(/[^.!?]+[.!?]*\s*/g) ?? [text];
  const chunks: string[] = [];
  let buf = "";
  for (const raw of sentences) {
    let s = raw;
    if (buf && (buf + s).length > maxLen) {
      chunks.push(buf.trim());
      buf = "";
    }
    while (s.length > maxLen) {
      let cut = s.lastIndexOf(" ", maxLen);
      if (cut <= 0) cut = maxLen;
      chunks.push(s.slice(0, cut).trim());
      s = s.slice(cut).trim();
    }
    buf += (buf ? " " : "") + s;
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks.filter(Boolean);
}

function Icon({ d }: { d: string }) {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
      aria-hidden
      focusable={false}
    >
      <path d={d} />
    </svg>
  );
}

const PLAY_PATH = "M6 4l14 8-14 8V4z";
const PAUSE_PATH = "M6 4h4v16H6zM14 4h4v16h-4z";
const STOP_PATH = "M5 5h14v14H5z";

type Status = "idle" | "speaking" | "paused";

export default function ListenBar({
  text,
  listenOpenInEdge,
}: {
  text: string;
  listenOpenInEdge: boolean;
}) {
  const [armed, setArmed] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [rate, setRate] = useState<number>(1);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceURI, setVoiceURI] = useState<string>("");

  const chunksRef = useRef<string[]>(chunkText(text));
  const idxRef = useRef(0);
  const cancelledRef = useRef(false);
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);
  const rateRef = useRef(rate);
  rateRef.current = rate;
  const statusRef = useRef<Status>(status);
  statusRef.current = status;
  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);
  voiceRef.current = voices.find((v) => v.voiceURI === voiceURI) ?? null;

  useEffect(() => {
    chunksRef.current = chunkText(text);
    idxRef.current = 0;
  }, [text]);

  async function requestWakeLock() {
    try {
      wakeLockRef.current =
        (await (navigator as Navigator & {
          wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> };
        }).wakeLock?.request("screen")) ?? null;
    } catch {
      // Not supported, or refused (e.g. backgrounded tab) — speech still plays.
    }
  }
  function releaseWakeLock() {
    wakeLockRef.current?.release().catch(() => {});
    wakeLockRef.current = null;
  }

  function speakFrom(i: number) {
    cancelledRef.current = false;
    const chunks = chunksRef.current;
    if (i >= chunks.length) {
      idxRef.current = 0;
      setStatus("idle");
      releaseWakeLock();
      return;
    }
    idxRef.current = i;
    const u = new SpeechSynthesisUtterance(chunks[i]);
    u.rate = rateRef.current;
    // Without this the platform default speaks, however good the alternatives.
    if (voiceRef.current) {
      u.voice = voiceRef.current;
      u.lang = voiceRef.current.lang;
    }
    const advance = () => {
      if (!cancelledRef.current) speakFrom(i + 1);
    };
    u.onend = advance;
    u.onerror = advance; // don't get stuck on one bad chunk
    window.speechSynthesis.speak(u);
  }

  function handlePlay() {
    setArmed(true);
    setStatus("speaking");
    void requestWakeLock();
    speakFrom(idxRef.current);
  }
  function handlePauseResume() {
    if (statusRef.current === "speaking") {
      cancelledRef.current = true;
      window.speechSynthesis.cancel();
      setStatus("paused");
      releaseWakeLock();
    } else if (statusRef.current === "paused") {
      setStatus("speaking");
      void requestWakeLock();
      speakFrom(idxRef.current);
    }
  }
  function handleStop() {
    cancelledRef.current = true;
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    idxRef.current = 0;
    setStatus("idle");
    setArmed(false); // Stop disarms — back to fully hidden (no idle bar).
    releaseWakeLock();
  }
  function changeRate(n: number) {
    setRate(n);
    try {
      localStorage.setItem(RATE_STORAGE_KEY, String(n));
    } catch {
      // Best-effort persistence only.
    }
  }
  function changeVoice(uri: string) {
    setVoiceURI(uri);
    try {
      localStorage.setItem(VOICE_STORAGE_KEY, uri);
    } catch {
      // Best-effort persistence only.
    }
    // Re-speak the current chunk in the new voice, so the choice is audible
    // immediately rather than at the next sentence boundary.
    if (statusRef.current === "speaking") {
      cancelledRef.current = true;
      window.speechSynthesis.cancel();
      const resumeAt = idxRef.current;
      const v = voices.find((x) => x.voiceURI === uri) ?? null;
      voiceRef.current = v;
      setTimeout(() => speakFrom(resumeAt), 0);
    }
  }

  // Voices arrive asynchronously (getVoices() is commonly empty on first call,
  // and Edge's online set lands later still), so this listens for
  // `voiceschanged` as well as reading once. The saved choice wins if it's
  // still present; otherwise the best-ranked voice is selected for the user,
  // which is what makes the Edge trip pay off without them hunting a menu.
  useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    let saved = "";
    try {
      saved = localStorage.getItem(VOICE_STORAGE_KEY) ?? "";
    } catch {
      // Ignore; the auto-pick below covers it.
    }
    function load() {
      const ranked = pickableVoices(window.speechSynthesis.getVoices());
      if (ranked.length === 0) return;
      setVoices(ranked);
      setVoiceURI((current) => {
        if (current && ranked.some((v) => v.voiceURI === current)) return current;
        if (saved && ranked.some((v) => v.voiceURI === saved)) return saved;
        return ranked[0].voiceURI;
      });
    }
    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", load);
  }, []);

  // Client-only feature/UA detection, the `ledgr:listen` listener (the ⋯ menu
  // click's target), and ?listen=1 auto-arm (show the player, never
  // auto-speak — a redirect landing has no user gesture yet, the Play tap
  // supplies it). One mount-only effect: the redirect decision needs the UA
  // read anyway, and closing over local consts here (not state) means the
  // listener never sees a stale value.
  /* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */
  useEffect(() => {
    setSupported("speechSynthesis" in window);
    const ua = navigator.userAgent;
    const inEdge = /Edg\//.test(ua);
    const isIOS = /iPad|iPhone|iPod/.test(ua);
    let edgeHref: string | null = null;
    if (!isIOS) {
      const isAndroid = /Android/.test(ua);
      const url = new URL(window.location.href);
      url.searchParams.set("listen", "1");
      edgeHref = isAndroid
        ? `intent://${window.location.host}${url.pathname}${url.search}#Intent;scheme=https;package=com.microsoft.emmx;end`
        : `microsoft-edge:${url.toString()}`;
    }
    try {
      const saved = parseFloat(localStorage.getItem(RATE_STORAGE_KEY) ?? "");
      if ((RATE_OPTIONS as readonly number[]).includes(saved)) setRate(saved);
    } catch {
      // localStorage can throw in a locked-down context; the default holds.
    }
    if (new URLSearchParams(window.location.search).get("listen") === "1") {
      setArmed(true);
    }

    function onListen() {
      if (listenOpenInEdge && !inEdge && edgeHref) {
        window.location.href = edgeHref!;
      } else {
        handlePlay();
      }
    }
    window.addEventListener("ledgr:listen", onListen);
    return () => window.removeEventListener("ledgr:listen", onListen);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */

  // Re-request the wake lock if it was released when the tab backgrounded,
  // whenever the user returns to it while still (logically) playing.
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === "visible" && statusRef.current === "speaking") {
        void requestWakeLock();
      }
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  useEffect(() => {
    return () => {
      cancelledRef.current = true;
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
      releaseWakeLock();
    };
  }, []);

  if (!text.trim() || !armed) return null;

  if (supported === false) {
    return (
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex justify-center px-4">
        <p className="pointer-events-auto rounded-card border border-line bg-surface-1 px-2.5 py-1.5 text-xs text-ink-faint shadow-lg">
          Read-aloud isn&rsquo;t supported in this browser.
        </p>
      </div>
    );
  }

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex justify-center px-4">
      <div className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-card border border-line bg-surface-1 px-2.5 py-1.5 text-xs text-ink-muted shadow-lg">
        <button
          type="button"
          onClick={status === "idle" ? handlePlay : handlePauseResume}
          className="flex items-center gap-1 rounded-card border border-line-strong bg-surface-2 px-2 py-1 hover:bg-surface-3"
        >
          <Icon d={status === "speaking" ? PAUSE_PATH : PLAY_PATH} />
          {status === "speaking" ? "Pause" : status === "paused" ? "Resume" : "Play"}
        </button>
        <button
          type="button"
          onClick={handleStop}
          disabled={status === "idle"}
          className="flex items-center gap-1 rounded-card border border-line-strong bg-surface-2 px-2 py-1 hover:bg-surface-3 disabled:opacity-40"
        >
          <Icon d={STOP_PATH} />
          Stop
        </button>
        {voices.length > 1 && (
          <label className="flex min-w-0 items-center gap-1.5 text-ink-subtle">
            Voice
            <select
              value={voiceURI}
              onChange={(e) => changeVoice(e.target.value)}
              className="max-w-[11rem] truncate rounded-card border border-line-strong bg-surface-2 px-1.5 py-0.5 text-ink-muted"
              title="Voices come from your browser. Edge offers Microsoft's Natural voices; Chrome and Android offer the Google set."
            >
              {voices.map((v) => (
                <option key={v.voiceURI} value={v.voiceURI}>
                  {v.name.replace(/^Microsoft /, "").replace(/ - .*$/, "")}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="ml-auto flex items-center gap-1.5 text-ink-subtle">
          Rate
          <select
            value={rate}
            onChange={(e) => changeRate(parseFloat(e.target.value))}
            className="rounded-card border border-line-strong bg-surface-2 px-1.5 py-0.5 text-ink-muted"
          >
            {RATE_OPTIONS.map((r) => (
              <option key={r} value={r}>
                {r}×
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}
