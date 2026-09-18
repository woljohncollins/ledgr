// The default item canvas (PRD §4.13): the markdown editor is the star, with
// the type's at-a-glance fields in a horizontal top strip and the standard
// bottom zone — the type's panel (subtasks, meeting prep, or embedded entity
// view), the backlinks panel, Save Offline, Share, and a collapsed read-only
// Fields section for everything the strip doesn't show.
//
// Every type without a bespoke canvas renders through this (the per-type
// canvas seam, ADR-041). A module canvas (a chord grid, a paper workspace)
// either replaces it or, like LinkCanvas, wraps it.
//
// Per-type layout (ADR-069, Feature B): a type with no saved canvas_layout
// renders the classic stacked canvas below, untouched (the common case, zero
// risk). A type WITH a saved layout — or any type while arranging (?arrange=1) —
// renders the same content as field-level cards in an arrangeable react-grid
// layout: MarkdownCanvas builds each card's content into a Record<CardId,
// ReactNode> and hands it to the client ItemLayoutGrid, which only positions it.
import type { ReactNode } from "react";
import ItemEditor from "@/components/markdown-editor/ItemEditor";
import FieldStrip, { type StripValues } from "@/components/canvas/FieldStrip";
import ItemLayoutGrid from "@/components/canvas/ItemLayoutGrid";
import CanvasSection from "@/components/canvas/CanvasSection";
import CustomProperties from "@/components/build/CustomProperties";
import ImageBox from "@/components/build/ImageBox";
import { imageUrl, personImage } from "@/lib/person-image";
import SaveOffline from "@/components/canvas/SaveOffline";
import ShareLink from "@/components/canvas/ShareLink";
import HistoryPanel from "@/components/canvas/HistoryPanel";
import ItemUtilitiesFooter from "@/components/canvas/ItemUtilitiesFooter";
import ItemFilesSection from "@/components/attachments/ItemFilesSection";
import { listItemFilesWithRefs } from "@/lib/attachments";
import { bodyMarkdown } from "@/lib/body";
import MeetingPrep from "@/components/meetings/MeetingPrep";
import MeetingNotes from "@/components/meetings/MeetingNotes";
import MeetingTranscripts from "@/components/meetings/MeetingTranscripts";
import { promotedBlockRefs } from "@/lib/meetings/promote";
import { getItem } from "@/lib/items";
import Link from "next/link";
import RecurrenceControl from "@/components/canvas/RecurrenceControl";
import RecurrenceCalendar from "@/components/canvas/RecurrenceCalendar";
import ReminderControl from "@/components/canvas/ReminderControl";
import ScheduledTimeControl from "@/components/canvas/ScheduledTimeControl";
import { parseScheduledTime } from "@/lib/scheduled-time";
import FocusStar from "@/components/today/FocusStar";
import { isFocusedOn } from "@/lib/focus";
import RelatedPanel from "@/components/relations/RelatedPanel";
import DiscoverPanel from "@/components/relations/DiscoverPanel";
import RelationProperties from "@/components/relations/RelationProperties";
import Subtasks from "@/components/subtasks/Subtasks";
import { topStripFields, footerFieldsFor, type CanvasField } from "@/lib/canvas-fields";
import {
  cardLabel,
  cardVocabulary,
  defaultLayout,
  reconcile,
  type CardId,
} from "@/lib/canvas-layout";
import { getType } from "@/lib/types";
import { resolveStatusSchema } from "@/lib/status";
import { parseRecurrence } from "@/lib/recurrence";
import { appTodayYmd } from "@/lib/recurrence-service";
import type { CanvasProps } from "@/lib/modules";

export default async function MarkdownCanvas({ item, ownerId, arrange = false }: CanvasProps) {
  // A locked item (items.properties.locked, set from the canvas "⋯" menu)
  // renders title, body, field strip, and properties read-only.
  const locked = Boolean(
    (item.properties as Record<string, unknown> | null)?.locked
  );
  const fields = topStripFields(item.type);
  const strip: StripValues = {
    status: item.status,
    dueDate: item.dueDate?.toISOString() ?? null,
    scheduledDate: item.scheduledDate?.toISOString() ?? null,
    urgency: item.urgency,
    meetingAt: item.meetingAt?.toISOString() ?? null,
    noteDate: item.noteDate?.toISOString() ?? null,
    url: item.url,
  };
  const footerFields = footerFieldsFor(item);
  // The type's custom fields (Build surface). A user type resolves through the
  // default canvas, so this is where its properties get an editable surface.
  const typeDef = await getType(item.type).catch(() => null);
  const propertySchema = typeDef?.propertySchema ?? [];
  // The type's resolved statuses (S2) for the status dropdown (labels + colors).
  const statuses = resolveStatusSchema(typeDef?.statusSchema ?? null);
  const savedLayout = typeDef?.canvasLayout ?? null;
  // Canvas tabs (ADR-095): auto-on for notes; opt-in for any other type via the
  // bespoke-tool catalog (the `tabs` capability, ADR-051). Tabs are sections of
  // the same markdown body, so this only changes the body editor.
  const tabsEnabled = item.type === "note" || typeDef?.capability === "tabs";
  // Today (app timezone) anchors a newly-enabled repeat; computed once for both
  // the classic mount and the grid card.
  const today = appTodayYmd();
  // Block anchors (ADR-090): a meeting's promoted lines (→ a "✓ task" badge), and
  // a promoted task's back-link to the exact meeting line it came from.
  const promotedRefs =
    item.type === "event" ? await promotedBlockRefs(ownerId, item.id) : undefined;
  const sourceObj =
    item.type === "task"
      ? ((item.properties as Record<string, unknown> | null)?.source as
          | { itemId?: string; blockRef?: string }
          | undefined)
      : undefined;
  let sourceLink: { href: string; title: string } | null = null;
  if (sourceObj?.itemId && sourceObj?.blockRef) {
    const src = await getItem(ownerId, sourceObj.itemId).catch(() => null);
    if (src && !src.deletedAt) {
      sourceLink = {
        href: `/items/${src.id}#^${sourceObj.blockRef}`,
        title: src.title || "Untitled",
      };
    }
  }
  const recurrenceRule = parseRecurrence(
    (item.properties as Record<string, unknown> | null)?.recurrence
  );
  const recurrenceNode = (
    <RecurrenceControl
      itemId={item.id}
      initial={recurrenceRule}
      scheduledDate={item.scheduledDate?.toISOString() ?? null}
      dueDate={item.dueDate?.toISOString() ?? null}
      today={today}
    />
  );
  // The completions calendar (S3): only for a recurring VIRTUAL series — a
  // materialized series' occurrences are their own items with their own
  // checkboxes, so editing the series log there would desync.
  const recurrenceCalendarNode =
    recurrenceRule && recurrenceRule.occurrenceMode === "virtual" ? (
      <RecurrenceCalendar itemId={item.id} initial={recurrenceRule} today={today} />
    ) : null;
  // Task canvas extras (S6, ADR-086): a focus-today star + the per-task reminder
  // lead-time picker (the ICS feed honors it). Classic-path only — the default
  // canvas; a custom grid layout can add these later.
  const reminderObj = (item.properties as Record<string, unknown> | null)?.reminder as
    | Record<string, unknown>
    | undefined;
  const reminderMinutes =
    typeof reminderObj?.minutesBefore === "number" ? reminderObj.minutesBefore : null;
  // Stage A time-blocking: a start time + length on the scheduled day, only
  // meaningful when there IS a scheduled day (a date or a recurrence anchor).
  const scheduledTime = parseScheduledTime(item.properties);
  const hasSchedule = item.scheduledDate != null || recurrenceRule != null;
  const taskExtrasNode = (
    <section className="mx-auto w-full max-w-3xl px-2 pb-1 pt-1 sm:px-8 md:px-12">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <span className="flex items-center gap-1.5 text-xs text-ink-subtle">
          <FocusStar itemId={item.id} focused={isFocusedOn(item.properties, today)} today={today} />
          Focus today
        </span>
        <ScheduledTimeControl itemId={item.id} initial={scheduledTime} hasSchedule={hasSchedule} />
        <ReminderControl itemId={item.id} initialMinutes={reminderMinutes} />
      </div>
    </section>
  );

  // Dispatch: render the grid when arranging OR when this type has a saved layout
  // (field-level placement can't be a vertical stack). Otherwise the classic
  // stacked canvas, exactly as before.
  const useGrid = arrange || savedLayout != null;

  if (useGrid) {
    const propsObj = (item.properties as Record<string, unknown>) ?? {};
    // The Files card's rows (ADR-237 addendum 3): fetched here because nodeFor
    // is sync. The card itself stays live via the upload/remove window events.
    const itemFiles = await listItemFilesWithRefs(ownerId, item.id).catch(() => []);
    // The read-only system footer (Type/Created/Updated + non-strip fields) as a
    // bare definition list — the card header already labels it "Details".
    const metaNode = (
      <dl className="flex flex-col gap-1 px-2">
        {footerFields.map(({ label, value }) => (
          <div key={label} className="flex gap-3 text-sm">
            <dt className="w-20 shrink-0 text-ink-subtle">{label}</dt>
            <dd className="min-w-0 break-words text-ink-muted">{value}</dd>
          </div>
        ))}
      </dl>
    );

    const nodeFor = (id: CardId): ReactNode => {
      if (id === "title")
        return (
          <ItemEditor
            item={{ id: item.id, title: item.title, body: item.body }}
            slot="title"
            locked={locked}
          />
        );
      if (id === "body")
        return (
          <ItemEditor
            item={{ id: item.id, title: item.title, body: item.body }}
            slot="body"
            promoteToMeetingId={item.type === "event" ? item.id : undefined}
            promotedRefs={promotedRefs}
            tabsEnabled={tabsEnabled}
            locked={locked}
          />
        );
      if (id.startsWith("sys:")) {
        const f = id.slice(4) as CanvasField;
        return <FieldStrip itemId={item.id} fields={[f]} initial={strip} today={today} statuses={statuses} locked={locked} />;
      }
      if (id === "recurrence") return item.type === "task" ? recurrenceNode : null;
      if (id === "recurrenceCalendar")
        return item.type === "task" ? recurrenceCalendarNode : null;
      if (id === "subtasks")
        return (
          <Subtasks ownerId={ownerId} itemId={item.id} parentScheduled={item.scheduledDate ?? null} />
        );
      if (id === "meetingPrep") return <MeetingPrep ownerId={ownerId} itemId={item.id} bare />;
      if (id === "meetingNotes") return <MeetingNotes ownerId={ownerId} itemId={item.id} bare />;
      if (id === "meetingTranscripts")
        return <MeetingTranscripts ownerId={ownerId} itemId={item.id} bare />;
      if (id.startsWith("prop:")) {
        const key = id.slice(5);
        // The person's built-in Image edits through the picture box (upload /
        // URL / remove — ADR-202 addendum 4), not a bare url row.
        if (item.type === "person" && key === "image") {
          return <ImageBox itemId={item.id} propKey="image" initial={personImage(item.properties)} />;
        }
        const def = propertySchema.find((p) => p.key === key);
        return def ? (
          <CustomProperties
            itemId={item.id}
            typeKey={item.type}
            schema={[def]}
            initial={propsObj}
            hideHeading
            locked={locked}
          />
        ) : null;
      }
      if (id.startsWith("rel:")) {
        const key = id.slice(4);
        const def = propertySchema.find((p) => p.key === key);
        // On events, person-target relation fields (Attending) are edited on
        // the People card (ADR-144) — don't render the same edges twice.
        if (def && item.type === "event" && def.targetType === "person") return null;
        return def ? (
          <RelationProperties
            ownerId={ownerId}
            itemId={item.id}
            typeKey={item.type}
            props={[def]}
            hideHeading
          />
        ) : null;
      }
      if (id === "files")
        return <ItemFilesSection itemId={item.id} initial={itemFiles} bare />;
      if (id === "related") return <RelatedPanel ownerId={ownerId} itemId={item.id} bare />;
      if (id === "discover")
        return <DiscoverPanel itemId={item.id} anchorTitle={item.title} bare />;
      if (id === "saveOffline") return <SaveOffline itemId={item.id} />;
      if (id === "share") return <ShareLink itemId={item.id} />;
      if (id === "history")
        return <HistoryPanel itemId={item.id} currentText={bodyMarkdown(item.body)} />;
      if (id === "meta") return metaNode;
      return null;
    };

    const order = cardVocabulary(item.type, propertySchema);
    const nodes: Record<CardId, ReactNode> = {};
    const labels: Record<CardId, string> = {};
    for (const id of order) {
      const node = nodeFor(id);
      if (node != null) {
        nodes[id] = node;
        labels[id] = cardLabel(id, propertySchema);
      }
    }
    const initialLayout = savedLayout
      ? reconcile(savedLayout, item.type, propertySchema)
      : defaultLayout(item.type, propertySchema);

    return (
      <>
        {/* "Customize layout" now lives in the canvas "⋯" actions menu. */}
        <ItemLayoutGrid
          itemId={item.id}
          typeKey={item.type}
          order={order}
          nodes={nodes}
          labels={labels}
          initialLayout={initialLayout}
          arrange={arrange}
        />
      </>
    );
  }

  // Classic stacked canvas (null layout, not arranging) — unchanged.
  // ("Customize layout" now lives in the canvas "⋯" actions menu.)
  const propsObj = (item.properties as Record<string, unknown>) ?? {};
  // Image-kind properties (ADR-255) get their own box beside the person
  // picture rather than a bare url row in Properties below.
  const imageProps = propertySchema.filter((p) => p.kind === "image");
  return (
    <>
      <ItemEditor
        item={{ id: item.id, title: item.title, body: item.body }}
        fields={
          fields.length > 0 ? (
            <FieldStrip itemId={item.id} fields={fields} initial={strip} today={today} statuses={statuses} locked={locked} />
          ) : null
        }
        promoteToMeetingId={item.type === "event" ? item.id : undefined}
        promotedRefs={promotedRefs}
        tabsEnabled={tabsEnabled}
        locked={locked}
        collapsibleToolbar
      />
      {/* The person's picture (ADR-202 addendum 4): a square box — click to
          upload (center-cropped square) or paste a URL. Feeds every avatar.
          Any other image-kind property on the type (ADR-255) gets its own box
          in the same row, right beside it. */}
      {(item.type === "person" || imageProps.length > 0) && (
        <div className="mx-auto flex w-full max-w-3xl flex-wrap gap-3 px-2 pt-2 sm:px-8 md:px-12">
          {item.type === "person" && (
            <ImageBox itemId={item.id} propKey="image" initial={personImage(item.properties)} />
          )}
          {imageProps.map((def) => (
            <ImageBox
              key={def.key}
              itemId={item.id}
              propKey={def.key}
              initial={imageUrl(propsObj[def.key])}
            />
          ))}
        </div>
      )}
      {/* Block-anchor back-link (ADR-090): a promoted task points to the exact
          meeting line it came from; clicking deep-links + flashes that line. */}
      {sourceLink && (
        <div className="mx-auto w-full max-w-3xl px-2 pt-1 text-xs text-ink-subtle sm:px-8 md:px-12">
          ↳ from{" "}
          <Link href={sourceLink.href} className="text-ink-muted hover:text-ink hover:underline">
            {sourceLink.title}
          </Link>
        </div>
      )}
      {/* Repeat control (native tasks, ADR-073/076): sets the task's recurrence
          rule; completion then advances the schedule deterministically. */}
      {item.type === "task" && recurrenceNode}
      {/* Completions calendar (S3, ADR-083): tick occurrence dates in any order;
          ✎ a date to carve it into a detached one-off. Recurring virtual only. */}
      {item.type === "task" && recurrenceCalendarNode}
      {/* Focus star + reminder lead-time (S6, ADR-086). */}
      {item.type === "task" && taskExtrasNode}
      {/* Subtasks are a task feature (ADR-018); a future project treatment
          may widen this, but meetings and notes don't grow checklists. */}
      {item.type === "task" && (
        <Subtasks ownerId={ownerId} itemId={item.id} parentScheduled={item.scheduledDate ?? null} />
      )}
      {/* Meeting prep (PRD §5.1): the people, their open tasks, recent
          meetings, and action-item -> task promotion. */}
      {item.type === "event" && <MeetingPrep ownerId={ownerId} itemId={item.id} />}
      {/* Notes (Tyler, 2026-07-01): jot notes on the meeting; each is a `note`
          filed under the meeting AND its project, so it also shows in Docs. */}
      {item.type === "event" && <MeetingNotes ownerId={ownerId} itemId={item.id} />}
      {/* Transcripts (meeting recording v1a, ADR-087): paste/list a meeting's
          transcripts (each its own item), the pivot for Claude-over-MCP minutes. */}
      {item.type === "event" && <MeetingTranscripts ownerId={ownerId} itemId={item.id} />}
      {/* Properties (PRD §3.6, the canvas redesign): one panel for the type's
          fields — scalar Build-surface fields (CustomProperties, over
          items.properties) AND typed relation fields (RelationProperties, link
          boxes over relations edges, ADR-067). A relation is a property whose
          value points at other items, so it belongs here, marked with a link
          glyph, not in a separate "Relations" section. */}
      {propertySchema.length > 0 && (
        <CanvasSection icon="properties" title="Properties">
          <div className="flex flex-col gap-2">
            <CustomProperties
              itemId={item.id}
              typeKey={item.type}
              // The person's Image and every image-kind property already have
              // their own box above, so a repeat row here would double them up.
              schema={propertySchema.filter(
                (pr) => pr.kind !== "image" && !(item.type === "person" && pr.key === "image")
              )}
              initial={propsObj}
              locked={locked}
              hideHeading
              bare
            />
            <RelationProperties
              ownerId={ownerId}
              itemId={item.id}
              typeKey={item.type}
              // On events, person-target relation fields (Attending) are edited
              // on the People card (ADR-144); the field definition stays (views/
              // filters still use it), only the duplicate editor row goes.
              props={
                item.type === "event"
                  ? propertySchema.filter((p) => p.targetType !== "person")
                  : propertySchema
              }
              hideHeading
              bare
            />
          </div>
        </CanvasSection>
      )}
      {/* Linked here (PRD §4.9, the canvas redesign): the connected data web —
          inbound links, @-mentions, wiki-links — with related tasks check-off-able
          and due-dates editable in place (ADR-055). Typed relation fields are
          excluded here; they show under Properties above, so nothing repeats. */}
      <RelatedPanel ownerId={ownerId} itemId={item.id} />
      {/* Discover related (ADR-127): deterministically ranked items worth
          linking but not linked yet, directly under Linked here. Collapsed,
          auto-hides when nothing clears the floor; Link graduates a row up into
          the panel above. */}
      <DiscoverPanel itemId={item.id} anchorTitle={item.title} />
      {/* Export & sharing (Save Offline PRD §4.7 + Share link §4.12) folded into
          one collapsed section, with Version History (Track changes) beside it.
          Shared with every canvas via ItemUtilitiesFooter. The arrange grid above
          still places these three as individual cards, so it doesn't use this. */}
      <ItemUtilitiesFooter itemId={item.id} currentText={bodyMarkdown(item.body)} />
      <div className="canvas-section-wrap mx-auto w-full max-w-3xl px-2 pb-12 sm:px-8 md:px-12">
        <details className="canvas-section">
        <summary className="ui-section-label cursor-pointer hover:text-ink">
          Fields
        </summary>
        <dl className="mt-2 flex flex-col gap-1 px-2">
          {footerFields.map(({ label, value }) => (
            <div key={label} className="flex gap-3 text-sm">
              <dt className="w-20 shrink-0 text-ink-subtle">{label}</dt>
              <dd className="min-w-0 break-words text-ink-muted">{value}</dd>
            </div>
          ))}
        </dl>
        </details>
      </div>
    </>
  );
}
