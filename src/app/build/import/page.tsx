// Import & Migration (2026-09-22): a real importer for Markdown shared from
// another Ledgr (front matter keeps type / properties / tags) or any .md.
import ImportDropzone from "@/components/build/ImportDropzone";

export const dynamic = "force-dynamic";

export default function ImportMigration() {
  return (
    <main className="min-h-screen">
      <div className="mx-auto w-full max-w-3xl px-6 py-10 sm:px-12">
        <h1 className="text-2xl font-bold tracking-tight text-neutral-100">Import &amp; Migration</h1>
        <p className="mt-2 text-sm text-neutral-400">
          Bring in notes shared from another Ledgr (the Share button&rsquo;s &ldquo;Download .md&rdquo;), or any
          Markdown file. Each file becomes one item; tags are matched by name or created.
        </p>
        <ImportDropzone />
      </div>
    </main>
  );
}
