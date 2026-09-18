// Resolved SURFACES for one item (ADR-260) — the read half of the surfaces
// contract declared in lib/modules.ts.
//
// `surfacesForType` (modules.ts) answers "what surfaces does this TYPE have?"
// as pure policy. This file answers "what is actually ON this item?", by pairing
// each declared surface with its stored content: the `body` surface reads
// items.body, a `property` surface reads items.properties[key], and a `derived`
// surface reports the surfaces it is assembled from and carries no content of
// its own.
//
// It exists so the two readers can't drift. MCP's get_item and the REST API's
// GET /api/items/[id] both hand back the same resolved list from the same
// resolver, which was the whole problem before: both surfaced a paper's notes
// and quote bank inside an untyped `properties` blob, neither named them, and a
// caller had no way to tell the draft (the deliverable) from the scratch pad.
//
// Cheap by construction (CLAUDE.md rule 8): the type lookup goes through
// `listTypes`, which is React-cached per request, so a page that already listed
// types pays nothing extra, and no call fans out per surface.
import { bodyMarkdown } from "@/lib/body";
import {
  canonicalFormatForType,
  surfacesForType,
  type SurfaceDef,
} from "@/lib/modules";
import { listTypes } from "@/lib/types";

// A declared surface plus what is stored in it.
export type ResolvedSurface = SurfaceDef & {
  // Text for a prose surface ("markdown"/"chordpro"), the parsed value for a
  // "json" one, and null for a derived surface (which stores nothing) or an
  // empty one.
  content: string | unknown | null;
  // True when the surface holds nothing yet — the cheap check a caller wants
  // before deciding whether to read or write it.
  empty: boolean;
};

// The item fields the resolver needs. Structural rather than the full row type,
// so a caller can pass a row from any of the several shapes that carry a body.
export type SurfaceSource = {
  type: string;
  body?: unknown;
  properties?: unknown;
};

function isEmptyValue(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return false;
}

// Pair each of the type's declared surfaces with its stored content. `capability`
// is the types-table row's attached bespoke-tool id; pass it when the caller
// already has the type in hand to skip the lookup entirely.
export async function resolveSurfaces(
  item: SurfaceSource,
  capability?: string | null
): Promise<ResolvedSurface[]> {
  let cap = capability;
  if (cap === undefined) {
    const defs = await listTypes({ includeHidden: true });
    cap = defs.find((t) => t.key === item.type)?.capability ?? null;
  }
  return resolveSurfacesSync(item, cap);
}

// The pure half, for callers that already know the capability (and for tests).
export function resolveSurfacesSync(
  item: SurfaceSource,
  capability?: string | null
): ResolvedSurface[] {
  const props = (item.properties ?? {}) as Record<string, unknown>;
  return surfacesForType(item.type, undefined, capability).map((s) => {
    let content: unknown = null;
    if (s.storage.kind === "body") {
      // bodyMarkdown is the tolerant reader for the { format, text } wrapper; it
      // returns the raw text whatever the format, so a chordpro chart comes back
      // as its ChordPro source rather than being treated as markdown.
      content = bodyMarkdown(item.body);
    } else if (s.storage.kind === "property") {
      content = props[s.storage.key] ?? null;
    }
    // A derived surface keeps content null on purpose: it has no storage, and
    // rendering the assembly here would duplicate the canvas's own projection.
    return { ...s, content, empty: isEmptyValue(content) };
  });
}

// The surface a write should land on when the caller names one, with the checks a
// write path needs: that the id exists on this type, and that it is writable.
// Returns a discriminated result rather than throwing, so each caller (MCP tool,
// REST route) can shape its own error.
export type SurfaceTarget =
  | { ok: true; surface: SurfaceDef }
  | { ok: false; reason: "unknown" | "read_only"; known: string[] };

export function resolveSurfaceTarget(
  type: string,
  surfaceId: string,
  capability?: string | null
): SurfaceTarget {
  const all = surfacesForType(type, undefined, capability);
  const surface = all.find((s) => s.id === surfaceId);
  if (!surface) return { ok: false, reason: "unknown", known: all.map((s) => s.id) };
  if (surface.readOnly || surface.storage.kind === "derived") {
    return { ok: false, reason: "read_only", known: all.filter((s) => !s.readOnly).map((s) => s.id) };
  }
  return { ok: true, surface };
}

// The canonical body format for a type — re-exported here so a write path has one
// import for everything surface-related. This is what every MCP write path failed
// to consult: they all stamped `{ format: "markdown" }`, which on a song (whose
// canonical format is chordpro) silently broke the chart render, the lyrics-only
// search index, and token resolution.
export function bodyFormatFor(type: string, capability?: string | null): string {
  return canonicalFormatForType(type, undefined, capability);
}
