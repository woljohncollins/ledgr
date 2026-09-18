-- Milestones become completable (ADR-196, reverses the 0044 "no done-state"
-- semantic). A milestone is now done when (a) it's checked off, (b) its linked
-- task completes, or (c) — dated milestones with no task link only — its date
-- passes ("arrives whether you act or not" survives for pure date milestones).
--
-- status_mode 'none' -> 'checkbox': the milestone canvas gains the standard
-- done-checkbox; it inherits the system default statuses (To Do / Done /
-- Archived), and every existing milestone row already sits at status 'open',
-- so nothing is rewritten.
UPDATE types SET status_mode = 'checkbox'
WHERE key = 'milestone' AND (status_mode IS NULL OR status_mode = 'none');--> statement-breakpoint

-- Two instance properties, appended only if the owner hasn't already added a
-- field with the same key (property_schema is owner-editable data, so this
-- merges rather than overwriting):
--   task   — a typed single relation to the task whose completion completes
--            this milestone (edges with role 'task').
--   points — the milestone's share of the project bar as a PERCENT (0–100):
--            "getting this done is worth 30% of the project," independent of
--            how many tasks it has. Blank = the default 5-point pool weight.
UPDATE types
SET property_schema = coalesce(property_schema, '[]'::jsonb)
  || '[{"key":"task","label":"Completes with task","kind":"relation","targetType":"task","cardinality":"single"}]'::jsonb
WHERE key = 'milestone'
  AND NOT coalesce(property_schema, '[]'::jsonb) @> '[{"key":"task"}]'::jsonb;--> statement-breakpoint

UPDATE types
SET property_schema = coalesce(property_schema, '[]'::jsonb)
  || '[{"key":"points","label":"Points (% of project)","kind":"number"}]'::jsonb
WHERE key = 'milestone'
  AND NOT coalesce(property_schema, '[]'::jsonb) @> '[{"key":"points"}]'::jsonb;
