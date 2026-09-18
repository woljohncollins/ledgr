// Custom-type tools, resolved (Tyler, 2026-08-17): the owner's designated
// "offer as a tool" types (settings.toolTypes) joined to the live type registry,
// as synthetic WidgetDefinitions wearing the types' real labels. Server-only
// (reads settings + types); the pure synthetic-def mechanics live in widgets.ts.
//
// A toolTypes entry whose type has been deleted or hidden simply drops out here
// — existing compositions referencing it keep parsing (widgetById), and the
// fan-out retires the card when the type is gone.
import { getSettings } from "@/lib/settings";
import { listTypes } from "@/lib/types";
import {
  BUILTIN_TOOL_TYPE_KEYS,
  customCollectionWidget,
  type WidgetDefinition,
} from "@/lib/widgets";

export async function customToolDefs(ownerId: string): Promise<WidgetDefinition[]> {
  const settings = await getSettings(ownerId);
  if (settings.toolTypes.length === 0) return [];
  const types = await listTypes(); // excludes hidden + deleted types
  const byKey = new Map(types.map((t) => [t.key, t]));
  return settings.toolTypes
    .filter((key) => !BUILTIN_TOOL_TYPE_KEYS.has(key))
    .map((key) => {
      const t = byKey.get(key);
      return t ? customCollectionWidget(t.key, t.label) : null;
    })
    .filter((d): d is WidgetDefinition => d !== null);
}
