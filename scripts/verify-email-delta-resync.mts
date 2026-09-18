// Email import recovers when Microsoft expires its delta token (2026-08-29).
//
// Graph hands back a delta token meaning "tell me what changed since here".
// It expires — after about 30 days, or whenever the mailbox's own sync state
// rolls over — and Graph then answers 410 "resync required". Ledgr used to
// keep the dead token and ask the same rejected question every ten minutes
// forever; email import was down from 2026-08-24 to 2026-08-29 that way, and
// could not recover without a person clearing the token by hand.
//
// Pure: it drives GraphMailSource with its two network seams stubbed, so it
// needs no mailbox, no Graph credentials and no database.
//
// Run: npx tsx scripts/verify-email-delta-resync.mts
import { GraphError } from "../src/lib/graph/client";
import { GraphMailSource } from "../src/lib/email/graph-source";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

const FRESH = /messages\/delta\?\$select=/;

// A source whose folder lookup and delta walk are both stubbed. `walk` records
// every URL it is asked for, so the test can assert WHAT was retried, not just
// that something was.
function stubbed(walk: (url: string) => Promise<{ messages: unknown[]; nextDeltaToken: string | null }>) {
  const src = new GraphMailSource("someone@example.com");
  const asAny = src as unknown as Record<string, unknown>;
  asAny.resolveFolders = async () => ({ importId: "IMPORT", importedId: "DONE" });
  asAny.walkDelta = async (url: string) => walk(url);
  return src;
}

const asked: string[] = [];
const gone = new GraphError("Graph GET 410: The sync state generation is not found", "request", 410);

{
  asked.length = 0;
  // A live token walks once and is never re-read from the top.
  const src = stubbed(async (url) => {
    asked.push(url);
    return { messages: [{ id: "a" }], nextDeltaToken: "token-2" };
  });
  const out = await src.listNewMessages("token-1");
  check("a live token is walked exactly once", asked.length === 1, asked.join(" , "));
  check("it walks from the token, not from scratch", asked[0] === "token-1");
  check("the advanced token comes back", out.nextDeltaToken === "token-2");
}

{
  asked.length = 0;
  // The whole point: 410 on the stored token, then a full read of the folder.
  const src = stubbed(async (url) => {
    asked.push(url);
    if (url === "expired") throw gone;
    return { messages: [{ id: "b" }], nextDeltaToken: "token-fresh" };
  });
  const out = await src.listNewMessages("expired");
  check("an expired token is retried, not surrendered to", asked.length === 2);
  check("the retry reads the folder whole", FRESH.test(asked[1] ?? ""), asked[1] ?? "none");
  check("a fresh token replaces the dead one", out.nextDeltaToken === "token-fresh");
  check(
    "only the retry's messages survive — a part-done walk contributes nothing",
    out.messages.length === 1
  );
}

{
  asked.length = 0;
  // A 410 on the FRESH read is a real failure. Retrying it again would be an
  // endless loop, which is the failure mode this file exists to end.
  const src = stubbed(async (url) => {
    asked.push(url);
    throw gone;
  });
  let threw = false;
  try {
    await src.listNewMessages("expired");
  } catch {
    threw = true;
  }
  check("it retries once and then gives up, never loops", asked.length === 2 && threw);
}

{
  asked.length = 0;
  // Any other Graph failure must surface. Swallowing a 403 into a full re-read
  // would turn a permissions problem into a silent, expensive no-op.
  const denied = new GraphError("Graph GET 403", "request", 403);
  const src = stubbed(async (url) => {
    asked.push(url);
    throw denied;
  });
  let caught: unknown = null;
  try {
    await src.listNewMessages("token-1");
  } catch (err) {
    caught = err;
  }
  check("a non-410 failure is not treated as a resync", asked.length === 1 && caught === denied);
}

{
  asked.length = 0;
  // No token at all (a first run) already reads the folder whole, and must not
  // pay for a doomed first attempt to get there.
  const src = stubbed(async (url) => {
    asked.push(url);
    return { messages: [], nextDeltaToken: "token-1" };
  });
  await src.listNewMessages(null);
  check("a first run goes straight to the full read", asked.length === 1 && FRESH.test(asked[0]));
}

console.log(failures === 0 ? "\nAll email delta-resync checks passed." : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
