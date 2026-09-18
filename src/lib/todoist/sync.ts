// Todoist sync engine (slice 25, PRD §5.2). Deterministic, no model in the
// loop. Push: any dated open task goes to Todoist (content, due, priority,
// link back); undated tasks stay app-only. Pull: completions and date changes
// flow back. Conflict rule: Ledgr is canonical for content; a three-way due
// reconcile (Ledgr / Todoist / last-synced) lets Ledgr win when both changed
// but still accepts a Todoist-only date change. Recurrence is Todoist's
// entirely. Inbox pull-in imports tasks created natively in Todoist's inbox
// (the offline-capture path); where those land is the owner's Capture routing
// for the "todoist" source, the Inbox unless they changed it (ADR-249).
import { and, eq, isNotNull, isNull, or } from "drizzle-orm";
import { getDb } from "@/db";
import { items, jobState } from "@/db/schema";
import { resolveRoute } from "@/lib/item-mutations";
import { relateItems } from "@/lib/relations";
import {
  dueFromTodoist,
  dueToTodoist,
  todoistPriority,
  type TodoistClient,
  type TodoistMeta,
  type TodoistTask,
} from "./types";

export const TODOIST_JOB_KEY = "todoist_sync";

export type TodoistRunResult = {
  pushedCreated: number;
  pushedUpdated: number;
  pushedDeleted: number;
  completedPushed: number;
  completedPulled: number;
  dateChanged: number;
  imported: number;
  errors: number;
};

export type TodoistJobState = {
  lastRunAt: string;
  lastSuccessAt: string | null;
  lastResult: TodoistRunResult;
};

type TaskRow = {
  id: string;
  title: string;
  status: "open" | "done" | "archived";
  dueDate: Date | null;
  urgency: number | null;
  todoistId: string | null;
  properties: unknown;
};

function readMeta(properties: unknown): TodoistMeta | null {
  const p = properties as { todoist?: TodoistMeta } | null;
  return p?.todoist ?? null;
}

function mergeMeta(properties: unknown, meta: TodoistMeta): Record<string, unknown> {
  const base =
    properties && typeof properties === "object" && !Array.isArray(properties)
      ? (properties as Record<string, unknown>)
      : {};
  return { ...base, todoist: meta };
}

function backlink(itemId: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL || "https://ledgr-teal.vercel.app";
  return `${base.replace(/\/$/, "")}/items/${itemId}`;
}

export async function runTodoistSync(
  ownerId: string,
  client: TodoistClient,
  opts: { onError?: (itemId: string, err: unknown) => void } = {}
): Promise<TodoistRunResult> {
  const db = getDb();
  const result: TodoistRunResult = {
    pushedCreated: 0,
    pushedUpdated: 0,
    pushedDeleted: 0,
    completedPushed: 0,
    completedPulled: 0,
    dateChanged: 0,
    imported: 0,
    errors: 0,
  };

  const [active, inboxProjectId] = await Promise.all([
    client.listActiveTasks(),
    client.getInboxProjectId(),
  ]);
  const activeById = new Map<string, TodoistTask>(active.map((t) => [t.id, t]));

  // Candidates: a task is relevant if it needs pushing (open + dated) or is
  // already linked to Todoist (reconcile / completion / lost-its-due).
  const candidates = (await db
    .select({
      id: items.id,
      title: items.title,
      status: items.status,
      dueDate: items.dueDate,
      urgency: items.urgency,
      todoistId: items.todoistId,
      properties: items.properties,
    })
    .from(items)
    .where(
      and(
        eq(items.ownerId, ownerId),
        eq(items.type, "task"),
        isNull(items.deletedAt),
        // A template task never syncs to Todoist (ADR-093).
        eq(items.isTemplate, false),
        or(
          and(eq(items.status, "open"), isNotNull(items.dueDate)),
          isNotNull(items.todoistId)
        )
      )
    )) as TaskRow[];

  const linkedIds = new Set<string>();

  for (const task of candidates) {
    try {
      if (task.todoistId) linkedIds.add(task.todoistId);
      const live = task.todoistId ? activeById.get(task.todoistId) : undefined;
      const ledgrDue = dueToTodoist(task.dueDate);
      const priority = todoistPriority(task.urgency);

      // --- not yet linked: create if it's an open dated task --------------
      if (!task.todoistId) {
        if (task.status === "open" && task.dueDate) {
          const created = await client.createTask({
            content: task.title,
            description: backlink(task.id),
            dueDate: ledgrDue,
            priority,
          });
          await db
            .update(items)
            .set({
              todoistId: created.id,
              properties: mergeMeta(task.properties, { id: created.id, syncedDue: ledgrDue }),
            })
            .where(and(eq(items.id, task.id), eq(items.ownerId, ownerId)));
          linkedIds.add(created.id);
          result.pushedCreated++;
        }
        continue;
      }

      // --- linked + Ledgr done: push the completion -----------------------
      if (task.status !== "open") {
        if (live) {
          await client.completeTask(task.todoistId);
          result.completedPushed++;
        }
        continue;
      }

      // --- linked + Ledgr open, but gone from Todoist active: completed ---
      if (!live) {
        await db
          .update(items)
          .set({ status: "done" })
          .where(and(eq(items.id, task.id), eq(items.ownerId, ownerId)));
        result.completedPulled++;
        continue;
      }

      // --- linked + Ledgr open, lost its due: undated stays app-only ------
      if (!task.dueDate) {
        await client.deleteTask(task.todoistId);
        // Unlink: clear the column and drop the todoist properties block.
        const props =
          task.properties && typeof task.properties === "object" && !Array.isArray(task.properties)
            ? { ...(task.properties as Record<string, unknown>) }
            : {};
        delete props.todoist;
        await db
          .update(items)
          .set({ todoistId: null, properties: props })
          .where(and(eq(items.id, task.id), eq(items.ownerId, ownerId)));
        result.pushedDeleted++;
        continue;
      }

      // --- linked + both live: reconcile due (three-way) + push content ---
      const meta = readMeta(task.properties);
      const syncedDue = meta?.syncedDue ?? null;
      let newSyncedDue = syncedDue;
      let touchedTodoist = false;

      if (ledgrDue !== syncedDue) {
        // Ledgr changed the date (or it's the first reconcile) -> Ledgr wins.
        if (live.dueDate !== ledgrDue) {
          await client.updateTask(task.todoistId, { dueDate: ledgrDue });
          touchedTodoist = true;
        }
        newSyncedDue = ledgrDue;
      } else if (live.dueDate !== syncedDue) {
        // Only Todoist changed the date -> sync it back into Ledgr.
        await db
          .update(items)
          .set({ dueDate: dueFromTodoist(live.dueDate) })
          .where(and(eq(items.id, task.id), eq(items.ownerId, ownerId)));
        newSyncedDue = live.dueDate;
        result.dateChanged++;
      }

      // Content + priority: Ledgr is canonical, so always push if they differ.
      if (live.content !== task.title || live.priority !== priority) {
        await client.updateTask(task.todoistId, { content: task.title, priority });
        touchedTodoist = true;
      }

      if (touchedTodoist) result.pushedUpdated++;
      if (newSyncedDue !== syncedDue) {
        await db
          .update(items)
          .set({ properties: mergeMeta(task.properties, { id: task.todoistId, syncedDue: newSyncedDue }) })
          .where(and(eq(items.id, task.id), eq(items.ownerId, ownerId)));
      }
    } catch (err) {
      result.errors++;
      opts.onError?.(task.id, err);
    }
  }

  // --- inbox pull-in: native Todoist inbox tasks become Ledgr inbox tasks --
  if (inboxProjectId) {
    // Where this arrival path files things, per the owner's Capture routing
    // (ADR-249). Resolved ONCE for the whole batch rather than per task: it is
    // the same answer every time and a pull can import a lot of tasks. This
    // path inserts directly (it carries todoistId, which createItem has no
    // field for), so it reuses createItem's router and writes the destination
    // edge the same best-effort way createItem does.
    const route = await resolveRoute(ownerId, { source: "todoist" });
    for (const t of active) {
      if (t.projectId !== inboxProjectId || linkedIds.has(t.id)) continue;
      try {
        const [made] = await db
          .insert(items)
          .values({
            ownerId,
            type: "task",
            title: t.content,
            status: "open",
            dueDate: dueFromTodoist(t.dueDate),
            inbox: route.inbox,
            todoistId: t.id,
            properties: { todoist: { id: t.id, syncedDue: t.dueDate } },
          })
          .returning({ id: items.id });
        if (route.destinationId) {
          await relateItems(ownerId, made.id, route.destinationId, "project").catch(
            () => {}
          );
        }
        result.imported++;
      } catch (err) {
        result.errors++;
        opts.onError?.(t.id, err);
      }
    }
  }

  const now = new Date().toISOString();
  const prior = await db
    .select({ value: jobState.value })
    .from(jobState)
    .where(eq(jobState.key, TODOIST_JOB_KEY));
  const priorState = (prior[0]?.value ?? null) as TodoistJobState | null;
  const state: TodoistJobState = {
    lastRunAt: now,
    lastSuccessAt: result.errors === 0 ? now : (priorState?.lastSuccessAt ?? null),
    lastResult: result,
  };
  await db
    .insert(jobState)
    .values({ key: TODOIST_JOB_KEY, value: state })
    .onConflictDoUpdate({ target: jobState.key, set: { value: state } });

  return result;
}

export async function getTodoistState(): Promise<TodoistJobState | null> {
  const rows = await getDb()
    .select({ value: jobState.value })
    .from(jobState)
    .where(eq(jobState.key, TODOIST_JOB_KEY));
  return (rows[0]?.value as TodoistJobState) ?? null;
}
