-- `project` and `tag` become BUILT-IN types (Tyler, 2026-08-17): every install
-- already seeds both rows, but they carried is_system=false, so they presented
-- as "custom" in Build and were deletable — and a fresh instance whose owner
-- deleted one lost a type the app's core surfaces (the Projects grid, tagging)
-- are built around. is_system=true makes them what they already are in
-- practice: part of the product, extendable but not deletable, alongside task
-- and milestone. Data-only; no shape change.
UPDATE types SET is_system = true WHERE key IN ('project', 'tag');
