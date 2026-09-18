// The fixed Today layout — the Work-surface home body (PRD §4.2, §4.11 Phase 1):
// quick capture, today's meetings, due/overdue tasks, recent items. One batched
// fetch via getTodayData; widgets and user arrangement are Phase 2.
//
// Lives here rather than in `app/page.tsx` because BOTH `/` and `/today` render
// it (each first checking its own assigned dashboard). A Next.js page file may
// only export from a fixed allowlist — `default`, `dynamic`, `metadata`, … — so
// the extra named export this used to be failed the typecheck, and since
// `next build` runs the typecheck, it broke every deploy from main. Not a route:
// the `_` prefix keeps this out of the router.
import Link from "next/link";
import QuickCapture from "@/components/today/QuickCapture";
import PushToggle from "@/components/pwa/PushToggle";
import RollOverdueButton from "@/components/today/RollOverdueButton";
import FocusStar from "@/components/today/FocusStar";
import SubtaskCheckbox from "@/components/subtasks/SubtaskCheckbox";
import SubtaskExpandableRow from "@/components/subtasks/SubtaskExpandableRow";
import { FOCUS_SOFT_CAP, focusOrder, isFocusedOn } from "@/lib/focus";
import { listItems } from "@/lib/items";
import { resolveOwnerState } from "@/lib/owner";
import { childRollups } from "@/lib/subtasks";
import { foldTodayTasks } from "@/lib/subtask-fold";
import { getAppTimezone, getTodayData } from "@/lib/today";

type ListedItem = Awaited<ReturnType<typeof listItems>>[number];

// The instant formatters render in the owner's timezone, so they're built from
// the resolved zone per request (memoized by zone). Due dates are calendar days
// stored as UTC midnight, so dueFmt stays UTC — its shown day must not shift.
const tzFmtCache = new Map<string, { heading: Intl.DateTimeFormat; time: Intl.DateTimeFormat; recent: Intl.DateTimeFormat }>();
function tzFormatters(tz: string) {
  let f = tzFmtCache.get(tz);
  if (!f) {
    f = {
      heading: new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: tz }),
      time: new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz }),
      recent: new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: tz }),
    };
    tzFmtCache.set(tz, f);
  }
  return f;
}
const dueFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

function Section({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="mt-8">
      <div className="flex items-center justify-between border-b border-neutral-800 pb-1">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="mt-2 px-2 text-sm text-neutral-600">{children}</p>;
}

// The date a task is "on the plate" by: its planned (scheduled) date if set,
// else its deadline (native tasks T2). Drives the Today partition + the row date.
function planDate(task: ListedItem): Date | null {
  return task.scheduledDate ?? task.dueDate ?? null;
}

const TODAY_ROW_CLASS =
  "group flex items-center gap-2.5 rounded px-2 py-1 hover:bg-neutral-800/60";

function TaskRow({
  task,
  overdue,
  today,
  rollup,
  defaultOpen = false,
}: {
  task: ListedItem;
  overdue: boolean;
  today: string;
  // This task's subtask progress (childRollups) — a task with children gets the
  // n/m expand pill, same as the /tasks rows.
  rollup?: { done: number; total: number };
  // The Today fold (ADR-205): start expanded because a subtask that would
  // otherwise be its own row folded under this one.
  defaultOpen?: boolean;
}) {
  const d = planDate(task);
  const inner = (
    <>
      <SubtaskCheckbox
        id={task.id}
        done={false}
        openSubtasks={rollup ? rollup.total - rollup.done : 0}
      />
      <Link
        href={`/items/${task.id}`}
        className={`min-w-0 flex-1 truncate text-sm ${
          task.title ? "text-neutral-200" : "text-neutral-500"
        }`}
      >
        {task.title || "Untitled"}
      </Link>
      {/* A scheduled-but-not-due task is planned work; mark it so the date isn't
          mistaken for a deadline. */}
      {task.scheduledDate && !task.dueDate && (
        <span className="shrink-0 text-xs text-neutral-600">planned</span>
      )}
      {task.urgency != null && task.urgency <= 2 && (
        <span className="shrink-0 rounded bg-amber-950 px-1.5 text-xs text-amber-400">
          {`P${task.urgency}`}
        </span>
      )}
      <span
        className={`shrink-0 text-xs ${
          overdue ? "text-[var(--accent)]" : "text-neutral-600"
        }`}
      >
        {d ? dueFmt.format(d) : ""}
      </span>
      <FocusStar
        itemId={task.id}
        focused={isFocusedOn(task.properties, today)}
        today={today}
      />
    </>
  );
  // A task with subtasks gets the n/m pill + inline tree (the same expandable
  // row the /tasks tabs use), pre-expanded when a child folded under it.
  if (rollup && rollup.total > 0) {
    return (
      <SubtaskExpandableRow
        id={task.id}
        done={rollup.done}
        total={rollup.total}
        liClassName={TODAY_ROW_CLASS}
        defaultOpen={defaultOpen}
        today={today}
      >
        {inner}
      </SubtaskExpandableRow>
    );
  }
  return <li className={TODAY_ROW_CLASS}>{inner}</li>;
}

// The Work home (/). If the owner has assigned a dashboard as Home, render it;
// otherwise the fixed Today layout below (the default + fallback). The Today
// surface (/today) mirrors this with todayDashboardId.

export default async function TodayHome() {
  const state = await resolveOwnerState();
  // Signed in, but this Ledgr has no account for that identity (ADR-184). Say so
  // instead of rendering the anonymous hero: the two states used to look
  // identical, and since `Nav.tsx` also renders nothing without an owner, the
  // whole symptom was "my user menu vanished" — a UI bug to look at, rather than
  // the auth failure it actually was. No redirect to /sign-in here on purpose:
  // the session is valid, so Clerk would send it straight back and loop.
  if (state.kind === "unrecognized") {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-3 p-8 text-center">
        <h1 className="ui-title">Signed in, but not recognized</h1>
        <p className="text-sm text-ink-muted">
          {state.email
            ? `This Ledgr has no account for ${state.email}.`
            : "This Ledgr has no account for the signed-in identity."}
        </p>
        <p className="text-sm text-ink-subtle">
          Nothing is wrong with your data. The session just isn&rsquo;t linked to
          the owner record, so every page will render empty until it is.
        </p>
        <Link href="/sign-in" className="text-sm text-[var(--accent)] hover:underline">
          Sign in as a different user
        </Link>
      </main>
    );
  }
  if (state.kind === "signed-out") {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-2 p-8">
        <h1 className="text-3xl font-semibold tracking-tight">Ledgr</h1>
        <p className="text-sm text-neutral-500">
          Phase 1 scaffold. The Work surface starts here.
        </p>
      </main>
    );
  }
  const owner = state.owner;

  const { bounds, meetings, dueTasks, recent, focusTasks, todayYmd, typeLabels } =
    await getTodayData(owner.id);
  const fmt = tzFormatters(await getAppTimezone(owner.id));
  // Today's Focus (T3): the vital few, ordered by the focus marker's order.
  const focus = [...focusTasks].sort(
    (a, b) => focusOrder(a.properties) - focusOrder(b.properties)
  );
  const focusedIds = new Set(focus.map((t) => t.id));
  // The due/planned list excludes anything already in the focus zone, so a task
  // shows once: in Focus if focused, else here.
  const rest = dueTasks.filter((t) => !focusedIds.has(t.id));
  // Partition on the effective plan date (scheduled, else due), so a task
  // planned for an earlier day counts as overdue even with no deadline.
  const overdueAll = rest.filter((t) => {
    const d = t.scheduledDate ?? t.dueDate;
    return d != null && d < bounds.dueToday;
  });
  const dueTodayAll = rest.filter((t) => {
    const d = t.scheduledDate ?? t.dueDate;
    return d != null && d >= bounds.dueToday;
  });
  // Recurring series advance via completion, not the roll (recurrence-service.ts),
  // so the roll button only counts the non-recurring overdue it would actually
  // move. Counted PRE-fold: the roll endpoint moves every overdue task in the
  // DB, folded-under-a-parent or not, so the count must match what it does.
  const rollableOverdue = overdueAll.filter(
    (t) => !(t.properties as Record<string, unknown> | null)?.recurrence
  ).length;
  // The subtask fold (ADR-205): a task whose parent is also in this section
  // renders under the parent's pre-expanded tree instead of as its own row
  // (overdue children hide only under an overdue parent — see subtask-fold).
  // Focus-zone parents don't fold anything: focus is an explicit, curated set.
  const { overdue, dueToday, expandIds } = foldTodayTasks(overdueAll, dueTodayAll);
  // Subtask progress for every rendered task row — powers the n/m expand pill
  // and the "N subtasks still open" completion toast. One batched query.
  const rollups = await childRollups(
    owner.id,
    [...focus, ...overdue, ...dueToday].map((t) => t.id)
  );

  return (
    <main className="min-h-screen">
      <div className="mx-auto w-full max-w-3xl px-6 py-10 sm:px-12">
        <h1 className="text-2xl font-bold tracking-tight text-neutral-100">
          Today
        </h1>
        <p className="mt-1 text-sm text-neutral-500">
          {fmt.heading.format(new Date())}
        </p>

        <div className="mt-6">
          <QuickCapture />
        </div>

        {focus.length > 0 && (
          <Section
            title="Today's Focus"
            action={
              focus.length > FOCUS_SOFT_CAP ? (
                <span className="text-xs text-amber-500/80">
                  {focus.length} in focus (the vital few is usually {FOCUS_SOFT_CAP} or fewer)
                </span>
              ) : undefined
            }
          >
            <ul className="mt-1">
              {focus.map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  overdue={false}
                  today={todayYmd}
                  rollup={rollups.get(t.id)}
                />
              ))}
            </ul>
          </Section>
        )}

        <Section title="Meetings">
          {meetings.length > 0 ? (
            <ul className="mt-1">
              {meetings.map((m) => (
                <li
                  key={m.id}
                  className="group flex items-center gap-2.5 rounded px-2 py-1 hover:bg-neutral-800/60"
                >
                  <span className="w-16 shrink-0 text-xs tabular-nums text-neutral-500">
                    {m.meetingAt ? fmt.time.format(m.meetingAt) : ""}
                  </span>
                  <Link
                    href={`/items/${m.id}`}
                    className={`min-w-0 flex-1 truncate text-sm ${
                      m.title ? "text-neutral-200" : "text-neutral-500"
                    } ${m.statusCategory === "done" ? "line-through opacity-60" : ""}`}
                  >
                    {m.title || "Untitled"}
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No meetings today.</Empty>
          )}
        </Section>

        <Section title="Tasks" action={<RollOverdueButton count={rollableOverdue} />}>
          {overdue.length + dueToday.length > 0 ? (
            <ul className="mt-1">
              {overdue.map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  overdue
                  today={todayYmd}
                  rollup={rollups.get(t.id)}
                  defaultOpen={expandIds.has(t.id)}
                />
              ))}
              {dueToday.map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  overdue={false}
                  today={todayYmd}
                  rollup={rollups.get(t.id)}
                  defaultOpen={expandIds.has(t.id)}
                />
              ))}
            </ul>
          ) : (
            <Empty>Nothing due or planned. Capture something above.</Empty>
          )}
        </Section>

        <Section title="Recent">
          {recent.length > 0 ? (
            <ul className="mt-1">
              {recent.map((item) => (
                <li
                  key={item.id}
                  className="group flex items-center gap-2.5 rounded px-2 py-1 hover:bg-neutral-800/60"
                >
                  <span className="w-16 shrink-0 truncate text-xs text-neutral-600">
                    {typeLabels[item.type] ?? item.type}
                  </span>
                  <Link
                    href={`/items/${item.id}`}
                    className={`min-w-0 flex-1 truncate text-sm ${
                      item.title ? "text-neutral-200" : "text-neutral-500"
                    }`}
                  >
                    {item.title || "Untitled"}
                  </Link>
                  <span className="shrink-0 text-xs text-neutral-600">
                    {fmt.recent.format(item.updatedAt)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No items yet.</Empty>
          )}
        </Section>

        <p className="mt-10 flex flex-wrap items-center gap-4 text-sm">
          <Link href="/dashboards" className="text-neutral-500 hover:text-neutral-300">
            Dashboards →
          </Link>
          <Link href="/items" className="text-neutral-500 hover:text-neutral-300">
            All items →
          </Link>
          <PushToggle />
        </p>
      </div>
    </main>
  );
}
