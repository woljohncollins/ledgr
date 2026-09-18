// API Tokens (ADR-179, rewritten for ADR-224). The reference page for "give an
// outside app or an AI assistant access to my data over HTTP": what the
// credential paths are, what they open, and how to authenticate. The *issuing*
// now happens in User Settings → API credentials, because that is where a
// credential can be listed, its last use read, and one of them revoked
// individually; this page points there rather than duplicating the form.
//
// The CLI + env path stays documented, deliberately: an entry in
// LEDGR_API_TOKENS is the credential a job needs before the app can serve a
// page (CRON_SECRET, a bootstrap script, a restore), and it is the one path
// that works when the database does not.
//
// Everything is read from server-side libs directly (no fetch), the same way
// the AI & MCP page reads its status.
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { hasScopedToken } from "@/lib/auth/machine";
import { hasActiveCredential } from "@/lib/auth/credentials";
import { appConfigured } from "@/lib/auth/oauth";
import AppTokenMinter from "@/components/build/AppTokenMinter";
import CopyField from "@/components/build/CopyField";
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

// The api-scoped surface a credential opens. Kept in step with the routes that
// call verifyApiRequest (credentials.ts) — if another is added, list it here.
const ENDPOINTS: { method: string; path: string; what: string }[] = [
  {
    method: "GET / POST / PATCH",
    path: "/api/machine/items",
    what: "read and write items (GET filters: id — one uuid or comma-separated — type, status, statusCategory, relatedTo, parentId, q, limit, offset; add includeBody=true for bodies)",
  },
  {
    method: "GET",
    path: "/api/machine/items/<id>",
    what: "read one item whole: body, custom properties, and its named surfaces",
  },
  {
    method: "POST",
    path: "/api/machine/relations",
    what: "link items to each other",
  },
  {
    method: "GET",
    path: "/api/machine/types",
    what: "list the type registry (incl. capability, so a client can find project-shaped types)",
  },
  {
    method: "POST",
    path: "/api/machine/attachments",
    what: "register a file + get a presigned upload URL",
  },
  {
    method: "POST",
    path: "/api/machine/capture",
    what: "capture a URL as a link item in the Inbox",
  },
];

export default async function ApiTokens() {
  const owner = await resolveOwner();
  if (!owner) redirect("/sign-in");

  // Derived from the request so the examples are right on prod, preview, and
  // localhost without an env var (same trick as the AI & MCP page).
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = host ? `${proto}://${host}` : (process.env.NEXT_PUBLIC_APP_URL ?? "");

  const appReady = appConfigured();
  const staticApiToken = hasScopedToken("api");
  const mintedApiCredential = await hasActiveCredential("api");

  const curl = `curl -u "<keyID>:<secret>" ${origin}/api/machine/items`;
  const curlWrite = `curl -X POST ${origin}/api/machine/items \\
  -u "<keyID>:<secret>" \\
  -H "Content-Type: application/json" \\
  -d '{"type":"note","title":"Hello from your app"}'`;
  const curlReadBody = `# one item, whole: body, properties, surfaces
curl -u "<keyID>:<secret>" ${origin}/api/machine/items/<id>

# several at once, with bodies
curl -u "<keyID>:<secret>" \\
  "${origin}/api/machine/items?id=<id>,<id>&includeBody=true"`;
  const curlCopy = `# copy one item's body onto another, byte for byte
BODY=$(curl -s -u "<keyID>:<secret>" \\
  "${origin}/api/machine/items/<sourceId>" | jq -c '.item.body')

curl -X PATCH ${origin}/api/machine/items \\
  -u "<keyID>:<secret>" \\
  -H "Content-Type: application/json" \\
  -d "{\\"id\\":\\"<targetId>\\",\\"body\\":$BODY}"`;

  return (
    <div className="mx-auto max-w-3xl px-5 py-8">
      <h1 className="ui-title">API</h1>
      <p className="mt-2 max-w-2xl text-sm text-ink-muted">
        How an outside app, a script, or an AI assistant reads and writes your
        Ledgr data over HTTP, with no sign-in. Each one gets its own credential,
        holding only the permissions you ticked.
      </p>

      {/* Where to get one */}
      <section className="mt-8">
        <h2 className="ui-section-label">Get a credential</h2>
        <div className="mt-3 rounded-card border border-line bg-surface-1 p-4">
          <p className="ui-row text-ink-muted">
            Credentials are created in{" "}
            <Link
              href="/settings"
              className="font-medium text-[var(--accent)] hover:underline"
            >
              User Settings → API credentials
            </Link>
            . Name it, tick what it may do, and you get back a{" "}
            <strong className="text-ink">key ID</strong> and a{" "}
            <strong className="text-ink">secret</strong>. The key ID is public
            and stays visible in the list; the secret is shown once and is not
            recoverable.
          </p>
          <p className="mt-2 ui-row text-ink-muted">
            The same page lists every credential with its permissions, when it
            was created, and when it was last used, and revokes any one of them
            on its own. Creating and revoking both take effect on the next
            request, with no redeploy.
          </p>
        </div>
      </section>

      {/* How to authenticate */}
      <section className="mt-8">
        <h2 className="ui-section-label">Authenticating</h2>
        <p className="mt-2 text-sm text-ink-muted">
          Send both parts as HTTP Basic auth. That is the documented path, and
          it is what every HTTP client already knows how to do.
        </p>
        <pre className="mt-3 overflow-x-auto rounded-card border border-line bg-surface-2 p-3 font-mono text-xs text-ink-muted">
          Authorization: Basic base64(keyID:secret)
        </pre>
        <p className="mt-3 text-sm text-ink-muted">
          A client that can only send a bearer token may send the pair as one,
          separated by a colon:
        </p>
        <pre className="mt-2 overflow-x-auto rounded-card border border-line bg-surface-2 p-3 font-mono text-xs text-ink-muted">
          Authorization: Bearer keyID:secret
        </pre>
      </section>

      {/* What the credential opens */}
      <section className="mt-8">
        <h2 className="ui-section-label">What the api permission reaches</h2>
        <p className="mt-2 text-sm text-ink-muted">
          A credential carrying{" "}
          <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-xs">
            api
          </code>{" "}
          opens these routes and nothing else. It acts as you, so anything
          it writes lands in your items.
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[34rem] border-collapse text-left">
            <thead>
              <tr className="border-b border-line">
                <th className="py-2 pr-3 ui-meta font-medium">Method</th>
                <th className="py-2 pr-3 ui-meta font-medium">Endpoint</th>
                <th className="py-2 ui-meta font-medium">What it does</th>
              </tr>
            </thead>
            <tbody>
              {ENDPOINTS.map((e) => (
                <tr key={e.path} className="border-b border-line/60">
                  <td className="py-2 pr-3 font-mono text-xs text-ink-subtle">
                    {e.method}
                  </td>
                  <td className="py-2 pr-3 font-mono text-xs text-ink">
                    {e.path}
                  </td>
                  <td className="py-2 ui-row text-ink-muted">{e.what}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-4">
          <p className="mb-1.5 ui-meta">Read</p>
          <pre className="overflow-x-auto rounded-card border border-line bg-surface-2 p-3 font-mono text-xs text-ink-muted">
            {curl}
          </pre>
        </div>
        <div className="mt-3">
          <p className="mb-1.5 ui-meta">Write</p>
          <pre className="overflow-x-auto rounded-card border border-line bg-surface-2 p-3 font-mono text-xs text-ink-muted">
            {curlWrite}
          </pre>
        </div>
      </section>

      {/* Reading content — the half this surface was missing until ADR-262 */}
      <section className="mt-8">
        <h2 className="ui-section-label">Reading content</h2>
        <p className="mt-2 text-sm text-ink-muted">
          A list is body-free by default, because bodies are unbounded text and
          most callers are after titles and dates. When you actually want the
          content, ask for it: <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-xs">includeBody=true</code>{" "}
          on the list, or the per-item route, which returns one item whole.
        </p>
        <pre className="mt-3 overflow-x-auto rounded-card border border-line bg-surface-2 p-3 font-mono text-xs text-ink-muted">
          {curlReadBody}
        </pre>
        <ul className="mt-4 flex flex-col gap-2 ui-row text-ink-muted">
          <li>
            <strong className="text-ink">
              <code className="font-mono text-xs">body</code> is the same object
              on read and on write
            </strong>{" "}
            —{" "}
            <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-xs">
              {`{"format":"markdown","text":"…"}`}
            </code>
            , never a bare string. A write that sends a plain string is refused
            with <em>body must be a &#123; format, text &#125; object or null</em>. That
            symmetry is the point: a read result feeds straight back into a
            write with nothing to reshape, which is what makes a byte-exact copy
            possible.
          </li>
          <li>
            <strong className="text-ink">
              <code className="font-mono text-xs">format</code> is the type&rsquo;s,
              not always markdown
            </strong>{" "}
            — a song&rsquo;s body comes back as{" "}
            <code className="font-mono text-xs">chordpro</code>. Send back what
            you were given rather than hardcoding a format.
          </li>
          <li>
            <strong className="text-ink">
              <code className="font-mono text-xs">properties</code> carries the
              rest
            </strong>{" "}
            — a bespoke type keeps real content there, not only in the body: a
            paper&rsquo;s Notes, Shape and Quote Bank all live in{" "}
            <code className="font-mono text-xs">properties</code>. The per-item
            route also returns{" "}
            <code className="font-mono text-xs">surfaces</code>, which names each
            one and says where it is stored, so a copy can tell the draft from
            the scratch pad.
          </li>
          <li>
            <strong className="text-ink">Bodies are capped at 25 rows</strong> per
            list response. Past that, page with{" "}
            <code className="font-mono text-xs">offset</code>, or name the ids you
            want with <code className="font-mono text-xs">id=</code>.
          </li>
          <li>
            <strong className="text-ink">
              An unknown query parameter is a 400
            </strong>
            , naming what it did not understand and what it would have. Nothing
            is silently ignored, and no endpoint under{" "}
            <code className="font-mono text-xs">/api/machine</code> ever answers
            with an HTML page: a path that does not exist is a JSON 404.
          </li>
        </ul>
        <div className="mt-4">
          <p className="mb-1.5 ui-meta">Copy content from one item to another</p>
          <pre className="overflow-x-auto rounded-card border border-line bg-surface-2 p-3 font-mono text-xs text-ink-muted">
            {curlCopy}
          </pre>
        </div>
      </section>

      <section className="mt-8">
        <h2 className="ui-section-label">Other permissions</h2>
        <p className="mt-3 ui-meta">
          A credential may also carry{" "}
          <code className="font-mono">mcp</code> (the MCP endpoint, for AI
          clients),{" "}
          <code className="font-mono">cron</code> (scheduled jobs), or{" "}
          <code className="font-mono">diag</code> (the ping endpoint only).
          Permissions are checked on every request, server-side, and a
          credential can never widen its own.
        </p>
      </section>

      {/* Revocation — the one thing that used to surprise people */}
      <section className="mt-8">
        <h2 className="ui-section-label">Revoking</h2>
        <div className="mt-3 rounded-card border border-line bg-surface-1 p-4">
          <p className="ui-row text-ink-muted">
            Revoke a credential from{" "}
            <Link
              href="/settings"
              className="font-medium text-[var(--accent)] hover:underline"
            >
              User Settings
            </Link>
            . It stops working on its very next request, and nothing else is
            affected: other credentials, the MCP connection, and your phone
            connector keep going.
          </p>
          <p className="mt-2 ui-row text-ink-muted">
            The two older minted-token paths (below) are signed rather than
            stored, so they have no list and no individual revocation: rotating
            their secret kills every token of that kind at once. That is the
            reason credentials exist, and the reason to prefer one.
          </p>
        </div>
      </section>

      {/* Status of every credential path */}
      <section className="mt-8">
        <h2 className="ui-section-label">Credential paths</h2>
        <p className="mt-2 text-sm text-ink-muted">
          Several kinds of credential open the{" "}
          <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-xs">
            api
          </code>{" "}
          permission. They coexist, and each one verifies only under the thing
          that issued it.
        </p>
        <ul className="mt-3 flex flex-col gap-2.5">
          <li className="flex items-start gap-2.5 ui-row text-ink-muted">
            <span className="mt-1.5">
              <StatusDot ok={mintedApiCredential} />
            </span>
            <span>
              <strong className="text-ink">Credentials</strong> — key ID +
              secret, created in User Settings, stored hashed on a row.
              Individually revocable, no redeploy. <em>Prefer this one.</em>{" "}
              {mintedApiCredential
                ? "At least one active api credential exists."
                : "None created yet."}
            </span>
          </li>
          <li className="flex items-start gap-2.5 ui-row text-ink-muted">
            <span className="mt-1.5">
              <StatusDot ok={appReady} />
            </span>
            <span>
              <strong className="text-ink">App tokens</strong> (ADR-179, legacy)
              — signed with{" "}
              <code className="font-mono text-xs">LEDGR_APP_SECRET</code>,
              stateless, revoked only by rotating that secret.{" "}
              {appReady ? "Configured." : "Not configured."}
              {/* Kept reachable rather than removed (defer by hiding, not
                  deleting): an app already holding one of these should be able
                  to be handed a replacement, and the intent stays visible. New
                  callers want a credential instead, which is why this is folded
                  away. */}
              <details className="mt-2">
                <summary className="cursor-pointer ui-meta hover:text-ink">
                  Generate a legacy app token anyway
                </summary>
                <div className="mt-2 rounded-card border border-line bg-surface-2 p-3">
                  <p className="mb-2 text-xs text-ink-subtle">
                    Prefer a credential in User Settings. This exists for an app
                    already built against an app token: it cannot be listed and
                    cannot be revoked on its own.
                  </p>
                  <AppTokenMinter
                    disabled={!appReady}
                    disabledHint="Set LEDGR_APP_SECRET on your host and redeploy to generate one here (runbook §3)."
                  />
                </div>
              </details>
            </span>
          </li>
          <li className="flex items-start gap-2.5 ui-row text-ink-muted">
            <span className="mt-1.5">
              <StatusDot ok />
            </span>
            <span>
              <strong className="text-ink">Web clipper</strong> — User Settings →
              Save from the web. Needs no token (ADR-238): the bookmarklet saves
              through your own signed-in session. Tokens signed with{" "}
              <code className="font-mono text-xs">LEDGR_CLIPPER_SECRET</code>{" "}
              still verify, so a bookmarklet dragged before that change keeps
              working, but nothing issues new ones.
            </span>
          </li>
          <li className="flex items-start gap-2.5 ui-row text-ink-muted">
            <span className="mt-1.5">
              <StatusDot ok={staticApiToken} />
            </span>
            <span>
              <strong className="text-ink">Static env tokens</strong> — the{" "}
              <code className="font-mono text-xs">
                scripts/make-token.mjs
              </code>{" "}
              CLI, hashed into{" "}
              <code className="font-mono text-xs">LEDGR_API_TOKENS</code>. A
              redeploy per token, and per revocation. Still the right choice for
              a credential that has to exist before the app can serve a page, or
              that must work when the database does not:{" "}
              <code className="font-mono text-xs">CRON_SECRET</code>, a
              bootstrap script, a restore. See runbook §3.{" "}
              {staticApiToken
                ? "At least one api-scoped entry is set."
                : "No api-scoped entry set."}
            </span>
          </li>
        </ul>
      </section>

      <p className="mt-8 ui-meta">
        For AI clients (Claude and other MCP-speaking apps), Build → AI &amp; MCP
        covers connecting over OAuth, which is what claude.ai and the phone apps
        need. A credential carrying{" "}
        <code className="font-mono">mcp</code> works for clients that take a
        static credential, such as Claude Code.
      </p>

      {origin && (
        <div className="mt-6">
          <p className="mb-1.5 ui-meta">Your API base URL</p>
          <CopyField value={`${origin}/api/machine`} label="API base URL" />
        </div>
      )}
    </div>
  );
}
