// Web clipper bookmarklet (ADR-100, ADR-160, ADR-238). The bookmarklet carries
// NO credential: it hands the captured page to a popup on Ledgr's own origin,
// and that popup saves as the signed-in owner. So this is a static draggable
// link, the same URL for anyone on this instance — drag it once, and the first
// click while signed out sends the popup through sign-in and saves from there
// on. (Before ADR-238 a token was baked into the URL, which meant minting one,
// keeping the bookmark secret, and rotating an env var to revoke it.)
"use client";

import { useEffect, useRef } from "react";

// Reads the live DOM (no script injection, so page CSP can't block it),
// extraction + image-stripping happen server-side. {ORIGIN} is filled in below.
// Kept terse: a bookmarklet is one URL.
//
// The actual save happens through a popup on Ledgr's own origin
// (/capture/relay), not a fetch() from inside the host page: some sites (e.g.
// YouTube) ship a CSP `connect-src` that silently blocks a cross-origin
// fetch() from their page, which otherwise surfaces as a bare "Failed to
// fetch" with no workaround available from inside that page. Opening a
// popup and handing the captured data over via postMessage sidesteps that
// entirely, since the POST is then made from Ledgr's own page — and that page,
// being Ledgr's own origin, carries the owner's session, which is what lets the
// bookmarklet stay credential-free.
//
// The ready/send handshake repeats rather than firing once: when the popup
// lands on sign-in first, the relay page that finally announces itself is a
// SECOND page load, and a one-shot listener would have already been torn down
// by then. So we answer every "ready" ping — until the relay says it saved,
// which retires the listener so a later reload of that popup can't re-send the
// clip and file it twice.
export function buildBookmarklet(origin: string): string {
  const relay = origin + "/capture/relay";
  const src = `(function(){var d={url:location.href,title:document.title,html:document.documentElement.outerHTML};var w=window.open(${JSON.stringify(
    relay
  )},"ledgr-clip","width=380,height=200");if(!w){alert("Ledgr: please allow pop-ups for this site, then try again");return}function m(e){if(e.source!==w)return;if(e.data==="ledgr-relay-ready")w.postMessage(d,${JSON.stringify(
    origin
  )});else if(e.data==="ledgr-relay-saved")window.removeEventListener("message",m)}window.addEventListener("message",m)})();`;
  return "javascript:" + encodeURIComponent(src);
}

export default function ClipperSetup({ origin }: { origin: string }) {
  const linkRef = useRef<HTMLAnchorElement>(null);

  // Set the href imperatively: React sanitizes `javascript:` hrefs in JSX, so
  // we write the attribute straight to the DOM node instead.
  useEffect(() => {
    linkRef.current?.setAttribute("href", buildBookmarklet(origin));
  }, [origin]);

  return (
    <div className="mt-4 flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <a
          ref={linkRef}
          draggable
          onClick={(e) => e.preventDefault()}
          className="inline-flex cursor-grab items-center gap-2 rounded-lg border border-[var(--accent)]/40 bg-[var(--accent)]/15 px-3.5 py-2 text-sm font-semibold text-[var(--accent)] active:cursor-grabbing"
        >
          📎 Clip to Ledgr
        </a>
        <span className="text-xs text-neutral-500">
          Drag this to your bookmarks bar.
        </span>
      </div>

      <p className="text-xs leading-relaxed text-neutral-500">
        Then click it on any page to save it, with its readable content and its
        images stripped, wherever you routed the Web clipper above. It briefly
        opens a small Ledgr popup to do the
        save (which also works around sites that block cross-site requests, e.g.
        YouTube) — allow pop-ups for it if your browser asks. If you&rsquo;re not
        signed in to Ledgr, that popup asks you to sign in the first time, then
        saves. The bookmark holds no password or token, so it&rsquo;s safe to
        keep and nothing needs revoking.
      </p>
    </div>
  );
}
