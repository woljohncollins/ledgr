-- A built-in "Image" property on the person type (Tyler, 2026-08-18, ADR-202
-- addendum 3): a url-kind field holding a picture of the person, so avatar
-- circles (project cards' people row, the task rows' person chips) can show a
-- face instead of initials/a glyph. Data-only append to person's
-- property_schema, guarded so an owner who already added their own `image`
-- field is left byte-identical. No shape change.
UPDATE types
SET property_schema = COALESCE(property_schema, '[]'::jsonb)
  || '[{"key": "image", "label": "Image", "kind": "url"}]'::jsonb
WHERE key = 'person'
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(property_schema, '[]'::jsonb)) e
    WHERE e->>'key' = 'image'
  );
