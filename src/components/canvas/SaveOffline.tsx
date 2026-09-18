// Save Offline (PRD §4.7): one tap makes a document available with no
// network at all. Three legs: (1) export to OneDrive now via POST /api/export,
// (2) pin the self-contained print render (/items/[id]/print) plus its images
// into the service worker's ledgr-pin-v1 cache — *verified* with a cache.match
// round-trip before "saved ✓" is shown, never best-effort, (3) the print
// view's @media print styles make the browser's print-to-PDF the PDF leg.
// The pin is stored under both the print URL and /items/[id], so an offline
// navigation to the item itself serves the clean document render.
"use client";

import { useEffect, useState } from "react";

const PIN_CACHE = "ledgr-pin-v1";

type LegState =
  | { phase: "idle" }
  | { phase: "busy" }
  | { phase: "ok"; detail: string }
  | { phase: "fail"; detail: string };

async function exportLeg(): Promise<LegState> {
  try {
    const res = await fetch("/api/export", { method: "POST" });
    if (res.status === 503) {
      return {
        phase: "fail",
        detail: "OneDrive export not configured yet (runbook §1b)",
      };
    }
    if (!res.ok) return { phase: "fail", detail: `export failed (${res.status})` };
    // errors/remaining are counts, not arrays (ExportRunResult). This read used
    // to be `errors.length` on a number, so the failure branch never fired.
    const result = (await res.json()) as {
      exported?: number;
      errors?: number;
      remaining?: number;
    };
    if (result.errors && result.errors > 0) {
      return { phase: "fail", detail: `export ran with ${result.errors} error(s)` };
    }
    // A run stops at its time budget, so a large backlog finishes over several
    // runs. Say so rather than implying OneDrive is fully caught up.
    const queued = result.remaining
      ? `, ${result.remaining} still queued`
      : "";
    return {
      phase: "ok",
      detail: `exported to OneDrive ✓ (${result.exported ?? 0} item(s)${queued})`,
    };
  } catch {
    return { phase: "fail", detail: "export unreachable (offline?)" };
  }
}

async function pinLeg(itemId: string): Promise<LegState> {
  if (!("caches" in window)) {
    return { phase: "fail", detail: "offline cache unavailable in this browser" };
  }
  const printUrl = `/items/${itemId}/print`;
  try {
    const res = await fetch(printUrl, { cache: "no-store" });
    if (!res.ok) return { phase: "fail", detail: `fetch failed (${res.status})` };
    const html = await res.text();
    // Date is stamped so public/offline.html can say "saved Aug 10" per row —
    // a hand-built Response carries no Date of its own. The offline directory
    // filters pins on the /items/{id}/print pathname, so changing what this
    // function pins (a query param, a different route) silently empties that
    // list; scripts/verify-offline-landing.mts guards the pair.
    const headers = {
      "Content-Type": "text/html; charset=utf-8",
      Date: new Date().toUTCString(),
    };
    const cache = await caches.open(PIN_CACHE);
    await cache.put(printUrl, new Response(html, { headers }));
    await cache.put(`/items/${itemId}`, new Response(html, { headers }));

    // Pin the document's images too (slides, diagrams). Cross-origin
    // (R2) fetches may only yield opaque responses; those still serve from
    // the cache. Image failures downgrade the message, not the pin.
    const doc = new DOMParser().parseFromString(html, "text/html");
    const srcs = [...doc.querySelectorAll("img")]
      .map((img) => img.getAttribute("src"))
      .filter((s): s is string => !!s);
    let imagesPinned = 0;
    for (const src of srcs) {
      try {
        let imgRes = await fetch(src, { cache: "no-store" }).catch(() => null);
        if (!imgRes || (!imgRes.ok && imgRes.type !== "opaque")) {
          imgRes = await fetch(src, { mode: "no-cors", cache: "no-store" });
        }
        await cache.put(src, imgRes);
        imagesPinned += 1;
      } catch {
        // counted below
      }
    }

    // The verification round-trip: only a re-read copy proves the pin. Match on
    // a marker every print document carries — the print-bar's window.print()
    // handler plus the full <html>…</html> shell — not the title <h1>, which
    // renderPrintDocument suppresses for chordpro chord-chart bodies. A 404
    // "Not found" string or a /sign-in redirect body carries neither, so it
    // still fails.
    const stored = await cache.match(printUrl);
    const storedItem = await cache.match(`/items/${itemId}`);
    const body = stored ? await stored.text() : "";
    const isPrintDoc =
      body.includes("window.print()") && body.includes("</html>");
    if (!stored || !storedItem || !isPrintDoc) {
      return { phase: "fail", detail: "pin verification failed — not cached" };
    }
    const imgNote =
      srcs.length > 0
        ? `, ${imagesPinned}/${srcs.length} image(s)`
        : "";
    return { phase: "ok", detail: `saved for offline ✓${imgNote}` };
  } catch {
    return { phase: "fail", detail: "pin failed" };
  }
}

function Row({ state }: { state: LegState }) {
  if (state.phase === "idle") return null;
  const color =
    state.phase === "ok"
      ? "text-green-400"
      : state.phase === "fail"
        ? "text-red-400"
        : "text-neutral-500";
  return (
    <li className={`text-xs ${color}`}>
      {state.phase === "busy" ? "working…" : state.detail}
    </li>
  );
}

export default function SaveOffline({
  itemId,
  bare = false,
}: {
  itemId: string;
  // Drop the standalone canvas wrapper (width + padding) when nested inside a
  // parent section that already provides alignment — e.g. the shared footer's
  // "Export & sharing" details. Default keeps the widget-card usage unchanged.
  bare?: boolean;
}) {
  const [exportState, setExportState] = useState<LegState>({ phase: "idle" });
  const [pinState, setPinState] = useState<LegState>({ phase: "idle" });
  const [alreadyPinned, setAlreadyPinned] = useState(false);

  // Surface an existing pin so "is this available offline?" has an answer
  // without re-running anything.
  useEffect(() => {
    if (!("caches" in window)) return;
    let cancelled = false;
    void caches
      .open(PIN_CACHE)
      .then((c) => c.match(`/items/${itemId}/print`))
      .then((hit) => {
        if (!cancelled && hit) setAlreadyPinned(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [itemId]);

  const busy = exportState.phase === "busy" || pinState.phase === "busy";

  async function run() {
    if (busy) return;
    setExportState({ phase: "busy" });
    setPinState({ phase: "busy" });
    // Independent legs: a 503 from OneDrive must not block the pin.
    const [exp, pin] = await Promise.all([exportLeg(), pinLeg(itemId)]);
    setExportState(exp);
    setPinState(pin);
    if (pin.phase === "ok") setAlreadyPinned(true);
  }

  async function unpin() {
    if (!("caches" in window)) return;
    const cache = await caches.open(PIN_CACHE);
    await cache.delete(`/items/${itemId}/print`);
    await cache.delete(`/items/${itemId}`);
    setAlreadyPinned(false);
    setPinState({ phase: "idle" });
    setExportState({ phase: "idle" });
  }

  return (
    <div className={bare ? "" : "mx-auto w-full max-w-3xl px-2 pt-2 sm:px-8 md:px-12"}>
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={() => void run()}
          disabled={busy}
          className="rounded border border-neutral-700 bg-neutral-800 px-2.5 py-1 text-xs font-medium text-neutral-200 hover:bg-neutral-700 disabled:opacity-50"
        >
          {busy ? "Working…" : "Save Offline"}
        </button>
        <a
          href={`/items/${itemId}/print`}
          target="_blank"
          className="text-xs text-neutral-500 hover:text-neutral-300"
        >
          Print / PDF view ↗
        </a>
        {alreadyPinned && pinState.phase === "idle" && (
          <span className="text-xs text-green-500/80">
            saved offline ✓
            <button
              onClick={() => void unpin()}
              className="ml-2 text-neutral-600 hover:text-neutral-400"
            >
              remove
            </button>
          </span>
        )}
      </div>
      {(exportState.phase !== "idle" || pinState.phase !== "idle") && (
        <ul className="mt-1.5 flex flex-col gap-0.5">
          <Row state={exportState} />
          <Row state={pinState} />
        </ul>
      )}
    </div>
  );
}
