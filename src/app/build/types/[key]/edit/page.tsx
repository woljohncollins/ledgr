// Edit type (slice 33): the builder seeded with an existing type. notFound()
// for an unknown key. System types load here too (extendable, not deletable).
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import TypeBuilder from "@/components/build/TypeBuilder";
import StatusSchemaEditor from "@/components/build/StatusSchemaEditor";
import TypeSectionsEditor from "@/components/build/TypeSectionsEditor";
import CardElementsEditor from "@/components/build/CardElementsEditor";
import ListTabsEditor from "@/components/build/ListTabsEditor";
import TocSettingsEditor from "@/components/build/TocSettingsEditor";
import { resolveProjectCardConfig } from "@/lib/project-card-config";
import { parseComposition, resolveComposition } from "@/lib/composition";
import { lensesForType, lensPropertyOptions } from "@/lib/list-lenses";
import { canvasIdForType, capabilityById } from "@/lib/modules";
import { BUILTIN_TOOL_TYPE_KEYS, isWidgetAvailable, widgetsForScope } from "@/lib/widgets";
import { customToolDefs } from "@/lib/custom-tools";
import ToolTypeToggle from "@/components/build/ToolTypeToggle";
import { resolveOwner } from "@/lib/owner";
import { getSettings } from "@/lib/settings";
import { tocForType } from "@/lib/toc";
import { countItemsOfType, getType, listTypes } from "@/lib/types";
import { ItemError } from "@/lib/items";

export const dynamic = "force-dynamic";

export default async function EditType({
  params,
}: {
  params: Promise<{ key: string }>;
}) {
  const owner = await resolveOwner();
  if (!owner) redirect("/sign-in");

  const { key } = await params;
  const type = await getType(key).catch((err) => {
    if (err instanceof ItemError && err.code === "not_found") notFound();
    throw err;
  });

  // SPIKE (bespoke-tool catalog): resolve any attached capability to its label
  // for the builder's banner.
  const cap = type.capability
    ? capabilityById(type.capability, owner.id)
    : undefined;
  const attached = cap ? { id: cap.id, label: cap.label } : null;
  const itemCount = await countItemsOfType(key);
  // Live types feed a relation field's target-type dropdown (ADR-067).
  const availableTypes = (await listTypes()).map((t) => ({
    key: t.key,
    label: t.label,
  }));

  // List-tabs ("lenses") customization for this type's list page.
  const settings = await getSettings(owner.id);
  const propertyOptions = lensPropertyOptions(type.propertySchema);

  // Layer 2 (ADR-181): the sections every record of this type shows. `effective`
  // is what records show right now — the stored default if the type has one,
  // else the built-in starting set — so the editor opens on current behavior
  // rather than an empty list. Collection/relation cards preview N rows, so only
  // those get a count control.
  const sectionCatalog = [
    ...widgetsForScope("record").filter(isWidgetAvailable),
    // The owner's custom-type tools (2026-08-17): designated types join the
    // sections vocabulary so a type default can carry, say, a Chapters card.
    ...(await customToolDefs(owner.id)),
  ].map((w) => ({
    id: w.id,
    label: w.label,
    // The Timeline previews N entries with a drill-down too (2026-08-17), so
    // it takes the same count control as the collection/relation cards.
    capped: w.kind === "collection" || w.kind === "relation" || w.id === "timeline",
  }));
  const storedDefault = parseComposition(type.defaultWidgets);
  const { composition: effectiveSections } = resolveComposition(
    null,
    type.defaultWidgets,
    key
  );

  return (
    <main className="min-h-screen">
      <div className="mx-auto w-full max-w-3xl px-6 py-10 sm:px-12">
        <div className="flex items-baseline justify-between gap-2">
          <h1 className="text-2xl font-bold tracking-tight text-neutral-100">
            {type.label}
          </h1>
          <Link
            href="/build/types"
            className="text-sm text-neutral-500 hover:text-neutral-300"
          >
            ← All types
          </Link>
        </div>
        <TypeBuilder
          initial={type}
          attached={attached}
          itemCount={itemCount}
          availableTypes={availableTypes}
        />
        <StatusSchemaEditor
          typeKey={key}
          initialMode={type.statusMode}
          initial={type.statusSchema}
        />
        {/* Tools (default sections) only apply to types whose records resolve
            to the widget canvas — project, pursuit, and custom types with the
            Project-style page checkbox on (ADR-204). Rendering it on a plain
            document type read as "my type is still treated as a Project." */}
        {canvasIdForType(key, owner.id, type.capability) === "widgets" && (
          <TypeSectionsEditor
            typeKey={key}
            typeLabel={type.label}
            catalog={sectionCatalog}
            initial={storedDefault}
            effective={effectiveSections}
          />
        )}
        {/* Offer-as-a-tool (2026-08-17): any type not already covered by a
            built-in catalog card can join the Add-a-Tool menu on widget-home
            records. Hidden for built-in tool types (the card would double). */}
        {!BUILTIN_TOOL_TYPE_KEYS.has(key) && (
          <ToolTypeToggle
            typeKey={key}
            typeLabel={type.label}
            initial={settings.toolTypes.includes(key)}
          />
        )}
        {/* Project cards carry a configurable element set (2026-08-17). Only the
            project type renders cards today; widen this gate when another type
            grows a card (pursuit is the likely next). */}
        {key === "project" && (
          <CardElementsEditor
            typeKey={key}
            initial={resolveProjectCardConfig(null, settings.cardsByType[key])}
            customized={Boolean(settings.cardsByType[key])}
          />
        )}
        <ListTabsEditor
          typeKey={key}
          propertyOptions={propertyOptions}
          initialLenses={lensesForType(settings, key)}
          customized={Boolean(settings.listTabs[key])}
        />
        <TocSettingsEditor
          typeKey={key}
          initial={tocForType(settings, key)}
          customized={Boolean(settings.tocByType[key])}
        />
      </div>
    </main>
  );
}
