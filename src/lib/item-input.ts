// Request-body parsing/validation for item create/update. Split out of api.ts
// (slice 36, ADR-047) so it stays PURE — no next/server, no auth, no DB — and
// can be imported from node contexts that aren't a route handler: the MCP tool
// layer (tools.ts) and verify scripts. api.ts re-exports these so the existing
// /api/items* routes import them unchanged. Hand-rolled (the shapes are small
// and a validation lib isn't worth a dependency, rule 5): one place that turns
// request JSON into a well-formed ItemInput/ItemPatch.
import { isItemBody } from "@/lib/body";
import { ItemError } from "@/lib/items";
import { type ItemInput, type ItemPatch } from "@/lib/item-mutations";
import { toPriority } from "@/lib/priority";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bad(message: string): never {
  throw new ItemError("bad_request", message);
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string") bad(`${field} must be a string`);
  return value;
}

function asNullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return asString(value, field);
}

function asNullableDate(value: unknown, field: string): Date | null {
  if (value === null) return null;
  if (typeof value !== "string") bad(`${field} must be an ISO date string`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) bad(`${field} is not a valid date`);
  return date;
}

export function asUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    bad(`${field} must be a UUID`);
  }
  return value;
}

// One parser for POST (create) and PATCH (update): same fields, except
// create requires type and rejects nothing-to-do later in the lib.
export function parseItemPayload(raw: unknown, mode: "create"): ItemInput;
export function parseItemPayload(raw: unknown, mode: "patch"): ItemPatch;
export function parseItemPayload(
  raw: unknown,
  mode: "create" | "patch"
): ItemInput | ItemPatch {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    bad("request body must be a JSON object");
  }
  const input = raw as Record<string, unknown>;
  const out: ItemPatch = {};

  if (input.type !== undefined) {
    const type = asString(input.type, "type");
    if (!type) bad("type must be non-empty");
    out.type = type;
  } else if (mode === "create") {
    bad("type is required");
  }

  if (input.title !== undefined) out.title = asString(input.title, "title");
  if (input.body !== undefined) {
    // The canonical body is { format, text } (markdown by default; ADR-040).
    // null clears it. Reject anything else, including the pre-cutover block
    // array, so a stale client can't write a body no renderer understands.
    if (input.body !== null && !isItemBody(input.body)) {
      bad("body must be a { format, text } object or null");
    }
    out.body = input.body;
  }
  if (input.status !== undefined) {
    // A status KEY (S2): statuses are user-defined per type, so validate the
    // shape (a slug) here; the type's schema gives it meaning + its category
    // (resolved in createItem/updateItem).
    const status = asString(input.status, "status").trim().toLowerCase();
    if (!/^[a-z][a-z0-9_]*$/.test(status) || status.length > 40) {
      bad("status must be a status key (a slug: letters, digits, _)");
    }
    out.status = status;
  }
  if (input.urgency !== undefined) {
    const p = input.urgency === null ? null : toPriority(input.urgency);
    if (input.urgency !== null && p === null) {
      bad("urgency (priority) must be null or an integer 1–6");
    }
    out.urgency = p;
  }
  if (input.dueDate !== undefined) {
    out.dueDate = asNullableDate(input.dueDate, "dueDate");
  }
  if (input.scheduledDate !== undefined) {
    out.scheduledDate = asNullableDate(input.scheduledDate, "scheduledDate");
  }
  if (input.meetingAt !== undefined) {
    out.meetingAt = asNullableDate(input.meetingAt, "meetingAt");
  }
  if (input.endAt !== undefined) {
    out.endAt = asNullableDate(input.endAt, "endAt");
  }
  if (input.noteDate !== undefined) {
    out.noteDate = asNullableDate(input.noteDate, "noteDate");
  }
  if (input.url !== undefined) out.url = asNullableString(input.url, "url");
  if (input.parentId !== undefined) {
    out.parentId =
      input.parentId === null ? null : asUuid(input.parentId, "parentId");
  }
  if (input.inbox !== undefined) {
    if (typeof input.inbox !== "boolean") bad("inbox must be a boolean");
    out.inbox = input.inbox;
  }
  // Which arrival path made this item (ADR-249). Create-only, and consulted
  // only when `inbox` is absent: it names the path so createItem can look up
  // where the owner told that path to file things. Free text, matching
  // settings.inboxRoutes' keys, and an unrecognized one falls back to that
  // source's default rather than erroring — so the browser capture paths and
  // the offline outbox can send it without a client/server version handshake.
  if (mode === "create" && input.source !== undefined) {
    out.source = asString(input.source, "source");
  }
  // Next Action (ADR-111/PJ2): a task pointer (uuid) and/or free text, both
  // nullable; the record page's Next Action widget sets them.
  if (input.nextActionTaskId !== undefined) {
    out.nextActionTaskId =
      input.nextActionTaskId === null
        ? null
        : asUuid(input.nextActionTaskId, "nextActionTaskId");
  }
  if (input.nextActionText !== undefined) {
    out.nextActionText = asNullableString(input.nextActionText, "nextActionText");
  }
  // Per-record widget composition override (Layer 3): an object or null. Shape
  // validated where it's consumed (composition.ts, PJ3).
  if (input.composition !== undefined) {
    if (
      input.composition !== null &&
      (typeof input.composition !== "object" || Array.isArray(input.composition))
    ) {
      bad("composition must be an object or null");
    }
    out.composition = input.composition as Record<string, unknown> | null;
  }
  if (input.properties !== undefined) {
    if (
      input.properties !== null &&
      (typeof input.properties !== "object" || Array.isArray(input.properties))
    ) {
      bad("properties must be an object or null");
    }
    out.properties = input.properties as Record<string, unknown> | null;
  }
  // Cross-device edit guard token (ADR-134): the digest of the body the client
  // last synced with, sent alongside a body write so updateItem can detect that
  // another device changed the body in the meantime. Patch-only; an opaque short
  // string, so we only assert it's a string.
  if (input.expectedBodyDigest !== undefined) {
    out.expectedBodyDigest = asString(
      input.expectedBodyDigest,
      "expectedBodyDigest"
    );
  }
  // Per-key merge into items.properties (ADR-069 canvas cards): an object whose
  // keys are merged, not replaced. Patch-only — create uses `properties`.
  if (input.propertyPatch !== undefined) {
    if (
      input.propertyPatch === null ||
      typeof input.propertyPatch !== "object" ||
      Array.isArray(input.propertyPatch)
    ) {
      bad("propertyPatch must be an object");
    }
    out.propertyPatch = input.propertyPatch as Record<string, unknown>;
  }

  return mode === "create" ? (out as ItemInput) : out;
}
