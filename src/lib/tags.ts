// The tags vocabulary, in one place (Tyler, 2026-08-12).
//
// Tagging is not its own mechanism: a tag is an ordinary item of the `tag` type,
// and tagging something is a `relations` edge pointing at it with role "tags"
// (ADR-094 E2, over ADR-067's typed relation kind). Both strings were previously
// literals living only in `drizzle/0028_tag_type_and_tags_field.sql` and
// `scripts/seed.mjs`, so every reader open-coded them. They're a contract between
// the migration, the seed, and now the read path, which is exactly the kind of
// thing that drifts silently — so they get a name.
//
// Deliberately tiny and dependency-free: it's imported by both server reads and
// client components, so it must not pull in the db.

// The `relations.role` used by the built-in Tags field. This is also the field's
// `key` in a type's property_schema — for a typed relation property the role IS
// the key (schema.md, `relations.role`), which is why one constant covers both.
export const TAGS_ROLE = "tags";

// The item type a tag is. `is_system = false` on purpose: the owner can rename it
// to "Topic", or delete it when unused, like any other type.
export const TAG_TYPE = "tag";

// --- quick-add sigils ------------------------------------------------------
// One concept per sigil (Tyler, 2026-08-12): "@" links to any existing item, "#"
// tags, "+" files under a project. Pure so it can be tested — the previous
// version of this logic lived inline in AddTaskCard and shipped a silent bug
// (an unmatched "#foo" was stripped from the title and did nothing), which is
// exactly the kind of thing a test catches and a code read doesn't.

export type NamedItem = { id: string; title: string };

export type TagToken = {
  // The literal matched text, e.g. "#fall-retreat" — used to strip it from the title.
  token: string;
  // The human name, dashes expanded: "fall retreat".
  name: string;
  // The existing tag it resolves to, or null when it should be created.
  tag: NamedItem | null;
};

// Every distinct "#tag" in the text. Dashes become spaces, matching is
// case-insensitive and EXACT (not substring, unlike a project): creating
// "outreach" when "Outreach 2026" exists would be a duplicate nobody asked for.
// Duplicates within one string collapse, so "#a #a" is one tag.
export function parseTagTokens(text: string, tags: NamedItem[]): TagToken[] {
  const out: TagToken[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/#([\w-]+)/g)) {
    const name = m[1].replace(/-/g, " ").trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push({
      token: m[0],
      name,
      tag: tags.find((t) => (t.title || "").trim().toLowerCase() === key) ?? null,
    });
  }
  return out;
}

// The first "+project" in the text, resolved against existing projects. Substring
// matching is deliberate here (typing "+fall" should find "Fall Retreat 2026") —
// a project is picked from a known set, never created by this sigil, so a loose
// match costs nothing.
export function parseProjectToken(
  text: string,
  projects: NamedItem[]
): { token: string; project: NamedItem | null } | null {
  const m = text.match(/\+([\w-]+)/);
  if (!m) return null;
  const q = m[1].replace(/-/g, " ").toLowerCase();
  return {
    token: m[0],
    project: projects.find((p) => (p.title || "").toLowerCase().includes(q)) ?? null,
  };
}

// The title with the tokens that BECAME STRUCTURE removed. A "+project" that
// matched nothing keeps its text: stripping it would delete a word and do nothing
// in its place (the original bug). Unmatched "#tag" tokens ARE stripped, because
// they do act — the tag gets created.
export function stripConsumedTokens(
  title: string,
  tagTokens: TagToken[],
  projectToken: { token: string; project: NamedItem | null } | null
): string {
  const consumed = [
    ...tagTokens.map((t) => t.token),
    ...(projectToken?.project ? [projectToken.token] : []),
  ];
  let out = title;
  for (const tok of consumed) out = out.split(tok).join(" ");
  return out.replace(/\s+/g, " ").trim();
}

// Every distinct "@name" in a PRE-FILLED title (the promote-to-task flow). The
// typed capture consumes an "@" the moment you pick a row from the typeahead,
// but text that arrives already written never had a pick — so a promoted line's
// "@Roger" would otherwise stay as literal words and link nothing. Same rules as
// "#": one token, dashes expand to spaces, matching is exact and case-blind
// (resolved by the caller against a search). Multi-word names are written
// "@Elder-Board", the way a multi-word tag is.
export function parseMentionTokens(text: string): { token: string; name: string }[] {
  const out: { token: string; name: string }[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/(?:^|\s)(@([\w-]+))/g)) {
    const name = m[2].replace(/-/g, " ").trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push({ token: m[1], name });
  }
  return out;
}
