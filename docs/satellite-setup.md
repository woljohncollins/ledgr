# Satellite setup: stand up a new person's Ledgr instance

This is a procedure for **Claude Code, running on the new owner's own computer**, to
stand up a complete satellite instance of Ledgr: their GitHub fork, their Neon
database, their Clerk app, their Vercel project. The human sitting with you may not
be technical. You do the work; they sign into accounts when a browser window opens.

Background on what a satellite is: `runbook.md` §1k (ADR-194). The one-paragraph
version: Brandon's and Tyler's instances deploy from `strategicli/ledgr` itself;
everyone else deploys from a **fork** of it, with entirely their own accounts and
credentials. Nothing is shared between instances.

## How to behave while running this

- **Their only jobs are creating accounts and granting permission.** Everything
  that can be done through a granted CLI, you do. Never send them to click around
  a website for something `gh`/`vercel`/`neonctl`/`clerk` can reach — the whole
  design is: they sign up, they click Allow, you do the rest.
- **One step at a time.** Before every browser popup, tell the person in one plain
  sentence what window is about to open and what to do in it ("A Vercel page will
  open — click Continue with GitHub"). Wait for each login to finish before starting
  the next.
- **This must be their computer and their browser.** If the machine belongs to
  someone else (e.g. Tyler is helping on his laptop), every popup will sign into the
  helper's accounts instead. Stop and say so rather than proceeding.
- **The sign-in email is the single most important input.** Confirm it letter by
  letter before Phase 3. Seeding the wrong address creates an owner nobody signs in
  as, and every page then renders the ADR-184 "Signed in, but not recognized" screen
  — which reads as the app being broken.
- **Order matters.** The database is migrated and seeded (Phase 3) before the code
  ever deploys (Phase 5). An empty database behind deployed code 500s on every page.
- **If a step fails, stop and read the error.** Do not improvise around a failed
  step; each later phase assumes the earlier ones actually succeeded.
- **Keep secrets out of chat where you can.** Pipe keys from files/commands into
  `vercel env add` rather than asking the person to paste them.

## Inputs to collect first

The setup guide's build prompt supplies all three; ask for any that are missing.

1. **`OWNER_EMAIL`** — the exact email address they will sign in with. Read it back
   to them.
2. **`NAME`** — their first name, lowercased (e.g. `michelle`). Used for the Vercel
   project `<NAME>-ledgr` and the app URL `https://<NAME>-ledgr.vercel.app`.
3. **`TIMEZONE`** — their IANA timezone (most Bethany folks: `America/Chicago`).

**`GH_USER`** (their GitHub username) is not asked for — derive it:
`gh api user -q .login`.

## Phase 0 — Preflight

Check for `node` (need ≥ 20) and `git`. The setup guide the person followed had
them install Node before installing Claude Code, so it should be there — verify
anyway. If either is missing, install it (macOS: the nodejs.org installer or
Homebrew; Windows: `winget install OpenJS.NodeJS.LTS` and `winget install
Git.Git`, then have them close and reopen the terminal so PATH updates — you'll
need to be relaunched in the new window; tell them to run `claude --continue`
there to pick this session back up).

The npm CLIs run via `npx`, so they need no global install:

- Vercel: `npx -y vercel@latest <cmd>`
- Neon: `npx -y neonctl@latest <cmd>`
- Clerk: `npx -y clerk@latest <cmd>` (the npm package is **`clerk`**, not `@clerk/cli`)

GitHub's CLI (`gh`) is not on npm; the guide's step 2 had you install it. If it's
missing: Windows `winget install GitHub.cli`; macOS `brew install gh` when
Homebrew exists, otherwise download the latest macOS `.pkg` from
https://github.com/cli/cli/releases and run `sudo installer -pkg <file> -target /`.

If any CLI's flags disagree with this document, the binary is the source of truth —
run `--help` and adapt. This doc was written against Vercel CLI 55, neonctl 2.x,
Clerk CLI 1.4.

## Phase 1 — Verify the four account connections

The setup guide already walked the person through this, one account at a time
(steps 2–5): create the account, then a small prompt had you run each CLI's login
so they could click Allow in the browser. So this phase is a **verification pass**,
not a redo — but each check has a fallback in case a guide step was skipped:

1. **GitHub:** `gh auth status` must show them logged in — on failure, have them
   create an account at https://github.com/signup if needed, then run
   `gh auth login --web`, show them the one-time code, and wait while they enter
   it in the browser and click **Authorize**. That grant is what lets you act on
   their account. Then set `GH_USER=$(gh api user -q .login)` and verify the fork:
   `gh repo view "$GH_USER/ledgr"` — on failure, create it yourself:
   `gh repo fork strategicli/ledgr --clone=false`. Never ask them to click around
   github.com; the whole point of the grant is that you do the GitHub work.
2. **Vercel:** `npx -y vercel@latest whoami` — on failure, run
   `npx -y vercel@latest login` and tell them to pick **Continue with GitHub**
   (it makes the git connection in Phase 5 seamless).
3. **Neon:** `npx -y neonctl@latest me` — on failure, run
   `npx -y neonctl@latest auth` (browser opens; GitHub sign-in is fine).
4. **Clerk:** `npx -y clerk@latest whoami` — on failure, run
   `npx -y clerk@latest auth login` (browser opens; sign up / sign in).

## Phase 2 — Get the code

```sh
gh repo clone "$GH_USER/ledgr" ledgr
cd ledgr
npm install
```

Clone **their fork**, not `strategicli/ledgr` — the clone is only needed to run the
setup scripts, but using the fork keeps everything pointed at their copy.

## Phase 3 — Neon database, then migrate + seed + owner row

Create the project and get the **pooled** connection string:

```sh
npx -y neonctl@latest projects create --name ledgr --output json
# note the project id from the output, then:
npx -y neonctl@latest connection-string --project-id <PROJECT_ID> --pooled
```

The host **must contain `-pooler`** (serverless requirement, runbook §0). The
scripts refuse a direct string, so if you grabbed the wrong one you'll be told.
Call the result `DATABASE_URL`.

Now the one command that migrates, seeds the system types, creates the owner row,
and verifies:

```sh
npm run instance:new -- --database-url "<DATABASE_URL>" \
  --owner "<OWNER_EMAIL>" --app-url "https://<NAME>-ledgr.vercel.app"
```

Do not proceed unless it ends with `Database ready`. Its failure messages say
exactly what went wrong; fix and re-run (it's idempotent).

## Phase 4 — Clerk app and keys

```sh
npx -y clerk@latest apps create "Ledgr" --json
# note the application id, then pull its development-instance keys:
npx -y clerk@latest env pull --app <APP_ID> --file .env.clerk
```

`.env.clerk` now holds `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (`pk_test_...`) and
`CLERK_SECRET_KEY` (`sk_test_...`). Development-instance keys are the norm for
satellites (a Clerk production instance needs a custom domain; `*.vercel.app`
can't have one). **Their own Clerk app, never a shared one** — a shared app puts
them in someone else's user pool.

Delete `.env.clerk` after Phase 5 sets the env vars.

## Phase 5 — Vercel project, env vars, deploy

From the clone directory:

1. **Create + link the project:** `npx -y vercel@latest link` — answer the prompts:
   set up new project, name it `<NAME>-ledgr`, accept defaults (it detects Next.js).
2. **Connect it to their fork:** `npx -y vercel@latest git connect
   https://github.com/<GH_USER>/ledgr` — first time, this asks them to install the
   Vercel GitHub App in the browser; walk them through approving it. This is what
   makes future updates deploy automatically.
3. **Set the build command to the satellite one.** This is load-bearing: it makes
   every deploy run migrations *before* the build, so a bad migration fails the
   build and Vercel keeps the previous working deploy live (runbook §1k).
   ```sh
   npx -y vercel@latest api /v9/projects/<NAME>-ledgr -X PATCH \
     -F buildCommand="npm run build:satellite"
   ```
   If `vercel api` misbehaves (it's beta), fall back to opening the dashboard:
   `npx -y vercel@latest open`, then Settings → Build & Development → Build Command
   → `npm run build:satellite`, and confirm with the person that it's saved.
4. **Env vars.** For each, pipe the value in (targets all environments unless you
   say otherwise; add to `production` at minimum):
   ```sh
   printf '%s' "<value>" | npx -y vercel@latest env add <NAME> production
   ```
   The boot set — a missing Clerk key is a hard 503, not a partial app:
   | Var | Value |
   |---|---|
   | `DATABASE_URL` | the pooled string from Phase 3 |
   | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | from `.env.clerk` |
   | `CLERK_SECRET_KEY` | from `.env.clerk` |
   | `NEXT_PUBLIC_CLERK_SIGN_IN_URL` | `/sign-in` |
   | `NEXT_PUBLIC_APP_URL` | `https://<NAME>-ledgr.vercel.app` |
   | `LEDGR_TIMEZONE` | `<TIMEZONE>` |
   | `LEDGR_SELF_UPDATE` | `on` — only correct because step 3 set `build:satellite` |
5. **Deploy:** `npx -y vercel@latest deploy --prod`. Watch it finish.

## Phase 6 — Verify, then they sign in

1. `curl -s https://<NAME>-ledgr.vercel.app/health` — `database` must be ok.
2. Open `https://<NAME>-ledgr.vercel.app/sign-in` and have them sign up / sign in
   **with exactly `OWNER_EMAIL`**. They should land in the app with nav visible.
   "Signed in, but not recognized" means the address they used differs from the
   seeded one — re-run Phase 3's `instance:new` with the right address.

## Phase 7 (recommended) — One-button updates and the Changelog

Without a GitHub token, `/build/updates` is status-only and the in-app Changelog
shows "not connected." With one, they update themselves with a button — the whole
point being that a non-builder should never need a terminal again.

1. Use the token from the gh grant — no clicks needed:
   `gh auth token | tr -d '\n' | npx -y vercel@latest env add GITHUB_TOKEN production`
   That token covers their whole account (broader than strictly needed) and is
   revocable anytime at https://github.com/settings/applications ("GitHub CLI").
   Tell them that in one sentence and note the alternative: a fine-grained PAT
   from https://github.com/settings/personal-access-tokens/new scoped to only
   their `ledgr` fork with **Contents: Read and write** — the better choice if
   they care, or if this setup ran on a borrowed machine (the cleanup below
   logs gh out, and they shouldn't leave a personal token minted on someone
   else's gh session).
2. Redeploy so it takes effect: `npx -y vercel@latest redeploy <deployment-url>`
   or push any commit.

Leave `GITHUB_REPO` unset (it defaults to `strategicli/ledgr`, which is what the
Changelog should read); the self-updater detects their fork from Vercel's own git
env vars.

## Phase 8 — Wrap up

1. **Print a summary block** and tell the person to keep a screenshot of it
   somewhere safe, and to share it with Tyler if he asks (he keeps the roster in
   `instances.local.json` until instance registration is built into Ledgr itself):
   - name, `GH_USER/ledgr`, `OWNER_EMAIL`, app URL
   - the pooled `DATABASE_URL` — this is a credential; if shared, share it
     directly (in person or a private message), never posted anywhere public.
2. **Point them at updates:** show them Build → Updates in the app and say that's
   how they get new versions from now on — one button, no terminal.
3. **Say plainly what is not set up:** no R2 means uploads/attachments quietly do
   not work; no transcription; no Microsoft Graph export. All optional, all
   addable later (`.env.example` documents each).
4. **Clean up:** delete `.env.clerk`. If this ran on a borrowed machine, log out:
   `npx vercel logout`, `npx clerk auth logout`, `gh auth logout`, and remove
   `~/.config/neonctl/credentials.json`.
5. The local clone can be kept (handy for future maintenance) or deleted; the
   deployed instance does not need it.
