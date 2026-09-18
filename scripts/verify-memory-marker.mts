// ADR-259 verification: the STALE / SUPERSEDED marker and the stump line that
// carries it. Pure functions only (no DB): memoryMarker and renderStumpIndex.
//   npx tsx scripts/verify-memory-marker.mts
import { memoryMarker, renderStumpIndex, type MemoryStump } from "../src/lib/memory";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

const NOW = Date.parse("2026-09-14T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000);

check("fresh seasonal: no marker", memoryMarker("seasonal", daysAgo(10), null, NOW) === "");
check("seasonal at 91 days: STALE", memoryMarker("seasonal", daysAgo(91), null, NOW) === ", STALE");
check("episodic at 91 days: STALE", memoryMarker("episodic", daysAgo(91), null, NOW) === ", STALE");
check("evergreen never STALE", memoryMarker("evergreen", daysAgo(900), null, NOW) === "");
check("unknown horizon never STALE", memoryMarker(null, daysAgo(900), null, NOW) === "");
const sup = { id: "new-id", date: "2026-09-13" };
check(
  "superseded renders date and new id",
  memoryMarker("seasonal", daysAgo(10), sup, NOW) === ", SUPERSEDED 2026-09-13 ->new-id"
);
check(
  "SUPERSEDED wins over STALE",
  memoryMarker("seasonal", daysAgo(400), sup, NOW) === ", SUPERSEDED 2026-09-13 ->new-id"
);

const stumps: MemoryStump[] = [
  {
    id: "old-id",
    title: "Production is the Tailscale hostname",
    kind: "reference",
    horizon: "evergreen",
    pinned: false,
    updatedAt: daysAgo(13),
    supersededBy: sup,
    linked: [],
  },
  {
    id: "stale-id",
    title: "Campus roster as of June",
    kind: "reference",
    horizon: "seasonal",
    pinned: false,
    updatedAt: daysAgo(100),
    supersededBy: null,
    linked: [],
  },
];
const rendered = renderStumpIndex(stumps, 2, NOW);
check(
  "stump line carries SUPERSEDED",
  rendered.includes("old-id [refr/ever] (2026-09-01, 13d ago, SUPERSEDED 2026-09-13 ->new-id) Production"),
  rendered.split("\n")[2]
);
check(
  "stump line carries STALE",
  rendered.includes("stale-id [refr/seas] (2026-06-06, 3mo ago, STALE) Campus roster"),
  rendered.split("\n")[3]
);

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall memory-marker checks passed");
