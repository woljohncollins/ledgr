// Build → Capture & Inbox (ADR-249). One address for "how does stuff get into
// Ledgr": where each of the seven arrival paths lands, and the web clipper
// setup — which moved here from the bottom of User Settings, so the page starts
// life consolidating rather than adding.
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import CaptureRoutes from "@/components/build/CaptureRoutes";
import WebClipper from "@/components/settings/WebClipper";
import { listItems } from "@/lib/items";
import { resolveOwner } from "@/lib/owner";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

export default async function BuildCapture() {
  const owner = await resolveOwner();
  if (!owner) redirect("/sign-in");

  const [settings, projects] = await Promise.all([
    getSettings(owner.id),
    listItems(owner.id, { type: "project", limit: 200 }),
  ]);

  // Origin from the serving request so the clipper bookmarklet points at the
  // right host (prod, preview, or localhost) without an env var — the same
  // derivation User Settings used while the clipper lived there.
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  const proto =
    h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = host ? `${proto}://${host}` : (process.env.NEXT_PUBLIC_APP_URL ?? "");

  return (
    <main className="min-h-screen">
      <div className="mx-auto w-full max-w-3xl px-6 py-10 sm:px-12">
        <h1 className="text-2xl font-bold tracking-tight text-neutral-100">
          Capture &amp; Inbox
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-muted">
          Everything that arrives in Ledgr without you filing it by hand, and
          where each one lands. Send a path to the{" "}
          <Link href="/inbox" className="underline decoration-dotted underline-offset-2 hover:text-ink">
            Inbox
          </Link>{" "}
          to triage it later, file it straight away, or drop it into a project.
          When nothing routes to the Inbox and nothing is waiting in it, the
          Inbox drops out of your nav; the page itself keeps working.
        </p>
        <div className="mt-6">
          <CaptureRoutes
            initial={settings.inboxRoutes}
            projects={projects.map((p) => ({ id: p.id, title: p.title ?? "" }))}
          />
        </div>
        <WebClipper origin={origin} />
      </div>
    </main>
  );
}
