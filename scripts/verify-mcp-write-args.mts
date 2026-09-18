// Verification: the MCP write-arg guard in buildWriteRaw + the `body` alias in
// optBodyMarkdown. The tool schemas declare additionalProperties:false but the
// transport never validates args, so these two are the enforcement point: an
// unknown key must throw a bad_request naming it (with a did-you-mean for the
// body mis-names), and `body` — the name callers actually guess — must be
// honoured as bodyMarkdown instead of being dropped into an empty note (the
// observed failure, twice: 2026-08-19, 2026-08-22). Pure (no DB, no server).
// Run:
//   npx tsx scripts/verify-mcp-write-args.mts
import { existsSync, readFileSync } from "node:fs";

// Pure test — no env needed — but load .env.local when present so it runs the
// same way the DB-backed verifies do.
if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

const { buildWriteRaw, optBodyMarkdown } = await import("../src/lib/mcp/tools/args");
const { ItemError } = await import("../src/lib/items");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

// Expect buildWriteRaw to throw a bad_request whose message satisfies `want`.
function rejects(
  name: string,
  args: Record<string, unknown>,
  extra: string[],
  handlerKeys: string[],
  want: (msg: string) => boolean
) {
  try {
    buildWriteRaw(args, extra, handlerKeys);
    check(name, false, "did not throw");
  } catch (e) {
    const isItemError = e instanceof ItemError && e.code === "bad_request";
    const msg = e instanceof Error ? e.message : String(e);
    check(name, isItemError && want(msg), msg);
  }
}

console.log("\n# unknown keys rejected (the silent-drop bug)");
rejects(
  "update_item content → suggests bodyMarkdown",
  { id: "00000000-0000-0000-0000-000000000000", content: "y" },
  ["propertyPatch"],
  ["id"],
  (m) => m.includes('"content"') && m.includes("bodyMarkdown")
);
rejects(
  "text and markdown both hint at bodyMarkdown",
  { type: "note", text: "a", markdown: "b" },
  ["type"],
  [],
  (m) => m.split("bodyMarkdown").length >= 3
);
rejects(
  "a plain typo is named without a hint",
  { type: "task", duedate: "2026-08-19" },
  ["type"],
  [],
  (m) => m.includes('"duedate"') && !m.includes("did you mean")
);
rejects(
  "message lists the accepted fields",
  { type: "note", bodyText: "y" },
  ["type"],
  [],
  (m) => m.includes("accepted fields:") && m.includes("bodyMarkdown") && m.includes("dueDate")
);

console.log("\n# `body` is an alias, not an unknown key (the empty-note bug)");
{
  const raw = buildWriteRaw({ type: "note", title: "x", body: "y" }, ["type"], ["relateTo"]);
  check("create_item body lands as the body", (raw.body as { text?: string })?.text === "y");
}
{
  const raw = buildWriteRaw(
    { id: "00000000-0000-0000-0000-000000000000", body: "y" },
    ["propertyPatch"],
    ["id"]
  );
  check("update_item body lands as the body", (raw.body as { text?: string })?.text === "y");
}
{
  const raw = buildWriteRaw({ type: "note", bodyMarkdown: "real", body: "alias" }, ["type"], []);
  check("bodyMarkdown wins when both are passed", (raw.body as { text?: string })?.text === "real");
}
check(
  "the alias reaches the hand-parsed tools too (remember, add_to_record)",
  optBodyMarkdown({ body: "y" }) === "y" && optBodyMarkdown({ bodyMarkdown: "y" }) === "y"
);
check("no body at all stays undefined", optBodyMarkdown({ title: "x" }) === undefined);
{
  // The REST body shape is NOT the alias — say so instead of silently dropping.
  let msg = "";
  try {
    optBodyMarkdown({ body: { format: "markdown", text: "y" } });
  } catch (e) {
    msg = e instanceof ItemError && e.code === "bad_request" ? e.message : `wrong error: ${e}`;
  }
  check("a non-string body is a clear error", msg.includes("bodyMarkdown"), msg);
}
check(
  "nested entries get their path in the error",
  (() => {
    try {
      optBodyMarkdown({ bodyMarkdown: 3 }, "subtasks[2].");
      return false;
    } catch (e) {
      return e instanceof Error && e.message.startsWith("subtasks[2].bodyMarkdown");
    }
  })()
);

console.log("\n# legit calls still pass");
{
  const raw = buildWriteRaw(
    { type: "note", title: "x", bodyMarkdown: "y" },
    ["type"],
    ["relateTo"]
  );
  check("bodyMarkdown becomes body", (raw.body as { text?: string })?.text === "y");
  check("title carries over", raw.title === "x");
}
{
  const raw = buildWriteRaw(
    {
      type: "task",
      title: "t",
      dueDate: "2026-08-19",
      urgency: 2,
      properties: { campus: "north" },
      parentId: "00000000-0000-0000-0000-000000000000",
      relateTo: ["00000000-0000-0000-0000-000000000001"],
      inbox: true,
    },
    ["type"],
    ["relateTo"]
  );
  check(
    "task fields carry over",
    raw.dueDate === "2026-08-19" && raw.urgency === 2 && raw.inbox === true
  );
  check("handler key relateTo is allowed but NOT copied", !("relateTo" in raw));
}
{
  const raw = buildWriteRaw(
    { id: "00000000-0000-0000-0000-000000000000", propertyPatch: { k: "v" } },
    ["propertyPatch"],
    ["id"]
  );
  check(
    "update: propertyPatch carries, id allowed but not copied",
    (raw.propertyPatch as Record<string, string>)?.k === "v" && !("id" in raw)
  );
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
