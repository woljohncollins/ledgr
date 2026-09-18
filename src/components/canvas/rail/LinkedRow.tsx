// The task rail's "Linked" row (ADR-253; given the Version History shape on
// Tyler's call, 2026-09-11).
//
// "+ Relate" used to float unlabelled under the body, and on a task with no links
// it was a bare button with no home. It moved here instead, beside Project / Tags
// / People, which are relation edges too: the rail is everything ABOUT the task,
// the main pane is the work.
//
// It reads as a disclosure rather than a flat count — a caret to open, the count
// as a chip — matching the VERSION HISTORY section, so the two collapsible things
// on an item behave the same way. The caret rotation and the chip are the
// existing `.cs-caret` / `.canvas-section-count` rules (globals.css), keyed off
// `details[open] > .canvas-section-summary`, so this adds no new CSS and inherits
// the section skin the owner picked.
//
// Titles only, on purpose: the "Linked here" panel in the main pane owns the rich
// rows (check-off, dates, unrelate, role grouping). A 248px rail can't carry those
// and shouldn't try to compete with them.
import Link from "next/link";
import { listRelatedItems } from "@/lib/relations";
import { RAIL_LABEL } from "./styles";
import AddRelation from "@/components/relations/AddRelation";

export default async function LinkedRow({
  ownerId,
  itemId,
}: {
  ownerId: string;
  itemId: string;
}) {
  // Same source as the panel below, so the count can never disagree with it.
  const related = await listRelatedItems(ownerId, itemId);
  const count = related.length;

  // The "+" sits outside the <summary> deliberately: a button inside a summary
  // toggles the disclosure when clicked, so opening the relate picker would also
  // expand the list.
  const add = (
    <span className="absolute right-0 top-0">
      <AddRelation itemId={itemId} rail />
    </span>
  );

  if (count === 0) {
    return (
      <div className="relative flex w-full flex-col gap-1">
        <span className={RAIL_LABEL}>Linked</span>
        <span className="text-sm text-ink-faint">Nothing linked</span>
        {add}
      </div>
    );
  }

  return (
    <div className="relative w-full">
      <details>
        <summary className="canvas-section-summary flex cursor-pointer list-none items-center gap-1.5 pr-6">
          <svg
            className="cs-caret shrink-0 text-ink-subtle"
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M9 6l6 6-6 6" />
          </svg>
          <span className={RAIL_LABEL}>Linked</span>
          <span className="canvas-section-count text-[11px]">{count}</span>
        </summary>
        <ul className="mt-1.5 flex flex-col gap-1 pl-[1.1rem]">
          {related.map((r) => (
            <li key={r.id} className="min-w-0">
              <Link
                href={`/items/${r.id}`}
                className="block truncate text-sm text-ink-muted transition-colors hover:text-[var(--accent)]"
              >
                {r.title || "Untitled"}
              </Link>
            </li>
          ))}
        </ul>
      </details>
      {add}
    </div>
  );
}
