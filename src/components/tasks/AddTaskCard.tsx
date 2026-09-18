// The one task-add card, used everywhere a task is created (global capture, the
// per-day Add task in Upcoming, project cards) so the experience is consistent
// (Tyler, 2026-06-21 — Image #15). Title with live NL token highlighting +
// Description + an SVG chip row (Date · Priority · Assignee · …)
// gated by the Quick Add config (settings.quickAddHidden) + a destination picker
// (Inbox / a project) + Cancel / Add task. Inline (in a list) or inside the
// capture modal — same component.
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { parseTaskTitle } from "@/lib/nl-date";
import { PRIORITIES, priorityStyle, type Priority } from "@/lib/priority";
import { enqueueCapture } from "@/lib/outbox";
import { scheduleListRefresh } from "@/lib/list-refresh";
import {
  TAG_TYPE,
  TAGS_ROLE,
  parseMentionTokens,
  parseProjectToken,
  parseTagTokens,
  stripConsumedTokens,
} from "@/lib/tags";
import {
  consumeMentionText,
  detectMentionToken,
  useMentionTypeahead,
  type MentionHit,
} from "@/components/capture/useMentionTypeahead";
import { LinkedChips, MentionPopup, useTypeGlyphs, type LinkedItem } from "@/components/capture/mention-ui";
import {
  createMentionTarget,
  createTargets,
  type CreateTarget,
} from "@/lib/mention-create";
import { loadTypes, type TypeMeta } from "@/components/search/type-token";
import { GROUP_TYPE } from "@/lib/events/people";
import { announceFloatingOpen } from "@/lib/floating";
import DateInput from "@/components/ui/DateInput";
import { showToast } from "@/components/ui/ActionToast";
import DayPickerPanel from "@/components/ui/DayPickerPanel";
import type { PropertyDef } from "@/lib/types";

function localTodayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// --- inline title highlighting (shared shape with the old capture) ---
type Seg = { text: string; hl?: boolean };
function buildSegments(title: string, detections: { source: string }[]): Seg[] {
  if (!title) return [];
  const lower = title.toLowerCase();
  const ranges: [number, number][] = [];
  for (const d of detections) {
    const src = d.source?.trim();
    if (!src) continue;
    const idx = lower.indexOf(src.toLowerCase());
    if (idx >= 0) ranges.push([idx, idx + src.length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const segs: Seg[] = [];
  let pos = 0;
  for (const [start, end] of ranges) {
    if (start < pos) continue;
    if (start > pos) segs.push({ text: title.slice(pos, start) });
    segs.push({ text: title.slice(start, end), hl: true });
    pos = end;
  }
  if (pos < title.length) segs.push({ text: title.slice(pos) });
  return segs;
}

// --- inline SVG icons (16px, currentColor) ---
function I({ d, extra }: { d: string; extra?: React.ReactNode }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
      {extra}
    </svg>
  );
}
const IconCalendar = <I d="M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" extra={<><path d="M4 9h16" /><path d="M8 3v3M16 3v3" /></>} />;
const IconFlag = <I d="M5 21V4" extra={<path d="M5 4h12l-2 4 2 4H5" />} />;
const IconDots = <I d="M5 12h.01M12 12h.01M19 12h.01" />;
const IconInbox = <I d="M4 13h4l1 3h6l1-3h4" extra={<path d="M4 13l2-7h12l2 7v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" />} />;
const IconDescription = <I d="M4 7h16M4 12h16M4 17h10" />;
const IconCanvas = <I d="M4 14c2 0 2-6 4-6s2 8 4 8 2-10 4-10 2 6 4 6" />;
const IconChevron = <I d="M6 9l6 6 6-6" />;
const IconX = <I d="M6 6l12 12M18 6L6 18" />;
const IconRepeat = <I d="M17 2l4 4-4 4" extra={<><path d="M3 11V9a4 4 0 0 1 4-4h14" /><path d="M7 22l-4-4 4-4" /><path d="M21 13v2a4 4 0 0 1-4 4H3" /></>} />;
// The hash glyph now marks a TAG (the "#" sigil). Kept for the tag chips below.
const IconHash = <I d="M4 9h16M4 15h15M10 3L8 21M16 3l-2 18" />;
// The project-destination indicator. A plus, matching the "+project" sigil you
// type — it used to be IconHash, which now means something else entirely.
const IconPlus = <I d="M12 5v14M5 12h14" />;
const IconUser = <I d="M4 20c0-3.5 3.6-6 8-6s8 2.5 8 6" extra={<circle cx="12" cy="8" r="4" />} />;
// Group: two overlapping figures — a person with a second head/shoulder behind.
const IconGroup = <I d="M2 20c0-3 3-5 6.5-5s6.5 2 6.5 5" extra={<><circle cx="8.5" cy="8" r="3.5" /><path d="M16 5.5a3.5 3.5 0 0 1 0 7" /><path d="M17.5 15c2.6.4 4.5 2.3 4.5 5" /></>} />;

let quickAddPromise: Promise<string[]> | null = null;
function loadQuickAddHidden(): Promise<string[]> {
  quickAddPromise ??= fetch("/api/settings")
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => (Array.isArray(d?.settings?.quickAddHidden) ? (d.settings.quickAddHidden as string[]) : []))
    .catch(() => []);
  return quickAddPromise;
}

type ProjectOpt = { id: string; title: string };

// The provisional task a host can render immediately, before the POST resolves
// (optimistic add). Just enough to paint a recognizable row.
export type OptimisticTask = {
  id: string;
  title: string;
  scheduleLabel: string | null;
};

export default function AddTaskCard({
  defaultDueYmd,
  host,
  parentId,
  autoFocus = true,
  lockDestination = false,
  initialTitle,
  initialDescription,
  createVia,
  onBeforeCreate,
  submitLabel,
  onDone,
  onCancel,
  onOptimisticAdd,
  onOptimisticSettle,
}: {
  defaultDueYmd?: string;
  // The item the task is added FROM (a project card, a note, …): the task
  // auto-associates with it instead of landing in the Inbox. role defaults to
  // "related" ("project" for a project host).
  host?: { id: string; label: string; role?: string };
  // Subtask mode (Tyler, 2026-08-19): the created task nests under this parent
  // (body.parentId). A subtask's place IS its parent, so the destination picker
  // hides and no inbox/project destination is written — a typed "+project"
  // still relates the subtask to that project (never a silent no-op).
  parentId?: string;
  autoFocus?: boolean;
  // Destination is fixed to the host (e.g. a project's Tasks card): hide the
  // destination picker entirely and always file onto the host.
  lockDestination?: boolean;
  // Pre-filled capture (the meeting "promote to task" flow): the line's text as
  // the title, its sub-bullets as the description. Everything the typed capture
  // parses out of a title — dates, "p2", "#tag", "+project", "@person" — is
  // parsed out of a pre-filled one the same way, since it's the same card.
  initialTitle?: string;
  initialDescription?: string;
  // Create through a different endpoint with extra fields merged into the POST
  // body (promotion posts to the meeting's promote-task route so the task also
  // gets its source anchor and the meeting's people).
  createVia?: { url: string; extra?: Record<string, unknown> };
  // Awaited before the POST (promotion flushes the meeting body save first, so
  // the line's ^id anchor exists before the task points at it).
  onBeforeCreate?: () => Promise<void> | void;
  submitLabel?: string;
  onDone: () => void;
  onCancel: () => void;
  // When provided (inline list surfaces), the add is OPTIMISTIC: the card closes
  // and this fires with the provisional task immediately, the POST runs behind
  // it, and a coalesced refresh reconciles the real row in. Absent (modal /
  // related panel) keeps the original await-then-refresh-then-close flow.
  onOptimisticAdd?: (task: OptimisticTask) => void;
  // Fires when the POST lands, with the provisional id and the REAL item id. The
  // gap matters: the row is provisional for ~150ms (the POST) but the coalesced
  // refresh is ~900ms out, and the old row spent that whole second looking
  // unfinished. Optional, so a host can ignore it and keep the old behavior.
  onOptimisticSettle?: (tmpId: string, realId: string) => void;
}) {
  const router = useRouter();
  const [title, setTitle] = useState(initialTitle ?? "");
  const [description, setDescription] = useState(initialDescription ?? "");
  const [showDesc, setShowDesc] = useState(!!initialDescription);
  // due/scheduled hold an explicit PICK only. The defaultDueYmd is a fallback
  // (used when nothing is typed or picked) so a typed date ("…Saturday") always
  // wins over it; dateCleared lets the ✕ suppress that fallback too.
  const [due, setDue] = useState("");
  const [scheduled, setScheduled] = useState("");
  const [dateCleared, setDateCleared] = useState(false);
  const [urgency, setUrgency] = useState<Priority | null>(null);
  const [dest, setDest] = useState<string>(host?.id ?? "inbox");
  const [projects, setProjects] = useState<ProjectOpt[]>([]);
  // Existing tags, for resolving "#name" tokens (ADR: sigils, 2026-08-12). Same
  // shape as projects — id + title is all a match needs.
  const [tags, setTags] = useState<ProjectOpt[]>([]);
  const [qaHidden, setQaHidden] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [pickDate, setPickDate] = useState(false);
  const [priorityOpen, setPriorityOpen] = useState(false);
  // Tag + Person chips (Tyler, 2026-08-18): pick tags/persons without typing
  // the "#"/"@" sigils. Picked tags merge with "#" tokens on save; picked
  // persons ride the same `linked` list the "@" mentions use (related edges).
  const [pickedTags, setPickedTags] = useState<{ id: string | null; name: string }[]>([]);
  const [tagOpen, setTagOpen] = useState(false);
  const [tagQ, setTagQ] = useState("");
  // One picker serving every linkable-type chip (Person, Group, …): which type
  // is open and what's typed into it. It used to be three person-only states,
  // and adding Group beside it would have been a third copy of the same block
  // (Brandon, 2026-08-28 — "add groups just as easily as person").
  const [pick, setPick] = useState<{ type: string; q: string } | null>(null);
  const [pickHits, setPickHits] = useState<{ id: string; title: string }[]>([]);
  // The kebab (⋯): any OTHER custom property on the task type, set at creation.
  // Schema loads on first open; opened keys render small per-kind editors whose
  // values land in the POST's properties.
  const [moreOpen, setMoreOpen] = useState(false);
  const [taskSchema, setTaskSchema] = useState<PropertyDef[] | null>(null);
  const [openProps, setOpenProps] = useState<string[]>([]);
  const [extraProps, setExtraProps] = useState<Record<string, unknown>>({});
  const showAction = (id: string) => !qaHidden.has(id);
  // Two chip-row controls are placeholders with nothing wired behind them yet:
  // the "Rich editor" button (no canvas handoff) and the "Assignee" chip (the
  // @-assignee shortcut was retired; no dedicated picker exists). Deferred by
  // hiding until they do something (Brandon, 2026-06-21) — the code stays put and
  // still respects the Quick Add config (showAction) so flipping this to true
  // re-surfaces them cleanly. Non-functional controls shouldn't ship visible.
  const PLACEHOLDERS_READY = false;

  // "@"-mention linking (unified with the universal capture card): typing "@"
  // links this task to any existing item as a `related` edge (create-on-miss
  // included). The three sigils are deliberately one-concept-each (2026-08-12):
  //   "@" links to ANY existing item (an association)
  //   "#" tags        — tags only, creating the tag when it's new
  //   "+" project     — the destination, i.e. where the task is filed
  // (The old "@name = assignee" shortcut was retired here — a dedicated assignee
  // picker can hang off the Assignee chip later.)
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const descRef = useRef<HTMLTextAreaElement>(null);
  const { glyph, typeLabel } = useTypeGlyphs();
  const [caret, setCaret] = useState(0);
  const [selected, setSelected] = useState(0);
  const [creatingLink, setCreatingLink] = useState(false);
  const [dismissedQuery, setDismissedQuery] = useState<string | null>(null);
  const [linked, setLinked] = useState<LinkedItem[]>([]);
  // The type registry, for the create-on-miss rows (which types a bare unmatched
  // name can be created as). Memoized in type-token — one shared fetch.
  const [mTypes, setMTypes] = useState<TypeMeta[]>([]);

  useEffect(() => {
    void loadTypes().then(setMTypes);
    loadQuickAddHidden().then((ids) => setQaHidden(new Set(ids)));
    fetch("/api/items?type=project&limit=50")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setProjects(Array.isArray(d?.items) ? d.items : []))
      .catch(() => {});
    fetch(`/api/items?type=${TAG_TYPE}&limit=200`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setTags(Array.isArray(d?.items) ? d.items : []))
      .catch(() => {});
  }, []);

  // A pre-filled title's "@name" tokens (promotion): resolve each against an
  // exact title match and turn it into the same linked chip a picked mention
  // makes, stripping the token from the title. No match leaves the words alone
  // — the "+project" rule: never delete a word and do nothing in its place.
  useEffect(() => {
    const tokens = parseMentionTokens(initialTitle ?? "");
    if (tokens.length === 0) return;
    let live = true;
    void (async () => {
      for (const t of tokens) {
        const res = await fetch(
          `/api/items?q=${encodeURIComponent(t.name)}&limit=8`
        ).catch(() => null);
        if (!res || !res.ok || !live) continue;
        const d = (await res.json()) as { items: LinkedItem[] };
        const hit = (d.items ?? []).find(
          (i) => (i.title || "").trim().toLowerCase() === t.name.toLowerCase()
        );
        if (!hit || !live) continue;
        if (hit.type === TAG_TYPE) {
          setPickedTags((cur) =>
            cur.some((x) => x.name.toLowerCase() === hit.title.toLowerCase())
              ? cur
              : [...cur, { id: hit.id, name: hit.title }]
          );
        } else {
          setLinked((cur) =>
            cur.some((l) => l.id === hit.id)
              ? cur
              : [...cur, { id: hit.id, title: hit.title, type: hit.type ?? null }]
          );
        }
        setTitle((cur) => cur.split(t.token).join(" ").replace(/\s+/g, " ").trim());
      }
    })();
    return () => {
      live = false;
    };
    // Mount-only: initialTitle is the seed, not a controlled value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Link-chip typeahead: a small debounced search over items of the open chip's
  // type (person, group, …).
  useEffect(() => {
    if (!pick) return;
    const q = pick.q.trim();
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ type: pick.type, limit: "8" });
        if (q) params.set("q", q);
        const res = await fetch(`/api/items?${params}`, { signal: ctrl.signal });
        if (!res.ok) return;
        const d = (await res.json()) as { items: { id: string; title: string }[] };
        setPickHits(Array.isArray(d.items) ? d.items : []);
      } catch {
        // aborted or offline; the next keystroke retries
      }
    }, 150);
    return () => {
      ctrl.abort();
      clearTimeout(t);
    };
  }, [pick]);

  // Kebab: the task type's OTHER custom scalar properties (relation kinds have
  // their own chips/sigils; multi_select defers). Loaded on mount so the kebab
  // can HIDE entirely when there is nothing beyond the built-in chips to offer
  // (Tyler, 2026-08-18).
  useEffect(() => {
    fetch("/api/types/task")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const schema = Array.isArray(d?.type?.propertySchema) ? (d.type.propertySchema as PropertyDef[]) : [];
        setTaskSchema(schema.filter((pr) => pr.kind !== "relation" && pr.kind !== "multi_select"));
      })
      .catch(() => setTaskSchema([]));
  }, []);

  // Chip popovers (date / tag / person / kebab) dismiss on any outside click —
  // each wrapper wears data-chip-pop, so a click inside any of them survives.
  useEffect(() => {
    if (!pickDate && !tagOpen && !pick && !moreOpen) return;
    const onDown = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest?.("[data-chip-pop]")) return;
      setPickDate(false);
      setTagOpen(false);
      setPick(null);
      setMoreOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [pickDate, tagOpen, pick, moreOpen]);

  // Clicking anywhere OUTSIDE the card dismisses it, like Cancel (Tyler,
  // 2026-08-18 — "I expect both to work"). Chip popovers and portaled menus
  // don't count as outside.
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      // A mousedown on the "@" popup picks on MOUSEDOWN, which re-renders and
      // unmounts the popup before this document listener runs — the target is
      // then detached, contains() says "outside", and the whole card cancelled
      // out from under the pick. A detached target was inside something that
      // just closed; it is never an outside click.
      if (!t.isConnected) return;
      if (cardRef.current?.contains(t)) return;
      if (t.closest?.("[data-chip-pop],[data-row-menu]")) return;
      onCancel();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onCancel]);

  const mention = useMemo(() => detectMentionToken(title, caret), [title, caret]);
  const { hits, typeFilter, query: mQuery } = useMentionTypeahead(mention);
  const alreadyLinked = (id: string) => linked.some((l) => l.id === id);
  const visibleHits = hits.filter((h) => !alreadyLinked(h.id));
  const showCreate =
    mQuery !== "" && !hits.some((h) => h.title.trim().toLowerCase() === mQuery.toLowerCase());
  // One create row per type the name could be (lib/mention-create.ts); a scoped
  // "@/person Jane" yields exactly one, i.e. the pre-picker behavior.
  const mTargets = useMemo(
    () => (showCreate ? createTargets(mTypes, typeFilter) : []),
    [showCreate, mTypes, typeFilter]
  );
  const mRowCount = visibleHits.length + mTargets.length;
  const mDismissed = mention != null && dismissedQuery === mention.rawQuery;
  const mOpen = mention != null && !mDismissed && mRowCount > 0;
  const mSel = Math.min(selected, Math.max(0, mRowCount - 1));

  // Close any other open floating panel when this typeahead appears (open
  // transition only, so it doesn't re-fire per keystroke).
  useEffect(() => {
    if (mOpen) announceFloatingOpen("task-mention");
  }, [mOpen]);

  const preview = useMemo(() => (title.trim() ? parseTaskTitle(title, localTodayYmd()) : null), [title]);
  // +project-name → file the task under a matching project (Tyler, 2026-08-12).
  // This used to be "#project", but "#" now belongs to tags and only tags: a
  // hash reads as a tag to everyone outside Todoist, and one sigil can't mean two
  // things. Project keeps a typing shortcut on "+" alongside the destination
  // picker, which is unchanged.
  const projectMatch = useMemo(
    () => parseProjectToken(title, projects),
    [title, projects]
  );
  // #tag-name → tag the task. EVERY "#" token counts (a task can wear several),
  // and one that matches nothing is a tag to CREATE rather than a silent no-op —
  // the old behavior stripped an unmatched "#foo" out of the title and did
  // nothing, so typing "#outreach" quietly deleted the word (Tyler found this).
  // Matching is case-insensitive and exact-after-dash-expansion, unlike the
  // project's substring match: creating "outreach" when "Outreach 2026" exists
  // would be a duplicate the user didn't ask for.
  const tagMatches = useMemo(() => parseTagTokens(title, tags), [title, tags]);
  // @-mention tokens aren't highlighted in the mirror: they're consumed into
  // chips the instant you pick, so no persistent "@word" lingers in the text.
  const segments = useMemo(
    () => buildSegments(title, [
      ...(preview?.detections ?? []),
      ...(projectMatch ? [{ source: projectMatch.token }] : []),
      // Highlight every "#tag" token, matched or not — an about-to-be-created tag
      // should look as live as an existing one, since both act on submit.
      ...tagMatches.map((t) => ({ source: t.token })),
    ]),
    [title, preview, projectMatch, tagMatches]
  );

  // Effective dates: an explicit pick wins, then what was parsed from the title,
  // then the host's default (suppressed once the user clears). This is the single
  // source of truth for both the chip label and what create() saves.
  const effDue = due || preview?.dueDate || "";
  const effScheduled = scheduled || preview?.scheduledDate || "";
  const effDefault = !effDue && !effScheduled && !dateCleared ? (defaultDueYmd ?? "") : "";
  const dateLabel = useMemo(() => {
    const ymd = effDue || effScheduled || effDefault;
    if (!ymd) return null;
    if (ymd === localTodayYmd()) return "Today";
    const [y, m, d] = ymd.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  }, [effDue, effScheduled, effDefault]);
  // Detected recurrence has no chip of its own; it folds into the Date chip
  // (Todoist-style: a date with a repeat icon). The chip text shows both.
  const recurrenceLabel = useMemo(
    () => preview?.detections.find((d) => d.field === "recurrence")?.label ?? null,
    [preview]
  );
  // The Date chip combines date + recurrence ("Today · Weekly"); falls back to either alone.
  const scheduleLabel = [dateLabel, recurrenceLabel].filter(Boolean).join(" · ") || null;
  // Priority shown reflects a manual pick first, otherwise what was parsed from the title.
  const effUrgency = (urgency ?? preview?.urgency ?? null) as Priority | null;
  const pStyle = effUrgency ? priorityStyle(effUrgency) : null;
  // A "+project" in the title drives the destination directly; otherwise the manual pick.
  const effDest = projectMatch?.project?.id ?? dest;

  async function create() {
    const raw = title.trim();
    if (!raw || busy) return;
    await onBeforeCreate?.();
    const p = parseTaskTitle(raw, localTodayYmd());
    // Strip the sigil tokens that became structure — "#tag" and "+project" — since
    // each is now carried as a real relation rather than as words in the title.
    // "@" mentions are already consumed into chips, and a literal unmatched "@" the
    // user never picked stays as text.
    //
    // A "+project" that matched NOTHING keeps its text: stripping it would delete a
    // word and do nothing in its place, which is the exact silent-no-op bug this
    // change fixes. Unmatched "#tag" tokens are safe to strip because they DO act —
    // they create the tag below.
    const finalTitle = stripConsumedTokens(p.title || raw, tagMatches, projectMatch);
    // Subtask mode: the parent is the placement, so there is no destination —
    // except a "+project" the user actually typed, which becomes a plain
    // project relation below (stripping the token and doing nothing would be
    // the silent no-op the comment above warns about).
    const destId = parentId
      ? projectMatch?.project?.id ?? null
      : lockDestination && host
        ? host.id
        : projectMatch?.project?.id ?? dest;
    const dueDay = effDue || effDefault;
    const sched = effScheduled;
    const urg = urgency ?? p.urgency ?? null;
    const rec = p.recurrence ?? null;
    const body: Record<string, unknown> = { type: "task", title: finalTitle };
    if (parentId) body.parentId = parentId;
    if (destId === "inbox") body.inbox = true;
    if (dueDay) body.dueDate = `${dueDay}T00:00:00.000Z`;
    if (sched) body.scheduledDate = `${sched}T00:00:00.000Z`;
    if (urg != null) body.urgency = urg;
    const props: Record<string, unknown> = {};
    if (rec) props.recurrence = rec;
    // Kebab-opened custom properties: only committed values ride along.
    for (const [k, v] of Object.entries(extraProps)) {
      if (v !== "" && v != null) props[k] = v;
    }
    if (Object.keys(props).length) body.properties = props;
    if (description.trim()) body.body = { format: "markdown", text: description.trim() };

    // "#" tokens + Tag-chip picks, deduped by name (case-blind) so typing
    // "#prayer" AND picking "Prayer" can't double-tag or double-create.
    const pendingTags: { id: string | null; name: string }[] = [];
    for (const t of [
      ...tagMatches.map((t) => ({ id: t.tag?.id ?? null, name: t.name })),
      ...pickedTags,
    ]) {
      if (!pendingTags.some((x) => x.name.toLowerCase() === t.name.toLowerCase())) pendingTags.push(t);
    }

    // Every edge with a KNOWN target rides the create itself (`relateTo`,
    // ADR-202 addendum 5): the destination project, "@"-linked items, and
    // existing tags. The old follow-up POSTs swallowed failures — a task could
    // land without its project (Tyler hit exactly that on a record's full task
    // list) — and the offline outbox replayed the bare create with no edges at
    // all. Only brand-new tags still need the post-create flow (the tag has to
    // exist before it can be linked).
    const relateTo: { targetId: string; role?: string }[] = [];
    if (destId && destId !== "inbox") {
      relateTo.push({ targetId: destId, role: destId === host?.id ? host.role ?? "related" : "project" });
    }
    for (const l of linked) relateTo.push({ targetId: l.id, role: "related" });
    for (const t of pendingTags) {
      if (t.id) relateTo.push({ targetId: t.id, role: TAGS_ROLE });
    }
    if (relateTo.length > 0) body.relateTo = relateTo;
    // Promotion rides the same body through the meeting's route, which adds the
    // source anchor + the meeting's people on the server side.
    // ponytail: the offline outbox replays every capture to /api/items, so a
    // promotion queued while offline lands as a plain task; wire the outbox to
    // per-entry endpoints if that ever bites.
    if (createVia?.extra) Object.assign(body, createVia.extra);
    const newTags = pendingTags.filter((t) => t.id === null);

    // POST the task and wire up its destination/@-linked relations. Shared by
    // both paths below. Returns the created id so the optimistic path can settle
    // its provisional row into a real one (see onOptimisticSettle).
    const persist = async (): Promise<string> => {
      const res = await fetch(createVia?.url ?? "/api/items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(String(res.status));
      // Read the body unconditionally: it used to be parsed only when there were
      // relations to write, but the id is now always wanted, and a response body
      // can only be consumed once.
      const { item, relateErrors } = (await res.json()) as {
        item: { id: string };
        relateErrors?: string[];
      };
      // The server wrote the known edges with the create; say so if any failed
      // instead of silently shipping an unassociated task.
      if (relateErrors && relateErrors.length > 0) {
        showToast("Task created, but linking it failed");
      }
      if (newTags.length > 0) {
        const rel = (targetId: string, role: string) =>
          fetch(`/api/items/${item.id}/relations`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ targetId, role }),
          }).catch(() => {});
        // Brand-new "#tag"/picked tags → create the tag, then the `tags` edge.
        // Tags are created WITHOUT inbox:true (unlike the "@" create-on-miss
        // stub): a tag isn't an untriaged capture, it's a finished thing the
        // moment it's named. Sequential so two tokens naming the same new tag
        // in one submit can't race into duplicates.
        for (const t of newTags) {
          const tr = await fetch("/api/items", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: TAG_TYPE, title: t.name }),
          }).catch(() => null);
          if (!tr || !tr.ok) continue;
          const created = (await tr.json()) as { item?: { id?: string } };
          if (created.item?.id) await rel(created.item.id, TAGS_ROLE);
        }
      }
      return item.id;
    };

    if (onOptimisticAdd) {
      // Optimistic: paint the row and close the card now; POST behind it and let
      // a single coalesced refresh reconcile the real row in (matching how
      // completing already feels). A failure falls back to the offline outbox.
      // busy guards against a re-entrant submit (rapid double-Enter) in the tick
      // before onDone unmounts the card.
      setBusy(true);
      const tmpId = `tmp-${Date.now()}`;
      onOptimisticAdd({ id: tmpId, title: finalTitle, scheduleLabel });
      onDone();
      void persist()
        .then((realId) => {
          // The task is real NOW, ~150ms in — long before the coalesced refresh
          // brings the server row ~900ms later. Tell the host so the row stops
          // looking pending and picks up a working check circle; the refresh
          // then swaps in the server row invisibly instead of ending a wait.
          onOptimisticSettle?.(tmpId, realId);
          scheduleListRefresh(() => router.refresh());
        })
        .catch(() => {
          enqueueCapture(body);
          window.dispatchEvent(new Event("ledgr:outbox"));
          scheduleListRefresh(() => router.refresh());
        });
      return;
    }

    // Non-optimistic (modal / related panel): await, refresh, then close.
    setBusy(true);
    try {
      await persist();
      router.refresh();
      onDone();
    } catch {
      enqueueCapture(body);
      window.dispatchEvent(new Event("ledgr:outbox"));
      onDone();
    }
  }

  // --- "@"-mention helpers (parity with MentionTitleField) ---
  function syncCaret() {
    const el = titleRef.current;
    if (el) setCaret(el.selectionStart ?? 0);
  }
  function linkItem(item: MentionHit | LinkedItem) {
    if (!mention) return;
    // A tag picked via "@" is still a tag, not a link — route it into pickedTags
    // (same as the Tag chip) so it tags the task and renders as a hash chip,
    // instead of a big linked chip that doesn't actually tag anything (Brandon,
    // 2026-08-29 bug report).
    if (item.type === TAG_TYPE) {
      setPickedTags((cur) =>
        cur.some((t) => t.name.toLowerCase() === item.title.toLowerCase())
          ? cur
          : [...cur, { id: item.id, name: item.title }]
      );
    } else if (!alreadyLinked(item.id)) {
      setLinked([...linked, { id: item.id, title: item.title, type: item.type }]);
    }
    const { text, caret: nextCaret } = consumeMentionText(title, mention.start, caret);
    setTitle(text);
    setDismissedQuery(null);
    setSelected(0);
    requestAnimationFrame(() => {
      const el = titleRef.current;
      if (el) { el.focus(); el.setSelectionRange(nextCaret, nextCaret); setCaret(nextCaret); }
    });
  }
  // Create as the picked type, then link it like any other hit. A null return
  // means the POST failed: the "@query" text stays so it isn't lost.
  async function createAndLink(target: CreateTarget) {
    if (creatingLink || !mQuery) return;
    setCreatingLink(true);
    const made = await createMentionTarget(mQuery, target);
    setCreatingLink(false);
    if (made) linkItem({ id: made.id, title: made.title, type: made.type });
  }
  function pickSelected() {
    if (mSel < visibleHits.length) linkItem(visibleHits[mSel]);
    else {
      const target = mTargets[mSel - visibleHits.length];
      if (target) void createAndLink(target);
    }
  }
  function onTitleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (mOpen) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSelected((mSel + 1) % mRowCount); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSelected((mSel - 1 + mRowCount) % mRowCount); return; }
      if (e.key === "Enter") { e.preventDefault(); pickSelected(); return; }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setDismissedQuery(mention?.rawQuery ?? null); return; }
    }
    // "/" at a word boundary hands off to the description (Tyler, 2026-08-18):
    // type the title, hit "/", keep typing — the rest lands in the task's body.
    // Word-boundary only, so "9/13" and "https://…" never trigger it.
    if (e.key === "/" && !mOpen) {
      const el = e.currentTarget;
      const at = el.selectionStart ?? 0;
      const before = at === 0 ? " " : el.value[at - 1];
      if (/\s/.test(before)) {
        e.preventDefault();
        setShowDesc(true);
        requestAnimationFrame(() => descRef.current?.focus());
        return;
      }
    }
    if (e.key === "Enter") { e.preventDefault(); void create(); }
    if (e.key === "Escape") onCancel();
  }

  // The linkable-type chips. Person is always offered; Group only where the
  // instance has a group type (ADR-144 creates it per-instance via
  // scripts/setup-groups.mts), so this file stays instance-agnostic and the
  // chip can't point at a type that isn't there.
  const linkChips = [
    { type: "person", label: "Person", action: "person", icon: IconUser },
    { type: GROUP_TYPE, label: "Group", action: "group", icon: IconGroup },
  ].filter(
    (lc) =>
      showAction(lc.action) &&
      (lc.type === "person" || mTypes.some((t) => t.key === lc.type))
  );

  const chip = "flex items-center gap-1.5 rounded-md border border-neutral-700 px-2 py-1 text-sm text-neutral-300 hover:border-neutral-600";
  const destProject = projects.find((p) => p.id === effDest);

  return (
    <div ref={cardRef} className="rounded-xl border border-neutral-700 bg-neutral-900 p-3 shadow-lg shadow-black/40">
      {/* title + top-right toggles */}
      <div className="flex items-start gap-2">
        {/* The title wraps to multiple lines as it grows: a textarea overlays an
            in-flow mirror that holds the SAME wrapped text, so the mirror defines
            the height (the textarea fills it, no JS resize) and the highlight stays
            character-aligned. Both share identical typography + wrapping. */}
        <div className="relative min-w-0 flex-1">
          <div aria-hidden className="pointer-events-none min-h-6 whitespace-pre-wrap break-words text-base font-medium leading-6 text-transparent">
            {segments.length === 0
              ? " "
              : segments.map((s, i) =>
                  // px adds the padding "around" the detected word; the matching -mx
                  // pulls layout back so the mirror stays aligned with the textarea
                  // (the bg just bleeds past the text). Kept to ~1.5px so two adjacent
                  // tokens ("Saturday" + "every week") leave a visible gap rather than
                  // merging. py rounds it into a pill.
                  // color is INLINE, not `text-transparent`: globals.css paints every
                  // <mark> bright (`mark { color: var(--mark-ink) }`, ADR-251) from an
                  // unlayered rule, which beats any Tailwind utility regardless of
                  // specificity. Without this the mirror's word shows through the
                  // textarea as doubled white text (the recurring "quick add" glitch).
                  s.hl ? <mark key={i} style={{ color: "transparent" }} className="rounded px-[1.5px] py-0.5 -mx-[1.5px] bg-[var(--accent)]/35">{s.text}</mark> : <span key={i}>{s.text}</span>
                )}
          </div>
          <textarea
            ref={titleRef}
            autoFocus={autoFocus}
            rows={1}
            value={title}
            onChange={(e) => { setTitle(e.target.value); setCaret(e.target.selectionStart ?? 0); setSelected(0); setDismissedQuery(null); }}
            // Enter submits (no newlines in a title) unless the "@" picker is open
            // (then Enter picks); Escape closes the picker first, else cancels.
            onKeyDown={onTitleKeyDown}
            onKeyUp={syncCaret}
            onClick={syncCaret}
            onSelect={syncCaret}
            onBlur={() => setDismissedQuery(mention?.rawQuery ?? null)}
            placeholder="Task name"
            aria-label="Task name"
            className="absolute inset-0 h-full w-full resize-none overflow-hidden whitespace-pre-wrap break-words border-0 bg-transparent p-0 text-base font-medium leading-6 text-neutral-100 outline-none placeholder:text-neutral-500"
          />
          {mOpen && (
            <MentionPopup
              hits={visibleHits}
              selected={mSel}
              createTargets={mTargets}
              creating={creatingLink}
              query={mQuery}
              typeFilter={typeFilter}
              onHover={setSelected}
              onPick={linkItem}
              onCreate={(target) => void createAndLink(target)}
              glyph={glyph}
              typeLabel={typeLabel}
            />
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1 text-neutral-500">
          <button type="button" title="Toggle description" aria-label="Toggle description" onClick={() => setShowDesc((v) => !v)} className="rounded p-1 hover:bg-neutral-800 hover:text-neutral-300">{IconDescription}</button>
          {PLACEHOLDERS_READY && (
            <button type="button" title="Rich editor" aria-label="Rich editor" className="rounded p-1 hover:bg-neutral-800 hover:text-neutral-300">{IconCanvas}</button>
          )}
        </div>
      </div>

      {(showDesc || description) && (
        // A textarea, not an input: promoted lines bring their sub-bullets in as
        // real markdown lines. Enter makes a newline here (the title field is
        // where Enter submits); Cmd/Ctrl+Enter still submits from the field.
        <textarea
          ref={descRef}
          value={description}
          rows={Math.min(8, description.split("\n").length || 1)}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void create(); }
            if (e.key === "Escape") onCancel();
          }}
          placeholder="Description"
          aria-label="Description"
          className="mt-1 w-full resize-y bg-transparent text-sm text-neutral-300 outline-none placeholder:text-neutral-600"
        />
      )}

      {/* "@"-linked items → become `related` relations on save */}
      <LinkedChips linked={linked} onRemove={(id) => setLinked(linked.filter((l) => l.id !== id))} glyph={glyph} />

      {/* Pending "#tag" tokens, shown as chips so the typed sigil has a visible
          consequence before you submit — and so a NEW tag announces itself as new
          rather than silently appearing in your tag list afterwards. This is the
          legibility half of the fix: the old "#" ate the word with no feedback at
          all. Read-only chips (edit the text to change them). */}
      {(tagMatches.length > 0 || pickedTags.length > 0) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {tagMatches.map((t) => (
            <span
              key={t.token}
              className="inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-xs text-ink-muted"
              title={t.tag ? `Existing tag "${t.name}"` : `Creates a new tag "${t.name}"`}
            >
              <span className="text-ink-faint">{IconHash}</span>
              {t.name}
              {!t.tag && <span className="text-[var(--accent)]">new</span>}
            </span>
          ))}
          {pickedTags.map((t) => (
            <span
              key={`picked-${t.name}`}
              className="inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-xs text-ink-muted"
              title={t.id ? `Existing tag "${t.name}"` : `Creates a new tag "${t.name}"`}
            >
              <span className="text-ink-faint">{IconHash}</span>
              {t.name}
              {!t.id && <span className="text-[var(--accent)]">new</span>}
              <button
                type="button"
                aria-label={`Remove tag ${t.name}`}
                onClick={() => setPickedTags((cur) => cur.filter((x) => x.name !== t.name))}
                className="text-neutral-500 hover:text-red-400"
              >
                {IconX}
              </button>
            </span>
          ))}
        </div>
      )}

      {/* SVG chip row — detected date/recurrence/priority/project fill these in */}
      <div className="mt-2 flex flex-wrap items-center gap-2 border-b border-neutral-800 pb-3">
        {showAction("deadline") && (
          <span className="relative" data-chip-pop>
            <button type="button" className={`${chip} ${scheduleLabel ? "text-[var(--accent)]" : ""}`} onClick={() => setPickDate((v) => !v)}>
              {recurrenceLabel ? IconRepeat : IconCalendar} {scheduleLabel ?? "Date"}
              {scheduleLabel && (
                <span role="button" aria-label="Clear date" onClick={(e) => { e.stopPropagation(); setDue(""); setScheduled(""); setDateCleared(true); }} className="text-neutral-500 hover:text-neutral-200">{IconX}</span>
              )}
            </button>
            {/* The same Todoist-shaped picker the task rows use (quick picks +
                month grid + free text) — one date UI everywhere. */}
            {pickDate && (
              <span className="absolute left-0 top-full z-20 mt-1 block max-h-[70vh] w-72 overflow-y-auto rounded-lg border border-neutral-700 bg-neutral-900 p-2 shadow-xl shadow-black/50">
                <DayPickerPanel
                  valueYmd={due || null}
                  today={localTodayYmd()}
                  onPick={(ymd) => {
                    if (ymd) { setDue(ymd); setDateCleared(false); } else { setDue(""); setScheduled(""); setDateCleared(true); }
                    setPickDate(false);
                  }}
                />
              </span>
            )}
          </span>
        )}
        {showAction("priority") && (
          // A button + popover, same shape as the Date/Tag/Person chips (not a
          // native <select>): a <select> with appearance-none + an overlaid icon
          // doesn't fully suppress native chrome on every browser, which read as
          // the flag rendering in its own separate box next to "P3" — a visual
          // split with no code-visible cause until the control itself stopped
          // being native.
          <span className="relative" data-chip-pop>
            <button
              type="button"
              onClick={() => setPriorityOpen((v) => !v)}
              // Text + border take the priority color (P2 gold, P3 purple…); the
              // neutral defaults are only applied when no priority is set, so they
              // never fight the colored classes (Tailwind has no order guarantee).
              className={`${chip} ${pStyle ? `${pStyle.text} ${pStyle.border}` : ""}`}
            >
              {IconFlag} {pStyle ? pStyle.label : "Priority"}
            </button>
            {priorityOpen && (
              <span className="absolute left-0 top-full z-10 mt-1 flex w-28 flex-col rounded border border-neutral-700 bg-neutral-900 p-1 shadow-lg shadow-black/40">
                {PRIORITIES.map((u) => {
                  const s = priorityStyle(u);
                  return (
                    <button
                      key={u}
                      type="button"
                      onClick={() => { setUrgency(u); setPriorityOpen(false); }}
                      className={`flex items-center rounded px-2 py-1 text-left text-sm hover:bg-neutral-800 ${s.text}`}
                    >
                      {s.label}
                    </button>
                  );
                })}
                {effUrgency != null && (
                  <button
                    type="button"
                    onClick={() => { setUrgency(null); setPriorityOpen(false); }}
                    className="mt-1 flex items-center rounded border-t border-neutral-800 px-2 py-1 pt-2 text-left text-sm text-neutral-500 hover:bg-neutral-800"
                  >
                    Clear
                  </button>
                )}
              </span>
            )}
          </span>
        )}
        {/* Tag chip (Tyler, 2026-08-18): pick from existing tags (the 200 the
            token matcher already loads) or create one, without typing "#". */}
        {showAction("tags") && (
          <span className="relative" data-chip-pop>
            <button type="button" className={chip} onClick={() => { setTagOpen((v) => !v); setTagQ(""); }}>
              {IconHash} Tag
            </button>
            {tagOpen && (
              <span className="absolute left-0 top-full z-10 mt-1 flex w-56 flex-col rounded border border-neutral-700 bg-neutral-900 p-1 shadow-lg shadow-black/40">
                <input
                  autoFocus
                  value={tagQ}
                  onChange={(e) => setTagQ(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Escape") setTagOpen(false); }}
                  placeholder="Search tags…"
                  aria-label="Search tags"
                  className="mb-1 w-full rounded border border-neutral-700 bg-transparent px-2 py-1 text-sm text-neutral-200 outline-none placeholder:text-neutral-600 focus:border-neutral-500"
                />
                <span className="max-h-44 overflow-y-auto">
                  {tags
                    .filter((t) => t.title.toLowerCase().includes(tagQ.trim().toLowerCase()))
                    .filter((t) => !pickedTags.some((x) => x.name.toLowerCase() === t.title.toLowerCase()))
                    .slice(0, 8)
                    .map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => { setPickedTags((cur) => [...cur, { id: t.id, name: t.title }]); setTagOpen(false); }}
                        className="flex w-full items-center rounded px-2 py-1 text-left text-sm text-neutral-300 hover:bg-neutral-800"
                      >
                        {t.title || "Untitled"}
                      </button>
                    ))}
                  {tagQ.trim() !== "" &&
                    !tags.some((t) => t.title.trim().toLowerCase() === tagQ.trim().toLowerCase()) && (
                      <button
                        type="button"
                        onClick={() => { setPickedTags((cur) => [...cur, { id: null, name: tagQ.trim() }]); setTagOpen(false); }}
                        className="flex w-full items-center gap-1 rounded px-2 py-1 text-left text-sm hover:bg-neutral-800"
                      >
                        <span className="text-neutral-400">Create</span>
                        <span className="min-w-0 flex-1 truncate text-neutral-100">“{tagQ.trim()}”</span>
                      </button>
                    )}
                </span>
              </span>
            )}
          </span>
        )}
        {/* Person / Group chips: attach an item (a `related` edge — the same list
            the "@" mention writes, so LinkedChips shows and removes them). Group
            only appears on an instance that HAS a group type (ADR-144 creates it
            per-instance), so this stays instance-agnostic. */}
        {linkChips.map((lc) => (
          <span key={lc.type} className="relative" data-chip-pop>
            <button type="button" className={chip} onClick={() => setPick((cur) => (cur?.type === lc.type ? null : { type: lc.type, q: "" }))}>
              {lc.icon} {lc.label}
            </button>
            {pick?.type === lc.type && (
              <span className="absolute left-0 top-full z-10 mt-1 flex w-56 flex-col rounded border border-neutral-700 bg-neutral-900 p-1 shadow-lg shadow-black/40">
                <input
                  autoFocus
                  value={pick.q}
                  onChange={(e) => setPick({ type: lc.type, q: e.target.value })}
                  onKeyDown={(e) => { if (e.key === "Escape") setPick(null); }}
                  placeholder={`Search ${lc.label.toLowerCase()}…`}
                  aria-label={`Search ${lc.label.toLowerCase()}`}
                  className="mb-1 w-full rounded border border-neutral-700 bg-transparent px-2 py-1 text-sm text-neutral-200 outline-none placeholder:text-neutral-600 focus:border-neutral-500"
                />
                <span className="max-h-44 overflow-y-auto">
                  {pickHits
                    .filter((h) => !alreadyLinked(h.id))
                    .map((h) => (
                      <button
                        key={h.id}
                        type="button"
                        onClick={() => { setLinked((cur) => [...cur, { id: h.id, title: h.title, type: lc.type }]); setPick(null); }}
                        className="flex w-full items-center rounded px-2 py-1 text-left text-sm text-neutral-300 hover:bg-neutral-800"
                      >
                        {h.title || "Untitled"}
                      </button>
                    ))}
                  {pickHits.length === 0 && (
                    <span className="block px-2 py-1 text-xs text-neutral-600">No matches.</span>
                  )}
                </span>
              </span>
            )}
          </span>
        ))}
        {/* Assignee is kept as a placeholder chip (defer-by-hiding): assign-by-@
            was retired when "@" became a generic link, and a dedicated picker
            can hang off this chip later. Config-hideable via Quick Add. */}
        {PLACEHOLDERS_READY && showAction("assignee") && (
          <span className={chip} title="Assignee (dedicated picker coming soon)">
            {IconUser} Assignee
          </span>
        )}
        {/* The kebab (Tyler, 2026-08-18): every OTHER custom property the task
            type carries, settable at creation. Hidden entirely when the type has
            nothing beyond the built-in chips; the h-5 content line matches the
            text chips' height. */}
        {taskSchema != null && taskSchema.length > 0 && (
        <span className="relative" data-chip-pop>
          <button type="button" className={chip} onClick={() => setMoreOpen((v) => !v)} title="More properties" aria-label="More properties">
            <span className="flex h-5 items-center">{IconDots}</span>
          </button>
          {moreOpen && (
            <span className="absolute left-0 top-full z-10 mt-1 flex w-56 flex-col rounded border border-neutral-700 bg-neutral-900 p-1 shadow-lg shadow-black/40">
              {taskSchema.filter((pr) => !openProps.includes(pr.key)).length === 0 ? (
                <span className="block px-2 py-1 text-xs text-neutral-600">
                  Every property is already shown.
                </span>
              ) : (
                taskSchema
                  .filter((pr) => !openProps.includes(pr.key))
                  .map((pr) => (
                    <button
                      key={pr.key}
                      type="button"
                      onClick={() => { setOpenProps((cur) => [...cur, pr.key]); setMoreOpen(false); }}
                      className="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-sm text-neutral-300 hover:bg-neutral-800"
                    >
                      {pr.label}
                      <span className="text-xs text-neutral-600">{pr.kind}</span>
                    </button>
                  ))
              )}
            </span>
          )}
        </span>
        )}
      </div>

      {/* Kebab-opened property editors: one compact labelled control per opened
          key; the value rides the POST's properties. */}
      {openProps.length > 0 && taskSchema && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {openProps.map((key) => {
            const def = taskSchema.find((pr) => pr.key === key);
            if (!def) return null;
            const val = extraProps[key];
            const set = (v: unknown) => setExtraProps((cur) => ({ ...cur, [key]: v }));
            const drop = () => {
              setOpenProps((cur) => cur.filter((k) => k !== key));
              setExtraProps((cur) => { const next = { ...cur }; delete next[key]; return next; });
            };
            const box = "rounded border border-neutral-700 bg-transparent px-2 py-0.5 text-sm text-neutral-200 outline-none focus:border-neutral-500";
            return (
              <span key={key} className="inline-flex items-center gap-1.5 text-sm text-neutral-400">
                {def.label}
                {def.kind === "date" ? (
                  <DateInput
                    value={typeof val === "string" ? val.slice(0, 10) : null}
                    onCommit={(ymd) => set(`${ymd}T00:00:00.000Z`)}
                    ariaLabel={def.label}
                    className={box}
                  />
                ) : def.kind === "checkbox" ? (
                  <input
                    type="checkbox"
                    checked={val === true}
                    onChange={(e) => set(e.target.checked)}
                    aria-label={def.label}
                    className="accent-[var(--accent)]"
                  />
                ) : def.kind === "select" ? (
                  <select value={typeof val === "string" ? val : ""} onChange={(e) => set(e.target.value)} aria-label={def.label} className={box}>
                    <option value="">—</option>
                    {(def.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : (
                  <input
                    type={def.kind === "number" ? "number" : "text"}
                    value={typeof val === "string" || typeof val === "number" ? String(val) : ""}
                    onChange={(e) => set(def.kind === "number" ? (e.target.value === "" ? "" : Number(e.target.value)) : e.target.value)}
                    aria-label={def.label}
                    className={`${box} w-36`}
                  />
                )}
                <button type="button" aria-label={`Remove ${def.label}`} onClick={drop} className="text-neutral-600 hover:text-red-400">{IconX}</button>
              </span>
            );
          })}
        </div>
      )}

      {/* footer: destination + actions. When the destination is locked to the
          host (a project's Tasks card), the picker is hidden and the actions get
          the full row. */}
      <div className={`mt-3 flex items-center gap-2 ${lockDestination || parentId ? "justify-end" : "justify-between"}`}>
        {/* min-w-0 + w-full: a <select> is as wide as its LONGEST option, so one
            long project title used to push Cancel/Add past the card edge. Now the
            picker takes the free space and the buttons never move. */}
        {!lockDestination && !parentId && (
          <span className="relative inline-flex min-w-0 flex-1 items-center text-sm text-neutral-300">
            <span className="pointer-events-none absolute left-1.5 text-neutral-500">{destProject ? IconPlus : IconInbox}</span>
            <select
              value={effDest}
              onChange={(e) => setDest(e.target.value)}
              disabled={!!projectMatch?.project}
              aria-label="Destination"
              className="w-full min-w-0 appearance-none truncate rounded-md bg-transparent py-1 pl-7 pr-5 text-sm text-neutral-300 outline-none disabled:opacity-100"
            >
              {host && host.role !== "project" && <option value={host.id}>{host.label}</option>}
              <option value="inbox">Inbox</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.title || "Untitled project"}</option>)}
            </select>
            <span className="pointer-events-none absolute right-0 text-neutral-500">{IconChevron}</span>
          </span>
        )}
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" onClick={onCancel} className="rounded-md bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700">Cancel</button>
          <button type="button" disabled={!title.trim() || busy} onClick={() => void create()} className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white hover:brightness-110 disabled:opacity-40">
            {busy ? "Adding…" : submitLabel ?? (parentId ? "Add subtask" : "Add task")}
          </button>
        </div>
      </div>
    </div>
  );
}
