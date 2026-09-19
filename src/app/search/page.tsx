// Search (PRD §4.2): full-text across titles and bodies, filtered by type,
// related person, and updated date. The server side only gathers the filter
// options; querying is client-driven through GET /api/search.
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { types } from "@/db/schema";
import SearchClient from "@/components/search/SearchClient";
import { resolveOwner } from "@/lib/owner";
import { getSettings } from "@/lib/settings";
import { compareTypeKeys } from "@/lib/type-order";
import { listPersonOptions } from "@/lib/views";

export const dynamic = "force-dynamic";

export default async function Search({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; saved?: string }>;
}) {
  const owner = await resolveOwner();
  if (!owner) redirect("/sign-in");

  // Prefill from ?q= for the Discover "Search everything about this" handoff
  // (ADR-127); ?saved=<id> deep-links a saved search (command palette).
  const sp = await searchParams;
  const initialQuery = sp.q ?? "";
  const initialSavedId = sp.saved;

  const [typeRows, people, settings] = await Promise.all([
    getDb()
      .select({ key: types.key, label: types.label, propertySchema: types.propertySchema })
      .from(types),
    listPersonOptions(owner.id),
    getSettings(owner.id),
  ]);
  typeRows.sort((a, b) => compareTypeKeys(a.key, b.key));

  // Custom fields a fuzzy criterion can target (ADR-172). All three lists are
  // keyed by the PROPERTY KEY and deduped across types, because a criterion
  // matches items.properties[key] (or a relation `role`) regardless of which type
  // declares it — two types sharing a "campus" field should offer one row, with
  // the union of their options.
  //
  //   dateProps  — date-kind: which date a When criterion measures.
  //   tagProps   — select / multi_select: "I remember it was tagged X".
  //   roleProps  — relation-kind: narrows a person criterion to one typed field
  //                (linked as Author, vs linked anywhere).
  const dateProps = new Map<string, string>();
  const tagProps = new Map<string, { label: string; options: Set<string> }>();
  const roleProps = new Map<string, string>();
  for (const t of typeRows) {
    for (const p of (t.propertySchema ?? []) as {
      key: string;
      label: string;
      kind: string;
      options?: string[];
    }[]) {
      if (!p.key) continue;
      const label = p.label || p.key;
      if (p.kind === "date") {
        if (!dateProps.has(p.key)) dateProps.set(p.key, label);
      } else if (p.kind === "select" || p.kind === "multi_select") {
        const existing = tagProps.get(p.key) ?? { label, options: new Set<string>() };
        for (const o of p.options ?? []) if (o) existing.options.add(o);
        tagProps.set(p.key, existing);
      } else if (p.kind === "relation") {
        if (!roleProps.has(p.key)) roleProps.set(p.key, label);
      }
    }
  }

  return (
    <main className="min-h-screen">
      <div className="mx-auto w-full max-w-3xl px-6 py-10 sm:px-12">
        <h1 className="text-2xl font-bold tracking-tight text-neutral-100">
          Search
        </h1>
        <p className="mt-1 text-sm text-neutral-500">
          Words, &quot;quoted phrases&quot;, OR, and -exclusions all work.
        </p>
        <div className="mt-6">
          <SearchClient
            initialQuery={initialQuery}
            initialSavedSearches={settings.savedSearches}
            initialSavedId={initialSavedId}
            types={typeRows.map((t) => ({ value: t.key, label: t.label }))}
            people={people.map((p) => ({
              value: p.id,
              label: p.title || "Untitled",
            }))}
            dateProps={[...dateProps].map(([value, label]) => ({ value, label }))}
            // Only fields that actually have options are offerable: a select with
            // none has nothing to pick, so the row would be a dead end.
            tagProps={[...tagProps]
              .filter(([, v]) => v.options.size > 0)
              .map(([key, v]) => ({
                value: key,
                label: v.label,
                options: [...v.options].sort(),
              }))}
            roleProps={[...roleProps].map(([value, label]) => ({ value, label }))}
          />
        </div>
      </div>
    </main>
  );
}
