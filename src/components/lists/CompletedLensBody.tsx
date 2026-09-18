// The "Completed" tab's body (Tyler, 2026-08-25): finished work, searchable.
//
// This is the other half of letting a board hide completed work. The kanban's
// Done column collapses to a rail so a board reads as live work, and a finished
// project stops cluttering every list — which is only safe because everything
// that leaves the board is still one tab away and findable by name months later
// ("how did the Reception TV project actually go?").
//
// Rows are rendered HERE, on the server, and handed to SearchableList as nodes,
// so a completed project looks exactly like a live one (the same rich card, its
// people, counts, progress and Timeline link) while the search box stays instant
// and client-side. A non-project type falls back to a plain titled row, so the
// tab works for any type the owner adds it to rather than being project-only.
import Link from "next/link";
import {
  ProjectCardBody,
  projectCardFrameClass,
} from "@/components/projects/ProjectCardGrid";
import SearchableList, { type SearchableRow } from "@/components/lists/SearchableList";
import { projectCardsForView } from "@/lib/project-cards";
import type { ViewLensData } from "@/lib/view-render";

function plural(word: string): string {
  if (/(s|x|z|ch|sh)$/.test(word)) return `${word}es`;
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

// A completed row's date line: when it was last touched, which for a finished
// record is effectively when it was finished.
const dateFmt = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

export default async function CompletedLensBody({
  data,
  ownerId,
  typeLabel,
}: {
  data: ViewLensData;
  ownerId: string;
  // For the empty state and the search placeholder ("Search completed
  // projects…"), lowercased from the type's own label so it reads right for any
  // type rather than saying "items".
  typeLabel: string;
}) {
  // A type's label is singular ("Project"), and this tab talks about a set of
  // them. Naive pluralization on purpose — the same rule the project cards and
  // the sweep summary already use, so the wording stays consistent across the
  // app rather than one surface being cleverer than the others.
  const noun = plural(typeLabel.toLowerCase());
  const cards = await projectCardsForView(ownerId, data.view, data.items);

  const rows: SearchableRow[] = data.items.map((item) => {
    const card = cards?.byId[item.id];
    if (card) {
      return {
        id: item.id,
        title: item.title || "Untitled",
        node: (
          <div
            className={`relative rounded-xl border p-4 transition-colors ${projectCardFrameClass(
              card.favorited
            )}`}
          >
            <ProjectCardBody card={card} config={cards.config} />
          </div>
        ),
      };
    }
    return {
      id: item.id,
      title: item.title || "Untitled",
      node: (
        <Link
          href={`/items/${item.id}`}
          className="flex items-center justify-between gap-2 rounded px-2 py-1.5 hover:bg-surface-2"
        >
          <span className={`truncate ${item.title ? "text-ink" : "text-ink-faint"}`}>
            {item.title || "Untitled"}
          </span>
          <span className="ui-meta shrink-0 text-ink-faint">
            {dateFmt.format(item.updatedAt)}
          </span>
        </Link>
      ),
    };
  });

  return (
    <SearchableList
      rows={rows}
      total={data.count}
      layout={cards ? "grid" : "list"}
      placeholder={`Search completed ${noun}…`}
      emptyLabel={`No completed ${noun} yet. Mark one done and it lands here.`}
    />
  );
}
