# Exploration: `ledgr login`, a browser sign-in for scripts (no minted keys)

**Raised:** Brandon, 2026-09-11, while setting up a shared API key for small Claude projects. **Status:** parked idea, not intent, not a decision. **Scope:** mostly non-core (a CLI script); one server change touches API authentication, so that part needs an ADR and a heads-up to Tyler before it lands.

## The ask

Work the way `vercel login` does: a command opens the browser, Brandon signs in with Microsoft, and the terminal ends up logged in. No key to mint at `/build/api`, nothing to paste into a file.

## What already exists (checked 2026-09-11)

Ledgr runs its own OAuth 2.1 authorization server for the claude.ai connector (`src/app/api/oauth/*`, `src/lib/auth/oauth.ts`):

- **Dynamic client registration** (`/api/oauth/register`, RFC 7591), stateless: the client id is a signed blob carrying its redirect URIs.
- **Loopback redirects are already allowed**: `http://127.0.0.1:<port>` and `http://localhost:<port>` pass `isValidRedirectUri` (register route), which is the RFC 8252 mechanism every browser-then-terminal CLI uses.
- **PKCE S256 required, public clients** (no secret), so a CLI embeds nothing sensitive.
- **`/api/oauth/authorize` is Clerk-gated with a consent page**, so "sign in, then approve" is built.
- **Tokens:** HMAC-signed with `LEDGR_OAUTH_SECRET`; access 1 hour, refresh 90 days, refresh rotated on use.
- **Accepted by `/api/mcp`** (`verifyAccessToken`), **not** by `/api/machine/*` (`verifyApiRequest` never tries the OAuth verifier), and the only OAuth scope is `mcp`.

## What it would take

1. **A `ledgr-login` script** (Node, no dependencies, ~100 lines): register with `redirect_uris: ["http://127.0.0.1:<port>/callback"]`, open the browser at `/api/oauth/authorize` with a PKCE challenge, catch the code on a throwaway local listener, exchange it at `/api/oauth/token`, save `{access, refresh, expiresAt, url}` to `~/.ledgr/credentials.json`. A companion helper reads the file and refreshes silently. Home: OneDrive `cli-sync/scripts`, so `/refresh-all` distributes it; each machine logs in once.
2. **One server change** (ADR + Tyler heads-up, since it changes what the API accepts): either `verifyApiRequest` also accepts OAuth access tokens, or `/authorize` can grant an `api` scope. Existing callers keep working either way.
3. A verify script covering the loopback registration and the token exchange, and a runbook §3 paragraph.

## Trade-offs to weigh before building

- **No per-token revoke.** OAuth tokens are stateless; the only cut-off is rotating `LEDGR_OAUTH_SECRET`, which also signs out every claude.ai connector. Minted credentials (`/build/api`) revoke one at a time. For a single owner this is probably fine; name it in the ADR.
- **Needs a browser.** A headless job (GitHub Actions, the supervisor) still wants a minted key or a static token. This replaces the key for interactive/small-project use, not for automation.
- **Where the token is minted matters.** `api_credentials` does not sync between installs and neither would this; the CLI logs in against one URL (the hub) and stores that URL beside the token.

## Related

- The shared-key approach it would replace: `~/.ledgr-api-key.env` via the secrets harness (`cli-sync/scripts/secrets-manifest.json`, entry `globals/ledgr-api-key.env.enc`).
- `scripts/make-token.mjs` (static env tokens), runbook §3 (connection paths), ADR-179 (browser-minted app tokens).
