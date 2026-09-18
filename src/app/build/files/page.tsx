// Build → Files (ADR-237; moved out of Data Hygiene same day at Tyler's call —
// files are DATA the owner browses, not a mess to clean). Every file in
// storage, the item it belongs to, a "not linked" mark when nothing points at
// it anymore, and Delete per row. The cleanup counterpart (orphaned bytes with
// no item at all) lives on Data Hygiene.
import AllFilesTool from "@/components/build/AllFilesTool";

export const dynamic = "force-dynamic";

export default function BuildFiles() {
  return (
    <main className="min-h-screen">
      <div className="mx-auto w-full max-w-3xl px-6 py-10 sm:px-12">
        <h1 className="text-2xl font-bold tracking-tight text-neutral-100">
          Files
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-muted">
          Every file in your storage, the item it belongs to, and whether that
          item still points at it. Deleting a link out of a body never deletes
          the file — this is where you see what you actually have, and delete
          what you don&rsquo;t want.
        </p>
        <div className="mt-5">
          <AllFilesTool />
        </div>
      </div>
    </main>
  );
}
