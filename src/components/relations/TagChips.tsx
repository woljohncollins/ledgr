// Tag chips for a list row (Tyler, 2026-08-12: "add tags to tasks and have them
// show on the task to the left of it somewhere"). Read-only — editing a row's tags
// happens on the item canvas's Tags field (ADR-067/094). This is the at-a-glance
// half: what is this task about, without opening it.
//
// Tags are `relations` edges with role "tags" pointing at `tag` items, so a chip
// links to the tag itself. That makes a chip a real navigation affordance (open the
// tag, see everything wearing it) rather than decoration, and it costs nothing —
// the batched read already carries each tag's id and title.
//
// Server component: no state, no handlers, so it stays out of the client bundle on
// every task list that renders it.
import Link from "next/link";

export type TagRef = { id: string; title: string };

export default function TagChips({
  tags,
  max = 3,
  className = "",
}: {
  tags: TagRef[];
  // Cap the chips so a heavily-tagged row can't push the title out of the row.
  // The overflow count stays visible, so the row never lies about how many there
  // are — same discipline as badgeCount() capping a number instead of hiding it.
  max?: number;
  className?: string;
}) {
  if (tags.length === 0) return null;
  const shown = tags.slice(0, max);
  const extra = tags.length - shown.length;

  return (
    // `shrink-0` on the group, `truncate` per chip: the row's title owns the
    // flexible space, and a long tag name shortens itself instead of the title.
    <span className={`flex shrink-0 items-center gap-1 ${className}`}>
      {shown.map((t) => (
        <Link
          key={t.id}
          href={`/items/${t.id}`}
          title={t.title || "Untitled tag"}
          className="max-w-[8rem] truncate rounded border border-line px-1.5 text-xs text-ink-subtle hover:border-line-strong hover:text-ink-muted"
        >
          {t.title || "Untitled"}
        </Link>
      ))}
      {extra > 0 && (
        <span
          className="text-xs text-ink-faint"
          title={tags.slice(max).map((t) => t.title || "Untitled").join(", ")}
        >
          +{extra}
        </span>
      )}
    </span>
  );
}
