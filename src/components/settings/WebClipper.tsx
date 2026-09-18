// "Save from the web" (web clipper) setup (ADR-122). The clipper itself shipped
// with ADR-100, but its setup lived buried at the bottom of Build → AI & MCP
// next to MCP tokens, where nobody looking to "save a web page" would find it.
// This is its framing: one place to drag the desktop bookmarklet and read the
// mobile share-sheet steps. It's a set-up-once surface (drag the bookmarklet
// once; install the PWA once), so it never earned a daily-nav slot. It sat on
// User Settings until ADR-249 moved it to Build → Capture & Inbox, next to the
// routing that decides where a clipped page lands. The draggable link lives in
// ClipperSetup; this wrapper supplies the framing and the mobile walkthrough.
//
// ADR-238 removed the token step entirely, and with it the readiness
// breadcrumb this section used to carry: there is no longer a state in which
// the clipper is unavailable, so there is nothing to report.
import ClipperSetup from "@/components/build/ClipperSetup";

export default function WebClipper({ origin }: { origin: string }) {
  return (
    <section className="mt-10 border-t border-neutral-800 pt-6">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">
        Save from the web
      </h2>
      <p className="mt-1 text-sm text-neutral-500">
        Clip a web page&rsquo;s readable content into Ledgr, from desktop or your
        phone. The article saves as a link item carrying its text, so you keep
        the substance even if the original moves or disappears. Where it lands
        is the Web clipper and Phone share sheet routing above.
      </p>

      {/* Desktop: the draggable bookmarklet. */}
      <h3 className="mt-6 text-xs font-semibold uppercase tracking-wide text-neutral-500">
        On desktop
      </h3>
      <ClipperSetup origin={origin} />

      {/* Mobile: the PWA share target. The share sheet only hands us the URL,
          so Ledgr re-fetches the page server-side to pull its content — which
          works for public pages and degrades to link + title for the rest. */}
      <h3 className="mt-7 text-xs font-semibold uppercase tracking-wide text-neutral-500">
        On mobile
      </h3>
      <ol className="mt-2 ml-4 list-decimal space-y-1.5 text-sm text-neutral-400">
        <li>
          Open Ledgr in your phone&rsquo;s browser and add it to your home
          screen (iPhone: Share → Add to Home Screen; Android: browser menu →
          Install app / Add to Home screen).
        </li>
        <li>
          From any app, tap Share and choose Ledgr. The page lands wherever you
          routed the share sheet above.
        </li>
      </ol>
      <p className="mt-2 text-xs text-neutral-600">
        Public pages capture their full readable content; pages behind a login
        or paywall save the link and title.
      </p>
    </section>
  );
}
