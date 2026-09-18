// The full-markdown view (Tyler, 2026-08-12). Every item's canonical body is
// markdown (`items.body = {format, text}`) and every other output — chord chart,
// slides, .docx, print — is RENDERED from it, never stored beside it. A bespoke
// canvas therefore shows a *presentation* of the body, not the body: on a song you
// see the chord chart, with no way to read or take the underlying text. This route
// is that missing surface, one hard-nav away from the "⋯" menu on any item.
//
// Read-only on purpose. Editing raw markdown already has a home (the body editor's
// source toggle); this is "show me the whole thing plainly, and let me copy it."
// The `format` is displayed rather than assumed — a type may declare a
// markdown-family format such as `chordpro`, and knowing which you're looking at
// is the whole point on a song.
//
// For a WIDGET-HOME record (a project, a pursuit, a custom hub type) this view
// shows the COMPOSED project document instead of the bare body (ADR-197): the
// whole project as one markdown file — summary, people, milestones, meetings,
// links, tasks with added/completed dates, timeline — rendered on demand from
// current state (the body alone is just the Overview, which lands inside it as
// the Summary). Same DB-canonical posture as every other rendering.
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getItem } from "@/lib/items";
import { canvasIdForType } from "@/lib/modules";
import { buildProjectMarkdown } from "@/lib/project-markdown";
import { resolveOwner } from "@/lib/owner";
import { getType } from "@/lib/types";
import { bodyMarkdown, wordCountOf } from "@/lib/body";
import CopyMarkdownButton from "@/components/canvas/CopyMarkdownButton";
import DownloadMarkdownButton from "@/components/canvas/DownloadMarkdownButton";
import BackButton from "@/components/ui/BackButton";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  try {
    const owner = await resolveOwner();
    if (!owner) return {};
    const item = await getItem(owner.id, id);
    return { title: `Markdown: ${item.title?.trim() || "Untitled"}` };
  } catch {
    return {};
  }
}

export default async function ItemMarkdownPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const owner = await resolveOwner();
  if (!owner) notFound();

  const item = await getItem(owner.id, id).catch(() => null);
  if (!item || item.deletedAt) notFound();

  const typeDef = await getType(item.type).catch(() => null);
  // A widget-home record (canvas id "widgets": Project, Pursuit, custom hub
  // types) gets the composed project document (ADR-197); every other type shows
  // its canonical body verbatim.
  const composed = canvasIdForType(item.type, owner.id, typeDef?.capability) === "widgets";
  const text = composed ? await buildProjectMarkdown(owner.id, item) : bodyMarkdown(item.body);
  // The declared body format, so a chordpro song says so instead of implying it's
  // plain markdown. Falls back to the schema default rather than guessing.
  const format = composed
    ? "markdown (composed)"
    : item.body && typeof item.body === "object" && "format" in item.body
      ? String((item.body as { format?: unknown }).format ?? "markdown")
      : "markdown";
  const words = wordCountOf(text);
  const filename = `${(item.title || "untitled").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.md`;

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-8">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <BackButton />
          <h1 className="ui-title mt-1 truncate">
            {item.title?.trim() || "Untitled"}
          </h1>
          <p className="ui-meta mt-0.5 text-ink-subtle">
            {typeDef?.label ?? item.type} · format{" "}
            <code className="text-ink-muted">{format}</code> ·{" "}
            {text.length.toLocaleString()} characters · {words.toLocaleString()}{" "}
            words
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <CopyMarkdownButton text={text} />
          {composed && <DownloadMarkdownButton text={text} filename={filename} />}
          <Link
            href={`/items/${item.id}`}
            className="rounded-card border border-line px-3 py-1.5 text-sm text-ink-muted hover:bg-surface-2 hover:text-ink"
          >
            Back to item
          </Link>
        </div>
      </div>

      {text.trim() === "" ? (
        <p className="rounded-card border border-line bg-surface-1 px-4 py-6 text-sm text-ink-subtle">
          This item has an empty body.
        </p>
      ) : (
        // Selectable, wrapped, and scrollable on its own axis so a long chord line
        // can't push the page sideways (the wide-content rule). `whitespace-pre-wrap`
        // keeps the markdown's own line breaks, which are meaningful in it.
        <pre className="overflow-x-auto rounded-card border border-line bg-surface-1 p-4 text-sm leading-relaxed text-ink selection:bg-[var(--accent)]/30">
          <code className="whitespace-pre-wrap break-words font-mono">
            {text}
          </code>
        </pre>
      )}
    </main>
  );
}
