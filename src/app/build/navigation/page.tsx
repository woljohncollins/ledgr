// Navigation builder (Build → INTERFACE → Navigation): edit the owner's middle
// nav slots (ADR-056). The slot config lives in users.settings; the editor
// offers built-in pages, the owner's dashboards, saved views, item types, and
// Build tools as destinations.
import Link from "next/link";
import { redirect } from "next/navigation";
import NavSlotsEditor from "@/components/build/NavSlotsEditor";
import SearchModeEditor from "@/components/build/SearchModeEditor";
import { listDashboards } from "@/lib/dashboards";
import { buildDestOptions } from "@/lib/nav-slot-options";
import { resolveOwner } from "@/lib/owner";
import { getSettings } from "@/lib/settings";
import { listTypes } from "@/lib/types";
import { listViews } from "@/lib/views";

export const dynamic = "force-dynamic";

export default async function NavigationBuilder() {
  const owner = await resolveOwner();
  if (!owner) redirect("/sign-in");

  const [views, types, settings, dashboards] = await Promise.all([
    listViews(owner.id),
    listTypes(),
    getSettings(owner.id),
    listDashboards(owner.id),
  ]);
  const destOptions = buildDestOptions(
    views.map((v) => ({ id: v.id, name: v.name })),
    types.map((t) => ({ key: t.key, label: t.label, icon: t.icon })),
    dashboards.map((d) => ({ id: d.id, name: d.name }))
  );

  return (
    <main className="min-h-screen">
      <div className="mx-auto w-full max-w-3xl px-6 py-10 sm:px-12">
        <div className="flex items-baseline justify-between gap-2">
          <h1 className="text-2xl font-bold tracking-tight text-neutral-100">Navigation</h1>
          <Link href="/build" className="text-sm text-neutral-500 hover:text-neutral-300">
            ← Build
          </Link>
        </div>
        <p className="mt-1 text-sm text-neutral-500">
          Configure the middle nav slots — the destinations between Home and New/More. Point
          one at a dashboard, view, type list, built-in page, or a tools group.
        </p>

        <section className="mt-8">
          <SearchModeEditor initial={settings.searchMode} />
        </section>

        <section className="mt-8">
          <NavSlotsEditor
            initialDesktop={settings.navSlots}
            initialMobile={settings.mobileNavSlots}
            options={destOptions}
          />
        </section>
      </div>
    </main>
  );
}
