// AI Memory (ADR-137) — the Build-surface management view for the durable
// memories an AI assistant reads over MCP. Deliberately a Build/MAINTAIN tool,
// not a Work destination: this is *about* the AI, not part of daily use. The
// heavy lifting (browse/open/edit/trash, multi-select) is the generic list at
// /list/memory; this page is the orientation + the live stump index (what the
// assistant actually loads at the start of a session).
//
// Gated by settings.aiMemoryEnabled: off → an enable prompt (the sidebar entry
// is hidden too, so you only land here from Settings or a direct link); on →
// the stumps, marked always-on (pinned) vs. pull-only.
import Link from "next/link";
import { redirect } from "next/navigation";
import NewItemButton from "@/components/home/NewItemButton";
import AiMemoryGuide from "@/components/memory/AiMemoryGuide";
import { getMemoryStumps, type MemoryStump } from "@/lib/memory";
import { resolveOwner } from "@/lib/owner";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

const dateFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });

function Badge({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "accent" | "green" }) {
  const cls =
    tone === "green"
      ? "bg-emerald-500/15 text-emerald-400"
      : tone === "accent"
        ? "bg-[var(--accent)]/15 text-[var(--accent)]"
        : "bg-neutral-800 text-neutral-400";
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${cls}`}>
      {children}
    </span>
  );
}

function StumpRow({ stump }: { stump: MemoryStump }) {
  return (
    <li className="rounded-xl border border-neutral-800 p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <Link href={`/items/${stump.id}`} className="min-w-0 flex-1 truncate text-sm text-neutral-200 hover:text-white">
          {stump.title || "Untitled memory"}
        </Link>
        {stump.pinned ? <Badge tone="green">always-on</Badge> : <Badge>on demand</Badge>}
        {stump.supersededBy && (
          <Link href={`/items/${stump.supersededBy.id}`} title={`Replaced on ${stump.supersededBy.date}; opens the newer memory`}>
            <Badge tone="accent">superseded</Badge>
          </Link>
        )}
        {stump.kind && <Badge>{stump.kind}</Badge>}
        {stump.horizon && <Badge>{stump.horizon}</Badge>}
        <span className="shrink-0 text-xs text-neutral-600">{dateFmt.format(new Date(stump.updatedAt))}</span>
      </div>
      {stump.linked.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-neutral-600">links:</span>
          {stump.linked.map((l) => (
            <Link
              key={l.id}
              href={`/items/${l.id}`}
              className="rounded bg-neutral-800/70 px-1.5 py-0.5 text-[11px] text-neutral-400 hover:text-neutral-200"
            >
              {l.title || l.type}
            </Link>
          ))}
        </div>
      )}
    </li>
  );
}

export default async function AiMemoryPage() {
  const owner = await resolveOwner();
  if (!owner) redirect("/sign-in");

  const { aiMemoryEnabled } = await getSettings(owner.id);

  return (
    <main className="min-h-screen">
      <div className="mx-auto w-full max-w-3xl px-6 py-10 sm:px-12">
        <div className="flex items-baseline justify-between gap-2">
          <h1 className="text-2xl font-bold tracking-tight text-neutral-100">AI Memory</h1>
          <Link href="/build" className="text-sm text-neutral-500 hover:text-neutral-300">
            ← Back to Build
          </Link>
        </div>
        <p className="mt-1 text-sm leading-relaxed text-neutral-500">
          Durable memories an AI assistant keeps in Ledgr and reads over MCP — so it acts like it
          knows you across sessions. This is a maintenance surface for the AI, not part of your Work.
          Each memory is a short “stump” linked to the people, projects, and notes it’s about; the
          assistant loads the pinned ones at the start of a session and searches out the rest when a
          task names someone or something they cover.
        </p>

        {!aiMemoryEnabled ? (
          <div className="mt-8 rounded-xl border border-amber-900/60 bg-amber-950/20 p-5">
            <p className="text-sm font-semibold text-neutral-100">AI Memory is off</p>
            <p className="mt-1.5 text-sm leading-relaxed text-neutral-400">
              Turn it on in{" "}
              <Link href="/settings" className="text-[var(--accent)] hover:underline">
                User Settings → AI Memory
              </Link>
              . While off, the memory tools aren’t exposed to any connected AI and this surface stays
              empty, so a plain MCP client behaves exactly as before.
            </p>
          </div>
        ) : (
          <EnabledBody ownerId={owner.id} />
        )}

        <details className="mt-10 rounded-xl border border-neutral-800 p-4 [&_summary]:cursor-pointer">
          <summary className="text-sm font-semibold text-neutral-200">
            How AI Memory works &amp; how to use it
          </summary>
          <div className="mt-3 border-t border-neutral-800 pt-3">
            <AiMemoryGuide />
          </div>
        </details>
      </div>
    </main>
  );
}

async function EnabledBody({ ownerId }: { ownerId: string }) {
  const { stumps: all } = await getMemoryStumps(ownerId, { includeAll: true });
  const pinnedCount = all.filter((s) => s.pinned).length;

  return (
    <>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <NewItemButton type="memory" />
        <Link
          href="/list/memory"
          className="rounded-lg border border-neutral-800 px-3 py-1.5 text-sm text-neutral-300 hover:border-neutral-700 hover:text-neutral-100"
        >
          Open the full memory list
        </Link>
        <Link
          href="/build/claude"
          className="text-sm text-neutral-500 hover:text-neutral-300"
        >
          Connection & tools →
        </Link>
      </div>

      <section className="mt-8">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Stumps ({all.length})
          </h2>
          <span className="text-xs text-neutral-600">
            {pinnedCount} always-on · {all.length - pinnedCount} pull-only
          </span>
        </div>
        {all.length === 0 ? (
          <p className="mt-4 rounded-xl border border-dashed border-neutral-800 p-5 text-sm leading-relaxed text-neutral-500">
            No memories yet. They appear here as your assistant files them with the{" "}
            <code className="rounded bg-neutral-800 px-1 py-0.5 font-mono text-[11px] text-neutral-400">
              remember
            </code>{" "}
            tool, or you can add one yourself with “+ New”. Only pinned memories load every session;
            everything else stays searchable and gets pulled in when it’s relevant.
          </p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {all.map((stump) => (
              <StumpRow key={stump.id} stump={stump} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
