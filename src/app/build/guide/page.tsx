// User Guide (ADR-189) — the in-app doorway onto the "Using Ledgr" guide.
//
// The markdown is NOT written here. It lives once in src/lib/mcp/user-guide.ts
// and is served three ways: this page, the MCP resource ledgr://guide/using-ledgr,
// and the links that point at this route (Build sidebar, Work "More", palette).
// Editing the guide means editing that file; this page only renders it.
//
// A plain server component: markdown-it is server-only by rule
// (markdown-render.ts), so the render happens here and the client ships no JS
// for it. Static — no owner data, no DB read — so no force-dynamic.
//
// The `.ledgr-prose` stylesheet normally arrives with the LAZY editor bundle
// (MarkdownEditor.tsx is its only other importer), so this page imports it
// directly. Without that import the guide renders unstyled — the same class of
// bug the strict cssChunking fix chased. Don't drop the import.
import { markdownToHtml } from "@/lib/markdown-render";
import { USING_LEDGR_GUIDE } from "@/lib/mcp/user-guide";
import "@/components/markdown-editor/markdown-editor.css";

export const metadata = { title: "User Guide" };

export default function UserGuidePage() {
  // markdownToHtml shifts body headings down one level so the page title keeps
  // the <h1>; the guide's own top-level `#` therefore renders as <h2>.
  const html = markdownToHtml(USING_LEDGR_GUIDE);
  return (
    <div className="mx-auto max-w-3xl px-5 py-8">
      <h1 className="ui-title">User Guide</h1>
      <p className="mt-2 max-w-2xl text-sm text-ink-muted">
        What Ledgr can do and where to find it. The same text is served to any
        connected AI as{" "}
        <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-xs">
          ledgr://guide/using-ledgr
        </code>
        , so asking an assistant works as well as reading this page.
      </p>
      <div
        className="ledgr-prose mt-8"
        // Static text from this repo, not user content — no injection surface.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
