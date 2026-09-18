import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api";
import { verifyApiRequest } from "@/lib/auth/credentials";
import { makeMarkdownBody } from "@/lib/body";
import { extractArticle, fetchAndExtract } from "@/lib/clip/extract";
import { recentCaptureId } from "@/lib/capture/share";
import { createItem } from "@/lib/item-mutations";
import { resolveMachineOwner } from "@/lib/machine/owner";
import { resolveOwner } from "@/lib/owner";

// Web clipper capture (ADR-100, explorations/web-clipper.md). The bookmarklet
// (and a later browser extension) POSTs here: the live page URL, its title, and
// optionally the rendered DOM html. We extract clean article markdown (images
// stripped, src/lib/clip/extract.ts) and land a `link` item in the Inbox.
//
// Auth is the same `api`-scoped machine token as /api/machine/items — the token
// IS the credential — or, since ADR-238, the signed-in owner's session, which
// is how the tokenless bookmarklet saves. CORS stays open (`*`) for the token
// callers: a bookmarklet runs on whatever origin the user is reading. The
// session door doesn't widen that, because a SameSite=Lax cookie is not sent on
// a cross-site POST and this route never sets Allow-Credentials.
//
// If no html is sent, we fetch + extract the URL server-side (the mobile-style
// path, public pages only). Either way, failure to extract still lands a
// URL-only item — capture never silently drops.
export const dynamic = "force-dynamic";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

function cors(res: NextResponse): NextResponse {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
  return res;
}

function json(body: unknown, status: number): NextResponse {
  return cors(NextResponse.json(body, { status }));
}

// Preflight: the bookmarklet's cross-origin POST carries Authorization +
// Content-Type, so the browser sends an OPTIONS first.
export function OPTIONS() {
  return cors(new NextResponse(null, { status: 204 }));
}

export async function POST(request: Request) {
  // Two doors. A machine token is the documented API path and resolves the
  // owner from env, exactly as it always has. Failing that, the signed-in
  // owner's own session counts (ADR-238): the bookmarklet's relay popup runs
  // on Ledgr's origin and carries the session cookie, which is why the
  // clipper no longer has to carry a token at all. Safe despite the open
  // CORS above — the session cookie is SameSite=Lax, so it never rides along
  // on a cross-site POST, and no Allow-Credentials header is sent.
  const identity = await verifyApiRequest(request.headers.get("authorization"));
  const ownerId = identity
    ? await resolveMachineOwner()
    : ((await resolveOwner())?.id ?? null);
  // A token that verified but names no owner is a misconfigured host, not a
  // bad credential — the two stay distinguishable.
  if (!ownerId)
    return identity
      ? json({ error: "owner not configured" }, 503)
      : json({ error: "unauthorized" }, 401);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  const payload = (body ?? {}) as Record<string, unknown>;
  const rawUrl = typeof payload.url === "string" ? payload.url.trim() : "";
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return json({ error: "a valid url is required" }, 400);
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return json({ error: "url must be http(s)" }, 400);
  }
  const url = parsedUrl.toString();

  // One clip, one item: this URL landing again within the window is the same
  // click arriving twice (an older bookmarklet re-handing the clip to a second
  // relay page load), not a second clip. Answer with the item it already made.
  // See recentCaptureId for why the client-side latches can't cover this alone.
  const already = await recentCaptureId(ownerId, url);
  // Still a 201 with the clip's id: to every existing caller this reads exactly
  // like the save it asked for, which keeps the machine API's success path
  // byte-compatible (`duplicate` is a new, additive field — ADR-183's carve-out).
  if (already) return json({ id: already, duplicate: true }, 201);

  // html present = the bookmarklet sent the live DOM (handles auth'd/SPA pages);
  // absent = fetch and extract the public page ourselves.
  const html = typeof payload.html === "string" ? payload.html : null;
  const article = html ? extractArticle(html, url) : await fetchAndExtract(url);

  const sharedTitle =
    typeof payload.title === "string" ? payload.title.trim() : "";
  const title = (sharedTitle || article?.title || parsedUrl.hostname).slice(0, 300);

  try {
    const item = await createItem(ownerId, {
      type: "link",
      title,
      url,
      source: "web_clipper",
      body: article ? makeMarkdownBody(article.markdown) : null,
    });
    return json({ id: item.id, extracted: article !== null }, 201);
  } catch (err) {
    return cors(await errorResponse(err));
  }
}
