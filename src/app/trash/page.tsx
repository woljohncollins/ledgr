// Trash (v5). Soft-deleted items, newest first, with one-click Restore. Items
// are purged after the owner's retention window (settings). Reached from the nav
// kebab. Uses the existing trash infra: listItems({trash}), restoreItem, and the
// purge job.
import Link from "next/link";
import { redirect } from "next/navigation";
import { listItems } from "@/lib/items";
import { listDeletedTypes } from "@/lib/types";
import { resolveOwner } from "@/lib/owner";
import { getSettings } from "@/lib/settings";
import RestoreButton from "@/components/trash/RestoreButton";
import TypeRestoreButton from "@/components/trash/TypeRestoreButton";

export const dynamic = "force-dynamic";

function deletedMs(d: Date | string | null): number {
  if (!d) return 0;
  const t = (d instanceof Date ? d : new Date(d)).getTime();
  return Number.isNaN(t) ? 0 : t;
}
const whenFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "2-digit", year: "numeric", hour: "numeric", minute: "2-digit" });
function whenDeleted(d: Date | string | null): string {
  const t = deletedMs(d);
  return t ? whenFmt.format(new Date(t)) : "";
}

export default async function TrashPage() {
  const owner = await resolveOwner();
  if (!owner) redirect("/sign-in");
  const [trashedRaw, deletedTypes, settings] = await Promise.all([
    listItems(owner.id, { trash: true, limit: 200 }),
    listDeletedTypes(),
    getSettings(owner.id),
  ]);
  // Most recently deleted first (John, 2026-10-08) - the list query orders by
  // update time, which is not the same thing once restores and edits mix in.
  const trashed = [...trashedRaw].sort((a, b) => deletedMs(b.deletedAt) - deletedMs(a.deletedAt));

  return (
    <main className="min-h-screen">
      <div className="mx-auto w-full max-w-3xl px-6 py-10 sm:px-12">
        <div className="flex items-baseline justify-between gap-2">
          <h1 className="text-2xl font-bold tracking-tight text-neutral-100">Trash</h1>
          <Link href="/" className="text-sm text-neutral-500 hover:text-neutral-300">
            ← Back
          </Link>
        </div>
        <p className="mt-1 text-sm text-neutral-500">
          Deleted items are kept for {settings.trashRetentionDays} days, then purged. Restore puts an item (and its
          children) back where it was.
        </p>

        {deletedTypes.length > 0 && (
          <section className="mt-6">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
              Types
            </h2>
            <p className="mt-1 text-xs text-neutral-600">
              Restoring a type brings back the type and the items deleted with it.
            </p>
            <ul className="mt-2 flex flex-col gap-2">
              {deletedTypes.map((t) => (
                <li
                  key={t.key}
                  className="flex items-center justify-between gap-3 rounded-lg border border-neutral-800 px-3 py-2"
                >
                  <div className="min-w-0">
                    <span className="text-sm text-neutral-200">{t.label}</span>
                    <span className="ml-2 text-xs text-neutral-600">
                      {t.itemCount} item{t.itemCount === 1 ? "" : "s"}
                      {whenDeleted(t.deletedAt) && ` · deleted ${whenDeleted(t.deletedAt)}`}
                    </span>
                  </div>
                  <TypeRestoreButton typeKey={t.key} />
                </li>
              ))}
            </ul>
          </section>
        )}

        {trashed.length === 0 && deletedTypes.length === 0 ? (
          <p className="mt-6 text-sm text-neutral-600">Trash is empty.</p>
        ) : trashed.length === 0 ? null : (
          <section className="mt-6">
            {deletedTypes.length > 0 && (
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                Items
              </h2>
            )}
            <ul className="flex flex-col gap-2">
              {trashed.map((it) => (
              <li
                key={it.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-neutral-800 px-3 py-2"
              >
                <div className="min-w-0">
                  <span className="text-sm text-neutral-200">{it.title || "Untitled"}</span>
                  <span className="ml-2 text-xs text-neutral-600">
                    {it.type}
                    {whenDeleted(it.deletedAt) && ` · deleted ${whenDeleted(it.deletedAt)}`}
                  </span>
                </div>
                <RestoreButton id={it.id} />
              </li>
            ))}
            </ul>
          </section>
        )}
      </div>
    </main>
  );
}
