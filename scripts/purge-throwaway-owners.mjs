// Remove the throwaway owners that DB-backed verify scripts leave behind.
//
// Why this exists (next_steps, 2026-08-12): the verify suites create a scratch
// owner per run and never clean up, so a dev database accumulates them — 13 at the
// time of writing. Harmless, but actively confusing when hand-testing: some of
// their items look live, and a relate call against one 404s "item not found"
// because it belongs to an owner you aren't.
//
// DRY RUN BY DEFAULT. It prints the owners and the exact row counts it would
// remove, and changes nothing. Deleting requires --apply, spelled out, because
// this deletes rows outright rather than soft-deleting: these are not the owner's
// content, they're test residue, and Trash exists for real items. That makes it
// the one place in the app that hard-deletes, which is why it asks twice.
//
// The safety property that makes this safe at all: `.invalid` is a RESERVED TLD
// (RFC 2606) that can never be a real address, and the pattern additionally
// requires the `verify-` prefix. A real owner cannot match it.
//
//   node --env-file-if-exists=.env.local scripts/purge-throwaway-owners.mjs
//   node --env-file-if-exists=.env.local scripts/purge-throwaway-owners.mjs --apply
import { neon } from "@neondatabase/serverless";

const APPLY = process.argv.includes("--apply");
const PATTERN = "verify-%@example.invalid";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Run with --env-file-if-exists=.env.local");
  process.exit(1);
}
const sql = neon(process.env.DATABASE_URL);

const owners = await sql`
  SELECT id, email FROM users WHERE email LIKE ${PATTERN} ORDER BY email
`;
if (owners.length === 0) {
  console.log("No throwaway owners found. Nothing to do.");
  process.exit(0);
}

// Belt and braces: never touch an address that isn't unmistakably test residue,
// even if the LIKE above were ever loosened.
const SAFE = /^verify-[a-z0-9-]+-?\d*@example\.invalid$/i;
const unsafe = owners.filter((o) => !SAFE.test(o.email));
if (unsafe.length > 0) {
  console.error("Refusing to run: these matched the query but not the safety pattern:");
  for (const o of unsafe) console.error(`  ${o.email}`);
  process.exit(1);
}

const ids = owners.map((o) => o.id);

// Discover the owner-scoped tables from the catalog rather than hardcoding a list
// that would silently rot as tables are added — the same reasoning as the CI
// verify runner discovering its suites.
const ownerTables = (
  await sql`
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'owner_id'
    ORDER BY table_name
  `
).map((r) => r.table_name);

// Tables holding a FK to items(id): these must go before items itself, since
// nothing here declares ON DELETE CASCADE.
const itemChildren = (
  await sql`
    SELECT DISTINCT tc.table_name, kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
      AND ccu.table_name = 'items'
      AND ccu.column_name = 'id'
    ORDER BY tc.table_name
  `
).map((r) => ({ table: r.table_name, column: r.column_name }));

console.log(`${owners.length} throwaway owner(s):`);
for (const o of owners) console.log(`  ${o.email}`);
console.log(
  `\nowner-scoped tables: ${ownerTables.length}` +
    `   tables referencing items: ${itemChildren.length}`
);

// Count first, always — the dry run's whole job is showing the blast radius.
console.log("\nrows that would be removed:");
let total = 0;
for (const { table, column } of itemChildren) {
  const [{ n }] = await sql`
    SELECT count(*)::int AS n FROM ${sql.unsafe(`"${table}"`)}
    WHERE ${sql.unsafe(`"${column}"`)} IN (SELECT id FROM items WHERE owner_id = ANY(${ids}))
  `;
  if (n > 0) console.log(`  ${table}.${column}  ${n}`);
  total += n;
}
for (const table of ownerTables) {
  const [{ n }] = await sql`
    SELECT count(*)::int AS n FROM ${sql.unsafe(`"${table}"`)} WHERE owner_id = ANY(${ids})
  `;
  if (n > 0) console.log(`  ${table}  ${n}`);
  total += n;
}
console.log(`  users  ${owners.length}`);
total += owners.length;
// An UPPER BOUND, not an exact count: a table with two FKs to items (relations
// has both source_id and target_id) is counted once per column, and an edge whose
// two ends are both the owner's items is therefore counted twice. Deletion is
// still correct — it's set-based, so a row already gone simply isn't matched again.
console.log(`\ntotal: at most ${total} row(s) (tables with two item FKs may double-count)`);

if (!APPLY) {
  console.log("\nDRY RUN — nothing was changed. Re-run with --apply to delete.");
  process.exit(0);
}

// Deletion order is forced by the FKs: item children, then items, then the
// remaining owner-scoped tables, then the owner rows themselves.
console.log("\napplying…");
for (const { table, column } of itemChildren) {
  await sql`
    DELETE FROM ${sql.unsafe(`"${table}"`)}
    WHERE ${sql.unsafe(`"${column}"`)} IN (SELECT id FROM items WHERE owner_id = ANY(${ids}))
  `;
}
for (const table of ownerTables) {
  await sql`DELETE FROM ${sql.unsafe(`"${table}"`)} WHERE owner_id = ANY(${ids})`;
}
await sql`DELETE FROM users WHERE id = ANY(${ids})`;

const [{ n: left }] = await sql`
  SELECT count(*)::int AS n FROM users WHERE email LIKE ${PATTERN}
`;
console.log(`done. throwaway owners remaining: ${left}`);
