// Idempotent seed: the five system type rows and the single v1 user row.
// Run via: npm run db:seed (loads .env / .env.local if present).
// Safe to re-run; every insert is ON CONFLICT DO NOTHING.
import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. See .env.example.");
  process.exit(1);
}
const hostname = new URL(url).hostname;
if (hostname.endsWith(".neon.tech") && !hostname.includes("-pooler")) {
  console.error(
    "DATABASE_URL must be the Neon pooler connection string (runbook.md §1)."
  );
  process.exit(1);
}

const sql = neon(url);

const systemTypes = [
  ["task", "Task", "check-square"],
  ["event", "Event", "users"],
  ["note", "Note", "file-text"],
  ["link", "Link", "link"],
  ["person", "Person", "user"],
];

for (const [key, label, icon] of systemTypes) {
  await sql`
    INSERT INTO types (key, label, icon, is_system)
    VALUES (${key}, ${label}, ${icon}, true)
    ON CONFLICT (key) DO NOTHING
  `;
}

// The `transcript` child type (meeting recording v1a, ADR-087): a meeting's
// transcript is its own item (parent_id = the meeting), is_system + visible but
// show_in_quick_capture=false. Its `minutes` select (none|draft|done) is the
// "needs minutes" signal the awaiting-minutes view filters on. Mirrors
// drizzle/0023_meeting_transcript_type.sql for fresh databases.
await sql`
  INSERT INTO types (key, label, icon, is_system, show_in_quick_capture, property_schema)
  VALUES (
    'transcript', 'Transcript', 'file-text', true, false,
    '[{"key": "minutes", "label": "Minutes", "kind": "select", "options": ["none", "draft", "done"]}]'::jsonb
  )
  ON CONFLICT (key) DO NOTHING
`;

// The `unmarked` placeholder type (ADR-067): hidden + system, label is a glyph.
// create-on-miss makes items of this type (inbox=true) when the target type is
// unknown; the user never reads the word "unmarked" (the key is code-facing).
// Mirrors drizzle/0018_unmarked_type.sql for fresh databases.
await sql`
  INSERT INTO types (key, label, icon, is_system, show_in_quick_capture, hidden)
  VALUES ('unmarked', '◌', NULL, true, false, true)
  ON CONFLICT (key) DO NOTHING
`;

// The `tag` type (ADR-094 E2): an ordinary, non-privileged grouping type
// (is_system=false, not in quick capture). Tagging is a relations edge pointed
// at a tag item; the `tags` relation field below makes it ergonomic. Mirrors
// drizzle/0028_tag_type_and_tags_field.sql for fresh databases.
await sql`
  INSERT INTO types (key, label, icon, is_system, show_in_quick_capture, hidden)
  VALUES ('tag', 'Tag', 'tag', false, false, false)
  ON CONFLICT (key) DO NOTHING
`;

// A built-in `tags` relation field (targetType=tag, cardinality=many) on the
// three content types, so fresh installs get ergonomic tagging (chip box +
// create-on-miss makes a tag). Merge-safe + idempotent: append only when the
// type has no `tags` field yet.
await sql`
  UPDATE types
  SET property_schema = COALESCE(property_schema, '[]'::jsonb)
    || '[{"key":"tags","label":"Tags","kind":"relation","targetType":"tag","cardinality":"many"}]'::jsonb
  WHERE key IN ('task', 'event', 'note')
    AND NOT (COALESCE(property_schema, '[]'::jsonb) @> '[{"key":"tags"}]'::jsonb)
`;

// The `project` type: the flagship widget-composed hub (Project Type, ADR-111).
// Fresh installs get the PRD §5 workflow-agnostic statuses (Planning/Active/On
// Hold/Done); a new project starts at Planning (initialStatusKey, ADR-111/PJ2).
// Existing instances keep their own buckets — migration 0035 only adopts this
// default where the project type is unused, else fixes the category mapping.
// Configurable per instance via the type's status editor (ADR-082).
await sql`
  INSERT INTO types (key, label, icon, is_system, show_in_quick_capture, hidden, status_mode, status_schema, property_schema, capability)
  VALUES (
    'project', 'Project', 'project', false, true, false, 'select',
    '[{"key":"planning","label":"Planning","category":"not_started","color":"#64748b","isDefault":true},{"key":"active","label":"Active","category":"in_progress","color":"#d97706"},{"key":"on_hold","label":"On Hold","category":"not_started","color":"#6b7280"},{"key":"done","label":"Done","category":"done","color":"#16a34a","isDefault":true}]'::jsonb,
    '[{"key":"repo","label":"Repo URL","kind":"url"},{"key":"liveurl","label":"Live URL","kind":"url"},{"key":"stack","label":"Stack","kind":"text"}]'::jsonb,
    'widget-home'
  )
  ON CONFLICT (key) DO NOTHING
`;
// The project type renders through the widget canvas (ADR-111). Idempotent for
// instances seeded before the capability existed (mirrors migration 0036).
await sql`UPDATE types SET capability = 'widget-home' WHERE key = 'project' AND capability IS NULL`;
// Give the project type its own glyph (2026-07-01). Only replaces the old
// 'folder' default so a hand-picked icon is never clobbered.
await sql`UPDATE types SET icon = 'project' WHERE key = 'project' AND icon = 'folder'`;

// The milestone type (ADR-111/PJ5): a polymorphic collection item with no
// done-state; date = due_date, upcoming/passed derived. Hidden, out of quick
// capture, status_mode none. Mirrors migration 0037.
await sql`
  INSERT INTO types (key, label, icon, is_system, show_in_quick_capture, hidden, status_mode, property_schema)
  VALUES ('milestone', 'Milestone', 'flag', true, false, true, 'none', '[]'::jsonb)
  ON CONFLICT (key) DO NOTHING
`;

// The pursuit type (ADR-111/PJ9): a widget-composed Type one scope up — contains
// Projects, rolls them up. Mirrors migration 0038.
await sql`
  INSERT INTO types (key, label, icon, is_system, show_in_quick_capture, hidden, status_mode, status_schema, capability)
  VALUES (
    'pursuit', 'Pursuit', 'target', false, true, false, 'select',
    '[{"key":"planning","label":"Planning","category":"not_started","color":"#64748b","isDefault":true},{"key":"active","label":"Active","category":"in_progress","color":"#d97706"},{"key":"on_hold","label":"On Hold","category":"not_started","color":"#6b7280"},{"key":"done","label":"Done","category":"done","color":"#16a34a","isDefault":true}]'::jsonb,
    'widget-home'
  )
  ON CONFLICT (key) DO NOTHING
`;

// Per-type status DISPLAY MODE (ADR-106), idempotent + mirrors migration 0032.
// Status is opt-in: rows left NULL resolve to 'none' (no status affordance) via
// resolveStatusMode. `task` is the binary done/undone default; any type with a
// custom status_schema (project + user types) is 'select' so it keeps its
// statuses. WHERE status_mode IS NULL so a later user choice is never clobbered.
await sql`UPDATE types SET status_mode = 'checkbox' WHERE key = 'task' AND status_mode IS NULL`;
await sql`UPDATE types SET status_mode = 'select' WHERE status_schema IS NOT NULL AND status_mode IS NULL`;

// A built-in `project` relation field on `task` (targetType=project, single).
await sql`
  UPDATE types
  SET property_schema = COALESCE(property_schema, '[]'::jsonb)
    || '[{"key":"project","label":"Project","kind":"relation","targetType":"project","cardinality":"single"}]'::jsonb
  WHERE key = 'task'
    AND NOT (COALESCE(property_schema, '[]'::jsonb) @> '[{"key":"project"}]'::jsonb)
`;

// The `memory` type (AI Memory subsystem, ADR-137): the durable, linkable store
// an AI assistant reads over MCP. Bespoke + user-controllable, on the default
// canvas; the Related panel is the serendipity graph. kind/horizon/pinned drive
// the always-on "stump" index. hidden=true keeps it out of every Work surface
// and the generic MCP list_types (an AI/system concern, not "normal work"), while
// getType still renders /list/memory + the Build → AI Memory page. Mirrors
// drizzle/0040_memory_type.sql for fresh databases.
await sql`
  INSERT INTO types (key, label, icon, is_system, show_in_quick_capture, hidden, property_schema)
  VALUES (
    'memory', 'Memory', 'sparkles', false, false, true,
    '[{"key":"kind","label":"Kind","kind":"select","options":["user","feedback","project","reference"]},{"key":"horizon","label":"Horizon","kind":"select","options":["evergreen","seasonal","episodic"]},{"key":"pinned","label":"Pinned","kind":"checkbox"}]'::jsonb
  )
  ON CONFLICT (key) DO NOTHING
`;

// The single v1 user row. Resolved from env so a separate deploy seeds its own
// owner rather than another instance's; the chain matches resolveMcpOwner()'s
// (LEDGR_MCP_OWNER_UPN -> ONEDRIVE_EXPORT_UPN), so an instance that already
// configures either one needs no new variable, and the literal fallback keeps
// the original behaviour when none are set.
const ownerEmail =
  process.env.LEDGR_OWNER_UPN ||
  process.env.LEDGR_MCP_OWNER_UPN ||
  process.env.ONEDRIVE_EXPORT_UPN ||
  "brandoncollins@edgewoodcommunity.org";

await sql`
  INSERT INTO users (email)
  VALUES (${ownerEmail})
  ON CONFLICT (email) DO NOTHING
`;

const typeRows = await sql`SELECT key FROM types ORDER BY key`;
const userRows = await sql`SELECT email FROM users`;
console.log(`Seed complete. types: ${typeRows.map((r) => r.key).join(", ")}`);
console.log(`users: ${userRows.map((r) => r.email).join(", ")}`);
