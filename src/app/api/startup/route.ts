import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/api";
import { getInstanceIdentity } from "@/lib/updates";
import { createLogger } from "@/lib/log";
import { readStartupReport } from "@/lib/startup";

// "Start when Windows starts", the app half (ADR-211).
//
// The app cannot register a scheduled task itself: the always-on scope wants an
// elevated prompt, and a web request is the wrong place to raise one. So this
// writes the request into the supervisor's data directory and the supervisor —
// a local process the owner started — carries it out and records the outcome.
// Deliberately the SAME signal-file mechanism as "Update now" rather than a
// second pattern.
//
// GET returns what the supervisor last recorded, so the toggle can be honest
// about a registration that failed for want of elevation.
export const dynamic = "force-dynamic";

const log = createLogger("startup");

export async function GET() {
  const owner = await requireOwner();
  if (owner instanceof NextResponse) return owner;
  return NextResponse.json(await readStartupReport(getInstanceIdentity().supervisorDir));
}

export async function POST(request: Request) {
  const owner = await requireOwner();
  if (owner instanceof NextResponse) return owner;

  const dir = getInstanceIdentity().supervisorDir;
  if (!dir) {
    return NextResponse.json(
      { ok: false, error: "This instance is not managed by a local supervisor." },
      { status: 403 }
    );
  }

  let body: { enabled?: unknown; scope?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json({ ok: false, error: "enabled must be true or false" }, { status: 400 });
  }
  if (body.scope !== undefined && body.scope !== "logon" && body.scope !== "always") {
    return NextResponse.json(
      { ok: false, error: 'scope must be "logon" or "always"' },
      { status: 400 }
    );
  }
  const scope = body.scope === "always" ? "always" : "logon";

  try {
    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await writeFile(
      join(dir, "startup-requested"),
      JSON.stringify({ enabled: body.enabled, scope }) + "\n",
      "utf8"
    );
  } catch (err) {
    log.error("startup signal write failed", { dir, detail: String(err) });
    return NextResponse.json(
      { ok: false, error: "Could not signal the supervisor. Is its data directory writable?" },
      { status: 502 }
    );
  }
  log.info("startup change signaled to supervisor", { enabled: body.enabled, scope });
  // The supervisor polls every 2s; the client re-reads GET to learn the result
  // rather than being told here that it worked.
  return NextResponse.json({ ok: true, pending: true });
}
