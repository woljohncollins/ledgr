import { NextResponse } from "next/server";
import { resolveOwner } from "@/lib/owner";
import { captureSharedUrlOrText, shareRedirectBase } from "@/lib/capture/share";
import { createInboxTranscript } from "@/lib/meetings/transcripts";
import { getStorage } from "@/lib/storage";

// PWA share target (slice 16; web clipper mobile half ADR-100; transcript-file
// share path; cold-share fix ADR-191). The manifest points Android's share
// sheet here as a POST multipart target so the app appears for BOTH a shared
// URL/text (unchanged) AND a shared text file. A POST navigation can't be
// served by a page, so this is a route handler that branches on what arrived
// and 303-redirects to a GET landing page:
//
//   • a shared .txt/.md file → captured as an inbox `transcript` (text never
//     lost), then on to /capture/transcript/{id} to pick the meeting.
//   • a shared URL/text → the existing capture (link/unmarked into the inbox),
//     then on to /items/{id}.
//
// This is now a PUBLIC route (see proxy.ts) because a cold Android share can
// arrive after the 60s Clerk session JWT has expired, and Clerk's handshake
// that heals an expired token only works for a GET navigation. So the route
// authenticates itself via resolveOwner(): when it succeeds the flow above
// runs unchanged; when it fails (stale token, or genuinely signed out) the
// payload is 303'd to the GET claim route instead, which CAN handshake (or
// bounces a truly signed-out visitor to /sign-in, redirect_url preserved).
// iOS has no share-target support and stays on the in-app upload/paste paths
// (PRD §4.5).
export const dynamic = "force-dynamic";


// The form field name the manifest declares for the shared file.
const FILE_FIELD = "transcript";

// Anonymous-path stash: an R2 object keyed by a random UUID under this
// prefix, holding the JSON payload a cold share couldn't carry any other way
// (a file's text, or a URL/text pair too long for a query string). The claim
// route reads it back by id and deletes it once claimed.
const STASH_PREFIX = "share-stash/";
// A recording app's transcript export shouldn't run away with R2 storage
// while waiting on a claim that may never come.
const MAX_FILE_BYTES = 2 * 1024 * 1024;
// Below this, a URL/text share rides in the claim URL's query string; at or
// above it, it goes through the same stash as a file share.
const MAX_QUERY_BYTES = 6 * 1024;

function str(v: FormDataEntryValue | null): string | undefined {
  return typeof v === "string" ? v.trim() || undefined : undefined;
}

// Filename → a sensible transcript name: drop the extension, tidy separators.
function titleFromFilename(name: string): string {
  const base = name.replace(/\.[^.]+$/, "").replace(/[_]+/g, " ").trim();
  return base || "Transcript";
}

// Builds the /capture/share/claim query string for a URL/text share, URL-
// encoding and omitting empty fields. Pure (no I/O) so it can be exercised
// directly by scripts/verify-share-claim.mts.
export function buildClaimQuery(fields: { title?: string; text?: string; url?: string }): string {
  const params = new URLSearchParams();
  if (fields.title) params.set("title", fields.title);
  if (fields.text) params.set("text", fields.text);
  if (fields.url) params.set("url", fields.url);
  return params.toString();
}

async function stashAndRedirect(
  payload: Record<string, unknown>,
  request: Request
): Promise<NextResponse> {
  const storage = getStorage();
  // No storage configured: nothing to stash into, so the share is lost rather
  // than crashing. Same degrade-gracefully posture as the rest of the app
  // running without R2 configured.
  if (!storage) return NextResponse.redirect(new URL("/", shareRedirectBase(request)), 303);
  const id = crypto.randomUUID();
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  await storage.putObject(`${STASH_PREFIX}${id}.json`, bytes, "application/json");
  return NextResponse.redirect(new URL(`/capture/share/claim?stash=${id}`, shareRedirectBase(request)), 303);
}

async function handleAnonymousFile(file: File, request: Request): Promise<NextResponse> {
  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.redirect(new URL("/", shareRedirectBase(request)), 303);
  }
  const text = await file.text();
  if (!text.trim()) return NextResponse.redirect(new URL("/", shareRedirectBase(request)), 303);
  return stashAndRedirect(
    { kind: "transcript", title: titleFromFilename(file.name || "Transcript"), text },
    request
  );
}

async function handleAnonymousTextOrUrl(form: FormData, request: Request): Promise<NextResponse> {
  const fields = { title: str(form.get("title")), text: str(form.get("text")), url: str(form.get("url")) };
  const query = buildClaimQuery(fields);
  if (query.length < MAX_QUERY_BYTES) {
    return NextResponse.redirect(new URL(`/capture/share/claim?${query}`, shareRedirectBase(request)), 303);
  }
  return stashAndRedirect({ kind: "text", ...fields }, request);
}

export async function POST(request: Request) {
  const owner = await resolveOwner();

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.redirect(new URL("/", shareRedirectBase(request)), 303);
  }

  const file = form.get(FILE_FIELD);
  const hasFile = !!file && typeof file !== "string" && file.size > 0;

  // Expired/missing session (or a genuinely signed-out visitor): stash the
  // payload and hand it to the GET claim route, which can either handshake a
  // stale token transparently or bounce to /sign-in and pick the claim back
  // up afterwards.
  if (!owner) {
    return hasFile
      ? handleAnonymousFile(file as File, request)
      : handleAnonymousTextOrUrl(form, request);
  }

  // A shared file wins: a recording app's transcript export is the whole point.
  if (hasFile) {
    const text = await (file as File).text();
    if (text.trim()) {
      const transcript = await createInboxTranscript(owner.id, {
        title: titleFromFilename((file as File).name || "Transcript"),
        text,
      });
      return NextResponse.redirect(
        new URL(`/capture/transcript/${transcript.id}`, shareRedirectBase(request)),
        303
      );
    }
  }

  // Otherwise a shared URL/text — the existing quick-capture / web-clipper path.
  const itemId = await captureSharedUrlOrText(owner.id, {
    title: str(form.get("title")),
    text: str(form.get("text")),
    url: str(form.get("url")),
  });
  return NextResponse.redirect(new URL(itemId ? `/items/${itemId}` : "/", shareRedirectBase(request)), 303);
}

// A stray GET (a bookmark to the old page, a manual hit) has nothing to capture;
// send it home rather than 405. Real shares always arrive as the POST above.
export async function GET(request: Request) {
  return NextResponse.redirect(new URL("/", shareRedirectBase(request)), 303);
}
