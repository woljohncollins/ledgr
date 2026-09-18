import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/api";
import { getUpdateReport, getInstanceIdentity, resolveApplicability } from "@/lib/updates";
import { getCodeStatus, applyCodeUpdate, GithubError } from "@/lib/github/client";
import { createLogger } from "@/lib/log";

// GET  — the update report (/build/updates renders it; the client island polls
//        it after an update to notice when the new deploy has taken over).
// POST — pull upstream into this instance's fork, which triggers its redeploy.
//
// Owner-gated: this is a Build/MAINTAIN action that changes what the whole
// instance runs, so it is never reachable by a signed-out caller.
export const dynamic = "force-dynamic";

const log = createLogger("updates");

export async function GET() {
  const owner = await requireOwner();
  if (owner instanceof NextResponse) return owner;
  return NextResponse.json(await getUpdateReport());
}

export async function POST() {
  const owner = await requireOwner();
  if (owner instanceof NextResponse) return owner;

  // Re-check applicability here rather than trusting the caller: the button is
  // only one of the ways this route can be reached, and the schema-safety rule
  // is the whole reason the gate exists.
  const instance = getInstanceIdentity();
  const code = await getCodeStatus(
    instance.sha,
    instance.upstreamRepo,
    instance.branch,
    instance.isSatellite || instance.isLocalPeer
  );
  const { canApply, blockedReason, strategy } = resolveApplicability(instance, code);

  if (code.state !== "behind") {
    return NextResponse.json(
      { ok: false, error: "Nothing to update — this instance is already current." },
      { status: 409 }
    );
  }

  // Local peer (LH2, ADR-206): hand the update to the supervisor by writing
  // the signal file it polls; it pulls, builds fresh, migrates, and swaps
  // (keep-last-good). The sha is informational — the supervisor builds
  // whatever `git pull` lands on.
  if (strategy === "supervisor-signal") {
    if (!canApply || !instance.supervisorDir) {
      return NextResponse.json(
        { ok: false, error: blockedReason ?? "Updating is not available on this instance." },
        { status: 403 }
      );
    }
    const targetSha = code.commits.at(-1)?.sha ?? "";
    try {
      const { writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      await writeFile(join(instance.supervisorDir, "update-requested"), targetSha, "utf8");
    } catch (err) {
      log.error("update signal write failed", { dir: instance.supervisorDir, detail: String(err) });
      return NextResponse.json(
        { ok: false, error: "Could not signal the supervisor. Is its data directory writable?" },
        { status: 502 }
      );
    }
    log.info("update signaled to supervisor", { from: instance.shortSha, commits: code.count });
    return NextResponse.json({
      ok: true,
      mergeType: "supervisor",
      commits: code.count,
      message: "Update handed to the supervisor. This instance rebuilds and restarts now.",
    });
  }

  if (!canApply || strategy !== "github-merge" || !instance.deployRepo) {
    return NextResponse.json(
      { ok: false, error: blockedReason ?? "Updating is not available on this instance." },
      { status: 403 }
    );
  }

  try {
    const result = await applyCodeUpdate(instance.deployRepo, instance.branch);
    log.info("update applied", {
      repo: instance.deployRepo,
      branch: instance.branch,
      from: instance.shortSha,
      commits: code.count,
      mergeType: result.mergeType,
    });
    return NextResponse.json({
      ok: true,
      mergeType: result.mergeType,
      commits: code.count,
      // The fork now has the new commits; Vercel takes a minute or two to build
      // and swap them in, which is what the client polls for.
      message:
        result.mergeType === "none"
          ? "The fork was already current; no deploy was triggered."
          : "Update pulled. This instance is rebuilding now.",
    });
  } catch (err) {
    const detail = err instanceof GithubError ? err.message : String(err);
    log.error("update failed", { repo: instance.deployRepo, detail });
    const isAuth = err instanceof GithubError && err.kind === "auth";
    return NextResponse.json(
      {
        ok: false,
        error: isAuth
          ? "GitHub refused the update: this instance's token can't write to its own repository."
          : `The update could not be applied: ${detail}`,
      },
      { status: isAuth ? 403 : 502 }
    );
  }
}
