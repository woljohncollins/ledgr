// Error intake for external schedulers (GitHub Actions backup, future
// Phase 2 sync workflows): a failed run POSTs here so the failure lands in
// error_log and /health counts it — the no-silent-failures rule extends to
// jobs that don't run on Vercel. Cron scope, same door as the other
// machine endpoints (ADR-004).
import { NextResponse } from "next/server";
import { verifyMachineRequest } from "@/lib/auth/credentials";
import { captureError } from "@/lib/log";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const identity = await verifyMachineRequest(
    request.headers.get("authorization"),
    "cron"
  );
  if (!identity) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const input = (body ?? {}) as Record<string, unknown>;
  const source = typeof input.source === "string" && input.source ? input.source : null;
  const message = typeof input.message === "string" && input.message ? input.message : null;
  if (!source || !message) {
    return NextResponse.json(
      { error: "source and message are required" },
      { status: 400 }
    );
  }

  const correlationId = crypto.randomUUID();
  await captureError(`${identity.name}:${source}`.slice(0, 120), null, {
    correlationId,
    message: message.slice(0, 500),
    detail: input.detail ?? null,
  });
  return NextResponse.json({ ok: true, correlationId });
}
