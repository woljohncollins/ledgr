// Quiet projects for the Tasks Today surface (Tyler, 2026-08-17): active
// projects the owner hasn't LOOKED AT (or touched) within their per-project
// window. Same selection rule as the Digest push (runDigestNotify) minus the
// milestone/upcoming half — this list is purely "gone quiet." Deterministic,
// no model, no writes.
//
// The clock: staleness measures against max(lastActivityAt, lastReviewedAt);
// opening the project writes checkin_reviewed via the view beacon, so reading
// it is enough to reset (no manual check-in, deliberately). A project with no
// activity ever doesn't nag (digestStatus's rule). Per-project opt-out + window
// live in composition.behaviors.digest (the record's "Check-ins" control);
// default on at 14 days (DEFAULT_DIGEST).
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { items } from "@/db/schema";
import { lastActivityAt, lastReviewedAt } from "@/lib/activity";
import { digestStatus } from "@/lib/digest/compose";
import { DEFAULT_DIGEST, resolveComposition } from "@/lib/composition";
import { getType } from "@/lib/types";

export type StaleProject = { id: string; title: string; daysQuiet: number };

const MAX_SHOWN = 5;

export async function staleProjects(ownerId: string, now = new Date()): Promise<StaleProject[]> {
  const projectType = await getType("project").catch(() => null);
  const projects = await getDb()
    .select({
      id: items.id,
      title: items.title,
      statusCategory: items.statusCategory,
      composition: items.composition,
    })
    .from(items)
    .where(
      and(
        eq(items.ownerId, ownerId),
        eq(items.type, "project"),
        isNull(items.deletedAt),
        eq(items.isTemplate, false)
      )
    );

  const out: StaleProject[] = [];
  for (const p of projects) {
    // A finished/archived project has every right to be quiet.
    if (p.statusCategory === "done" || p.statusCategory === "archived") continue;
    const { composition } = resolveComposition(p.composition, projectType?.defaultWidgets, "project");
    const digest = composition.behaviors.digest ?? DEFAULT_DIGEST;
    if (!digest.enabled) continue;
    const [lastActivity, lastReviewed] = await Promise.all([
      lastActivityAt(ownerId, p.id),
      lastReviewedAt(ownerId, p.id),
    ]);
    const status = digestStatus({
      lastActivityAt: lastActivity,
      lastReviewedAt: lastReviewed,
      stalenessDays: digest.stalenessDays,
      upcomingMilestoneDays: [],
      upcomingDays: 0,
      now,
    });
    if (status.trigger !== "staleness") continue;
    out.push({ id: p.id, title: p.title || "Untitled project", daysQuiet: status.daysQuiet });
  }
  return out.sort((a, b) => b.daysQuiet - a.daysQuiet).slice(0, MAX_SHOWN);
}
