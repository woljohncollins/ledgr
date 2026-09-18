// Verifies that a nav write cannot silently re-icon the owner's toolbar.
//
// Why this script exists: twice (2026-09-14, 2026-09-17) every slot in the
// owner's nav came back wearing the generic bullet-list glyph after an MCP
// caller added ONE destination. The mechanism is quiet by design —
// parseNavDestination stamps a missing `icon` with NAV_ICON_FALLBACK rather
// than refusing the slot, and update_nav replaces the whole list — so a caller
// that reads the nav lossily and writes it back destroys every icon and never
// errors. keepNavPresentation closes that at the one seam all nav writes pass
// through (updateSettings), which is why the guard is tested here rather than
// in any single caller.
//
//   npx tsx scripts/verify-nav-presentation.mts
import { keepNavPresentation, type NavSlotConfig } from "../src/lib/settings";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : `  (${String(detail)})`}`);
  if (!ok) failures++;
}

const current: NavSlotConfig[] = [
  { type: "destination", kind: "builtin", href: "/inbox", label: "Inbox", icon: "inbox", badge: "inbox" },
  { type: "destination", kind: "type", href: "/list/sermon", label: "Teaching", icon: "sermon" },
  { type: "tools", label: "Build", icon: "tools", children: [
    { kind: "builtin", href: "/build/types", label: "Types", icon: "layers" },
  ] },
];

// The exact failure: a caller resends the list it read, minus the icons, and
// adds one new slot.
const lossy = [
  { type: "destination", kind: "builtin", href: "/inbox", label: "Inbox" },
  { type: "destination", kind: "type", href: "/list/sermon", label: "Teaching" },
  { type: "tools", label: "Build", children: [
    { kind: "builtin", href: "/build/types", label: "Types" },
  ] },
  { type: "destination", kind: "builtin", href: "/notes", label: "Notes", icon: "notes" },
];
const kept = keepNavPresentation(lossy, current) as Record<string, unknown>[];
check("an omitted icon keeps the slot's current one", kept[0].icon === "inbox", kept[0].icon);
check("a type slot keeps its icon too", kept[1].icon === "sermon", kept[1].icon);
check("an omitted badge is kept as well", kept[0].badge === "inbox", kept[0].badge);
check("a tools group keeps its icon", kept[2].icon === "tools", kept[2].icon);
check(
  "a tools child keeps its icon",
  (kept[2].children as Record<string, unknown>[])[0].icon === "layers"
);
check("a brand-new slot keeps the icon it was sent", kept[3].icon === "notes", kept[3].icon);

// A deliberate icon change must still win, or the guard would freeze the nav.
const changed = keepNavPresentation(
  [{ type: "destination", kind: "builtin", href: "/inbox", label: "Inbox", icon: "bell" }],
  current
) as Record<string, unknown>[];
check("an explicitly sent icon overrides the kept one", changed[0].icon === "bell", changed[0].icon);

// Nothing to carry over from: pass through untouched, parse still defaults.
check("a null/mirroring phone list passes through", keepNavPresentation(null, current) === null);
check("no current slots means no carry-over", (keepNavPresentation(lossy, []) as unknown[])[0] === lossy[0]);

// An unknown icon key is not a valid ref, so it must fall back to the stored
// one rather than being carried into the nav and rendering as the bullet glyph.
const bogus = keepNavPresentation(
  [{ type: "destination", kind: "builtin", href: "/inbox", label: "Inbox", icon: "not_an_icon" }],
  current
) as Record<string, unknown>[];
check("an invalid icon key falls back to the stored one", bogus[0].icon === "inbox", bogus[0].icon);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
