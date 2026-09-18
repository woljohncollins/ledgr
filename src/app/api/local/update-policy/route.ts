import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/api";
import { getInstanceIdentity } from "@/lib/updates";
import { createLogger } from "@/lib/log";
import { readUpdatePolicy, validatePolicyInput, writeUpdatePolicy } from "@/lib/update-policy";

// GET/POST /api/local/update-policy — how this machine takes new versions.
//
// Same seam as /api/startup and /api/local/restart: the app never talks to the
// local service, it edits a file in the service's data directory and the
// service re-reads it on its next one-minute tick. Owner-gated and refused on
// any instance without a supervisor (every cloud deploy), where there is
// nothing to point the policy at.
export const dynamic = "force-dynamic";

const log = createLogger("update-policy");

function supervisorDir(): string | null {
  const id = getInstanceIdentity();
  return id.vercelEnv ? null : id.supervisorDir;
}

export async function GET() {
  const owner = await requireOwner();
  if (owner instanceof NextResponse) return owner;
  const dir = supervisorDir();
  return NextResponse.json({ available: !!dir, policy: await readUpdatePolicy(dir) });
}

export async function POST(request: Request) {
  const owner = await requireOwner();
  if (owner instanceof NextResponse) return owner;
  const dir = supervisorDir();
  if (!dir) {
    return NextResponse.json(
      { ok: false, error: "This instance is not managed by a local service." },
      { status: 403 }
    );
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  const v = validatePolicyInput(body);
  if (!v.ok) return NextResponse.json({ ok: false, error: v.error }, { status: 400 });
  try {
    const policy = await writeUpdatePolicy(dir, v.policy);
    log.info("update policy written", { ...policy });
    return NextResponse.json({ ok: true, policy });
  } catch (err) {
    log.error("update policy write failed", { dir, detail: String(err) });
    return NextResponse.json(
      { ok: false, error: "Could not write the policy. Is the service's data directory writable?" },
      { status: 502 }
    );
  }
}
