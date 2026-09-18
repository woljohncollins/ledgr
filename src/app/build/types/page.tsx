// Types index (slice 33, PRD §3.6/§4.10): the type registry, system rows first
// then custom, each linking into its builder. Part of the Build surface. Hidden
// types (ADR-059) are shown here too (dimmed, with a show/hide eye) — this is
// the one place you manage visibility. Below the list: a subtle "Create new
// type" affordance and a pointer to the bespoke-tool catalog.
import Link from "next/link";
import { redirect } from "next/navigation";
import TypeSettingsRow from "@/components/build/TypeSettingsRow";
import { attachableCapabilities } from "@/lib/modules";
// Side-effect: register the workflow modules so their capabilities show in the
// hint card below (same import the catalog page uses).
import "@/lib/modules/register";
import { resolveOwner } from "@/lib/owner";
import { resolveStatusSchema, type StatusMode } from "@/lib/status";
import { listTypes } from "@/lib/types";

export const dynamic = "force-dynamic";

// A one-glance summary of how a type tracks completion, so the row advertises
// that its status TERMS are editable behind it (ADR-181 — the panel existed since
// ADR-106/082 but nothing pointed at it from the index). Named stages read as
// their count, since the labels themselves are too long for a row badge; a
// checkbox type says so; a type with no status shows nothing.
function statusHint(t: { statusMode: StatusMode; statusSchema: unknown }): string | null {
  if (t.statusMode === "none") return null;
  if (t.statusMode === "checkbox") return "done checkbox";
  const n = resolveStatusSchema(t.statusSchema as never).length;
  return `${n} status${n === 1 ? "" : "es"}`;
}

export default async function BuildTypes() {
  const owner = await resolveOwner();
  if (!owner) redirect("/sign-in");

  // includeHidden so hidden types appear here (dimmed) to be un-hidden.
  const types = await listTypes({ includeHidden: true });
  const capabilities = attachableCapabilities(owner.id);

  return (
    <main className="min-h-screen">
      <div className="mx-auto w-full max-w-3xl px-6 py-10 sm:px-12">
        <div className="flex items-baseline justify-between gap-2">
          <h1 className="text-2xl font-bold tracking-tight text-neutral-100">
            Types
          </h1>
          <Link
            href="/build"
            className="text-sm text-neutral-500 hover:text-neutral-300"
          >
            ← Build
          </Link>
        </div>
        <p className="mt-1 text-sm text-neutral-500">
          The shapes your items take. Each type carries its own custom fields.
          Click a row to open its settings — quick capture, Listen, and
          visibility. Hide a built-in you don&rsquo;t use; it stays out of
          capture, menus, and tabs without deleting anything.
        </p>

        <ul className="mt-6 flex flex-col gap-1">
          {types.map((t) => (
            <TypeSettingsRow
              key={t.key}
              typeKey={t.key}
              label={t.label}
              fieldCount={t.propertySchema.length}
              statusHint={statusHint(t)}
              isSystem={t.isSystem}
              hidden={t.hidden}
              showInQuickCapture={t.showInQuickCapture}
              listenEnabled={t.listenEnabled}
              listenOpenInEdge={t.listenOpenInEdge}
            />
          ))}
        </ul>

        {/* Subtle "create" affordance at the foot of the list — quiet until you
            hover it. */}
        <Link
          href="/build/types/new"
          className="mt-2 flex items-center justify-center gap-2 rounded-lg border border-dashed border-neutral-800 px-3 py-2.5 text-sm text-neutral-600 transition hover:border-neutral-600 hover:bg-neutral-800/40 hover:text-neutral-200"
        >
          <span className="text-base leading-none">+</span> Create new type
        </Link>

        {/* Pointer to the bespoke-tool catalog so a user building a plain type
            knows there are richer, pre-built capabilities to borrow. */}
        <Link
          href="/build/tools"
          className="mt-4 block rounded-xl border border-neutral-800 bg-neutral-900/40 p-4 transition hover:border-neutral-700 hover:bg-neutral-900/70"
        >
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-neutral-100">
              Check our bespoke data types
            </h2>
            <span className="text-xs text-[var(--accent)]">Browse →</span>
          </div>
          <p className="mt-1 text-sm text-neutral-500">
            A new type starts plain. Some come with extra powers built in
            {capabilities.length > 0 ? (
              <>
                {" "}
                — like{" "}
                <span className="text-neutral-300">
                  {capabilities.slice(0, 3).map((c) => c.label).join(", ")}
                </span>
                {capabilities.length > 3 ? ", and more" : ""}.
              </>
            ) : (
              ": a chord-chart editor, a paper workspace, and more."
            )}{" "}
            Attach one to a type you name yourself.
          </p>
        </Link>
      </div>
    </main>
  );
}
