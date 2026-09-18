// verify-offline-landing: the offline landing page's pin directory (ADR-193).
//
// Pure — no DB, no network, no env — so scripts/verify-ci.mjs discovers it and
// CI runs it on every PR and push to main.
//
// The service worker can't be exercised on localhost at all (its IS_DEV branch
// makes it a self-unregistering passthrough, the v6 reload-loop fix), so the
// landing page's real behavior is only ever verified by hand on a deploy. This
// guards the parts that CAN break silently in a commit:
//
//   1. The key filter. It is the whole feature: it picks one row per pinned
//      item out of a cache that also holds the bare /items/{id} twin and every
//      pinned image URL. The regex is READ BACK OUT of offline.html rather than
//      copied here, so this cannot drift from what actually ships.
//   2. The three-way contract between SaveOffline (what it pins, and the Date
//      header the rows read), print-html (the <title> the rows scrape), and the
//      page. Any one of these moving alone empties the list with no error.
//   3. The VERSION bump. offline.html is precached and served cache-first, so
//      an edit without a bump is invisible on every installed device.
import { readFileSync } from "node:fs";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) {
    pass++;
    console.log(`PASS  ${name}${detail ? `  (${String(detail)})` : ""}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? `  (${String(detail)})` : ""}`);
  }
}

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const offline = read("../public/offline.html");
const sw = read("../public/sw.js");
const saveOffline = read("../src/components/canvas/SaveOffline.tsx");
const printHtml = read("../src/lib/print-html.ts");

// --- 1. The key filter, extracted from the shipped page ----------------------
const declared = offline.match(/var PIN_KEY = (\/.*\/);/);
check("offline.html declares PIN_KEY as one regex literal", !!declared);

if (declared) {
  const PIN_KEY = new RegExp(declared[1].slice(1, -1));
  const classify = (url: string) => new URL(url).pathname.match(PIN_KEY);

  const id = "3f9c1a2e-0000-4000-8000-abcdefabcdef";
  const hit = classify(`https://ledgr.app/items/${id}/print`);
  check("the print key matches", !!hit);
  check("…and captures the item id", hit?.[1] === id, hit?.[1]);

  // Each of these lives in ledgr-pin-v1 alongside the print key. A regex loose
  // enough to match any of them shows a duplicate or a broken row.
  check(
    "the bare /items/{id} twin is skipped (this is the de-dupe)",
    !classify(`https://ledgr.app/items/${id}`)
  );
  check(
    "a cross-origin pinned image is skipped",
    !classify("https://pub-xyz.r2.dev/attachments/slide-1.png")
  );
  check(
    "a same-origin pinned image is skipped",
    !classify("https://ledgr.app/api/attachments/abc/raw")
  );
  check(
    "a deeper path ending in /print is skipped",
    !classify(`https://ledgr.app/items/${id}/x/print`)
  );
  check(
    "the app's own routes are skipped",
    !classify("https://ledgr.app/") && !classify("https://ledgr.app/today")
  );
}

// --- 2. The contract with the pin protocol and the print renderer ------------
check(
  "SaveOffline pins the exact URL shape the page links to",
  /`\/items\/\$\{itemId\}\/print`/.test(saveOffline)
);
check(
  "SaveOffline pins no query params (a variant would not match PIN_KEY)",
  !/\/print\?/.test(saveOffline)
);
check(
  "SaveOffline stamps a Date header for the row's date",
  /Date:\s*new Date\(\)\.toUTCString\(\)/.test(saveOffline)
);
check(
  "the page reads that Date header",
  /headers\.get\("date"\)/.test(offline)
);
// Brandon, 2026-08-14: order must come from the stamp, not from cache key
// order. A re-save cache.put()s over the same key, and only an explicit sort
// puts that row back at the top no matter how the browser orders keys().
check(
  "rows are sorted on the saved stamp, newest first",
  /\.sort\(function \(a, b\) \{\s*return b\.at - a\.at;/.test(offline)
);
check(
  "the page does not lean on reversed cache key order instead",
  !/keys\.length - 1; i >= 0/.test(offline)
);
check(
  "print-html still emits the <title> the rows scrape",
  /<title>\$\{safeTitle\}<\/title>/.test(printHtml)
);
check(
  "the page scrapes it with a tag-free capture",
  /<title>\(\[\^<\]\*\)<\\\/title>/.test(offline)
);

// --- 3. Self-containment and the precache bump -------------------------------
check(
  "the page's script is inline (no fetch it could not make offline)",
  !/<script[^>]+src=/.test(offline)
);
check("the page reads the pin cache by name", /"ledgr-pin-v1"/.test(offline));
check(
  "offline.html is still precached by the worker",
  /const PRECACHE = \[\s*OFFLINE_URL/.test(sw)
);
// v8 shipped the old dead-end page. Anything later means the landing page's
// precache was replaced at least once; going back to v8 or earlier would serve
// the old copy to every installed device.
{
  const version = sw.match(/const VERSION = "v(\d+)"/);
  check("sw.js VERSION is past v8 (the pre-landing-page precache)", Number(version?.[1]) > 8, version?.[0]);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log("All checks passed.");
