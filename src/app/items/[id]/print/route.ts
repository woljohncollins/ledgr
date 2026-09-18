// Save Offline's document render (PRD §4.7): a self-contained HTML page —
// inline CSS, no scripts beyond one print button handler, no app chrome, no
// /_next chunks. Self-containment is the point: this exact response is what
// the pin protocol stores in the service worker's ledgr-pin-v1 cache, so it
// must render offline with nothing else cached, and its @media print rules
// make the browser's print-to-PDF the PDF leg. Dark on screen (stage
// friendly, app-consistent), black-on-white in print.
import { NextResponse } from "next/server";
import { ItemError, getItem } from "@/lib/items";
import { renderPrintDocument } from "@/lib/print-html";
import { resolveOwner } from "@/lib/owner";
import { getSettings } from "@/lib/settings";
import { resolveMentions } from "@/lib/mentions";
import { bodyMarkdown, makeMarkdownBody } from "@/lib/body";
import { boothExport } from "@/lib/editor/booth-export";
import { collectMentionIdsFromMarkdown } from "@/lib/editor/mention-markdown";
import { resolveItemBodyTokens } from "@/lib/item-tokens-service";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const owner = await resolveOwner();
  if (!owner) return NextResponse.redirect(new URL("/sign-in", _req.url));

  const { id } = await ctx.params;
  let item;
  try {
    item = await getItem(owner.id, id);
  } catch (err) {
    if (err instanceof ItemError) {
      return new NextResponse("Not found", { status: 404 });
    }
    throw err;
  }
  if (item.deletedAt) return new NextResponse("Not found", { status: 404 });

  // Resolve live {{item.*}} tokens (LT1) against the item's current state first,
  // so the printed/pinned copy carries real titles/dates and any mention links a
  // token emits are collected below and rendered type-aware.
  const resolved = await resolveItemBodyTokens(owner.id, item);

  // Type-aware @-mention icons unless ?icons=0 (the owner's "icons off" choice
  // for a cleaner PDF/offline copy; SaveOffline pins this exact URL).
  const params = new URL(_req.url).searchParams;
  const showIcons = params.get("icons") !== "0";
  // Body comments (ADR-170) are OFF unless asked for: this is the owner's own
  // copy, so opting in is allowed, but a printed/pinned note reads as clean prose
  // by default and never carries a private note to self by accident.
  const showComments = params.get("comments") === "1";
  // The booth copy (?booth=1): the same document, stripped to what someone
  // running slides needs — colors flattened, cut material gone, and a
  // **[SLIDE N]** cue at each highlight so they know when to advance. The cue
  // numbers match the slides document POST /api/items/[id]/slides writes, because
  // both come from the one boothExport pass.
  const booth = params.get("booth") === "1";
  const printBody = booth
    ? makeMarkdownBody(boothExport(bodyMarkdown(resolved.body)).manuscript)
    : resolved.body;
  const mentions = showIcons
    ? await resolveMentions(
        owner.id,
        collectMentionIdsFromMarkdown(bodyMarkdown(printBody))
      )
    : undefined;

  // The same self-contained shell the share route serves (slice 31), so a
  // pinned offline copy and a public link render identically.
  // The booth copy says so on the page: whoever is holding it should be able to
  // tell at a glance that it isn't the preacher's own annotated manuscript.
  // The owner's accent, so an accent highlight ("My highlight") keeps its color
  // in a document that carries no app context (getSettings is request-cached).
  const ownerSettings = await getSettings(owner.id);
  const accent = ownerSettings.highlightColor;
  const html = renderPrintDocument(
    booth ? `${resolved.title} — Presentation Copy` : resolved.title,
    printBody,
    { mentions, comments: showComments, accent, theme: ownerSettings.theme }
  );

  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Never cached by HTTP layers: the pin cache is the one deliberate
      // copy, and it must reflect the moment the user pinned.
      "Cache-Control": "no-store",
    },
  });
}
