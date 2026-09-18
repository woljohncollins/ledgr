// Slice 33 verification: the type registry store — parse/validate of
// types + property schemas, the CRUD store, system-type protection, and the
// in-use delete guard. Against live Neon.
// Types are instance-global (no owner_id), so the script tracks the keys it
// creates and deletes them in finally. Run: npx tsx scripts/verify-types.mts
// Safe to delete once the slice is closed.
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) {
    process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

const { getDb } = await import("../src/db");
const { items, types, users } = await import("../src/db/schema");
const {
  parseTypeInput,
  parsePropertySchema,
  createType,
  getType,
  listTypes,
  updateType,
  deleteType,
  PROPERTY_KINDS,
} = await import("../src/lib/types");
const { ItemError } = await import("../src/lib/items");
const { eq, inArray } = await import("drizzle-orm");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}
async function throws(name: string, fn: () => Promise<unknown> | unknown, code?: string) {
  try {
    await fn();
    check(name, false, "did not throw");
  } catch (err) {
    const ok = err instanceof ItemError && (!code || err.code === code);
    check(name, ok, err instanceof Error ? err.message : String(err));
  }
}

const stamp = Date.now();
const k1 = `vt${stamp}`; // a clean user type
const k2 = `vtb${stamp}`; // a second, used to test the in-use delete guard
const createdKeys = [k1, k2];

const db = getDb();
const [tempUser] = await db
  .insert(users)
  .values({ email: `verify-types-${stamp}@example.invalid` })
  .returning({ id: users.id });
const ownerId = tempUser.id;

try {
  // --- parseTypeInput ---
  check("PROPERTY_KINDS has the scalar + option + relation kinds", PROPERTY_KINDS.length === 11);
  check("PROPERTY_KINDS includes relation", PROPERTY_KINDS.includes("relation"));
  check("PROPERTY_KINDS includes image", PROPERTY_KINDS.includes("image"));
  // phone/email (ADR-192): scalar text with a declared intent. Pinned here
  // because the kind list is the core contract in schema.md — a kind appearing
  // or vanishing should fail a test, not slip through.
  check("PROPERTY_KINDS includes phone", PROPERTY_KINDS.includes("phone"));
  check("PROPERTY_KINDS includes email", PROPERTY_KINDS.includes("email"));

  // --- relation kind validation (ADR-067 R1) ---
  {
    const [rel] = parsePropertySchema([
      { key: "author", label: "Author", kind: "relation", targetType: "person", cardinality: "single" },
    ]);
    check("relation field keeps targetType + cardinality", rel.kind === "relation" && rel.targetType === "person" && rel.cardinality === "single");
  }
  {
    const [rel] = parsePropertySchema([{ key: "refs", label: "References", kind: "relation" }]);
    check("relation defaults: targetType null (any), cardinality many", rel.targetType === null && rel.cardinality === "many");
  }
  {
    const [rel] = parsePropertySchema([
      { key: "att", label: "Attendees", kind: "relation", targetType: "Person", cardinality: "bogus" },
    ]);
    check("relation normalizes targetType lowercase + bad cardinality -> many", rel.targetType === "person" && rel.cardinality === "many");
  }
  await throws("relation rejects a non-slug targetType", () => parsePropertySchema([{ key: "x", label: "X", kind: "relation", targetType: "1bad" }]), "bad_request");
  await throws("relation rejects reserved key 'mention'", () => parsePropertySchema([{ key: "mention", label: "M", kind: "relation" }]), "bad_request");
  await throws("relation rejects reserved key 'related'", () => parsePropertySchema([{ key: "related", label: "R", kind: "relation" }]), "bad_request");
  {
    // A reserved key is fine for a NON-relation kind (it's not used as a role).
    const [scal] = parsePropertySchema([{ key: "related", label: "Related notes", kind: "text" }]);
    check("reserved key is allowed for a scalar kind", scal.kind === "text" && scal.key === "related");
  }
  await throws("rejects missing label", () => parseTypeInput({ key: "x" }, "create"), "bad_request");
  await throws("rejects missing key on create", () => parseTypeInput({ label: "X" }, "create"), "bad_request");
  await throws("rejects non-slug key", () => parseTypeInput({ key: "1bad", label: "X" }, "create"), "bad_request");
  await throws("rejects key with hyphen", () => parseTypeInput({ key: "a-b", label: "X" }, "create"), "bad_request");

  const created = parseTypeInput({ key: "Hiring", label: "  Hiring  " }, "create");
  check("lowercases the key", created.key === "hiring");
  check("trims the label", created.label === "Hiring");
  check("defaults showInQuickCapture true", created.showInQuickCapture === true);
  check("defaults icon null", created.icon === null);
  const optedOut = parseTypeInput({ key: "data", label: "Data", showInQuickCapture: false }, "create");
  check("honors showInQuickCapture false", optedOut.showInQuickCapture === false);

  // patch carries no key
  const patch = parseTypeInput({ label: "Renamed" }, "patch");
  check("patch parses without a key", !("key" in patch) && patch.label === "Renamed");

  // --- parsePropertySchema ---
  await throws("rejects non-array schema", () => parsePropertySchema({}), "bad_request");
  await throws("rejects unknown kind", () => parsePropertySchema([{ key: "a", label: "A", kind: "color" }]), "bad_request");
  await throws("rejects select with no options", () => parsePropertySchema([{ key: "s", label: "S", kind: "select" }]), "bad_request");
  await throws("rejects duplicate property keys", () =>
    parsePropertySchema([
      { key: "a", label: "A", kind: "text" },
      { key: "a", label: "A2", kind: "number" },
    ]), "bad_request");

  const schema = parsePropertySchema([
    { key: "Stage", label: "Stage", kind: "select", options: ["Applied", "Applied", " Interview ", ""] },
    { key: "salary", label: "Salary", kind: "number" },
    { key: "notes_url", label: "Notes URL", kind: "url" },
  ]);
  check("normalizes property key to lowercase", schema[0].key === "stage");
  check("dedupes + trims + drops empty options", JSON.stringify(schema[0].options) === JSON.stringify(["Applied", "Interview"]));
  check("strips options from non-option kinds", schema[1].options === undefined);
  check("preserves property order", schema.map((p) => p.key).join(",") === "stage,salary,notes_url");

  // --- store CRUD ---
  const t1 = await createType(parseTypeInput({
    key: k1,
    label: "Hiring Candidate",
    icon: "user-plus",
    propertySchema: [{ key: "stage", label: "Stage", kind: "select", options: ["Applied", "Interview", "Offer"] }],
  }, "create"));
  check("createType returns a user type", t1.key === k1 && t1.isSystem === false);
  check("createType stored the schema", t1.propertySchema[0].kind === "select" && t1.propertySchema[0].options?.length === 3);

  const fetched = await getType(k1);
  check("getType round-trips", fetched.key === k1 && fetched.label === "Hiring Candidate");

  await throws("createType rejects a duplicate key", () =>
    createType(parseTypeInput({ key: k1, label: "Dupe" }, "create")), "bad_request");

  const updated = await updateType(k1, parseTypeInput({
    label: "Candidate",
    icon: "user",
    showInQuickCapture: false,
    propertySchema: [
      { key: "stage", label: "Stage", kind: "select", options: ["Applied", "Interview", "Offer", "Hired"] },
      { key: "salary", label: "Target salary", kind: "number" },
    ],
  }, "patch"));
  check("updateType changed the label", updated.label === "Candidate");
  check("updateType toggled showInQuickCapture", updated.showInQuickCapture === false);
  check("updateType grew the schema", updated.propertySchema.length === 2);

  const list = await listTypes();
  check("listTypes includes the new type", list.some((t) => t.key === k1));
  check("listTypes sorts system types first", (() => {
    const firstUser = list.findIndex((t) => !t.isSystem);
    const lastSystem = list.map((t) => t.isSystem).lastIndexOf(true);
    return firstUser === -1 || lastSystem === -1 || lastSystem < firstUser;
  })());

  await throws("getType is not-found for unknown", () => getType(`nope${stamp}`), "not_found");

  // --- system-type protection (the five seeded rows must already exist) ---
  const note = await getType("note").catch(() => null);
  if (note) {
    check("note is a system type", note.isSystem === true);
    await throws("system types can't be deleted", () => deleteType("note"), "bad_request");
  } else {
    check("note system type present (run db:seed)", false, "no 'note' row");
  }

  // --- the `unmarked` placeholder type (ADR-067 R3) ---
  const unmarked = await getType("unmarked").catch(() => null);
  if (unmarked) {
    check("unmarked is a hidden system type", unmarked.isSystem === true && unmarked.hidden === true);
    check("unmarked is excluded from listTypes()", !(await listTypes()).some((t) => t.key === "unmarked"));
    check("unmarked shows when includeHidden", (await listTypes({ includeHidden: true })).some((t) => t.key === "unmarked"));
  } else {
    check("unmarked type present (run db:migrate / db:seed)", false, "no 'unmarked' row");
  }

  // --- in-use delete guard ---
  await createType(parseTypeInput({ key: k2, label: "Used Type" }, "create"));
  await db.insert(items).values({ ownerId, type: k2, title: "holds the type" });
  await throws("deleteType blocked while items use it", () => deleteType(k2), "bad_request");
  await db.delete(items).where(eq(items.type, k2));
  await deleteType(k2);
  // ADR-058: deleteType soft-deletes — the type drops out of listTypes/pickers
  // but getType still resolves it (so trashed items keep their label).
  check("deleted type is gone from listTypes", !(await listTypes()).some((t) => t.key === k2));
} finally {
  // items FK to users + types; delete items first, then the test types, then users.
  await db.delete(items).where(eq(items.ownerId, ownerId));
  await db.delete(types).where(inArray(types.key, createdKeys));
  await db.delete(users).where(eq(users.id, ownerId));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
