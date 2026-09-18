// Create-on-miss: what "@Jake Tourtillott" makes when nothing matches.
//
// The rule (Tyler, 2026-08-12): *a user shouldn't be able to create something
// that isn't connected to anything, so if the system can't tell what it should
// be, the system should just ask.* So a create-on-miss row is no longer a single
// blind "Create" that mints an `unmarked` stub — it's a small set of TYPED create
// rows, and picking one is the answer to the question.
//
// This module is the single definition of that row set and of the POST behind it,
// because there are FIVE surfaces that create-on-miss and they used to each carry
// their own copy of the same fetch (and had already drifted on the `inbox` flag):
//
//   1. the body editor's "@" picker      (markdown-editor/mention-suggestion.ts)
//   2. the capture title's "@" picker    (capture/MentionTitleField.tsx)
//   3. the task-add card's "@" picker    (tasks/AddTaskCard.tsx)
//   4. the generic "+ Relate" box        (relations/AddRelation.tsx)
//   5. a null-targetType relation field  (relations/RelationField.tsx)
//
// Fixing one and not the others would leave four still minting `unmarked` stubs,
// i.e. the exact inconsistency the change is for — hence one shared module rather
// than five edits.
//
// Supersedes the create half of ADR-067's `unmarked` placeholder decision: the
// placeholder still EXISTS and is still reachable (it's the "Unsorted" escape
// hatch below, and quick-capture still files straight to it), it just stops being
// the silent default for a name the system could have asked about.
"use client";

import type { TypeMeta } from "@/components/search/type-token";

// One create row: the type an unmatched name would become, as the picker shows it.
export type CreateTarget = {
  key: string;
  // What the row says on its right edge ("Person", "Project", "Unsorted").
  label: string;
  // The type's configured nav icon, for the row glyph. null takes nav-icons'
  // generic fallback, which is what the `unmarked` placeholder wants anyway.
  icon: string | null;
};

// The escape hatch, and the one target that isn't resolved from the registry:
// `unmarked` is a HIDDEN type, so /api/types never returns it. "Unsorted" is the
// word the capture card's type picker already uses for it (CaptureCard.tsx) — the
// key is code-facing and the user should never read it.
export const UNSORTED_TARGET: CreateTarget = {
  key: "unmarked",
  label: "Unsorted",
  icon: null,
};

// The types offered by name, in order, when nothing narrows the query. Person is
// first because a bare unmatched name is overwhelmingly a person; project second
// because it's the other thing you type into being mid-sentence. Anything else is
// reachable by scoping the query instead ("@/song Cornerstone"), which is why
// this list stays SHORT — three rows is a choice, ten is a menu to read.
//
// A key missing from this instance's registry is skipped, not rendered dead, so
// an instance without a `project` type simply offers person + Unsorted.
const PREFERRED_CREATE_TYPES = ["person", "project"];

// The create rows to offer. `scoped` is the active "/type" token (or the relation
// field's declared targetType) — when the query already names a type there is
// nothing to ask, so the answer is that one row and the picker looks exactly like
// it did before this change.
export function createTargets(
  types: TypeMeta[],
  scoped: TypeMeta | null
): CreateTarget[] {
  if (scoped) {
    return [{ key: scoped.key, label: scoped.label, icon: scoped.icon }];
  }
  const preferred = PREFERRED_CREATE_TYPES.flatMap((key) => {
    const t = types.find((m) => m.key === key);
    return t ? [{ key: t.key, label: t.label, icon: t.icon }] : [];
  });
  return [...preferred, UNSORTED_TARGET];
}

// Whether a create target still needs triage in the Inbox. Only the catch-all
// does: once the user has NAMED the type, the item has a title, a type, and (at
// every one of the five call sites) a relation the moment it's made — there is
// nothing left for triage to decide.
//
// This also settles a pre-existing disagreement between the five sites: the three
// "@" pickers used to send inbox:true even for a scoped "@/person Jane", while
// RelationField sent inbox:!targetType. One rule now, in one place — flip this
// one expression to change every surface.
export function needsTriage(target: CreateTarget): boolean {
  return target.key === UNSORTED_TARGET.key;
}

export type CreatedItem = { id: string; title: string; type: string | null };

// POST the new item. Returns null on any failure (offline, 4xx, malformed) so
// every caller can leave the typed text in place and let the user retry — losing
// what they typed is worse than not creating.
export async function createMentionTarget(
  title: string,
  target: CreateTarget
): Promise<CreatedItem | null> {
  try {
    const res = await fetch("/api/items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: target.key,
        title,
        // The catch-all names its arrival path and lets the owner's Capture
        // routing place it (ADR-249). A SCOPED create is not a capture at all,
        // so it keeps saying "filed" outright: an explicit inbox always beats
        // the setting, which is what keeps "@/person Jane" behaving as it did.
        ...(needsTriage(target) ? { source: "mention_create" } : { inbox: false }),
      }),
    });
    if (!res.ok) return null;
    const { item } = (await res.json()) as {
      item?: { id?: string; title?: string; type?: string | null };
    };
    if (!item?.id) return null;
    return {
      id: item.id,
      title: item.title || title,
      type: item.type ?? target.key,
    };
  } catch {
    return null;
  }
}

// The row's main text. The typed name is the subject, the type is the right-edge
// label (createTargets' `label`) — so three stacked rows read as one question
// with three answers rather than three unrelated commands.
export function createRowText(query: string, creating: boolean): string {
  return creating ? `Creating “${query}”…` : `Create “${query}”`;
}
