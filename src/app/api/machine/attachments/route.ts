// POST /api/machine/attachments — register an attachment row + return a
// presigned R2 PUT: the `api`-token-gated analog of the Clerk-gated
// POST /api/attachments (ADR-112). Same door as the other /api/machine/* jobs
// (token IS the credential), acting on the single owner (resolveMachineOwner),
// and routed through the same createAttachment lib the in-app route uses so it
// can't drift from the app contract (quota, per-file cap, owner-scoped item
// check). Body { itemId, filename, contentType, sizeBytes }; response
// { id, filename, storageKey, uploadUrl, publicUrl }. The caller PUTs the bytes
// straight to R2 at uploadUrl (Content-Type must match contentType for the
// signature), then uses publicUrl in the item body. Only meaningful when R2 is
// configured; built for the migration's ~3,900-image pass.
import { NextResponse } from "next/server";
import { asUuid } from "@/lib/api";
import { verifyApiRequest } from "@/lib/auth/credentials";
import { createAttachment } from "@/lib/attachments";
import { ItemError } from "@/lib/items";
import { resolveMachineOwner } from "@/lib/machine/owner";
import { captureError } from "@/lib/log";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const identity = await verifyApiRequest(request.headers.get("authorization"));
  if (!identity) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const ownerId = await resolveMachineOwner();
  if (!ownerId) {
    return NextResponse.json({ error: "owner not configured" }, { status: 503 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return NextResponse.json(
      { error: "request body must be a JSON object" },
      { status: 400 }
    );
  }
  const input = raw as Record<string, unknown>;

  try {
    const result = await createAttachment(ownerId, {
      itemId: asUuid(input.itemId, "itemId"),
      filename: typeof input.filename === "string" ? input.filename : "",
      contentType:
        typeof input.contentType === "string" ? input.contentType : "",
      sizeBytes: typeof input.sizeBytes === "number" ? input.sizeBytes : NaN,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof ItemError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.code === "not_found" ? 404 : 400 }
      );
    }
    const correlationId = crypto.randomUUID();
    await captureError("machine-attachments", err, { correlationId });
    return NextResponse.json(
      { error: "internal error", correlationId },
      { status: 500 }
    );
  }
}
