"use client";

// Bookmarklet relay (fixes the clipper on CSP-strict sites, e.g. YouTube).
// The bookmarklet can't fetch() the Ledgr API directly from a page whose CSP
// `connect-src` doesn't allow it — that throws a bare "Failed to fetch" with
// no way to work around it from inside that page. So the bookmarklet instead
// opens this page (Ledgr's own origin, so the host page's CSP no longer
// applies) and hands over the captured data via postMessage; this page makes
// the actual POST to /api/machine/capture.
import { useEffect, useRef, useState } from "react";

type Status = "waiting" | "saving" | "done" | "error";

export default function CaptureRelay() {
  const [status, setStatus] = useState<Status>("waiting");
  const [message, setMessage] = useState("Waiting for the page to clip…");
  // One clip per popup. The opener answers EVERY "ready" ping (ADR-238, so a
  // popup that detoured through sign-in still gets its data), which means this
  // page can be handed the same clip more than once — twice on any double
  // "ready", e.g. React StrictMode running this effect twice in dev. Without
  // this latch each hand-off became its own item, so one click saved two.
  const saved = useRef(false);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.source !== window.opener) return;
      const data = event.data as {
        url?: string;
        title?: string;
        html?: string;
      } | null;
      if (!data || typeof data.url !== "string") return;
      if (saved.current) return;
      saved.current = true;
      setStatus("saving");
      setMessage("Saving to Ledgr…");
      // No Authorization header: this page is Ledgr's own origin, so the POST
      // is same-origin and carries the owner's session (ADR-238). The
      // bookmarklet therefore carries no credential at all.
      fetch("/api/machine/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: data.url, title: data.title, html: data.html }),
      })
        .then(async (res) => {
          const body = await res.json().catch(() => ({}));
          // A 401 here means the session lapsed between this page rendering
          // and the save. Say what to do rather than showing "unauthorized".
          if (res.status === 401) {
            throw new Error("sign in to Ledgr, then click the bookmarklet again");
          }
          if (!res.ok) throw new Error(body.error || "failed");
          // Tell the opener to stop answering "ready": this clip is filed, so a
          // later page load in this popup must not save it a second time.
          window.opener?.postMessage("ledgr-relay-saved", "*");
          setStatus("done");
          setMessage(
            body.duplicate
              ? "Already in your Inbox."
              : body.extracted
                ? "Saved to your Inbox (with content)."
                : "Saved to your Inbox (link only)."
          );
          setTimeout(() => window.close(), 1200);
        })
        .catch((err: Error) => {
          setStatus("error");
          setMessage(`Ledgr: ${err.message}`);
        });
    }

    window.addEventListener("message", onMessage);
    // Tell the opener we're ready to receive the captured page data.
    window.opener?.postMessage("ledgr-relay-ready", "*");
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-950 p-6 text-center">
      <p
        className={`text-sm ${
          status === "error"
            ? "text-red-400"
            : status === "done"
              ? "text-emerald-400"
              : "text-neutral-400"
        }`}
      >
        {message}
        {status === "error" ? <><br />You can close this window.</> : null}
      </p>
    </div>
  );
}
