// Search box + results (PRD §4.2, fuzzy mode ADR-172). Client-side: keystrokes
// debounce into GET /api/search (aborting the stale request), filters are plain
// controls, result titles open the item canvas modal like any list row. The
// [[..]] snippet markers from ts_headline render as <mark>.
//
// Two modes on one page. The plain box is the default and behaves exactly as it
// always has. "Tune" expands the fuzzy panel (ADR-172): stack up whatever you
// half-remember, set how sure you are about EACH piece separately, and results
// rank by the weighted total instead of being filtered down to nothing. Hidden
// behind the toggle rather than always-on, per the defer-by-hiding standard — the
// simple path never gets heavier.
"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { parseTypeToken } from "@/components/search/type-token";
import { parseFuzzyWhen } from "@/lib/nl-date";
import { pushSearchHistory, readSearchHistory } from "@/lib/search-history";

type Option = { value: string; label: string };

// The API's JSON shape, dates as strings; only the fields the rows render.
type ResultRow = {
  id: string;
  type: string;
  title: string;
  updatedAt: string;
  snippet: string | null;
  // Fuzzy mode only: per-criterion contributions, in the order the criteria were
  // sent, so a row can explain itself without a second round trip.
  contribs?: number[];
};

const dateFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

// Three stops, not a 1-10 scale: the numbers would be false precision nobody
// calibrates consistently. The stored value is the WORD, so the weights and
// curves behind it stay tunable without invalidating a saved search URL.
const STOPS = ["might", "probably", "sure"] as const;
type Stop = (typeof STOPS)[number];
const STOP_LABEL: Record<Stop, string> = {
  might: "Might",
  probably: "Probably",
  sure: "Sure",
};

type TermRow = { id: number; value: string; stop: Stop };
// A tag criterion: which select field, which of its values, how sure.
type TagRow = { id: number; key: string; value: string; stop: Stop };

function Snippet({ text }: { text: string }) {
  const parts = text.split(/\[\[(.*?)\]\]/g);
  return (
    <p className="mt-0.5 truncate text-xs text-neutral-500">
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark
            key={i}
            className="rounded bg-amber-400/20 px-0.5 text-amber-200"
          >
            {part}
          </mark>
        ) : (
          part
        )
      )}
    </p>
  );
}

const selectClass =
  "rounded border border-neutral-800 bg-neutral-900 px-1.5 py-1 text-xs text-neutral-300 outline-none focus:border-neutral-600";

// The confidence dial. For a date this bends how sharply the score falls off; for
// a word/type/person, "Sure" makes it a real filter and the lower stops boost
// without excluding. Titled so the difference is discoverable, per the
// scope-the-UI rule (no unexplained bespoke control).
function StopPicker({
  value,
  onChange,
  hint,
}: {
  value: Stop;
  onChange: (s: Stop) => void;
  hint: string;
}) {
  return (
    <div
      className="inline-flex overflow-hidden rounded border border-line"
      role="group"
      aria-label={`Confidence: ${hint}`}
      title={hint}
    >
      {STOPS.map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => onChange(s)}
          aria-pressed={value === s}
          className={`border-r border-line px-2 py-1 text-xs last:border-r-0 ${
            value === s
              ? "bg-surface-2 font-semibold text-ink"
              : "text-ink-subtle hover:text-ink-muted"
          }`}
        >
          {STOP_LABEL[s]}
        </button>
      ))}
    </div>
  );
}

export default function SearchClient({
  types,
  people,
  dateProps = [],
  tagProps = [],
  roleProps = [],
  initialQuery = "",
  initialSavedSearches = [],
  initialSavedId,
}: {
  types: Option[];
  people: Option[];
  // Date-kind custom fields, offered as "which date" the When criterion measures
  // (ADR-172). `value` is the properties key, sent as whensrc=prop:<key>.
  dateProps?: Option[];
  // select / multi_select fields, with their options, for tag criteria
  // ("I remember it was tagged X"). Sent as tag=<key>:<value>~<confidence>.
  tagProps?: (Option & { options: string[] })[];
  // relation-kind fields, for narrowing a person criterion to one typed link
  // ("linked as Author" rather than "linked anywhere"). Sent as role=<key>.
  roleProps?: Option[];
  // Prefill from ?q= (the Discover panel's "Search everything about this"
  // handoff, ADR-127): the effect below fetches on mount when q is non-empty.
  initialQuery?: string;
  // The owner's saved searches (settings.savedSearches), read server-side so
  // the chip row renders without a round trip; kept in local state after that
  // so save/delete update without a reload.
  initialSavedSearches?: { id: string; name: string; state: Record<string, unknown> }[];
  // A `?saved=<id>` deep link (page.tsx): applied once on mount.
  initialSavedId?: string;
}) {
  const [q, setQ] = useState(initialQuery);
  const [type, setType] = useState("");
  const [person, setPerson] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [fetched, setFetched] = useState<ResultRow[] | null>(null);
  const [expansions, setExpansions] = useState<Record<string, number>>({});
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");

  // --- Fuzzy ("Tune") state. All of it is inert until `tuning` is on. --------
  const [tuning, setTuning] = useState(false);
  const [terms, setTerms] = useState<TermRow[]>([]);
  const [nextTermId, setNextTermId] = useState(1);
  const [whenPhrase, setWhenPhrase] = useState("");
  const [whenStop, setWhenStop] = useState<Stop>("probably");
  // "updated" | "created" | "prop:<key>" — the wire value for whensrc.
  const [whenSrc, setWhenSrc] = useState("updated");
  const [typeStop, setTypeStop] = useState<Stop>("sure");
  const [personStop, setPersonStop] = useState<Stop>("sure");
  // "" = a link in either direction, any field (what person= has always meant).
  const [personRole, setPersonRole] = useState("");
  const [tags, setTags] = useState<TagRow[]>([]);
  const [nextTagId, setNextTagId] = useState(1);

  // --- Saved searches + recent history. --------------------------------------
  const [saved, setSaved] = useState(initialSavedSearches);
  // Read after mount: this component is server-rendered, and localStorage
  // differs from the server's empty list, so reading it during render would
  // mismatch on hydration.
  const [recent, setRecent] = useState<string[]>([]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRecent(readSearchHistory());
  }, []);

  // A leading "/type" token in the box narrows to one type ("/note budget");
  // it overrides the Type dropdown and the remaining text is the query. Resolved
  // against the same registry that fills the dropdown.
  const parsed = useMemo(
    () => parseTypeToken(q, types.map((t) => ({ key: t.value, label: t.label, icon: null }))),
    [q, types]
  );
  const apiQ = (parsed ? parsed.rest : q).trim();
  const apiType = parsed ? parsed.type.key : type;

  // The date phrase is parsed HERE as well as on the server: nl-date.ts is pure
  // and client-safe, so the "what I understood" chip needs no round trip. (The
  // synonym map is the opposite — it stays server-only, so the "+N synonyms"
  // hint does come back with the results.)
  const todayYmd = useMemo(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
      now.getDate()
    ).padStart(2, "0")}`;
  }, []);
  const whenParsed = useMemo(
    () => (whenPhrase.trim() ? parseFuzzyWhen(whenPhrase, todayYmd) : null),
    [whenPhrase, todayYmd]
  );

  // Restore a saved-search snapshot into the live state, filling defaults for
  // any key the snapshot doesn't have (an older snapshot, or a hand-edited
  // one). Sets tuning on when the snapshot carries any fuzzy criterion, even
  // if the snapshot itself didn't say so, so a restored search looks the same
  // as when it was saved.
  const restore = (state: Record<string, unknown>) => {
    const s = state as Record<string, unknown>;
    const str = (v: unknown, fallback = "") => (typeof v === "string" ? v : fallback);
    const stop = (v: unknown, fallback: Stop): Stop =>
      STOPS.includes(v as Stop) ? (v as Stop) : fallback;
    setQ(str(s.q));
    setType(str(s.type));
    setPerson(str(s.person));
    setFrom(str(s.from));
    setTo(str(s.to));
    const restoredTerms: TermRow[] = Array.isArray(s.terms)
      ? s.terms
          .filter((t): t is { value: unknown; stop?: unknown } => !!t && typeof t === "object")
          .map((t, i) => ({ id: i + 1, value: str(t.value), stop: stop(t.stop, "probably") }))
      : [];
    setTerms(restoredTerms);
    setNextTermId(restoredTerms.length + 1);
    setWhenPhrase(str(s.whenPhrase));
    setWhenStop(stop(s.whenStop, "probably"));
    setWhenSrc(str(s.whenSrc, "updated"));
    setTypeStop(stop(s.typeStop, "sure"));
    setPersonStop(stop(s.personStop, "sure"));
    setPersonRole(str(s.personRole));
    const restoredTags: TagRow[] = Array.isArray(s.tags)
      ? s.tags
          .filter((t): t is { key: unknown; value: unknown; stop?: unknown } => !!t && typeof t === "object")
          .map((t, i) => ({ id: i + 1, key: str(t.key), value: str(t.value), stop: stop(t.stop, "might") }))
      : [];
    setTags(restoredTags);
    setNextTagId(restoredTags.length + 1);
    const hasFuzzyCriteria =
      restoredTerms.length > 0 ||
      restoredTags.length > 0 ||
      !!str(s.whenPhrase) ||
      stop(s.typeStop, "sure") !== "sure" ||
      stop(s.personStop, "sure") !== "sure" ||
      !!str(s.personRole);
    setTuning(s.tuning === true || hasFuzzyCriteria);
  };

  // Apply a `?saved=<id>` deep link once on mount. A one-time bootstrap from a
  // URL param, not a sync with an external system, so the setState-in-effect
  // rule doesn't apply here.
  useEffect(() => {
    if (!initialSavedId) return;
    const match = initialSavedSearches.find((sv) => sv.id === initialSavedId);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (match) restore(match.state);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveSearch = async () => {
    const name = window.prompt("Name this search", apiQ || q);
    if (!name || !name.trim()) return;
    const snapshot: Record<string, unknown> = {
      q, type, person, from, to, tuning, terms, whenPhrase, whenStop, whenSrc,
      typeStop, personStop, personRole, tags,
    };
    try {
      const entry = { id: crypto.randomUUID(), name: name.trim(), state: snapshot };
      const next = [...saved, entry];
      const patchRes = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ savedSearches: next }),
      });
      if (patchRes.ok) setSaved(next);
    } catch {
      /* offline; the button stays usable to retry */
    }
  };

  const deleteSaved = async (id: string) => {
    const next = saved.filter((s) => s.id !== id);
    setSaved(next);
    try {
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ savedSearches: next }),
      });
    } catch {
      /* best-effort; a reload will resync from the server */
    }
  };

  const activeTerms = useMemo(
    () => terms.filter((t) => t.value.trim().length > 0),
    [terms]
  );

  const activeTags = useMemo(
    () => tags.filter((t) => t.key && t.value),
    [tags]
  );

  // Fuzzy mode engages only when the panel is open AND something in it is set.
  // Otherwise the request is byte-identical to the pre-ADR-172 exact search.
  const fuzzy =
    tuning &&
    (activeTerms.length > 0 ||
      activeTags.length > 0 ||
      whenParsed !== null ||
      typeStop !== "sure" ||
      personStop !== "sure" ||
      personRole !== "");

  // The query string, and the criteria order the server will score in — the
  // result rows' `contribs` array lines up with this, so it doubles as the
  // legend for the why-chips.
  const { search, legend } = useMemo(() => {
    const p = new URLSearchParams();
    const order: string[] = [];
    if (apiQ) {
      p.set("q", apiQ);
      if (fuzzy) order.push(`"${apiQ}"`);
    }
    if (fuzzy) {
      for (const t of activeTerms) {
        p.append("term", `${t.value.trim()}~${t.stop}`);
        order.push(`"${t.value.trim()}"`);
      }
      if (apiType) {
        p.set("type", `${apiType}~${typeStop}`);
        order.push(types.find((x) => x.value === apiType)?.label ?? apiType);
      }
      if (person) {
        p.set("person", `${person}~${personStop}`);
        if (personRole) p.set("role", personRole);
        const who = people.find((x) => x.value === person)?.label ?? "person";
        const asRole = roleProps.find((r) => r.value === personRole)?.label;
        order.push(asRole ? `${who} (${asRole})` : who);
      }
      for (const t of activeTags) {
        p.append("tag", `${t.key}:${t.value}~${t.stop}`);
        order.push(t.value);
      }
      if (whenParsed) {
        p.set("when", `${whenPhrase.trim()}~${whenStop}`);
        p.set("whensrc", whenSrc);
        order.push(
          whenSrc === "created"
            ? "date made"
            : whenSrc === "updated"
              ? "date worked on"
              : dateProps.find((p) => `prop:${p.value}` === whenSrc)?.label ?? "date"
        );
      } else if (from || to) {
        if (from) p.set("from", from);
        if (to) p.set("to", to);
        p.set("whensrc", whenSrc);
        p.set("whenconf", whenStop);
        order.push("date");
      }
    } else {
      if (apiType) p.set("type", apiType);
      if (person) p.set("person", person);
      if (from) p.set("from", from);
      if (to) p.set("to", to);
    }
    return { search: p.toString(), legend: order };
  }, [
    apiQ, apiType, person, from, to, fuzzy, activeTerms, whenParsed, whenPhrase,
    whenStop, whenSrc, typeStop, personStop, personRole, activeTags,
    types, people, dateProps, roleProps,
  ]);

  // In fuzzy mode a search can stand on criteria alone (a date and a type, no
  // words at all); in exact mode it still needs query text.
  const canSearch = fuzzy
    ? activeTerms.length > 0 || activeTags.length > 0 || apiQ.length > 0 || whenParsed !== null
    : apiQ.length > 0;

  // State changes happen only inside the debounced callback (the React
  // compiler rejects synchronous setState in an effect body); the blank-
  // query case is derived at render time below instead of stored.
  useEffect(() => {
    if (!canSearch) return;
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      setStatus("loading");
      try {
        const res = await fetch(`/api/search?${search}`, { signal: ctrl.signal });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as {
          items: ResultRow[];
          expansions?: Record<string, number>;
        };
        setFetched(data.items);
        setExpansions(data.expansions ?? {});
        setStatus("idle");
      } catch {
        if (!ctrl.signal.aborted) setStatus("error");
      }
    }, 300);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [search, canSearch]);

  const results = canSearch ? fetched : null;
  // "/type" with nothing typed yet: the box has a token but no query text.
  const awaitingText = parsed !== null && parsed.rest.trim() === "" && !fuzzy;

  const addTerm = () => {
    setTerms((prev) => [...prev, { id: nextTermId, value: "", stop: "probably" }]);
    setNextTermId((n) => n + 1);
  };
  const setTerm = (id: number, patch: Partial<TermRow>) =>
    setTerms((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  // A new tag row preselects the only sensible default: the first field, no value
  // yet (the value select shows a placeholder until picked).
  const addTag = () => {
    setTags((prev) => [
      ...prev,
      { id: nextTagId, key: tagProps[0]?.value ?? "", value: "", stop: "might" },
    ]);
    setNextTagId((n) => n + 1);
  };
  const setTag = (id: number, patch: Partial<TagRow>) =>
    setTags((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));

  return (
    <div>
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search titles and bodies…"
        aria-label="Search"
        autoFocus
        className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 outline-none placeholder:text-neutral-600 focus:border-neutral-600"
      />

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <label className="flex items-center gap-1.5 text-xs text-neutral-500">
          Type
          <select
            value={apiType}
            onChange={(e) => setType(e.target.value)}
            disabled={parsed !== null}
            title={parsed ? "Filtered by the /type in the search box" : undefined}
            className={`${selectClass} disabled:opacity-60`}
          >
            <option value="">any</option>
            {types.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        {tuning && apiType && (
          <StopPicker
            value={typeStop}
            onChange={setTypeStop}
            hint="How sure are you about the type? Sure filters to it; the lower stops only rank it higher, so a wrong guess never hides the real item."
          />
        )}
        <label className="flex items-center gap-1.5 text-xs text-neutral-500">
          Person
          <select
            value={person}
            onChange={(e) => setPerson(e.target.value)}
            className={selectClass}
          >
            <option value="">any</option>
            {people.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        {tuning && person && roleProps.length > 0 && (
          <select
            value={personRole}
            onChange={(e) => setPersonRole(e.target.value)}
            aria-label="Linked as"
            title="Narrow to one kind of link, or match a link of any kind"
            className={selectClass}
          >
            <option value="">linked anywhere</option>
            {roleProps.map((r) => (
              <option key={r.value} value={r.value}>
                linked as {r.label}
              </option>
            ))}
          </select>
        )}
        {tuning && person && (
          <StopPicker
            value={personStop}
            onChange={setPersonStop}
            hint="How sure are you this person is linked? Sure filters to them; the lower stops only rank them higher."
          />
        )}
        {!tuning && (
          <label className="flex items-center gap-1.5 text-xs text-neutral-500">
            Updated
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              aria-label="Updated from"
              className={selectClass}
            />
            –
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              aria-label="Updated to"
              className={selectClass}
            />
          </label>
        )}
        <button
          type="button"
          onClick={() => setTuning((v) => !v)}
          aria-expanded={tuning}
          className="ml-auto rounded border border-line px-2 py-1 text-xs text-ink-subtle hover:bg-surface-2 hover:text-ink-muted"
        >
          {tuning ? "Done tuning" : "Tune"}
        </button>
      </div>

      {tuning && (
        <div className="mt-3 rounded-card border border-line bg-surface-1 p-3">
          <p className="ui-meta text-ink-subtle">
            Stack up what you half-remember and say how sure you are about each
            piece. Nothing here has to be right: a low confidence only nudges the
            ranking, so a wrong guess never hides the real item.
          </p>

          <div className="mt-3 space-y-2">
            {terms.map((t) => {
              const extra = expansions[t.value.trim()] ?? 0;
              return (
                <div key={t.id} className="flex flex-wrap items-center gap-2">
                  <span className="ui-meta w-14 shrink-0 text-ink-subtle">
                    {t.id === terms[0]?.id ? "Words" : ""}
                  </span>
                  <input
                    type="text"
                    value={t.value}
                    onChange={(e) => setTerm(t.id, { value: e.target.value })}
                    placeholder="another word it might contain…"
                    aria-label="Search word"
                    className="min-w-0 flex-1 rounded border border-line bg-surface-0 px-2 py-1 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-line-strong"
                  />
                  <StopPicker
                    value={t.stop}
                    onChange={(stop) => setTerm(t.id, { stop })}
                    hint="How sure are you this word is in it? Sure requires it; the lower stops only rank it higher."
                  />
                  {extra > 0 && (
                    <span className="ui-meta text-ink-faint" title="Synonyms, number words, and your own dictionary entries that also count as a match">
                      +{extra} similar
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => setTerms((prev) => prev.filter((x) => x.id !== t.id))}
                    aria-label="Remove this word"
                    className="rounded px-1.5 text-ink-faint hover:bg-surface-2 hover:text-ink-muted"
                  >
                    ×
                  </button>
                </div>
              );
            })}
            <div className="flex items-center gap-2">
              <span className="ui-meta w-14 shrink-0 text-ink-subtle">
                {terms.length === 0 ? "Words" : ""}
              </span>
              <button
                type="button"
                onClick={addTerm}
                className="rounded border border-dashed border-line px-2 py-1 text-xs text-ink-subtle hover:bg-surface-2 hover:text-ink-muted"
              >
                + add a word
              </button>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="ui-meta w-14 shrink-0 text-ink-subtle">When</span>
            <input
              type="text"
              value={whenPhrase}
              onChange={(e) => setWhenPhrase(e.target.value)}
              placeholder="last month sometime · within the last week · at least 6 months ago"
              aria-label="Roughly when"
              className="min-w-0 flex-1 rounded border border-line bg-surface-0 px-2 py-1 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-line-strong"
            />
            <select
              value={whenSrc}
              onChange={(e) => setWhenSrc(e.target.value)}
              aria-label="Which date"
              title="Which date you're remembering: when you last worked on it, when you made it, or one of your own date fields"
              className={selectClass}
            >
              <option value="updated">I worked on it</option>
              <option value="created">I made it</option>
              {dateProps.map((p) => (
                <option key={p.value} value={`prop:${p.value}`}>
                  {p.label}
                </option>
              ))}
            </select>
            <StopPicker
              value={whenStop}
              onChange={setWhenStop}
              hint="How sure are you about the date? This only steepens how fast the score drops off outside your window — a date is never a hard cutoff, so an item outside it can still surface on a strong word match."
            />
          </div>
          {whenPhrase.trim() && (
            <p className="ui-meta mt-1 pl-16">
              {whenParsed ? (
                <span className="text-emerald-400/90">{whenParsed.label}</span>
              ) : (
                <span className="text-amber-400/90">
                  Didn&apos;t understand that. Try &ldquo;3 weeks ago&rdquo;, &ldquo;within the last month&rdquo;, or a date.
                </span>
              )}
            </p>
          )}

          {/* Tag criteria: any select / multi_select field on any type. Rendered
              only when some type actually declares one with options, so a fresh
              instance shows no dead control. */}
          {tagProps.length > 0 && (
            <div className="mt-3 space-y-2">
              {tags.map((t) => {
                const field = tagProps.find((p) => p.value === t.key);
                return (
                  <div key={t.id} className="flex flex-wrap items-center gap-2">
                    <span className="ui-meta w-14 shrink-0 text-ink-subtle">
                      {t.id === tags[0]?.id ? "Tagged" : ""}
                    </span>
                    <select
                      value={t.key}
                      onChange={(e) => setTag(t.id, { key: e.target.value, value: "" })}
                      aria-label="Which field"
                      className={selectClass}
                    >
                      {tagProps.map((p) => (
                        <option key={p.value} value={p.value}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                    <select
                      value={t.value}
                      onChange={(e) => setTag(t.id, { value: e.target.value })}
                      aria-label="Which value"
                      className={`${selectClass} min-w-0 flex-1`}
                    >
                      <option value="">pick a value…</option>
                      {(field?.options ?? []).map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                    <StopPicker
                      value={t.stop}
                      onChange={(stop) => setTag(t.id, { stop })}
                      hint="How sure are you about this tag? Sure filters to it; the lower stops only rank it higher, so a wrong guess never hides the real item."
                    />
                    <button
                      type="button"
                      onClick={() => setTags((prev) => prev.filter((x) => x.id !== t.id))}
                      aria-label="Remove this tag"
                      className="rounded px-1.5 text-ink-faint hover:bg-surface-2 hover:text-ink-muted"
                    >
                      ×
                    </button>
                  </div>
                );
              })}
              <div className="flex items-center gap-2">
                <span className="ui-meta w-14 shrink-0 text-ink-subtle">
                  {tags.length === 0 ? "Tagged" : ""}
                </span>
                <button
                  type="button"
                  onClick={addTag}
                  className="rounded border border-dashed border-line px-2 py-1 text-xs text-ink-subtle hover:bg-surface-2 hover:text-ink-muted"
                >
                  + add a tag
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {saved.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 px-2 text-xs text-ink-subtle">
          <span>Saved:</span>
          {saved.map((s) => (
            <span
              key={s.id}
              className="inline-flex items-center gap-1 rounded border border-line px-2 py-0.5"
            >
              <button
                type="button"
                onClick={() => restore(s.state)}
                className="text-ink-subtle hover:text-ink"
              >
                {s.name}
              </button>
              <button
                type="button"
                onClick={() => deleteSaved(s.id)}
                aria-label={`Delete saved search ${s.name}`}
                className="text-ink-faint hover:text-ink-muted"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="mt-6">
        {!canSearch && recent.length > 0 && (
          <div className="px-2">
            <p className="ui-meta text-ink-subtle">Recent searches</p>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {recent.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setQ(r)}
                  className="rounded border border-line px-2 py-1 text-xs text-ink-subtle hover:bg-surface-2 hover:text-ink-muted"
                >
                  {r}
                </button>
              ))}
            </div>
          </div>
        )}
        {awaitingText && (
          <p className="px-2 text-sm text-neutral-600">
            Keep typing to search {parsed?.type.label}.
          </p>
        )}
        {canSearch && status === "error" && (
          <p className="px-2 text-sm text-red-400">
            Search failed; keep typing to retry.
          </p>
        )}
        {canSearch && status === "loading" && results == null && (
          <p className="px-2 text-sm text-neutral-600">Searching…</p>
        )}
        {canSearch && (
          <div className="flex items-center justify-between px-2">
            <p className="text-xs text-neutral-600">
              {results == null
                ? ""
                : results.length === 0
                  ? "No matches."
                  : `${results.length} match${results.length === 1 ? "" : "es"}${
                      results.length === 50 ? " (showing the first 50)" : ""
                    }${fuzzy ? ", best guesses first" : ""}`}
            </p>
            <button
              type="button"
              onClick={saveSearch}
              className="rounded border border-line px-2 py-1 text-xs text-ink-subtle hover:bg-surface-2 hover:text-ink-muted"
            >
              Save search
            </button>
          </div>
        )}
        {results != null && results.length > 0 && (
          <ul className="mt-1">
            {results.map((row) => (
              <li
                key={row.id}
                className="group rounded px-2 py-1.5 hover:bg-neutral-800/60"
              >
                <div className="flex items-center gap-2.5">
                  <span className="w-16 shrink-0 truncate text-xs text-neutral-600">
                    {row.type}
                  </span>
                  <Link
                    href={`/items/${row.id}`}
                    onClick={() => apiQ && pushSearchHistory(apiQ)}
                    className={`min-w-0 flex-1 truncate text-sm ${
                      row.title ? "text-neutral-200" : "text-neutral-500"
                    }`}
                  >
                    {row.title || "Untitled"}
                  </Link>
                  <span className="shrink-0 text-xs text-neutral-600">
                    {dateFmt.format(new Date(row.updatedAt))}
                  </span>
                </div>
                {row.snippet && (
                  <div className="pl-[74px]">
                    <Snippet text={row.snippet} />
                  </div>
                )}
                {/* Why this row ranked where it did: the criteria that actually
                    contributed, strongest first. Keeps the dials legible rather
                    than magic (the Discover reason-chip idea). */}
                {fuzzy && row.contribs && legend.length > 0 && (
                  <div className="flex flex-wrap gap-1 pl-[74px] pt-0.5">
                    {row.contribs
                      .map((weight, i) => ({ weight, label: legend[i] }))
                      .filter((c) => c.weight > 0.01 && c.label)
                      .sort((a, b) => b.weight - a.weight)
                      .slice(0, 3)
                      .map((c) => (
                        <span
                          key={c.label}
                          className="ui-meta rounded border border-line px-1.5 text-ink-faint"
                        >
                          {c.label}
                        </span>
                      ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
