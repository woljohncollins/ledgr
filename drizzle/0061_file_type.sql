-- File type (Files as a first-class citizen, ADR-236). The item IS the file:
-- one uploaded attachment as the object (opened in a new tab off /files/<id>,
-- shared as a public link riding the item's share token), the markdown body as
-- the owner's description of it — for files markdown can't be (HTML pages,
-- spreadsheets, binaries). Canvas 'file' (the files module manifest routes it;
-- module-wiring renders FileCanvas). No done-state (status_mode='none');
-- visible in nav/type pickers but out of quick capture — you can't upload a
-- file mid-capture. is_system=false like project/pursuit: the owner may
-- rename or retire it.
-- Mirrors scripts/seed.mjs.
INSERT INTO types (key, label, icon, is_system, show_in_quick_capture, hidden, status_mode, property_schema)
VALUES ('file', 'File', 'document', false, false, false, 'none', '[]'::jsonb)
ON CONFLICT (key) DO NOTHING;
