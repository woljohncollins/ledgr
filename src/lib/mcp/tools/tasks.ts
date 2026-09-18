// Subtask + recurrence tools (ADR-180). The two native-task capabilities the
// app has had since ADR-073/076/085 but the MCP surface never exposed: nesting
// (parent_id, the "n of m done" checklist) and repeating tasks (the RRULE + the
// per-date completion log).
//
// Same posture as the rest of the MCP layer: thin wrappers over the libs the
// REST routes already call (subtasks.ts, recurrence.ts, recurrence-service.ts,
// item-mutations.ts), so the model gets the same behavior as the canvas and can
// never write a rule shape the app can't read. In particular:
//   - set_recurrence goes through makeRecurrence, so the stored string is always
//     a normalized RRULE from the supported subset — never a raw string the
//     model composed. Writing items.properties.recurrence by hand via
//     update_item's propertyPatch is still possible and still validated on read,
//     but this tool is the one that can't produce garbage.
//   - update_occurrence goes through recurrence-service, which owns advancing
//     scheduled_date, the status flip at series end, and relative-subtask
//     recomputation. None of that is reimplemented here.
import { asUuid, parseItemPayload } from "@/lib/api";
import { ItemError, getItem } from "@/lib/items";
import { createItem, updateItem } from "@/lib/item-mutations";
import { parseTaskTitle } from "@/lib/nl-date";
import {
  FREQUENCIES,
  WEEKDAYS,
  dateToYmdUtc,
  describeRule,
  enumerateOccurrences,
  instanceState,
  isOccurrence,
  isYmd,
  makeRecurrence,
  nextUncompletedOnOrAfter,
  parseRRule,
  parseRecurrence,
  ymdToUtcDate,
  type ByDayOrdinal,
  type Frequency,
  type RecurrenceRule,
  type Weekday,
} from "@/lib/recurrence";
import {
  appTodayYmd,
  carveOccurrence,
  toggleOccurrenceCompletion,
} from "@/lib/recurrence-service";
import { listSubtree, type SubtaskNode } from "@/lib/subtasks";
import { withDatePin } from "@/lib/date-anchor";
import {
  optBodyMarkdown,
  optEnum,
  optEnumArray,
  optInt,
  optIntArray,
  optString,
  optYmd,
} from "./args";
import { rowView } from "./serializers";
import type { McpTool } from "./wire";

// How many future dates a read projects. Enough to see the shape of the rule
// ("yes, that's the 2nd and 4th Tuesday") without spending context on a wall of
// dates; the rule string is the authority, this is the human check.
const PREVIEW_OCCURRENCES = 6;

// ---------------------------------------------------------------------------
// Recurrence read shape, shared with get_item (items.ts spreads it). Returns an
// EMPTY object for a non-recurring item, so a plain task's response is
// byte-for-byte what it was before this tool family existed.
export function recurrenceView(properties: unknown): {
  recurrence?: {
    describe: string;
    rrule: string;
    dtstart: string;
    anchorMode: string;
    occurrenceMode: string;
    maintainDueOffset: boolean;
    nextOccurrences: string[];
    nextUncompleted: string | null;
    completedCount: number;
    skippedCount: number;
    completeInstances: string[];
    skippedInstances: string[];
  };
} {
  const props = (properties ?? {}) as Record<string, unknown>;
  const rule = parseRecurrence(props.recurrence);
  if (!rule) return {};
  const today = appTodayYmd();
  return {
    recurrence: {
      describe: describeRule(rule),
      rrule: rule.rrule,
      dtstart: rule.dtstart,
      anchorMode: rule.anchorMode,
      occurrenceMode: rule.occurrenceMode,
      maintainDueOffset: rule.maintainDueOffset === true,
      nextOccurrences: enumerateOccurrences(rule, {
        from: today,
        max: PREVIEW_OCCURRENCES,
      }),
      nextUncompleted: nextUncompletedOnOrAfter(rule, today),
      completedCount: rule.completeInstances.length,
      skippedCount: rule.skippedInstances.length,
      // The tail of each log: enough to answer "did I do it last week?" without
      // dumping years of stamps into the response.
      completeInstances: rule.completeInstances.slice(-PREVIEW_OCCURRENCES),
      skippedInstances: rule.skippedInstances.slice(-PREVIEW_OCCURRENCES),
    },
  };
}

// ---------------------------------------------------------------------------
// Subtasks

// One node of the subtree, body-free and without the audit timestamps the tree
// view doesn't need (createdAt/updatedAt are on get_item if wanted).
function nodeView(n: SubtaskNode): Record<string, unknown> {
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    status: n.status,
    statusCategory: n.statusCategory,
    dueDate: n.dueDate,
    scheduledDate: n.scheduledDate,
    ...(n.relativeOffset !== null ? { relativeOffsetDays: n.relativeOffset } : {}),
    urgency: n.urgency,
    ...(n.progress ? { progress: n.progress } : {}),
    ...(n.children.length ? { children: n.children.map(nodeView) } : {}),
  };
}

// A subtask entry for add_subtasks: a bare string is the title, an object can
// carry the same per-item fields create_item takes. Validated by
// parseItemPayload, so an entry validates exactly like a create.
function subtaskInputs(
  args: Record<string, unknown>,
  parentId: string,
  defaultType: string
): Record<string, unknown>[] {
  const raw = args.subtasks;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ItemError("bad_request", "subtasks must be a non-empty array");
  }
  if (raw.length > 50) {
    throw new ItemError("bad_request", "subtasks: at most 50 per call");
  }
  return raw.map((entry, i) => {
    const at = `subtasks[${i}]`;
    if (typeof entry === "string") {
      const title = entry.trim();
      if (!title) throw new ItemError("bad_request", `${at} is empty`);
      return { type: defaultType, title, parentId };
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new ItemError("bad_request", `${at} must be a string or an object`);
    }
    const e = entry as Record<string, unknown>;
    const title = typeof e.title === "string" ? e.title.trim() : "";
    if (!title) throw new ItemError("bad_request", `${at}.title is required`);
    const out: Record<string, unknown> = {
      type: typeof e.type === "string" && e.type.trim() ? e.type.trim() : defaultType,
      title,
      parentId,
    };
    for (const k of ["status", "urgency", "dueDate", "scheduledDate", "url"]) {
      if (e[k] !== undefined) out[k] = e[k];
    }
    const md = optBodyMarkdown(e, `${at}.`);
    if (md !== undefined) out.body = { format: "markdown", text: md };
    return out;
  });
}

// ---------------------------------------------------------------------------
// Recurrence write helpers

// The anchor a fresh rule starts from, mirroring the canvas control exactly
// (RecurrenceControl: scheduled ?? due ?? today) so a rule set here and a rule
// set in the app land on the same dtstart for the same task.
function anchorFor(
  item: { scheduledDate: Date | null; dueDate: Date | null },
  today: string
): string {
  if (item.scheduledDate) return dateToYmdUtc(item.scheduledDate);
  if (item.dueDate) return dateToYmdUtc(item.dueDate);
  return today;
}

// BYDAY ordinals accept either the RRULE spelling ("1SU", "-1FR") or an object
// ({ ordinal: 1, weekday: "SU" }) — a model reaches for whichever it has.
function parseByDayOrdinal(raw: unknown): ByDayOrdinal[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new ItemError("bad_request", "byDayOrdinal must be an array");
  }
  return raw.map((entry) => {
    if (typeof entry === "string") {
      const m = entry.trim().toUpperCase().match(/^(-?\d)(MO|TU|WE|TH|FR|SA|SU)$/);
      if (!m) {
        throw new ItemError(
          "bad_request",
          `byDayOrdinal entry '${entry}' must look like 1SU, 3TH, or -1FR`
        );
      }
      return { ordinal: Number(m[1]), weekday: m[2] as Weekday };
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new ItemError("bad_request", "byDayOrdinal entries must be a string or an object");
    }
    const e = entry as Record<string, unknown>;
    const ordinal = Number(e.ordinal);
    const weekday = typeof e.weekday === "string" ? e.weekday.trim().toUpperCase() : "";
    if (!Number.isInteger(ordinal) || ordinal === 0 || ordinal < -1 || ordinal > 5) {
      throw new ItemError("bad_request", "byDayOrdinal ordinal must be 1–5 or -1 (last)");
    }
    if (!(WEEKDAYS as readonly string[]).includes(weekday)) {
      throw new ItemError("bad_request", `byDayOrdinal weekday must be one of: ${WEEKDAYS.join(", ")}`);
    }
    return { ordinal, weekday: weekday as Weekday };
  });
}

// nl-date.ts spells a day-of-month rule "<Nth> of the month". A model reaches
// just as readily for "monthly on the 3rd", which that parser reads as a PLAIN
// monthly rule — no BYMONTHDAY, and no error to notice. Rather than widen the
// shared quick-add parser (its phrasing is Brandon's typing habit, not ours),
// this rewrites the one phrasing MCP callers produce into the one it knows.
// Verified against the parser: "monthly on the 3rd" → BYMONTHDAY=3, "monthly on
// the first thursday" → BYDAY=1TH.
function normalizeRepeatPhrase(phrase: string): string {
  const m = phrase.trim().match(/^(?:monthly|every month) on(?: the)? (.+)$/i);
  if (!m) return phrase;
  const rest = m[1].trim().replace(/^last day$/i, "last");
  return `${rest} of the month`;
}

// Build the rule to store. Three ways in, in precedence order:
//   1. `repeat` — a natural-language phrase, run through the SAME parser quick-add
//      uses (nl-date.ts), so "every other tuesday" means here what it means there.
//   2. structured parts (freq/interval/byDay/…).
//   3. neither, but the task already recurs — a PARTIAL edit: the existing rule's
//      parts carry through and only the fields passed change (e.g. add `until`).
function buildRule(
  args: Record<string, unknown>,
  existing: RecurrenceRule | null,
  anchor: string,
  today: string
): RecurrenceRule {
  const repeat = optString(args, "repeat");
  const freqArg = optEnum<Frequency>(args, "freq", FREQUENCIES);
  const byDay = optEnumArray<Weekday>(args, "byDay", WEEKDAYS);
  const byDayOrdinal = parseByDayOrdinal(args.byDayOrdinal);
  const byMonthDay = optIntArray(
    args,
    "byMonthDay",
    (n) => n === -1 || (n >= 1 && n <= 31),
    "1–31, or -1 for the last day of the month"
  );
  const interval = optInt(args, "interval");
  if (interval !== undefined && interval < 1) {
    throw new ItemError("bad_request", "interval must be 1 or more");
  }
  const count = optInt(args, "count");
  if (count !== undefined && count < 1) {
    throw new ItemError("bad_request", "count must be 1 or more");
  }
  const until = optYmd(args, "until");
  if (count !== undefined && until !== undefined) {
    throw new ItemError("bad_request", "pass count or until, not both");
  }

  // Modes and flags: an explicit value wins, else carry the existing rule's.
  const anchorMode =
    optEnum(args, "anchorMode", ["fixed", "completion"] as const) ??
    existing?.anchorMode ??
    "fixed";
  const occurrenceMode =
    optEnum(args, "occurrenceMode", ["virtual", "materialized"] as const) ??
    existing?.occurrenceMode ??
    "virtual";
  const maintainDueOffset =
    args.maintainDueOffset !== undefined
      ? args.maintainDueOffset === true
      : existing?.maintainDueOffset === true;

  let base: {
    freq: Frequency;
    interval?: number;
    byDay?: Weekday[];
    byDayOrdinal?: ByDayOrdinal[];
    byMonthDay?: number[];
    count?: number;
    until?: string;
    dtstart: string;
  };
  let dtstart = optYmd(args, "dtstart") ?? anchor;

  if (repeat !== undefined) {
    // The phrase is parsed as if it were a quick-add title; only its recurrence
    // half is used. A date inside the phrase ("every friday starting June 6")
    // becomes the anchor unless dtstart was passed explicitly — detections is
    // what distinguishes a date the phrase carried from one the parser derived
    // as the first occurrence.
    const parsed = parseTaskTitle(normalizeRepeatPhrase(repeat), today);
    if (!parsed.recurrence) {
      throw new ItemError(
        "bad_request",
        `couldn't read a repeat out of "${repeat}" — try "every day", "every ` +
          `other tuesday", "every 3 weeks", "the 3rd of the month", "first and ` +
          `third thursday", "yearly", or pass freq/interval/byDay instead`
      );
    }
    const parts = parseRRule(parsed.recurrence.rrule);
    if (!parts) throw new ItemError("bad_request", "couldn't build a rule from that phrase");
    const carriedDate =
      parsed.detections.some((d) => d.field === "scheduled") && parsed.scheduledDate;
    if (optYmd(args, "dtstart") === undefined && carriedDate) {
      dtstart = parsed.scheduledDate as string;
    }
    base = { ...parts, dtstart };
    // Structured args still layer on top of a phrase, so "every friday" + until
    // is one call.
    if (byDay !== undefined) base.byDay = byDay;
    if (byDayOrdinal !== undefined) base.byDayOrdinal = byDayOrdinal;
    if (byMonthDay !== undefined) base.byMonthDay = byMonthDay;
    if (interval !== undefined) base.interval = interval;
  } else if (freqArg !== undefined) {
    base = {
      freq: freqArg,
      interval,
      byDay,
      byDayOrdinal,
      byMonthDay,
      dtstart,
    };
  } else if (existing) {
    const parts = parseRRule(existing.rrule);
    if (!parts) throw new ItemError("bad_request", "the stored rule is unreadable — pass freq or repeat");
    base = {
      freq: parts.freq,
      interval: interval ?? parts.interval,
      byDay: byDay ?? parts.byDay,
      byDayOrdinal: byDayOrdinal ?? parts.byDayOrdinal,
      byMonthDay: byMonthDay ?? parts.byMonthDay,
      count: parts.count,
      until: parts.until,
      dtstart: optYmd(args, "dtstart") ?? existing.dtstart,
    };
  } else {
    throw new ItemError(
      "bad_request",
      'this task does not repeat yet — pass repeat (e.g. "every other tuesday") or freq'
    );
  }

  // count/until are a two-way switch: passing one clears the other, and an
  // explicit null on either clears the bound (repeat forever).
  if (count !== undefined) {
    base.count = count;
    base.until = undefined;
  } else if (until !== undefined) {
    base.until = until;
    base.count = undefined;
  }
  if (args.count === null) base.count = undefined;
  if (args.until === null) base.until = undefined;

  const rule = makeRecurrence({
    ...base,
    anchorMode,
    occurrenceMode,
    maintainDueOffset,
  });

  // makeRecurrence starts a FRESH log (it's the "new rule" constructor). Editing
  // a live series must not silently throw away which days are already done, so
  // the existing log carries over unless the caller asks for a reset. Stamps for
  // dates the new rule no longer projects are harmless: every reader filters the
  // log against the rule's own projection.
  if (existing && args.resetLog !== true) {
    return {
      ...rule,
      completeInstances: existing.completeInstances,
      skippedInstances: existing.skippedInstances,
    };
  }
  return rule;
}

export const taskTools: McpTool[] = [
  {
    name: "list_subtasks",
    title: "List subtasks",
    description:
      "Read an item's SUBTASK tree — its children, their children, and so on, " +
      "nested, with an 'n of m done' progress rollup on the root and on every " +
      "node that has task children (only task-type children count toward a " +
      "rollup; a note filed under a parent is context, not a checklist entry). " +
      "Bodies are not included; open a child with get_item to read one. Use " +
      "this to answer 'what's left on X' or 'how far along is X'. To ADD " +
      "children use add_subtasks; to move an existing item under a parent, set " +
      "parentId with update_item.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The parent item id (UUID)." },
      },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (ownerId, args) => {
      const id = asUuid(args.id, "id");
      const tree = await listSubtree(ownerId, id);
      return {
        parentId: id,
        progress: tree.progress,
        count: tree.children.length,
        subtasks: tree.children.map(nodeView),
      };
    },
  },
  {
    name: "add_subtasks",
    title: "Add subtasks",
    description:
      "Add one or more SUBTASKS under an existing item in a single call — the " +
      "'break this down into steps' tool. Each entry is either a plain title " +
      "string or an object with title plus any of type, status, urgency, " +
      "dueDate, scheduledDate, url, bodyMarkdown. Children default to the task " +
      "type, so a plain list of strings makes a checklist. Order is preserved. " +
      "Returns the created children and the parent's new 'n of m done' rollup. " +
      "For a single child you can also just call create_item with parentId.",
    inputSchema: {
      type: "object",
      properties: {
        parentId: { type: "string", description: "The item id (UUID) these become children of." },
        subtasks: {
          type: "array",
          description:
            "The children to create, in order. Each entry: a title string, or " +
            "an object { title, type?, status?, urgency?, dueDate?, " +
            "scheduledDate?, url?, bodyMarkdown? }. Max 50 per call.",
          minItems: 1,
          maxItems: 50,
          items: {
            oneOf: [
              { type: "string", description: "The subtask title." },
              {
                type: "object",
                properties: {
                  title: { type: "string", description: "The subtask title (required)." },
                  type: { type: "string", description: "Type key; defaults to the call's `type` (task)." },
                  status: { type: "string", description: "Status key (default the type's not-started status)." },
                  urgency: { type: "number", description: "Priority 1–6 (1 highest)." },
                  dueDate: { type: "string", description: "Deadline, ISO 8601." },
                  scheduledDate: { type: "string", description: "Planned work date, ISO 8601." },
                  url: { type: "string", description: "URL, for a link-ish child." },
                  bodyMarkdown: { type: "string", description: "Body as markdown. Also accepted as `body`." },
                },
                required: ["title"],
                additionalProperties: false,
              },
            ],
          },
        },
        type: {
          type: "string",
          description:
            "Default type key for entries that don't name their own (default " +
            "task — the checklist case). See list_types.",
        },
      },
      required: ["parentId", "subtasks"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    handler: async (ownerId, args) => {
      const parentId = asUuid(args.parentId, "parentId");
      const defaultType = optString(args, "type") ?? "task";
      const raws = subtaskInputs(args, parentId, defaultType);
      // Validate EVERY entry before writing any, so a typo in the last title
      // can't leave half a checklist behind (createItem has no batch txn).
      const inputs = raws.map((raw) => parseItemPayload(raw, "create"));
      const created = [];
      for (const input of inputs) {
        created.push(rowView(await createItem(ownerId, input)));
      }
      const tree = await listSubtree(ownerId, parentId);
      return { parentId, count: created.length, created, progress: tree.progress };
    },
  },
  {
    name: "set_recurrence",
    title: "Set a repeat rule",
    description:
      "Make a task REPEAT, change how it repeats, or stop it repeating. The " +
      "easiest way in is repeat: a phrase like \"every day\", \"every weekday\", " +
      "\"every other tuesday\", \"every 3 weeks\", \"the 3rd of the month\", \"first " +
      "and third thursday\", \"last of the month\", or \"yearly\" — parsed the same " +
      "way Ledgr's own quick-add parses it. Or pass the parts (freq, interval, " +
      "byDay, byMonthDay, byDayOrdinal). Bound it with count or until, or leave " +
      "both off to repeat forever. Pass clear:true to remove the repeat and " +
      "leave a plain one-off task.\n\n" +
      "One item is the whole series: there is no row per occurrence and nothing " +
      "stacks up when it's missed. The task carries the rule plus a log of which " +
      "dates are done, and its planned date always points at the next one. So to " +
      "complete THIS occurrence, call update_item with a done status — the task " +
      "advances to the next date instead of closing. Use update_occurrence to " +
      "tick a specific past/future date, or to pull one date out of the series. " +
      "Editing the rule KEEPS the completion log (pass resetLog:true to wipe it).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The task's item id (UUID)." },
        repeat: {
          type: "string",
          description:
            "Natural-language repeat, e.g. \"every day\", \"every weekday\", " +
            "\"every other tuesday\", \"every 3 weeks\", \"the 3rd of the month\", " +
            "\"first and third thursday\", \"yearly\". Wins over freq. A date in " +
            "the phrase (\"every friday starting June 6\") becomes the anchor.",
        },
        clear: { type: "boolean", description: "true = remove the repeat rule; the task stays as a one-off. Ignores every other field." },
        freq: { type: "string", enum: [...FREQUENCIES], description: "How often, if not using repeat: daily | weekly | monthly | yearly." },
        interval: { type: "integer", description: "Every N of that unit (default 1; 2 = every other).", minimum: 1 },
        byDay: {
          type: "array",
          items: { type: "string", enum: [...WEEKDAYS] },
          description:
            "WEEKLY only: which weekdays it fires on (MO TU WE TH FR SA SU). " +
            "Mon–Fri = every weekday. Empty array clears.",
        },
        byMonthDay: {
          type: "array",
          items: { type: "integer" },
          description: "MONTHLY only: day(s) of the month, 1–31, or -1 for the last day. Empty array clears.",
        },
        byDayOrdinal: {
          type: "array",
          items: { type: "string" },
          description:
            "MONTHLY only: nth weekday(s) — \"1SU\" (first Sunday), \"3TH\" (third " +
            "Thursday), \"-1FR\" (last Friday). An object { ordinal, weekday } " +
            "also works. Empty array clears.",
        },
        count: { type: "integer", description: "Stop after this many occurrences. Mutually exclusive with until; null clears.", minimum: 1 },
        until: { type: "string", description: "Last date it may fire, YYYY-MM-DD (inclusive). Mutually exclusive with count; null clears." },
        dtstart: {
          type: "string",
          description:
            "The anchor — the first occurrence, YYYY-MM-DD. Defaults to the " +
            "task's planned date, else its due date, else today (what the app's " +
            "own repeat control does).",
        },
        anchorMode: {
          type: "string",
          enum: ["fixed", "completion"],
          description:
            "fixed (default) = a real calendar rule, next date computed from the " +
            "calendar even if you finish late. completion = N units AFTER you " +
            "actually finish (\"water the plants every 3 days from when I last did\").",
        },
        occurrenceMode: {
          type: "string",
          enum: ["virtual", "materialized"],
          description:
            "virtual (default) = one item is the series, with a per-date " +
            "completion log. materialized = a separate item per occurrence, " +
            "linked back to the series. Leave it alone unless the owner asks; " +
            "update_occurrence works on virtual series only.",
        },
        maintainDueOffset: {
          type: "boolean",
          description:
            "Superseded — a deadline now keeps its gap from the planned date " +
            "automatically, so true is the default behavior and you rarely need " +
            "this. Pass false to PIN the deadline instead, holding it still while " +
            "the plan moves (a hard external date). Kept so existing callers keep " +
            "working; prefer update_item's datePins property.",
        },
        resetLog: {
          type: "boolean",
          description:
            "true = start a fresh completion log when changing an existing rule. " +
            "Default false keeps which dates are already done/skipped.",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async (ownerId, args) => {
      const id = asUuid(args.id, "id");
      const item = await getItem(ownerId, id);
      const props = (item.properties ?? {}) as Record<string, unknown>;
      const existing = parseRecurrence(props.recurrence);

      if (args.clear === true) {
        if (!existing) {
          return { ...rowView(item), changed: false, note: "this task already does not repeat" };
        }
        const cleared = await updateItem(ownerId, id, { propertyPatch: { recurrence: null } });
        return { ...rowView(cleared), changed: true, note: "repeat removed; the task stays as a one-off" };
      }

      const today = appTodayYmd();
      const rule = buildRule(args, existing, anchorFor(item, today), today);

      // Mirrors the canvas control: turning a repeat ON when nothing is planned
      // yet seeds the planned date, so the series has a concrete next date and
      // shows up in Today/Planner. An already-planned task keeps its date.
      const patch: Parameters<typeof updateItem>[2] = { propertyPatch: { recurrence: rule } };
      // `maintainDueOffset` is superseded by date anchoring (ADR-253): a deadline
      // now rides the plan date by default, so the flag's `true` is simply the
      // new normal. Only an explicit `false` still says something — "hold this
      // deadline still" — and it is translated here, at the write boundary, into
      // the real lever (a due pin). The stored flag itself is no longer read:
      // parseRecurrence collapses `false` to `undefined`, making it
      // indistinguishable from the unset default every task already carries.
      if (args.maintainDueOffset !== undefined) {
        const next = withDatePin(
          item.properties as Record<string, unknown> | null,
          "due",
          args.maintainDueOffset !== true
        );
        patch.propertyPatch!.datePins = next.datePins ?? null;
      }
      if (!item.scheduledDate) {
        const first = nextUncompletedOnOrAfter(rule, rule.dtstart) ?? rule.dtstart;
        patch.scheduledDate = ymdToUtcDate(first);
      }
      const updated = await updateItem(ownerId, id, patch);
      return {
        ...rowView(updated),
        changed: true,
        ...recurrenceView(updated.properties),
      };
    },
  },
  {
    name: "update_occurrence",
    title: "Act on one occurrence",
    description:
      "Act on ONE date of a repeating task, without touching the rest of the " +
      "series. actions:\n" +
      "  complete — tick that date off (e.g. logging a day you did it late)\n" +
      "  uncomplete — untick it\n" +
      "  carve — pull that one date OUT into its own separate one-off item, " +
      "which you can then edit freely; the series skips that date and moves on. " +
      "Use this for \"this week's is different\" (returns the new item's id).\n" +
      "complete/uncomplete are idempotent — asking for the state it's already in " +
      "is a no-op, not a toggle. To complete the CURRENT occurrence, prefer " +
      "update_item with a done status; this tool is for a specific date. Works " +
      "on virtual series (the default); a materialized series has a real item " +
      "per occurrence, so update that item directly instead.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The repeating task's item id (the series)." },
        date: { type: "string", description: "Which occurrence, YYYY-MM-DD. Must be a date the rule actually fires on (see get_item's recurrence.nextOccurrences)." },
        action: {
          type: "string",
          enum: ["complete", "uncomplete", "carve"],
          description: "complete | uncomplete | carve (split that date off as its own item).",
        },
      },
      required: ["id", "date", "action"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async (ownerId, args) => {
      const id = asUuid(args.id, "id");
      const date = optString(args, "date");
      if (!date || !isYmd(date)) {
        throw new ItemError("bad_request", "date must be a calendar date, YYYY-MM-DD");
      }
      const action = optEnum(args, "action", ["complete", "uncomplete", "carve"] as const);
      if (!action) {
        throw new ItemError("bad_request", "action must be complete, uncomplete, or carve");
      }

      const item = await getItem(ownerId, id);
      const props = (item.properties ?? {}) as Record<string, unknown>;
      const rule = parseRecurrence(props.recurrence);
      if (!rule) {
        throw new ItemError("bad_request", "this task does not repeat — set a rule with set_recurrence first");
      }
      if (rule.occurrenceMode !== "virtual") {
        throw new ItemError(
          "bad_request",
          "this series materializes an item per occurrence — find that item (list_items with relatedTo=this id) and update it directly"
        );
      }
      if (!isOccurrence(rule, date)) {
        throw new ItemError(
          "bad_request",
          `${date} is not an occurrence of this rule (${describeRule(rule)}, from ${rule.dtstart})`
        );
      }

      if (action === "carve") {
        const { itemId, series } = await carveOccurrence(ownerId, id, date);
        return {
          action,
          date,
          carvedItemId: itemId,
          series: { ...rowView(series), ...recurrenceView(series.properties) },
        };
      }

      // Idempotent complete/uncomplete over a toggle: only write when the
      // logged state actually differs from what was asked for.
      const state = instanceState(rule, date);
      const isComplete = state === "complete";
      const want = action === "complete";
      if (isComplete === want) {
        return {
          action,
          date,
          changed: false,
          note: `${date} is already ${want ? "complete" : "not complete"}`,
          series: { ...rowView(item), ...recurrenceView(item.properties) },
        };
      }
      const series = await toggleOccurrenceCompletion(ownerId, id, date);
      return {
        action,
        date,
        changed: true,
        series: { ...rowView(series), ...recurrenceView(series.properties) },
      };
    },
  },
];
