// GET /files/[id] — the stable address of an attachment (ADR-228), now access
// controlled (ADR-231). Redirects to wherever the bytes currently live, so item
// bodies never contain a storage provider's URL and switching providers needs
// no body rewrite. This is the indirection that keeps storage swappable.
//
// A REDIRECT, not a proxy: bytes must never pass through the app server
// (CLAUDE.md principle 8, src/lib/storage/types.ts). The browser follows the
// 302 to R2 and reads from there.
//
// WHO MAY READ. The bucket is private, so there is no unsigned URL to any
// object and the UUID alone is no longer the credential. Two ways in, and
// nothing else:
//   - the OWNER, by Clerk session. This is the default and covers the app.
//   - an ANONYMOUS viewer holding `?s=<share token>`, but only if that token is
//     live and belongs to THIS attachment's parent item. A share page rewrites
//     its body's addresses to carry its own token (src/app/share/[token]).
// Both failures are a flat 404, never a 403: a wrong or revoked token must not
// confirm that an id exists.
//
// This is what lets a private file (an SSN scan) and a public share of a
// different item both be true at once — the earlier design could only have one.
//
// The route stays in the public matcher (proxy.ts) because the share path takes
// no session; "public route" means Clerk does not REQUIRE a session here, not
// that this handler skips its own check.
import { NextResponse } from "next/server";
import { getAttachmentForRead } from "@/lib/attachments";
import { SHARE_PARAM } from "@/lib/attachment-url";
import { resolveOwner } from "@/lib/owner";
import { resolveShareToken } from "@/lib/share";
import { getStorage } from "@/lib/storage";

export const dynamic = "force-dynamic";

// Never cached. The redirect target is a signed URL that expires, so a cached
// 302 would eventually hand out a dead link — and, worse, a cache shared
// between viewers would hand one reader's signed URL to another. Re-signing is
// one HMAC and no I/O; the bytes themselves still come off R2's CDN.
const CACHE_CONTROL = "private, no-store";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  // Not asUuid(): a malformed id here is a bad URL, not a bad API call, so it
  // gets the same 404 as an id that simply isn't ours.
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const storage = getStorage();
  if (!storage) {
    return new NextResponse("File storage is not configured.", { status: 503 });
  }

  const att = await getAttachmentForRead(id);
  if (!att) return new NextResponse("Not found", { status: 404 });

  const token = new URL(request.url).searchParams.get(SHARE_PARAM);
  let allowed = false;
  if (token) {
    // Scoped deliberately to the parent item: a live token for item A must not
    // become a skeleton key for every attachment the owner has.
    const shared = await resolveShareToken(token);
    allowed = !!shared && shared.itemId === att.parentItemId;
  } else {
    const owner = await resolveOwner();
    allowed = !!owner && owner.id === att.ownerId;
  }
  if (!allowed) return new NextResponse("Not found", { status: 404 });

  return NextResponse.redirect(await storage.presignDownload(att.storageKey), {
    status: 302,
    headers: { "cache-control": CACHE_CONTROL },
  });
}
