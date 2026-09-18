// Data Hygiene (ADR-063 stub → first real tool 2026-08-29, ADR-237): find and
// clean what the model no longer accounts for. The orphaned-files sweep is the
// first section; the ADR-063 plan (types with no items, views that return
// nothing, templates never applied, orphaned relations, unfilled properties)
// stays written down below so its intent survives until each tool lands.
import OrphanFilesTool from "@/components/build/OrphanFilesTool";

export const dynamic = "force-dynamic";

export default function DataHygiene() {
  return (
    <main className="min-h-screen">
      <div className="mx-auto w-full max-w-3xl px-6 py-10 sm:px-12">
        <h1 className="text-2xl font-bold tracking-tight text-neutral-100">
          Data Hygiene
        </h1>

        <section className="mt-6 rounded-card border border-line bg-surface-1 p-5">
          <h2 className="text-sm font-semibold text-ink">Unused files</h2>
          <p className="mt-1 text-sm leading-relaxed text-ink-muted">
            Two kinds of file you may not realize you still have, both counting
            against your storage: files whose item no longer links them (a note
            somewhere with a file attached that isn&rsquo;t being used), and
            orphans with no item at all. Recover an orphan and it becomes a note
            linking the file; the full inventory lives at Build → Files.
          </p>
          <div className="mt-3">
            <OrphanFilesTool />
          </div>
        </section>

        <div className="mt-6 rounded-xl border border-dashed border-neutral-800 p-5">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-neutral-600">
            Planned
          </p>
          <p className="mt-1.5 text-sm leading-relaxed text-neutral-400">
            More cleanup tools land here: types with no items, views that return
            nothing, templates never applied, orphaned relations, and properties
            defined but never filled. The Model Overview&rsquo;s &ldquo;Needs
            attention&rdquo; flags are the seed of this.
          </p>
        </div>
      </div>
    </main>
  );
}
