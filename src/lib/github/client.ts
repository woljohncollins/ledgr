// GitHub-backed shared collab surface: the Changelog (live commit history) and
// the shared collab notes (a committed file). Why GitHub and not the DB:
// Brandon and Tyler each run a separate single-tenant deploy (separate Vercel +
// Neon), so a DB row is never shared between them. Git is already this project's
// shared coordination medium (COLLAB.md, decisions.md), so the Changelog reads
// the repo's commit history live and the collab notes live in a committed file
// both deploys read and write. One PAT, plain fetch, no Octokit (Principle 5).
//
// Same posture as the Graph/Todoist clients: a typed error distinguishes "never
// configured" (visible, benign) from "GitHub said no" (a real failure to
// surface).
//
// READS NEED NO TOKEN (2026-09-12). GitHub serves a public repository's
// commits, compares and file contents anonymously (60 requests an hour per
// address, and every read here is cached for a minute or for ever), so the
// Changelog and the "am I behind?" check work on a fresh install with nothing
// configured. Only WRITES — the satellite fork merge and the collab-notes
// commits — need GITHUB_TOKEN, and those still say "not configured" without
// one. A private repository read without a token fails as a plain 404, which
// surfaces as "unknown", never as "current".

const API = "https://api.github.com";
const API_VERSION = "2022-11-28";

export class GithubError extends Error {
  constructor(
    message: string,
    readonly kind: "not_configured" | "auth" | "request",
    readonly status?: number
  ) {
    super(message);
    this.name = "GithubError";
  }
}

export type GithubConfig = {
  // Null when GITHUB_TOKEN is unset: reads go out anonymously, writes refuse.
  token: string | null;
  // owner/repo, e.g. "strategicli/ledgr".
  repo: string;
  // Branch whose commit history feeds the Changelog (the deploy branch).
  branch: string;
  // Branch the collab notes file lives on. Defaults to the deploy branch; point
  // it at a non-deployed branch (e.g. "collab-notes") to keep a note edit from
  // triggering a Vercel rebuild. Auto-created on first write if it doesn't exist.
  notesBranch: string;
  // Path of the committed notes file in the repo.
  notesPath: string;
};

// Always returns a config: reads work without a token. A classic PAT or
// fine-grained token with Contents read+write on the repo is what the notes
// commits (and a satellite's fork merge) need; see hasGithubToken.
export function getGithubConfig(): GithubConfig | null {
  const token = process.env.GITHUB_TOKEN || null;
  const repo = process.env.GITHUB_REPO || "strategicli/ledgr";
  const branch = process.env.GITHUB_BRANCH || "main";
  const notesBranch = process.env.GITHUB_NOTES_BRANCH || branch;
  const notesPath = process.env.GITHUB_NOTES_PATH || "COLLAB_NOTES.md";
  return { token, repo, branch, notesBranch, notesPath };
}

/** True when writes are possible. Reads never need this. */
export function hasGithubToken(): boolean {
  return !!process.env.GITHUB_TOKEN;
}

function requireConfig(): GithubConfig {
  const cfg = getGithubConfig();
  if (!cfg) {
    throw new GithubError("GitHub not configured", "not_configured");
  }
  return cfg;
}

/** For writes: the config, with a token, or the typed "not configured" error. */
function requireToken(): GithubConfig & { token: string } {
  const cfg = requireConfig();
  if (!cfg.token) {
    throw new GithubError("GitHub writes need GITHUB_TOKEN", "not_configured");
  }
  return { ...cfg, token: cfg.token };
}

type FetchOpts = RequestInit & { revalidate?: number | false };

// The one chokepoint every GitHub caller uses. `revalidate` maps to Next's
// fetch cache: a small number for the moving commit list, false (immutable) for
// per-commit detail, and no caching for writes.
async function gh(cfg: GithubConfig, path: string, opts: FetchOpts = {}): Promise<Response> {
  const { revalidate, headers, ...init } = opts;
  return fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}),
      accept: "application/vnd.github+json",
      "x-github-api-version": API_VERSION,
      ...headers,
    },
    ...(revalidate === undefined ? {} : { next: { revalidate } }),
  });
}

async function ghJson<T>(cfg: GithubConfig, path: string, opts: FetchOpts = {}): Promise<T> {
  const res = await gh(cfg, path, opts);
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { message?: string };
      if (body.message) detail = `: ${body.message}`;
    } catch {
      /* non-JSON error body; the status carries enough */
    }
    const kind = res.status === 401 || res.status === 403 ? "auth" : "request";
    throw new GithubError(`GitHub ${path} ${res.status}${detail}`, kind, res.status);
  }
  return (await res.json()) as T;
}

// ── Changelog (commit history) ──────────────────────────────────────────────

export type ChangelogEntry = {
  sha: string;
  shortSha: string;
  subject: string; // first line of the commit message
  body: string; // the rest, if any
  authorName: string;
  authorLogin: string | null;
  avatarUrl: string | null;
  date: string; // ISO 8601
  url: string; // html_url on GitHub
  filesChanged: number;
  additions: number;
  deletions: number;
};

// Shapes of the GitHub REST responses we read (only the fields we use).
type CommitListItem = {
  sha: string;
  html_url: string;
  commit: { message: string; author: { name: string; date: string } | null };
  author: { login: string; avatar_url: string } | null;
};
type CommitDetail = CommitListItem & {
  stats?: { additions: number; deletions: number };
  files?: unknown[];
};

// Pure: fold a list item (+ optional detail with stats) into a ChangelogEntry.
// Exported so the verify script can exercise it without the network.
export function toChangelogEntry(item: CommitListItem, detail?: CommitDetail): ChangelogEntry {
  const message = item.commit.message ?? "";
  const nl = message.indexOf("\n");
  const subject = nl === -1 ? message : message.slice(0, nl);
  const body = nl === -1 ? "" : message.slice(nl + 1).trim();
  return {
    sha: item.sha,
    shortSha: item.sha.slice(0, 7),
    subject: subject.trim() || "(no message)",
    body,
    authorName: item.commit.author?.name ?? item.author?.login ?? "unknown",
    authorLogin: item.author?.login ?? null,
    avatarUrl: item.author?.avatar_url ?? null,
    date: item.commit.author?.date ?? "",
    url: item.html_url,
    filesChanged: detail?.files?.length ?? 0,
    additions: detail?.stats?.additions ?? 0,
    deletions: detail?.stats?.deletions ?? 0,
  };
}

// The commit message the notes-file writes use. Exported so the changelog can
// filter them out: a notes Save is a commit, but it isn't a "change" anyone
// wants in the changelog (and they'd otherwise flood the top of the list).
export const NOTES_COMMIT_PREFIX = "Collab notes update (via Ledgr";

export function isNotesCommit(message: string): boolean {
  return message.startsWith(NOTES_COMMIT_PREFIX);
}

// Recent commits on the deploy branch, each enriched with its file/line counts
// (the "roughly how many things changed" in Tyler's ask). The list call is one
// request, cached briefly so the page stays fresh without hammering; per-commit
// detail is immutable, so it's cached indefinitely and fetched once per commit.
// App-generated notes commits are filtered out, so we over-fetch to still land
// ~limit real entries.
export async function getChangelog(limit = 25): Promise<ChangelogEntry[]> {
  const cfg = requireConfig();
  const fetchN = Math.min(limit * 3, 100);
  const list = await ghJson<CommitListItem[]>(
    cfg,
    `/repos/${cfg.repo}/commits?sha=${encodeURIComponent(cfg.branch)}&per_page=${fetchN}`,
    { revalidate: 60 }
  );
  const real = list.filter((item) => !isNotesCommit(item.commit.message ?? "")).slice(0, limit);
  return Promise.all(
    real.map(async (item) => {
      try {
        const detail = await ghJson<CommitDetail>(
          cfg,
          `/repos/${cfg.repo}/commits/${item.sha}`,
          { revalidate: false } // a commit's diff never changes
        );
        return toChangelogEntry(item, detail);
      } catch {
        // Stats are a nicety; never let one failed detail call sink the page.
        return toChangelogEntry(item);
      }
    })
  );
}

// ── Collab notes (committed file) ─────────────────────────────────────────────

export type CollabNotes = {
  markdown: string;
  // The blob sha GitHub needs to update the file; null when the file does not
  // exist yet (the first write creates it).
  sha: string | null;
};

type ContentsResponse = { content: string; encoding: string; sha: string };

export function decodeContent(res: ContentsResponse): string {
  if (res.encoding === "base64") {
    return Buffer.from(res.content, "base64").toString("utf8");
  }
  return res.content;
}

// Reads the notes file on a given ref. Null when the file/branch isn't there.
async function readContents(cfg: GithubConfig, ref: string, revalidate: number): Promise<{ markdown: string; sha: string } | null> {
  const res = await gh(
    cfg,
    `/repos/${cfg.repo}/contents/${encodeURIComponent(cfg.notesPath)}?ref=${encodeURIComponent(ref)}`,
    { revalidate }
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new GithubError(`GitHub read notes ${res.status}`, res.status === 401 || res.status === 403 ? "auth" : "request", res.status);
  }
  const data = (await res.json()) as ContentsResponse;
  return { markdown: decodeContent(data), sha: data.sha };
}

export async function readNotes(): Promise<CollabNotes> {
  const cfg = requireConfig();
  const onBranch = await readContents(cfg, cfg.notesBranch, 10);
  if (onBranch) return onBranch;
  // Notes branch/file not there yet. When notes live on a separate branch, show
  // the deploy-branch copy for continuity (the notes branch is created from it
  // on first write); sha is null so the next write resolves the real sha.
  if (cfg.notesBranch !== cfg.branch) {
    const onDeploy = await readContents(cfg, cfg.branch, 10);
    if (onDeploy) return { markdown: onDeploy.markdown, sha: null };
  }
  return { markdown: "", sha: null };
}

// Ensures the notes branch exists, creating it from the deploy branch's head if
// not. A no-op when notes live on the deploy branch (the default).
async function ensureNotesBranch(cfg: GithubConfig & { token: string }): Promise<void> {
  if (cfg.notesBranch === cfg.branch) return;
  const ref = await gh(cfg, `/repos/${cfg.repo}/git/ref/heads/${encodeURIComponent(cfg.notesBranch)}`, {
    revalidate: 0,
  });
  if (ref.ok) return;
  if (ref.status !== 404) {
    throw new GithubError(`GitHub branch check ${ref.status}`, ref.status === 401 || ref.status === 403 ? "auth" : "request", ref.status);
  }
  const base = await ghJson<{ object: { sha: string } }>(
    cfg,
    `/repos/${cfg.repo}/git/ref/heads/${encodeURIComponent(cfg.branch)}`,
    { revalidate: 0 }
  );
  await ghJson(cfg, `/repos/${cfg.repo}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${cfg.notesBranch}`, sha: base.object.sha }),
  });
}

// Commits the notes file (create or update). `sha` is the prior blob sha for an
// update, or null to create; GitHub returns 409 on a stale sha, which the route
// surfaces so a concurrent edit isn't silently clobbered. Clearing the notes is
// just a write of empty content.
export async function writeNotes(
  markdown: string,
  priorSha: string | null,
  authorEmail: string
): Promise<{ sha: string }> {
  const cfg = requireToken();
  await ensureNotesBranch(cfg);
  // priorSha drives optimistic concurrency for normal edits. When it's null
  // (first write, or just after the notes branch was created carrying the file
  // from the deploy branch), resolve the file's current sha so the PUT updates
  // the existing file instead of 422-ing on an unknown sha.
  let sha = priorSha;
  if (!sha) sha = (await readContents(cfg, cfg.notesBranch, 0))?.sha ?? null;
  const data = await ghJson<{ content: { sha: string } }>(
    cfg,
    `/repos/${cfg.repo}/contents/${encodeURIComponent(cfg.notesPath)}`,
    {
      method: "PUT",
      body: JSON.stringify({
        message: `${NOTES_COMMIT_PREFIX}, ${authorEmail})`,
        content: Buffer.from(markdown, "utf8").toString("base64"),
        branch: cfg.notesBranch,
        ...(sha ? { sha } : {}),
      }),
    }
  );
  return { sha: data.content.sha };
}

// ── Updates (is this deploy behind upstream?) ─────────────────────────────────
//
// A satellite instance deploys from a fork, so it only receives a change when
// that fork is synced with upstream. These two calls are the read and the write
// of that: how far behind am I, and pull the latest.
//
// Both are deliberately tolerant. An instance with no GITHUB_TOKEN, no Vercel
// git metadata, or a commit upstream has never heard of still renders a page
// that says so, because "I can't tell" and "you are behind" must never look the
// same to someone deciding whether to press a button.

export type UpdateCommit = {
  sha: string;
  shortSha: string;
  subject: string;
  authorName: string;
  date: string;
  url: string;
};

export type CodeStatus =
  | { state: "not_configured"; touchesSchema: false }
  | { state: "source"; touchesSchema: false }
  | { state: "unknown"; detail: string; touchesSchema: false }
  | { state: "current"; touchesSchema: false }
  | {
      state: "behind";
      count: number;
      commits: UpdateCommit[];
      // True when the pending update adds or changes anything under drizzle/,
      // i.e. it carries a schema change. This is the flag that decides whether
      // a non-builder is allowed to apply it (see resolveApplicability).
      touchesSchema: true | false;
      // GitHub caps a compare at 300 files / 250 commits; when it truncates,
      // touchesSchema is a floor rather than a certainty and the UI says so.
      truncated: boolean;
    };

type CompareResponse = {
  status: "diverged" | "ahead" | "behind" | "identical";
  ahead_by: number;
  behind_by: number;
  total_commits: number;
  commits: CommitListItem[];
  files?: { filename: string }[];
};

/**
 * How far is the running commit behind upstream's branch head?
 *
 * Compares WITHIN the upstream repo (runningSha...branch) rather than across
 * repos: a synced fork's commits are upstream's own commits, so the running sha
 * is already a ref upstream can resolve. When it can't — a fork that has
 * diverged, or a commit that never reached upstream — the compare 404s and this
 * reports "unknown" instead of guessing.
 */
export async function getCodeStatus(
  runningSha: string | null,
  upstreamRepo: string,
  branch: string,
  isSatellite: boolean
): Promise<CodeStatus> {
  if (!isSatellite) return { state: "source", touchesSchema: false };
  const cfg = getGithubConfig();
  if (!cfg) return { state: "not_configured", touchesSchema: false };
  if (!runningSha) {
    return {
      state: "unknown",
      detail: "This deploy reports no commit sha (running outside Vercel?).",
      touchesSchema: false,
    };
  }

  let cmp: CompareResponse;
  try {
    cmp = await ghJson<CompareResponse>(
      cfg,
      `/repos/${upstreamRepo}/compare/${encodeURIComponent(runningSha)}...${encodeURIComponent(branch)}`,
      { revalidate: 60 }
    );
  } catch (err) {
    return {
      state: "unknown",
      detail: err instanceof GithubError ? err.message : String(err),
      touchesSchema: false,
    };
  }

  if (cmp.ahead_by === 0) return { state: "current", touchesSchema: false };

  const files = cmp.files ?? [];
  const truncated = cmp.commits.length < cmp.ahead_by || files.length >= 300;
  return {
    state: "behind",
    count: cmp.ahead_by,
    commits: cmp.commits
      .slice()
      .reverse() // compare returns oldest-first; the page reads newest-first
      .map((item) => {
        const entry = toChangelogEntry(item);
        return {
          sha: entry.sha,
          shortSha: entry.shortSha,
          subject: entry.subject,
          authorName: entry.authorName,
          date: entry.date,
          url: entry.url,
        };
      }),
    touchesSchema: files.some((f) => f.filename.startsWith("drizzle/")),
    truncated,
  };
}

export type ApplyUpdateResult = {
  mergeType: "fast-forward" | "merge" | "none";
  message: string;
};

/**
 * Pull upstream into this instance's fork — GitHub's own "Sync fork" button,
 * which is a fast-forward when the fork has no commits of its own.
 *
 * Pushing to the fork's deploy branch is what triggers that instance's Vercel
 * build, so this call IS the deploy. It needs a token with Contents: write on
 * the FORK (the same GITHUB_TOKEN the changelog uses, when that token is the
 * instance owner's; LEDGR_UPDATE_TOKEN overrides it).
 */
export async function applyCodeUpdate(
  forkRepo: string,
  branch: string
): Promise<ApplyUpdateResult> {
  const cfg = requireConfig();
  const token = process.env.LEDGR_UPDATE_TOKEN || cfg.token;
  if (!token) {
    throw new GithubError("Pulling an update into a fork needs GITHUB_TOKEN or LEDGR_UPDATE_TOKEN", "not_configured");
  }
  const data = await ghJson<{ merge_type?: string; message?: string }>(
    { ...cfg, token },
    `/repos/${forkRepo}/merge-upstream`,
    { method: "POST", body: JSON.stringify({ branch }) }
  );
  const mergeType = data.merge_type;
  return {
    mergeType:
      mergeType === "fast-forward" || mergeType === "merge" || mergeType === "none"
        ? mergeType
        : "none",
    message: data.message ?? "",
  };
}

// ── Health canary ─────────────────────────────────────────────────────────────

export type GithubHealth =
  | { configured: false }
  | { configured: true; ok: true; repo: string }
  | { configured: true; ok: false; detail: string };

export async function checkGithub(): Promise<GithubHealth> {
  const cfg = getGithubConfig();
  if (!cfg) return { configured: false };
  try {
    await ghJson<{ full_name: string }>(cfg, `/repos/${cfg.repo}`, { revalidate: 60 });
    return { configured: true, ok: true, repo: cfg.repo };
  } catch (err) {
    return { configured: true, ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
