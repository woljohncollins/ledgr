// One date per task (John's instance, 2026-09-21): the due date IS the start
// date. Whichever of scheduledDate / dueDate a write supplies, the other follows,
// so every surface - canvas fields, quick capture, MCP, the Outlook bridge -
// leaves a task with a single day. Pure; env-gated so upstream behaviour can be
// restored with ONE_DATE_PER_TASK="0".
//
// Rule: only one supplied -> copy it to the other. Both supplied and different
// -> the scheduled (planned) day wins, matching how John phrased it: "make the
// due date equal to the scheduled date as I am typing".
export function oneDatePerTask(): boolean {
  const v = (process.env.ONE_DATE_PER_TASK ?? "1").trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "no");
}

type Dated = { dueDate?: Date | null; scheduledDate?: Date | null };

export function mirrorTaskDates<T extends Dated>(p: T, isTask: boolean): T {
  if (!isTask || !oneDatePerTask()) return p;
  const hasDue = p.dueDate !== undefined;
  const hasSched = p.scheduledDate !== undefined;
  if (hasSched && !hasDue) return { ...p, dueDate: p.scheduledDate ?? null };
  if (hasDue && !hasSched) return { ...p, scheduledDate: p.dueDate ?? null };
  if (hasDue && hasSched) {
    const a = p.dueDate ? p.dueDate.getTime() : null;
    const b = p.scheduledDate ? p.scheduledDate.getTime() : null;
    if (a !== b) return { ...p, dueDate: p.scheduledDate ?? null };
  }
  return p;
}
