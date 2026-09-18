// SVG glyphs for the item actions menu (ItemActionsMenu) and its template
// buttons. House style: 24x24, stroke 1.8, currentColor, round — the same svg
// wrapper NavGlyph uses. This set is UI chrome (favorite, lock, layout grid,
// related-graph, type-swap, template ±/✓), not user-pickable nav destinations,
// so it lives here rather than in NAV_ICONS/the Build icon picker. All icons are
// SVG, never emoji (the standing house rule).
import type { ReactNode } from "react";

export const ACTION_ICONS = {
  // Favorites toggle: outline = add, filled = remove.
  starOutline:
    '<path d="M12 2.5l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3.1-5.8 3.1 1.1-6.5-4.7-4.6 6.5-.9z"/>',
  starFilled:
    '<path fill="currentColor" d="M12 2.5l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3.1-5.8 3.1 1.1-6.5-4.7-4.6 6.5-.9z"/>',
  // Lock toggle: closed shackle = lock, open shackle = unlock.
  lockClosed:
    '<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/><path d="M12 14v2.5"/>',
  lockOpen:
    '<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 7.7-1.6"/><path d="M12 14v2.5"/>',
  // Customize layout — a 3x3 grid.
  grid:
    '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 9.33h16M4 14.66h16M9.33 4v16M14.66 4v16"/>',
  // Explore related — a hub-and-spoke node graph.
  network:
    '<circle cx="12" cy="12" r="2.4"/><circle cx="12" cy="4.5" r="1.8"/><circle cx="5" cy="18" r="1.8"/><circle cx="19" cy="18" r="1.8"/><path d="M12 9.6V6.3M10.4 13.5 6.2 16.6M13.6 13.5l4.2 3.1"/>',
  // Move to Trash — a trash can (lid, handle, body, two ribs).
  trash:
    '<path d="M4 7h16"/><path d="M10 4h4a1 1 0 0 1 1 1v2H9V5a1 1 0 0 1 1-1z"/><path d="M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13"/><path d="M10 11v6M14 11v6"/>',
  // Change type — opposing swap arrows.
  swap: '<path d="M4 9h12"/><path d="M13 6l3 3-3 3"/><path d="M20 15H8"/><path d="M11 12l-3 3 3 3"/>',
  // Make subtask of — an arrow turning down into an indented child row.
  subtask: '<path d="M6 5v7a3 3 0 0 0 3 3h9"/><path d="M15 12l3 3-3 3"/>',
  // View full markdown — angle brackets over a slash, the conventional "source"
  // glyph. Reads as "the underlying text," distinct from `grid` (arrange) and
  // `network` (relations) beside it in the menu.
  markdown: '<path d="M8.5 8.5 5 12l3.5 3.5"/><path d="M15.5 8.5 19 12l-3.5 3.5"/><path d="M13.5 5.5l-3 13"/>',
  // Template pair: a page with a + badge (save) or a ✓ badge (apply).
  templateSave:
    '<rect x="3" y="3" width="11" height="16" rx="2"/><path d="M3 8h11"/><path d="M6 12h5M6 15h3"/><path d="M18.5 14v6M15.5 17h6"/>',
  templateApply:
    '<rect x="3" y="3" width="11" height="16" rx="2"/><path d="M3 8h11"/><path d="M6 12h5M6 15h3"/><path d="M15.5 17.5l2 2 4-4"/>',
  // Listen (read-aloud) — a speaker with two sound-wave arcs.
  speaker:
    '<path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/><path d="M19 6a8.5 8.5 0 0 1 0 12"/>',
} as const;

export type ActionIconKey = keyof typeof ACTION_ICONS;

// One action-menu glyph. Presentational and hook-free (renders on server or
// client), mirroring NavGlyph — an unknown key would be a compile error since
// `icon` is keyed to ACTION_ICONS.
export default function ActionGlyph({
  icon,
  size = 16,
  className,
}: {
  icon: ActionIconKey;
  size?: number;
  className?: string;
}): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className ?? ""}`}
      aria-hidden
      focusable={false}
      dangerouslySetInnerHTML={{ __html: ACTION_ICONS[icon] }}
    />
  );
}
