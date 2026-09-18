import { NextResponse } from "next/server";
import { asUuid, errorResponse, parseItemPayload } from "@/lib/api";
import { verifyApiRequest } from "@/lib/auth/credentials";
import {
  ItemError,
  listItems,
  listItemsWithBodies,
  MAX_BODY_ROWS,
  type ItemStatus,
  type ListOptions,
} from "@/lib/items";
import { createItem, updateItem } from "@/lib/item-mutations";
import { resolveMachineOwner } from "@/lib/machine/owner";
import {
  parseBoolParam,
  unknownParams,
  unknownParamsError,
} from "@/lib/machine/query";
import { captureError, createLogger } from "@/lib/log";
import { STATUS_CATEGORIES, type StatusCategory } from "@/lib/status";

// The external HTTP API (ADR-066): app integrations and crons — e.g. Savor's
// journal-push cron — read items out of and write items into Ledgr with an
// `api`-scoped machine token, no Clerk login. Same door as the other
// /api/machine/* jobs (proxy.ts public set, token IS the credential); acts on
// the single owner (resolveMachineOwner). Every write validates through the
// same parseItemPayload / createItem the in-app POST /api/items uses, so this
// surface can't drift from the app contract or skip owner-scoping.
export const dynamic = "force-dynamic";

const MAX_BATCH = 100;

// Every query parameter GET understands. An unknown one is a 400 naming it
// (ADR-262), not a silent ignore: `?id=…` used to be dropped on the floor and
// answer with an unfiltered list, so a typo came back looking like a successful
// read of the wrong item. A read surface that can't say "I didn't do that" is
// worse than one that refuses.
const LIST_PARAMS = new Set([
  "type",
  "id",
  "status",
  "statusCategory",
  "relatedTo",
  "parentId",
  "q",
  "limit",
  "offset",
  "includeBody",
]);

// CORS is open for the same reason /api/machine/capture's is (see the comment
// there): the token IS the credential, there are no cookies to protect, and a
// browser client (Launchpad's task tile) fetches with an Authorization header —
// which triggers a preflight this route must answer.
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

function cors(res: NextResponse): NextResponse {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
  return res;
}

function json(body: unknown, status = 200): NextResponse {
  return cors(NextResponse.json(body, { status }));
}

export function OPTIONS() {
  return cors(new NextResponse(null, { status: 204 }));
}

// GET /api/machine/items — owner-scoped list. Filters mirror the in-app list:
// ?type= (one key or comma-separated) &status= &statusCategory= (a category or
// "active") &relatedTo=<itemId> (confirmed edge either direction — tasks tagged
// with a tag item / filed under a project item) &parentId= &q= &limit= &offset=,
// plus ?id= (one uuid or comma-separated — read a known set) and
// ?includeBody=true.
//
// includeBody is off by default, so an existing caller's payload is unchanged
// byte for byte (ADR-262). Turned on, each row carries its raw `{ format, text }`
// body — the same object PATCH accepts — so a read result feeds straight back
// into a write with no reshaping, and capped at MAX_BODY_ROWS rows because
// bodies are unbounded text. This is what the surface was missing: it could
// write a body and never read one, which made "copy this content to that item"
// a retyping job for whatever was holding the request, and retyping is how a
// 10,737-character note came back 10,736 characters long with no way to find
// the difference.
//
// An unrecognized parameter is a 400 naming it, never a silent ignore.
export async function GET(request: Request) {
  const identity = await verifyApiRequest(request.headers.get("authorization"));
  if (!identity) {
    return json({ error: "unauthorized" }, 401);
  }

  const ownerId = await resolveMachineOwner();
  if (!ownerId) {
    return json({ error: "owner not configured" }, 503);
  }

  try {
    const params = new URL(request.url).searchParams;
    const unknown = unknownParams(params, LIST_PARAMS);
    if (unknown.length > 0) {
      return json({ error: unknownParamsError(unknown, LIST_PARAMS) }, 400);
    }
    // type accepts one key or a comma-separated list (?type=project,seminary
    // — the "everything project-shaped" query, paired with GET
    // /api/machine/types to discover which keys those are).
    const rawType = params.get("type");
    const typeList = rawType
      ? rawType.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
    const opts: ListOptions = {
      type: typeList.length > 1 ? typeList : typeList[0] ?? undefined,
      parentId: params.get("parentId") ?? undefined,
      q: params.get("q") ?? undefined,
    };
    const status = params.get("status");
    if (status !== null) {
      // A status KEY, not the inherited default set (ADR-243) — see the note in
      // /api/items. Shape-check only; an unknown key matches nothing.
      if (!/^[a-z][a-z0-9_]*$/.test(status) || status.length > 40) {
        return json(
          { error: "status must be a status key (a slug: letters, digits, _)" },
          400
        );
      }
      opts.status = status as ItemStatus;
    }
    const statusCategory = params.get("statusCategory");
    if (statusCategory !== null) {
      const valid =
        statusCategory === "active" ||
        (STATUS_CATEGORIES as readonly string[]).includes(statusCategory);
      if (!valid) {
        return json(
          {
            error: `statusCategory must be "active" or one of: ${STATUS_CATEGORIES.join(", ")}`,
          },
          400
        );
      }
      opts.statusCategory = statusCategory as StatusCategory | "active";
    }
    const relatedTo = params.get("relatedTo");
    if (relatedTo !== null) opts.relatedTo = asUuid(relatedTo, "relatedTo");
    // ?id= names the exact rows to read. Each one is validated as a uuid, so a
    // mistyped id is a 400 rather than a silently empty list.
    const rawIds = params.get("id");
    if (rawIds !== null) {
      const ids = rawIds.split(",").map((s) => s.trim()).filter(Boolean);
      if (ids.length === 0) return json({ error: "id must be a uuid" }, 400);
      opts.ids = ids.map((id, i) => asUuid(id, ids.length > 1 ? `id[${i}]` : "id"));
    }
    const limit = params.get("limit");
    if (limit !== null) opts.limit = Number(limit) || undefined;
    const offset = params.get("offset");
    if (offset !== null) opts.offset = Number(offset) || undefined;

    const rawIncludeBody = params.get("includeBody");
    let includeBody = false;
    if (rawIncludeBody !== null) {
      const parsed = parseBoolParam("includeBody", rawIncludeBody);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      includeBody = parsed.value;
    }
    if (includeBody) {
      // The cap is applied in listItemsWithBodies; say so in the response rather
      // than truncating quietly, so a caller reading 40 bodies knows it got 25.
      const rows = await listItemsWithBodies(ownerId, opts);
      return json({
        items: rows,
        ...(rows.length === MAX_BODY_ROWS
          ? { note: `capped at ${MAX_BODY_ROWS} items when includeBody is on; page with offset` }
          : {}),
      });
    }

    return json({ items: await listItems(ownerId, opts) });
  } catch (err) {
    return cors(await errorResponse(err));
  }
}

// POST /api/machine/items — create one item (a bare item object) or a batch
// ({ items: [...] }). A batch is the cron shape: push every new entry since the
// last run. A malformed entry is reported in `errors` and skipped, never
// dropping the rest — so one bad journal doesn't fail the whole push.
// Response: { count, created: Item[], errors: [{ index, error }] }. Status is
// 201 if anything was created, 400 if every entry failed.
export async function POST(request: Request) {
  const identity = await verifyApiRequest(request.headers.get("authorization"));
  if (!identity) {
    return json({ error: "unauthorized" }, 401);
  }

  const log = createLogger("machine-items");
  const ownerId = await resolveMachineOwner();
  if (!ownerId) {
    log.warn("machine API owner unresolved (set LEDGR_API_OWNER_UPN / ONEDRIVE_EXPORT_UPN)");
    return json({ error: "owner not configured" }, 503);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  const batch = (body as { items?: unknown })?.items;
  const rawItems = Array.isArray(batch) ? batch : [body];
  if (rawItems.length === 0) {
    return json({ count: 0, created: [], errors: [] });
  }
  if (rawItems.length > MAX_BATCH) {
    return json({ error: `too many items (max ${MAX_BATCH} per request)` }, 400);
  }

  const created: unknown[] = [];
  const errors: { index: number; error: string }[] = [];
  for (let i = 0; i < rawItems.length; i++) {
    try {
      const input = parseItemPayload(rawItems[i], "create");
      created.push(await createItem(ownerId, input));
    } catch (err) {
      if (err instanceof ItemError) {
        errors.push({ index: i, error: err.message });
      } else {
        const correlationId = crypto.randomUUID();
        await captureError("machine-items", err, { correlationId, detail: { index: i } });
        errors.push({ index: i, error: `internal error (correlationId ${correlationId})` });
      }
    }
  }

  return json({ count: created.length, created, errors }, created.length > 0 ? 201 : 400);
}

// PATCH /api/machine/items — update one item (a bare { id, ...patch }) or a
// batch ({ items: [{ id, ...patch }] }, max 100). Each entry names its target
// by `id` and carries the same fields POST accepts (title, status, parentId,
// body, properties, …); every entry is validated through the same
// parseItemPayload + updateItem the in-app PATCH /api/items/:id uses, so this
// surface can't drift from the app contract or skip owner-scoping — and
// parent_id changes still go through assertValidParent (no cycles). Added
// (ADR-113) for the migration's two remaining update passes: the not-done task
// hierarchy re-pull (set parent_id) and the attachment body-ref rewrite. A bad
// entry is reported in `errors` and skipped, never failing the rest. Response:
// { count, updated, errors }; 200 if anything updated, 400 if every entry failed.
export async function PATCH(request: Request) {
  const identity = await verifyApiRequest(request.headers.get("authorization"));
  if (!identity) {
    return json({ error: "unauthorized" }, 401);
  }

  const ownerId = await resolveMachineOwner();
  if (!ownerId) {
    return json({ error: "owner not configured" }, 503);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  const batch = (body as { items?: unknown })?.items;
  const rawItems = Array.isArray(batch) ? batch : [body];
  if (rawItems.length === 0) {
    return json({ count: 0, updated: [], errors: [] });
  }
  if (rawItems.length > MAX_BATCH) {
    return json({ error: `too many items (max ${MAX_BATCH} per request)` }, 400);
  }

  const updated: unknown[] = [];
  const errors: { index: number; error: string }[] = [];
  for (let i = 0; i < rawItems.length; i++) {
    try {
      const entry = rawItems[i] as Record<string, unknown>;
      const id = asUuid(entry.id, "id");
      const patch = parseItemPayload(entry, "patch");
      updated.push(await updateItem(ownerId, id, patch));
    } catch (err) {
      if (err instanceof ItemError) {
        errors.push({ index: i, error: err.message });
      } else {
        const correlationId = crypto.randomUUID();
        await captureError("machine-items", err, { correlationId, detail: { index: i } });
        errors.push({ index: i, error: `internal error (correlationId ${correlationId})` });
      }
    }
  }

  return json({ count: updated.length, updated, errors }, updated.length > 0 ? 200 : 400);
}
