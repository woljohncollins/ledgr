// Public share link render (slice 31, PRD §4.12). An unguessable token →
// the item's self-contained print render, with no Clerk on the path (it's in
// the public-route set in proxy.ts). Read-only: it serves the same flat
// document the Save Offline print view does (mentions as plain names, no app
// chrome, no navigation into the owner's data), and the print-to-PDF leg is
// the page's Print/PDF button. A revoked or unknown token, or a trashed item,
// is a plain 404.
import { NextResponse } from "next/server";
import { renderPrintDocument } from "@/lib/print-html";
import { resolveShareToken } from "@/lib/share";
import { resolveMentions } from "@/lib/mentions";
import { bodyMarkdown } from "@/lib/body";
import { collectMentionIdsFromMarkdown } from "@/lib/editor/mention-markdown";
import { resolveItemBodyTokens } from "@/lib/item-tokens-service";
import { addShareTokenToAttachmentUrls } from "@/lib/attachment-url";
import { getSettings } from "@/lib/settings";
import { makeMarkdownBody } from "@/lib/body";
import { captureError, createLogger } from "@/lib/log";

export const dynamic = "force-dynamic";

const NOT_FOUND = "This link is not available. It may have been revoked.";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ token: string }> }
) {
  const { token } = await ctx.params;
  let shared;
  try {
    shared = await resolveShareToken(token);
  } catch (err) {
    const log = createLogger("share");
    await captureError("share", err, { correlationId: log.correlationId });
    return new NextResponse("Something went wrong.", { status: 500 });
  }
  if (!shared) return new NextResponse(NOT_FOUND, { status: 404 });

  // Resolve live {{item.*}} tokens (LT1) against the shared item's current
  // state, so a public link always shows the up-to-date title/date and any
  // mention links a token emits are collected below.
  const resolved = await resolveItemBodyTokens(shared.ownerId, {
    id: shared.itemId,
    title: shared.title,
    body: shared.body,
  });

  // Type-aware @-mention icons unless this link was created with them off
  // (showIcons defaults on). The flag rides the token, so the recipient renders
  // exactly what the owner chose. Resolved owner-scoped against the link's owner.
  const showIcons = shared.options.showIcons ?? true;
  const mentions = showIcons
    ? await resolveMentions(
        shared.ownerId,
        collectMentionIdsFromMarkdown(bodyMarkdown(resolved.body))
      )
    : undefined;

  // Body comments (ADR-170) never reach a public link: renderPrintDocument
  // defaults them off, and there is deliberately no per-link opt-in yet. A
  // comment is a private note to self, and a share is cached at the edge for up
  // to 60s, so a leak can't be taken back. If a "share with my comments" option
  // is ever wanted, it rides the token the way showIcons does above.
  // Attachments are private (ADR-231): /files/<id> needs the owner's session,
  // which an anonymous reader of this page does not have. Rewrite each address
  // on the way out so it carries THIS link's token — the route then grants
  // access only for attachments hanging off this very item. Nothing stored
  // changes; revoking the link kills its images along with the page.
  const shareBody = makeMarkdownBody(
    addShareTokenToAttachmentUrls(bodyMarkdown(resolved.body), token)
  );

  // The footer names whose Ledgr this came from (Tyler, 2026-08-29) — the
  // owner's Settings display name, escaped since footerHtml is raw markup;
  // falls back to the plain wording when no name is set.
  const ownerSettings = await getSettings(shared.ownerId);
  const displayName = ownerSettings.displayName.trim();
  const escaped = displayName
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const whose = escaped
    ? `${escaped}${/s$/i.test(escaped) ? "'" : "'s"} Ledgr`
    : "Ledgr";
  const html = renderPrintDocument(resolved.title, shareBody, {
    footerHtml: `Shared from ${whose} · read-only`,
    mentions,
    // So an accent highlight in the body renders in the owner's color on a
    // page that has no app context to resolve `var(--accent)` against.
    accent: ownerSettings.highlightColor,
    // The look baked into the link when it was minted, else the owner's current
    // theme. The reader can switch it on the page itself.
    theme: shared.options.theme ?? ownerSettings.theme,
  });

  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Statically cacheable at the CDN (PRD §6.5) so a popular link barely
      // touches the origin, but a short window so revocation propagates fast:
      // revocation is immediate at the origin, and at most ~60s at the edge.
      "Cache-Control": "public, max-age=0, s-maxage=60, stale-while-revalidate=300",
      // Don't let a shared link leak into search indexes or referrers.
      "X-Robots-Tag": "noindex, nofollow",
      "Referrer-Policy": "no-referrer",
    },
  });
}
