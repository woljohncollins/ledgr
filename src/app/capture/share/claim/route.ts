import { NextResponse } from "next/server";
import { resolveOwner } from "@/lib/owner";
import { captureSharedUrlOrText, shareRedirectBase } from "@/lib/capture/share";
import { createInboxTranscript } from "@/lib/meetings/transcripts";
import { getStorage } from "@/lib/storage";

// The GET half of the cold-share fix (ADR-191; see src/proxy.ts and
// ../route.ts for the full flow). Being a plain document navigation, a stale
// Clerk session JWT here goes through Clerk's redirect handshake (GET-only)
// and gets transparently refreshed before this handler runs; a genuinely
// signed-out visitor is bounced to /sign-in by the middleware (this route is
// NOT in the public matcher), with redirect_url preserving this exact URL —
// so the share survives sign-in and lands here again afterwards.
export const dynamic = "force-dynamic";


const STASH_PREFIX = "share-stash/";
// Same one-off UUID guard every other file in this codebase rolls locally
// (item-input.ts, views.ts, settings.ts) rather than sharing a module for one
// line. Strict format match only: this route must never be steerable into
// reading an arbitrary storage key off the "stash" param.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidStashId(id: string | null): id is string {
  return !!id && UUID_RE.test(id);
}

type StashPayload =
  | { kind: "transcript"; title?: string; text?: string }
  | { kind: "text"; title?: string; text?: string; url?: string };

function isStashPayload(v: unknown): v is StashPayload {
  return !!v && typeof v === "object" && ((v as { kind?: unknown }).kind === "transcript" || (v as { kind?: unknown }).kind === "text");
}

function home(request: Request): NextResponse {
  return NextResponse.redirect(new URL("/", shareRedirectBase(request)), 303);
}

export async function GET(request: Request) {
  const owner = await resolveOwner();
  // Defensive only: middleware already protects this route, but a valid Clerk
  // session can still resolve to no owner row (ADR-184's "unrecognized"
  // state) — nothing to claim the share into.
  if (!owner) return home(request);

  const url = new URL(request.url);
  const stashId = url.searchParams.get("stash");

  if (stashId !== null) {
    if (!isValidStashId(stashId)) return home(request);
    const storage = getStorage();
    if (!storage) return home(request);

    const key = `${STASH_PREFIX}${stashId}.json`;
    let payload: StashPayload | null = null;
    try {
      const res = await fetch(await storage.presignDownload(key));
      if (res.ok) {
        const parsed: unknown = await res.json();
        if (isStashPayload(parsed)) payload = parsed;
      }
    } catch {
      payload = null;
    }
    // Gone, expired, or malformed (already claimed, or the object never made
    // it) — nothing to recover.
    if (!payload) return home(request);

    // Best-effort: the owner already has their item once we get here, so a
    // failed delete must never fail the request. ponytail: a stash object
    // that's NEVER claimed relies on the 2MB/6KB caps at write time plus a
    // future R2 lifecycle rule to age it out, not a cleanup cron.
    const cleanup = () => storage.deleteObject(key).catch(() => {});

    if (payload.kind === "transcript") {
      const transcript = await createInboxTranscript(owner.id, {
        title: payload.title,
        text: payload.text,
      });
      await cleanup();
      return NextResponse.redirect(
        new URL(`/capture/transcript/${transcript.id}`, shareRedirectBase(request)),
        303
      );
    }

    const itemId = await captureSharedUrlOrText(owner.id, {
      title: payload.title,
      text: payload.text,
      url: payload.url,
    });
    await cleanup();
    return NextResponse.redirect(new URL(itemId ? `/items/${itemId}` : "/", shareRedirectBase(request)), 303);
  }

  // No stash: the URL/text share rode directly in the query string.
  const itemId = await captureSharedUrlOrText(owner.id, {
    title: url.searchParams.get("title")?.trim() || undefined,
    text: url.searchParams.get("text")?.trim() || undefined,
    url: url.searchParams.get("url")?.trim() || undefined,
  });
  // Revisiting/refreshing this URL (back button, a re-sent redirect_url after
  // sign-in racing a first successful claim) re-runs the capture, but a URL
  // share now lands on the existing item rather than a second one (the
  // recapture window in lib/capture/share.ts). A bare TEXT share still has no
  // URL to key on, so that one can still double; soft-delete + inbox triage
  // stays the safety net there.
  return NextResponse.redirect(new URL(itemId ? `/items/${itemId}` : "/", shareRedirectBase(request)), 303);
}
