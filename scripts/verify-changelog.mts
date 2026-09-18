// Changelog / collab-notes verification: the pure parsing in the GitHub client
// (commit list+detail → ChangelogEntry, file content decode, config defaults).
// No network — these are the deterministic seams the page and notes API ride.
// Run: npx tsx scripts/verify-changelog.mts  — safe to delete when closed.

const { toChangelogEntry, decodeContent, getGithubConfig, isNotesCommit, NOTES_COMMIT_PREFIX } = await import("../src/lib/github/client");

let failures = 0;
function check(label: string, cond: boolean) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}

// ── toChangelogEntry ──────────────────────────────────────────────────────────
const listItem = {
  sha: "abcdef1234567890",
  html_url: "https://github.com/strategicli/ledgr/commit/abcdef1234567890",
  commit: {
    message: "Add changelog page\n\nLonger body explaining the change.",
    author: { name: "Tyler Collins", date: "2026-06-14T15:30:00Z" },
  },
  author: { login: "tylerc", avatar_url: "https://example.invalid/a.png" },
};
const detail = { ...listItem, stats: { additions: 42, deletions: 7 }, files: [{}, {}, {}] };

const e = toChangelogEntry(listItem, detail);
check("subject is the first message line", e.subject === "Add changelog page");
check("body is the remainder, trimmed", e.body === "Longer body explaining the change.");
check("shortSha is 7 chars", e.shortSha === "abcdef1");
check("author name from commit", e.authorName === "Tyler Collins");
check("login + avatar carried", e.authorLogin === "tylerc" && e.avatarUrl === "https://example.invalid/a.png");
check("date carried", e.date === "2026-06-14T15:30:00Z");
check("filesChanged = files.length", e.filesChanged === 3);
check("additions/deletions from stats", e.additions === 42 && e.deletions === 7);

// Without detail, stats default to zero (the page still renders the commit).
const eNoDetail = toChangelogEntry(listItem);
check("no detail → zero stats", eNoDetail.filesChanged === 0 && eNoDetail.additions === 0 && eNoDetail.deletions === 0);

// Single-line message → empty body.
const single = toChangelogEntry({ ...listItem, commit: { ...listItem.commit, message: "Quick fix" } });
check("single-line message → empty body", single.subject === "Quick fix" && single.body === "");

// Empty message → placeholder, no crash.
const empty = toChangelogEntry({ ...listItem, commit: { message: "", author: null }, author: null });
check("empty message → placeholder subject", empty.subject === "(no message)");
check("missing author → 'unknown'", empty.authorName === "unknown" && empty.authorLogin === null);

// ── isNotesCommit (changelog filter) ──────────────────────────────────────────
check("a notes-Save commit is flagged", isNotesCommit(`${NOTES_COMMIT_PREFIX}, tyler@bethanycentral.org)`));
check("a real commit is not flagged", !isNotesCommit("Add changelog page (ADR-054)"));
check("an empty message is not flagged", !isNotesCommit(""));

// ── decodeContent ─────────────────────────────────────────────────────────────
const md = "# Notes\n\nLeave each other notes here. ✓";
const b64 = Buffer.from(md, "utf8").toString("base64");
check("base64 content round-trips (incl. unicode)", decodeContent({ content: b64, encoding: "base64", sha: "x" }) === md);
check("non-base64 content passes through", decodeContent({ content: "raw", encoding: "utf-8", sha: "x" }) === "raw");

// ── getGithubConfig ───────────────────────────────────────────────────────────
const saved = { ...process.env };
delete process.env.GITHUB_TOKEN;
// Reads need no token (a public repo answers anonymously), so the config is
// always there; only the token is null, which is what gates writes.
check("no token → a config with a null token (reads still work, writes refuse)", getGithubConfig()?.token === null);

process.env.GITHUB_TOKEN = "ghp_test";
delete process.env.GITHUB_REPO;
delete process.env.GITHUB_BRANCH;
delete process.env.GITHUB_NOTES_BRANCH;
delete process.env.GITHUB_NOTES_PATH;
const cfg = getGithubConfig();
check("token set → config returned", cfg !== null);
check("repo defaults to strategicli/ledgr", cfg?.repo === "strategicli/ledgr");
check("branch defaults to main", cfg?.branch === "main");
check("notesBranch defaults to the deploy branch", cfg?.notesBranch === "main");
check("notesPath defaults to COLLAB_NOTES.md", cfg?.notesPath === "COLLAB_NOTES.md");

process.env.GITHUB_NOTES_BRANCH = "collab-notes";
check("notesBranch override honored", getGithubConfig()?.notesBranch === "collab-notes");

process.env = saved;

console.log(failures === 0 ? `\nAll checks passed.` : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
