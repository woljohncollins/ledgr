// Hand-rolled MCP tool-argument parsing: every failure throws ItemError so
// callTool's catch turns it into a clean isError result instead of a thrown
// exception reaching the transport. Split out of the old monolithic tools.ts
// (ADR-047).
import { asUuid } from "@/lib/api";
import { makeMarkdownBody } from "@/lib/body";
import { ItemError } from "@/lib/items";
import { isYmd } from "@/lib/recurrence";

export function optString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new ItemError("bad_request", `${key} must be a string`);
  const t = v.trim();
  return t === "" ? undefined : t;
}

export function reqString(args: Record<string, unknown>, key: string): string {
  const v = optString(args, key);
  if (v === undefined) throw new ItemError("bad_request", `${key} is required`);
  return v;
}

export function optInt(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new ItemError("bad_request", `${key} must be an integer`);
  return n;
}

export function optEnum<T extends string>(
  args: Record<string, unknown>,
  key: string,
  allowed: readonly T[]
): T | undefined {
  const v = optString(args, key);
  if (v === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(v)) {
    throw new ItemError("bad_request", `${key} must be one of: ${allowed.join(", ")}`);
  }
  return v as T;
}

// An object of string→string (e.g. {{ask:Label}} answers); non-string values
// are dropped. Returns undefined for a missing/empty/non-object value.
export function optStringRecord(
  args: Record<string, unknown>,
  key: string
): Record<string, string> | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) {
    throw new ItemError("bad_request", `${key} must be an object`);
  }
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") out[k] = val;
  }
  return Object.keys(out).length ? out : undefined;
}

// A calendar day (YYYY-MM-DD) — the shape recurrence rules speak (ADR-076).
// Rejects a datetime so a caller can't smuggle a zone into a date-only field.
export function optYmd(args: Record<string, unknown>, key: string): string | undefined {
  const v = optString(args, key);
  if (v === undefined) return undefined;
  if (!isYmd(v)) throw new ItemError("bad_request", `${key} must be a calendar date, YYYY-MM-DD`);
  return v;
}

// An array of values from a fixed set (e.g. byDay weekdays). Undefined for a
// missing key; an EMPTY array is preserved (it means "clear this part").
export function optEnumArray<T extends string>(
  args: Record<string, unknown>,
  key: string,
  allowed: readonly T[]
): T[] | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new ItemError("bad_request", `${key} must be an array`);
  return v.map((x) => {
    const s = typeof x === "string" ? x.trim().toUpperCase() : "";
    if (!(allowed as readonly string[]).includes(s)) {
      throw new ItemError("bad_request", `${key} entries must be one of: ${allowed.join(", ")}`);
    }
    return s as T;
  });
}

// An array of integers within an inclusive range (e.g. byMonthDay 1..31, -1).
export function optIntArray(
  args: Record<string, unknown>,
  key: string,
  allow: (n: number) => boolean,
  hint: string
): number[] | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new ItemError("bad_request", `${key} must be an array`);
  return v.map((x) => {
    const n = Number(x);
    if (!Number.isInteger(n) || !allow(n)) {
      throw new ItemError("bad_request", `${key} entries must be ${hint}`);
    }
    return n;
  });
}

export function optUuidArray(args: Record<string, unknown>, key: string): string[] {
  const v = args[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new ItemError("bad_request", `${key} must be an array of item ids`);
  return v.map((x) => asUuid(x, `${key} entry`));
}

// Property keys that map 1:1 onto the REST item fields (everything except the
// body, which MCP takes as a markdown string and turns into an ItemBody here).
const WRITE_FIELDS = [
  "title",
  "status",
  "urgency",
  "dueDate",
  "scheduledDate",
  "meetingAt",
  "url",
  "properties",
  "inbox",
  "parentId",
] as const;

// Wrong names callers actually reach for, each pointing at the real field
// (ADR-201). `body` is NOT here: it's a competing convention rather than a
// typo, so optBodyMarkdown accepts it as an alias instead (ADR-207).
const KEY_HINTS: Record<string, string> = {
  content: "bodyMarkdown",
  text: "bodyMarkdown",
  markdown: "bodyMarkdown",
};

// The body markdown, under either name (ADR-207). The declared field is
// bodyMarkdown, but `body` is what model callers reach for — it's the name
// Ledgr's own REST API and the items.body column use — and dropping it cost
// three real empty-body saves. This is the single place every MCP write path
// takes a body from, so no caller can guess wrong again. bodyMarkdown wins if
// both are passed. `at` prefixes the error for nested entries ("subtasks[2].").
//
// DON'T re-reject the alias: ADR-201 tried exactly that and the saves kept
// happening, because three write tools never went through buildWriteRaw. Read
// ADR-207 before narrowing this back.
export function optBodyMarkdown(
  args: Record<string, unknown>,
  at = ""
): string | undefined {
  const key =
    args.bodyMarkdown !== undefined && args.bodyMarkdown !== null ? "bodyMarkdown" : "body";
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") {
    throw new ItemError(
      "bad_request",
      `${at}${key} must be a markdown string${key === "body" ? " (alias for bodyMarkdown)" : ""}`
    );
  }
  return v;
}

// Builds the ItemInput/ItemPatch raw object for parseItemPayload from MCP args.
// MCP takes the body as a markdown string (bodyMarkdown, or its `body` alias);
// everything else maps 1:1 onto the REST item fields, so parseItemPayload does
// the real validation.
// handlerKeys are args the calling tool reads itself outside this builder
// (e.g. relateTo, id): accepted here, never copied into the raw object.
export function buildWriteRaw(
  args: Record<string, unknown>,
  extra: string[],
  handlerKeys: string[] = []
): Record<string, unknown> {
  // Enforce the schemas' additionalProperties:false. Nothing else does: the
  // transport doesn't validate args, so an unknown key used to be dropped
  // silently — a create_item whose body rode in as `body` "succeeded" with an
  // empty body. Reject by name instead, with a did-you-mean where we have one.
  const allowed = new Set<string>([
    "bodyMarkdown",
    "body", // alias, see optBodyMarkdown
    ...WRITE_FIELDS,
    ...extra,
    ...handlerKeys,
  ]);
  const unknown = Object.keys(args).filter((k) => !allowed.has(k));
  if (unknown.length > 0) {
    const named = unknown
      .map((k) => (KEY_HINTS[k] ? `"${k}" (did you mean "${KEY_HINTS[k]}"?)` : `"${k}"`))
      .join(", ");
    throw new ItemError(
      "bad_request",
      `unknown field${unknown.length > 1 ? "s" : ""} ${named}; accepted fields: ${[...allowed].sort().join(", ")}`
    );
  }
  const raw: Record<string, unknown> = {};
  for (const k of [...WRITE_FIELDS, ...extra]) {
    if (k in args && args[k] !== undefined) raw[k] = args[k];
  }
  const md = optBodyMarkdown(args);
  if (md !== undefined) raw.body = makeMarkdownBody(md);
  return raw;
}
