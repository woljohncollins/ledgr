// Inbox (PRD §4.2): items that arrived untriaged, awaiting type/entity/date
// assignment. Phase 1's only arrival path is quick capture; email-in,
// Todoist pull-ins, and the share target (Phase 2) land here through the
// same inbox flag. Rows open in the canvas for deep triage; the inline
// controls cover the fast cases. Task rows get a second line of fast-processing
// controls (schedule / priority / project / people — InboxTaskControls) so the
// overwhelmingly common capture (a task) can be processed without opening it.
import Link from "next/link";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { types } from "@/db/schema";
import BulkActionBar from "@/components/selection/BulkActionBar";
import SelectCheckbox from "@/components/selection/SelectCheckbox";
import SelectionProvider from "@/components/selection/SelectionProvider";
import SelectModeToggle from "@/components/selection/SelectModeToggle";
import TriageControls from "@/components/inbox/TriageControls";
import InboxTaskControls from "@/components/inbox/InboxTaskControls";
import RowMenu from "@/components/lists/RowMenu";
import QuickCapture from "@/components/today/QuickCapture";
import { listItems } from "@/lib/items";
import { relatedSummaryFor } from "@/lib/relations";
import { resolveOwner } from "@/lib/owner";
import { getAppTimezone } from "@/lib/today";
import { appTodayYmd } from "@/lib/recurrence-service";
import { compareTypeKeys } from "@/lib/type-order";
import type { Priority } from "@/lib/priority";

export const dynamic = "force-dynamic";

const dateFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});

export default async function Inbox() {
  const owner = await resolveOwner();
  if (!owner) redirect("/sign-in");

  const [typeRows, inboxItems, tz] = await Promise.all([
    getDb().select({ key: types.key, label: types.label }).from(types),
    // Active-only: a completed/archived item is no longer awaiting triage, and
    // completion clears the inbox flag (see updateItem). This also keeps done
    // items from ever showing here while the import-flag backlog is cleaned up.
    listItems(owner.id, { inbox: true, statusCategory: "active", limit: 200 }),
    getAppTimezone(owner.id),
  ]);
  const today = appTodayYmd(new Date(), tz);
  typeRows.sort((a, b) => compareTypeKeys(a.key, b.key));
  // Oldest first: the Inbox is a queue, and the back of it is the debt.
  inboxItems.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  // Persons connected to each task row (any confirmed edge, ADR-175), so the
  // People chip can show who's attached. One batched pair of queries.
  const taskIds = inboxItems.filter((i) => i.type === "task").map((i) => i.id);
  const peopleByTask = await relatedSummaryFor(owner.id, taskIds, { type: "person" });

  return (
    <main className="min-h-screen">
      <div className="mx-auto w-full max-w-3xl px-6 py-10 sm:px-12">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="ui-title text-ink">Inbox</h1>
            <p className="mt-1 ui-meta text-ink-subtle">
              {inboxItems.length === 0
                ? "Nothing waiting."
                : `${inboxItems.length} item${
                    inboxItems.length === 1 ? "" : "s"
                  } awaiting triage`}
            </p>
          </div>
          {inboxItems.length > 0 && (
            <Link
              href="/inbox/triage"
              className="shrink-0 rounded-card border border-line px-3 py-1.5 text-sm text-ink-muted hover:border-line-strong hover:text-ink"
            >
              Triage →
            </Link>
          )}
        </div>

        <div className="mt-6">
          <QuickCapture typeOptions={typeRows} />
        </div>

        {/* Empty state (ADR-249): an empty queue is now ambiguous — you may have
            triaged everything, or you may have routed every arrival path
            somewhere else — so say what feeds this page and where that is set. */}
        {inboxItems.length === 0 && (
          <p className="mt-6 ui-meta text-ink-subtle">
            Things land here when an arrival path is routed to the Inbox: quick
            capture, your phone&rsquo;s share sheet, the web clipper, email in,
            Todoist, new items from an @-mention, and Claude. Each one can queue
            here, file itself straight away, or drop into a project.{" "}
            <Link
              href="/build/capture"
              className="underline decoration-dotted underline-offset-2 hover:text-ink"
            >
              Set that up in Capture &amp; Inbox
            </Link>
            .
          </p>
        )}

        {inboxItems.length > 0 && (
          <SelectionProvider ids={inboxItems.map((item) => item.id)}>
            <SelectModeToggle />
            <ul className="mt-6 space-y-1">
              {inboxItems.map((item) => (
                <RowMenu
                  key={item.id}
                  id={item.id}
                  canComplete={item.type === "task"}
                  today={today}
                  label={item.title ?? undefined}
                  className="group flex flex-col gap-1.5 rounded-card px-2 py-1.5 hover:bg-surface-1"
                >
                  {/* Title row: checkbox · title (wraps, never truncated — the
                      Inbox is where you read what a thing is) · captured date. */}
                  <div className="flex items-start gap-2">
                    <SelectCheckbox id={item.id} />
                    <Link
                      href={`/items/${item.id}`}
                      className={`min-w-0 flex-1 break-words ui-row ${
                        item.title ? "text-ink" : "text-ink-subtle"
                      }`}
                    >
                      {item.title || "Untitled"}
                    </Link>
                    <span className="shrink-0 ui-meta text-ink-faint">
                      {dateFmt.format(item.createdAt)}
                    </span>
                  </div>
                  {/* Control line (all rows): task fast-processing controls (tasks
                      only) on the left, then type retype + Triaged + Delete pushed
                      to the right. Wraps on narrow screens. */}
                  <div className="flex flex-wrap items-center gap-2 pl-7">
                    {item.type === "task" && (
                      <InboxTaskControls
                        id={item.id}
                        today={today}
                        scheduledDate={item.scheduledDate}
                        urgency={item.urgency as Priority | null}
                        people={peopleByTask.get(item.id) ?? []}
                      />
                    )}
                    <TriageControls
                      id={item.id}
                      type={item.type}
                      typeOptions={typeRows}
                      label={item.title ?? undefined}
                    />
                  </div>
                </RowMenu>
              ))}
            </ul>
            {/* Mixed-type surface: only universal fields (no per-type status /
                select). urgency + dates are real columns on every type, and
                inbox:false (Triaged) applies to anything. */}
            <BulkActionBar
              canTriage
              priorityField
              dateFields={["scheduledDate", "dueDate"]}
            />
          </SelectionProvider>
        )}
      </div>
    </main>
  );
}
