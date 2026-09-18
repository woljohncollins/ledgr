// The schema-version vocabulary the sync wire speaks: the latest migration
// tag in the journal BUNDLED with the running code (the same static-import
// trick as src/lib/updates.ts, so it always describes what this build
// expects, network-free). Two peers may exchange ops only when their tags
// match; /api/machine/sync answers a mismatch with 409 + both versions, which
// is what lights the update card on the stale peer later (phase 5).
import journal from "../../../drizzle/meta/_journal.json";

const entries = (journal.entries as { tag: string }[]) ?? [];

export function latestSchemaVer(): string {
  return entries.length > 0 ? entries[entries.length - 1].tag : "none";
}
