// AI & MCP (ADR-047, ADR-063). The MCP server is fully built and live at
// /api/mcp; this page is its management surface — it surfaces connection status,
// the endpoint and how to connect a client (Claude or any other MCP-speaking
// AI), and the live tool list the server exposes. Labelled "AI & MCP", not
// "Claude": the server is client-agnostic (build-nav.ts).
//
// All read from server-side libs directly (no fetch): the same hasScopedToken /
// resolveMcpOwner the /health canary uses, and listToolDefs() so the tool list
// here can never drift from what the server actually serves.
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { hasScopedToken } from "@/lib/auth/machine";
import { oauthConfigured } from "@/lib/auth/oauth";
import { mintMcpToken } from "@/lib/auth/mint-actions";
import CopyField from "@/components/build/CopyField";
import TokenMinter from "@/components/build/TokenMinter";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@/lib/mcp/protocol";
import { resolveMcpOwner } from "@/lib/mcp/owner";
import { SERVER_INFO } from "@/lib/mcp/server";
import { listToolDefs } from "@/lib/mcp/tools";
import { resolveOwner } from "@/lib/owner";

export const dynamic = "force-dynamic";

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${
        ok ? "bg-emerald-500" : "bg-amber-500"
      }`}
      aria-hidden
    />
  );
}

function CheckRow({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-2.5 text-sm text-neutral-300">
      <StatusDot ok={ok} />
      {children}
    </li>
  );
}

export default async function AiAndMcp() {
  const owner = await resolveOwner();
  if (!owner) redirect("/sign-in");

  const hasToken = hasScopedToken("mcp");
  const oauthReady = oauthConfigured();
  const ownerResolves = !!(await resolveMcpOwner());
  // Connectable when a static mcp token exists OR the OAuth secret is set —
  // the latter now also backs browser-minted MCP tokens (ADR-160), so a green
  // status no longer requires an env-configured token.
  const canConnect = hasToken || oauthReady;
  const configured = canConnect && ownerResolves;
  const hasApiToken = hasScopedToken("api");

  // The UPN the server acts as (owner.ts's resolution order). It's the owner's
  // own email — fine to show on a single-user surface — and tells you which env
  // knob is in play if the owner doesn't resolve.
  const actingUpn =
    process.env.LEDGR_MCP_OWNER_UPN ||
    process.env.ONEDRIVE_EXPORT_UPN ||
    process.env.GRAPH_MAILBOX_UPN ||
    process.env.DEV_USER_EMAIL ||
    null;

  // Endpoint URL from the request the page is being served on, so it's always
  // the right origin (preview, prod, or localhost) without an env var.
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = host ? `${proto}://${host}` : (process.env.NEXT_PUBLIC_APP_URL ?? "");
  const mcpUrl = `${origin}/api/mcp`;

  const tools = await listToolDefs(owner.id);
  const tokenCommand = "node scripts/make-token.mjs claude-mcp mcp";
  const addCommand = `claude mcp add --transport http ledgr ${mcpUrl} --header "Authorization: Bearer <token>"`;

  // The external HTTP API (ADR-066) — for app integrations / crons, not AI.
  const itemsUrl = `${origin}/api/machine/items`;
  const apiTokenCommand = "node scripts/make-token.mjs savor api";
  const pushExample = `curl -X POST ${itemsUrl} \\
  -H "Authorization: Bearer <token>" \\
  -H "Content-Type: application/json" \\
  -d '{"items":[{"type":"note","title":"Journal — 2026-06-15",
    "body":{"format":"markdown","text":"Today I…"},"inbox":true}]}'`;

  // Meeting minutes automation (ADR-087): a Claude-over-MCP workflow, not an
  // in-app LLM call. The manual trigger; the full prompt + scheduling live in
  // docs/meeting-minutes-automation.md.
  const minutesTrigger =
    "Process my meeting transcripts awaiting minutes: run the \"Transcripts " +
    "awaiting minutes\" view, draft minutes into each meeting's body, file the " +
    "action items as Inbox tasks related to the meeting, and mark each " +
    "transcript's minutes draft. Don't auto-commit anything — I review it.";

  return (
    <main className="min-h-screen">
      <div className="mx-auto w-full max-w-3xl px-6 py-10 sm:px-12">
        <h1 className="text-2xl font-bold tracking-tight text-neutral-100">AI &amp; MCP</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Ledgr runs a Model Context Protocol server so an AI assistant (Claude, or
          any MCP-speaking client) can search, read, create, and update your items
          on your behalf. It authenticates with a personal API token, never your
          login.
        </p>

        {/* Status */}
        <section className="mt-8">
          <div
            className={`rounded-xl border p-5 ${
              configured ? "border-emerald-900/60 bg-emerald-950/20" : "border-amber-900/60 bg-amber-950/20"
            }`}
          >
            <div className="flex items-center gap-2.5">
              <StatusDot ok={configured} />
              <p className="text-sm font-semibold text-neutral-100">
                {configured ? "Server live and connectable" : "Server not yet connectable"}
              </p>
            </div>
            <ul className="mt-3 flex flex-col gap-1.5">
              <CheckRow ok={canConnect}>
                {hasToken
                  ? "A token with the mcp scope is configured."
                  : oauthReady
                    ? "Ready to mint MCP tokens below (LEDGR_OAUTH_SECRET is set)."
                    : "No mcp-scoped token, and minting isn't set up — see below."}
              </CheckRow>
              <CheckRow ok={ownerResolves}>
                {ownerResolves ? (
                  <>
                    Owner resolves
                    {actingUpn ? (
                      <>
                        {" "}— acting as{" "}
                        <span className="text-neutral-400">{actingUpn}</span>
                      </>
                    ) : null}
                    .
                  </>
                ) : (
                  <>Owner not configured — set LEDGR_MCP_OWNER_UPN (runbook §1f).</>
                )}
              </CheckRow>
            </ul>
          </div>
        </section>

        {/* Connection details */}
        <section className="mt-10">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Connection
          </h2>
          <div className="mt-2 flex flex-col gap-3">
            <div>
              <p className="mb-1 text-xs text-neutral-500">Endpoint (Streamable HTTP, POST)</p>
              <CopyField value={mcpUrl} label="endpoint URL" />
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-xs text-neutral-500">Server</dt>
                <dd className="text-neutral-300">
                  {SERVER_INFO.name} v{SERVER_INFO.version}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-neutral-500">Auth</dt>
                <dd className="text-neutral-300">Bearer token (mcp scope)</dd>
              </div>
              <div>
                <dt className="text-xs text-neutral-500">Protocol</dt>
                <dd className="text-neutral-300">{SUPPORTED_PROTOCOL_VERSIONS.join(", ")}</dd>
              </div>
            </dl>
          </div>
        </section>

        {/* How to connect */}
        <section className="mt-10">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Connect a client
          </h2>
          <ol className="mt-3 flex flex-col gap-4">
            <li>
              <p className="text-sm text-neutral-300">
                <span className="font-semibold text-neutral-100">1.</span> Generate a
                token. It&rsquo;s shown only once — copy it right away. Generating
                one takes effect immediately (no redeploy).
              </p>
              <div className="mt-2">
                <TokenMinter
                  action={mintMcpToken}
                  noun="MCP token"
                  disabled={!oauthReady}
                  disabledHint="Set LEDGR_OAUTH_SECRET on your host and redeploy to mint tokens here (runbook §3a)."
                />
              </div>
              <p className="mt-2 text-xs text-neutral-500">
                Prefer the CLI? Run{" "}
                <code className="rounded bg-neutral-800 px-1 py-0.5 font-mono text-[11px] text-neutral-400">
                  {tokenCommand}
                </code>{" "}
                and add the printed entry to the{" "}
                <code className="rounded bg-neutral-800 px-1 py-0.5 font-mono text-[11px] text-neutral-400">
                  LEDGR_API_TOKENS
                </code>{" "}
                env var, then redeploy.
              </p>
            </li>
            <li>
              <p className="text-sm text-neutral-300">
                <span className="font-semibold text-neutral-100">2.</span> Point a
                client at the endpoint with that token. For Claude Code:
              </p>
              <div className="mt-1.5">
                <CopyField value={addCommand} label="claude mcp add command" />
              </div>
              <p className="mt-1.5 text-xs text-neutral-500">
                For <strong className="text-neutral-300">claude.ai or the Claude
                mobile apps</strong>, add a custom connector with just the
                endpoint URL above (no token field needed): those clients connect
                over OAuth, so Claude discovers the flow and you approve it with a
                normal sign-in. Add it once and it&rsquo;s available on web,
                desktop, and your phone. The OAuth shim must be configured for
                this path (see below). Any MCP-speaking client that does the
                manual-header style (like Claude Code, above) can still use the{" "}
                <code className="rounded bg-neutral-800 px-1 py-0.5 font-mono text-[11px] text-neutral-400">
                  Authorization: Bearer &lt;token&gt;
                </code>{" "}
                token instead.
              </p>
            </li>
          </ol>
        </section>

        {/* Phone / claude.ai — the OAuth connector path (ADR-117) */}
        <section className="mt-10">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Phone &amp; claude.ai (OAuth connector)
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-neutral-400">
            The consumer Claude apps (claude.ai web and the iOS/Android apps)
            connect to a custom connector over OAuth, not a pasted token. The
            server runs a minimal OAuth flow so you can add it there with just
            the endpoint URL above and a normal sign-in. Connectors are
            account-level, so adding it once makes it available on web, desktop,
            and your phone.
          </p>
          <div className="mt-3 flex items-center gap-2.5">
            <StatusDot ok={oauthReady} />
            <p className="text-sm text-neutral-300">
              {oauthReady ? (
                "OAuth shim is configured — add the endpoint as a custom connector in Claude."
              ) : (
                <>
                  Not configured — set{" "}
                  <code className="rounded bg-neutral-800 px-1 py-0.5 font-mono text-xs text-neutral-300">
                    LEDGR_OAUTH_SECRET
                  </code>{" "}
                  on Vercel and redeploy (runbook §3a). Until then, only the
                  manual-token clients above can connect.
                </>
              )}
            </p>
          </div>
          <div className="mt-3 rounded-lg border border-amber-900/50 bg-amber-950/20 p-3">
            <p className="text-xs leading-relaxed text-amber-200/80">
              <span className="font-semibold text-amber-200">Revoking MCP access:</span>{" "}
              rotate{" "}
              <code className="rounded bg-neutral-800 px-1 py-0.5 font-mono text-[11px] text-neutral-300">
                LEDGR_OAUTH_SECRET
              </code>{" "}
              on your host and redeploy. ⚠️ This signs out{" "}
              <strong>every</strong> MCP credential signed by it at once — the
              phone/web connector <em>and</em> every browser-minted MCP token
              above. Generating a new token never revokes an old one; only this
              does. It does not affect static{" "}
              <code className="rounded bg-neutral-800 px-1 py-0.5 font-mono text-[11px] text-neutral-300">
                LEDGR_API_TOKENS
              </code>{" "}
              clients, the web clipper, or your non-Ledgr connectors.
            </p>
          </div>
        </section>

        {/* Tools the server exposes */}
        <section className="mt-10">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
              Tools exposed ({tools.length})
            </h2>
            <span className="text-xs text-neutral-600">live from the server</span>
          </div>
          <ul className="mt-2 flex flex-col gap-1.5">
            {tools.map((t) => {
              const readOnly = t.annotations.readOnlyHint === true;
              return (
                <li key={t.name} className="rounded-xl border border-neutral-800 p-3.5">
                  <div className="flex items-center gap-2">
                    <code className="font-mono text-sm text-neutral-200">{t.name}</code>
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                        readOnly
                          ? "bg-neutral-800 text-neutral-400"
                          : "bg-[var(--accent)]/15 text-[var(--accent)]"
                      }`}
                    >
                      {readOnly ? "read" : "write"}
                    </span>
                  </div>
                  <p className="mt-1 text-sm leading-relaxed text-neutral-500">
                    {t.description}
                  </p>
                </li>
              );
            })}
          </ul>
        </section>

        {/* Automations — Claude-over-MCP workflows (ADR-087) */}
        <section className="mt-10">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Automations
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-neutral-400">
            Workflows run by Claude over the tools above (not an in-app model
            call). Nothing auto-commits: outputs are staged for review.
          </p>
          <div className="mt-4 rounded-xl border border-neutral-800 p-3.5">
            <p className="text-sm font-semibold text-neutral-100">
              Meeting minutes
            </p>
            <p className="mt-1 text-sm leading-relaxed text-neutral-500">
              Turns transcripts awaiting minutes into draft minutes (in the
              meeting body) and suggested tasks (in the Inbox, related to the
              meeting). Run it manually after a meeting, or on a schedule. Full
              prompt + scheduling in{" "}
              <code className="rounded bg-neutral-800 px-1 py-0.5 font-mono text-[11px] text-neutral-400">
                docs/meeting-minutes-automation.md
              </code>
              .
            </p>
            <p className="mb-1 mt-3 text-xs text-neutral-500">Manual trigger</p>
            <CopyField value={minutesTrigger} label="minutes trigger" />
          </div>
        </section>

        {/* External HTTP API — app integrations, not AI (ADR-066) */}
        <section className="mt-12 border-t border-neutral-800 pt-8">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
            App integrations (HTTP API)
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-neutral-400">
            A plain REST endpoint for other apps and scheduled jobs (not AI) to
            push items into Ledgr and read them back out, authenticated with a
            machine token. This is the path for connecting something like Savor:
            its cron POSTs each new journal entry here as an item.
          </p>

          <div className="mt-3 flex items-center gap-2.5">
            <StatusDot ok={hasApiToken} />
            <p className="text-sm text-neutral-300">
              {hasApiToken
                ? "An api-scoped token is configured."
                : "No api-scoped token yet — generate one below to enable the endpoint."}
            </p>
          </div>

          <dl className="mt-4 flex flex-col gap-3">
            <div>
              <dt className="text-xs text-neutral-500">
                Write items in (single object or {"{ items: [...] }"} batch)
              </dt>
              <dd className="mt-1">
                <CopyField value={`POST ${itemsUrl}`} label="write endpoint" />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-neutral-500">
                Read items out (body-free list; ?type= &amp;status= &amp;limit= …)
              </dt>
              <dd className="mt-1">
                <CopyField value={`GET ${itemsUrl}`} label="read endpoint" />
              </dd>
            </div>
          </dl>

          <div className="mt-4">
            <p className="text-sm text-neutral-300">
              <span className="font-semibold text-neutral-100">1.</span> Generate
              an api-scoped token (same scheme as the MCP token above):
            </p>
            <div className="mt-1.5">
              <CopyField value={apiTokenCommand} label="api token command" />
            </div>
          </div>

          <div className="mt-4">
            <p className="text-sm text-neutral-300">
              <span className="font-semibold text-neutral-100">2.</span> Point the
              other app&rsquo;s cron at the endpoint with that token. The{" "}
              <code className="rounded bg-neutral-800 px-1 py-0.5 font-mono text-xs text-neutral-300">
                type
              </code>{" "}
              decides which item type each entry becomes — set up a type for it in{" "}
              <a href="/build/types" className="text-[var(--accent)] hover:underline">
                Types &amp; Properties
              </a>{" "}
              (or use a built-in like <code className="rounded bg-neutral-800 px-1 py-0.5 font-mono text-xs text-neutral-300">note</code>),
              then send its key:
            </p>
            <pre className="mt-1.5 overflow-x-auto rounded border border-neutral-800 bg-neutral-900 p-3 font-mono text-[11px] leading-relaxed text-neutral-300">
              {pushExample}
            </pre>
            <p className="mt-1.5 text-xs text-neutral-500">
              Each entry validates exactly like the in-app create. A bad entry in
              a batch is reported and skipped, not fatal. Have the cron push only
              entries new since its last run (track a cursor on its side) to avoid
              duplicates.
            </p>
          </div>
        </section>

        {/* Web clipper — setup relocated to User Settings (ADR-122). The
            bookmarklet rides the api token generated here, so it's mentioned,
            but the drag-to-bookmarks UI + mobile steps live in Settings where
            people actually look for "save a web page". */}
        <section className="mt-12 border-t border-neutral-800 pt-8">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Web clipper
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-neutral-400">
            Save a web page&rsquo;s readable content as a link item, from
            desktop or mobile, landing wherever Capture &amp; Inbox routes the
            Web clipper. It posts to{" "}
            <code className="rounded bg-neutral-800 px-1 py-0.5 font-mono text-xs text-neutral-300">
              /api/machine/capture
            </code>{" "}
            using the same api-scoped token as the HTTP API above. Drag the
            bookmarklet and set up mobile sharing in{" "}
            <a href="/settings" className="text-[var(--accent)] hover:underline">
              User Settings → Save from the web
            </a>
            .
          </p>
        </section>
      </div>
    </main>
  );
}
