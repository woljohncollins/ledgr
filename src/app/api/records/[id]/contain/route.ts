import { NextResponse } from "next/server";
import { asUuid, errorResponse, requireOwner } from "@/lib/api";
import { createItem } from "@/lib/item-mutations";
import { getItem } from "@/lib/items";
import { listTypes, mayLiveInManyRecords } from "@/lib/types";
import {
  filedUnderRecords,
  homeParentRecord,
  relateItems,
  setHome,
  unrelateItems,
} from "@/lib/relations";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

// POST /api/records/[id]/contain — create an item (or attach an existing one,
// `{ itemId }`) and make it a HOME-contained
// child of this record (Project Type, ADR-111/PJ5). The one write path behind
// the editable collection widgets: the Tasks widget's "add task", the Notes
// capture bar, the Milestones "add". Tasks use the existing role "project"
// (so the task→project field stays one mechanism); everything else uses the
// generic "contains" role. Body { type, title?, text?, date? } — milestones
// also accept { points?, taskId?, newTaskTitle? } (ADR-196): points lands in
// properties.points (the % share of the project bar), taskId links an existing
// task as the milestone's "Completes with task" (edges with role 'task'), and
// newTaskTitle creates that task IN this record first, then links it.
// The built-in collections this route has always served. Custom types are
// allowed too (ADR-204 — the bug Tyler hit: a type offered as a tool got a 400
// from this allowlist, and the card's add did nothing): any LIVE, non-hidden
// type from the registry may be contained. `milestone`/`mindmap` are hidden
// types, which is why the built-in set stays a fast path rather than folding
// into the registry check.
const ALLOWED = new Set(["task", "note", "milestone", "event", "link", "mindmap"]);

// The home-edge role a contained item gets. Tasks keep the existing "project"
// role so the task→project field stays one mechanism; everything else is the
// generic "contains". One function because BOTH branches below need it (create
// and attach) and the widgets' read queries filter on exactly this — the two
// deciding it separately is how they'd drift into an item that files fine and
// then never shows up in its card.
const containRole = (type: string) => (type === "task" ? "project" : "contains");

// The edge a multi-record attach writes. Named because the detach ✕ deletes
// exactly this role, so the two must not drift apart.
const RELATED_ROLE = "related";

export async function POST(request: Request, context: Context) {
  const owner = await requireOwner();
  if (owner instanceof NextResponse) return owner;
  try {
    const id = asUuid((await context.params).id, "id");
    const raw = (await request.json()) as Record<string, unknown>;

    // Attach an item that ALREADY exists instead of creating a blank one
    // (Brandon, 2026-08-28 — the cards could only ever make something new).
    // What the attach WRITES depends on the item's own type, not the caller's
    // `type` hint (so a mistyped hint can't file a note as a task):
    //   - a resource type (note, event, link) gains a plain `related` edge and
    //     keeps its home, so it can be relevant to several projects at once
    //   - a type that completes (task, milestone) is MOVED, home and all
    // Either way it lands in the same card, read by the same home-agnostic
    // query the create path feeds.
    if (raw.itemId !== undefined) {
      const itemId = asUuid(raw.itemId, "itemId");
      const existing = await getItem(owner.id, itemId);
      if (existing.deletedAt) {
        return NextResponse.json({ error: "item not found" }, { status: 404 });
      }
      const filedUnder = await filedUnderRecords(owner.id, itemId);
      // Whether this type may be filed under several records — the client needs
      // it to say the right thing about what just happened.
      const multi = await mayLiveInManyRecords(existing.type);
      // Already filed here: nothing to do, and say so rather than writing a
      // second edge to the same record.
      if (filedUnder.includes(id)) {
        return NextResponse.json({ item: existing, contained: true, multi }, { status: 200 });
      }
      // A resource type (no completion concept) may belong to several records
      // at once (ADR-232): add a plain `related` edge and leave its filing
      // where it is. `related` rather than `contains` on purpose — the
      // completion sweep scopes on `home or role in ('project','contains')`,
      // so a contains edge would put a note that merely VISITS this project
      // inside the project's completion net. Association is never swept.
      //
      // Unless it isn't filed anywhere yet: the FIRST record to take an
      // unfiled resource adopts it. Otherwise a note attached to two projects
      // would be a visitor in both and a resident of nowhere, and the visitor
      // marker would say nothing (found in the browser check, 2026-08-28).
      if (multi && filedUnder.length > 0) {
        await relateItems(owner.id, itemId, id, RELATED_ROLE);
        return NextResponse.json({ item: existing, contained: false, multi }, { status: 200 });
      }
      // Filed under exactly one record from here on. setHome only DEMOTES the
      // previous home edge (home=false) and the cards are home-agnostic, so
      // without this the item would keep rendering on its old record's card
      // with no way to remove it — a completing type has no detach ✕. Drop the
      // old filing edges first so "belongs to one record" is actually true.
      // Both containment roles, not just this type's: the old edge was written
      // by whatever filed it there. Role-scoped on purpose, so a deliberate
      // `related` or `tags` edge to the old record survives the re-filing.
      for (const old of filedUnder) {
        for (const role of ["project", "contains"]) {
          await unrelateItems(owner.id, itemId, old, { role });
        }
      }
      await setHome(owner.id, itemId, id, containRole(existing.type));
      return NextResponse.json({ item: existing, contained: true, multi }, { status: 200 });
    }

    const type = String(raw.type ?? "");
    if (!ALLOWED.has(type)) {
      const live = await listTypes(); // excludes hidden + deleted types
      if (!live.some((t) => t.key === type)) {
        return NextResponse.json({ error: "unsupported contained type" }, { status: 400 });
      }
    }
    const title = typeof raw.title === "string" ? raw.title : "";
    const text = typeof raw.text === "string" ? raw.text.trim() : "";
    const body = text ? { format: "markdown", text } : undefined;
    // A date on the payload maps to the type's natural date column: milestones
    // land on due_date, meetings (events) on meeting_at.
    const rawDate = typeof raw.date === "string" && raw.date ? new Date(raw.date) : undefined;
    const validDate = rawDate && !Number.isNaN(rawDate.getTime()) ? rawDate : undefined;
    const dueDate = type === "milestone" ? validDate : undefined;
    const meetingAt = type === "event" ? validDate : undefined;
    // Milestone extras (ADR-196), validated shape-only here; ownership of a
    // linked task is asserted by relateItems below.
    const points = type === "milestone" ? Number(raw.points) : NaN;
    const properties =
      Number.isFinite(points) && points > 0
        ? { points: Math.min(Math.round(points), 100) }
        : undefined;
    const item = await createItem(owner.id, {
      type,
      title,
      ...(body ? { body } : {}),
      ...(dueDate ? { dueDate } : {}),
      ...(meetingAt ? { meetingAt } : {}),
      ...(properties ? { properties } : {}),
    });
    await setHome(owner.id, item.id, id, containRole(type));
    if (type === "milestone") {
      let taskId = typeof raw.taskId === "string" && raw.taskId ? asUuid(raw.taskId, "taskId") : null;
      const newTaskTitle = typeof raw.newTaskTitle === "string" ? raw.newTaskTitle.trim() : "";
      if (!taskId && newTaskTitle) {
        // Create the completing task inside this record, same as the Tasks
        // widget's add would (role "project").
        const t = await createItem(owner.id, { type: "task", title: newTaskTitle });
        await setHome(owner.id, t.id, id, "project");
        taskId = t.id;
      }
      if (taskId) {
        // The typed relation field's edge (ADR-067): milestone -> task, role
        // 'task'. relateItems asserts both ends are owned + live.
        await relateItems(owner.id, item.id, taskId, "task");
      }
    }
    // A note jotted ON a meeting also files under the meeting's project, so it
    // surfaces in that project's Docs box (Tyler, 2026-07-01). The note's HOME
    // stays the meeting; a plain "contains" edge to the project is enough for the
    // Docs query (type=note related to the project). Best-effort, non-fatal.
    if (type === "note") {
      const parent = await getItem(owner.id, id).catch(() => null);
      if (parent?.type === "event") {
        const project = await homeParentRecord(owner.id, id);
        if (project) {
          await relateItems(owner.id, item.id, project.id, "contains").catch(() => {});
        }
      }
    }
    return NextResponse.json({ item }, { status: 201 });
  } catch (err) {
    if (err instanceof SyntaxError) {
      return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
    }
    return errorResponse(err);
  }
}
