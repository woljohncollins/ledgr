// Verifies the tokenless web clipper (ADR-238): the bookmarklet carries no
// credential, saves through a same-origin relay popup, and survives the
// sign-in round trip. Pure, no DB/network.
//   npx tsx scripts/verify-clipper-tokenless.mts
import { readFileSync } from "node:fs";
import { buildBookmarklet } from "../src/components/build/ClipperSetup";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error(`  ✗ ${name}`);
  }
}

const ORIGIN = "https://ledgr.example.com";
const src = decodeURIComponent(buildBookmarklet(ORIGIN).replace(/^javascript:/, ""));

check("is a javascript: URL", buildBookmarklet(ORIGIN).startsWith("javascript:"));
check("opens the relay on Ledgr's own origin", src.includes(`${ORIGIN}/capture/relay`));
check("sends the page URL, title, and DOM", /url:location\.href/.test(src) && /title:document\.title/.test(src) && /outerHTML/.test(src));
check("posts to the relay's exact origin, never '*'", src.includes(`,"${ORIGIN}")`) && !src.includes('postMessage(d,"*")'));

// The whole point: nothing secret rides in the bookmark, so the same URL works
// for anyone and there is nothing to revoke.
check("carries no token field", !/token/i.test(src));
check("carries no bearer header", !/Bearer|Authorization/i.test(src));

// The popup may land on /sign-in first and announce itself only on a SECOND
// page load. A one-shot listener would be gone by then, so it must not remove
// itself — this is what makes "click it, sign in, it saves" work.
check(
  "answers every ready ping (not one-shot on ready)",
  src.includes("ledgr-relay-ready") &&
    !/ledgr-relay-ready"\)\s*(\{)?\s*window\.removeEventListener/.test(src)
);
// ...but exactly one clip per popup: once the relay says it saved, the opener
// stops answering, so a later page load in that popup can't re-send the clip
// and file a duplicate.
check(
  "retires the listener once the relay reports the save",
  /ledgr-relay-saved"\)\s*window\.removeEventListener\("message",\s*m\)/.test(src)
);

// Behavioural: run the bookmarklet against a fake window and count the sends.
// Two "ready" pings (the popup announcing itself twice) must still hand the
// clip over twice — that's the sign-in round trip — but once the relay reports
// the save, further pings are ignored.
{
  const sends: unknown[] = [];
  const handlers: ((e: unknown) => void)[] = [];
  const w = { postMessage: (d: unknown) => sends.push(d) };
  const fakeWindow = {
    open: () => w,
    addEventListener: (_t: string, h: (e: unknown) => void) => handlers.push(h),
    removeEventListener: (_t: string, h: (e: unknown) => void) => {
      const i = handlers.indexOf(h);
      if (i >= 0) handlers.splice(i, 1);
    },
  };
  const fakeDoc = { title: "T", documentElement: { outerHTML: "<html></html>" } };
  const send = (data: unknown) => [...handlers].forEach((h) => h({ source: w, data }));

  new Function("window", "document", "location", "alert", src)(
    fakeWindow,
    fakeDoc,
    { href: "https://example.com/a" },
    () => {}
  );

  send("ledgr-relay-ready");
  send("ledgr-relay-ready");
  check("re-sends the clip on a repeat ready (sign-in round trip)", sends.length === 2);
  send("ledgr-relay-saved");
  send("ledgr-relay-ready");
  check("sends nothing more once the relay reports the save", sends.length === 2);
}
check("warns when the popup is blocked", /allow pop-ups/i.test(src));

// Structural tripwires: the two files the credential-free path depends on.
const relay = readFileSync("src/app/capture/relay/page.tsx", "utf8");
// Matches the header as CODE (a backticked Bearer value), so the comment
// explaining its absence doesn't trip the check.
check("relay sends no Authorization header", !/Authorization:\s*`/.test(relay));
check("relay posts to the capture route", relay.includes("/api/machine/capture"));
check("relay tells a signed-out clipper what to do", /sign in to Ledgr/.test(relay));
// The latch that closes the other half of the double-save: however many times
// this page is handed the clip, it POSTs once.
check("relay files a clip at most once per popup", /saved\.current/.test(relay));
check("relay tells the opener the clip is filed", relay.includes("ledgr-relay-saved"));

const route = readFileSync("src/app/api/machine/capture/route.ts", "utf8");
check("capture route falls back to the session owner", /resolveOwner\(\)/.test(route));
check("capture route still accepts a machine token first", /verifyApiRequest/.test(route));
check(
  "capture route never sets Allow-Credentials (open CORS must stay cookie-free)",
  !/"Access-Control-Allow-Credentials"/.test(route)
);
// The half the client can't guarantee: a bookmark in the owner's bar is a
// frozen copy of the bookmarklet, so an older one still re-hands the clip to a
// second relay page load and that fresh page has a fresh latch. The route
// refuses the repeat. Behaviour is covered by verify-capture-dedupe.mts.
check(
  "capture route refuses a repeat of the same URL",
  /recentCaptureId\(ownerId, url\)/.test(route)
);
check("relay says so when the clip was already filed", /duplicate/.test(relay));

const shareLib = readFileSync("src/lib/capture/share.ts", "utf8");
check(
  "the share/claim path shares that same guard",
  /recentCaptureId\(ownerId, url\)/.test(shareLib)
);

console.log(`${pass} passed, ${fail} failed`);
process.exitCode = fail > 0 ? 1 : 0;
