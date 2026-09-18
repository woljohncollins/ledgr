// ADR-197 verification: the project markdown document composer — a project
// rendered as ONE markdown file (Summary → People → Milestones → Meetings →
// Links → Tasks → Timeline, Tyler's order). Pure (no DB): exercises
// composeProjectMarkdown against fixtures.
// Run: npx tsx scripts/verify-project-markdown.mts
import { composeProjectMarkdown, type ProjectMarkdownInput } from "../src/lib/project-markdown";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

const TZ = "America/Chicago";

const full: ProjectMarkdownInput = {
  title: "Website Relaunch",
  summary: "A ground-up rebuild of the site.",
  timezone: TZ,
  people: [{ title: "Brandon Collins" }, { title: "Tyler Collins" }],
  milestones: [
    {
      title: "Design locked",
      dueDate: new Date("2026-07-15T00:00:00.000Z"),
      done: true,
      completedAt: new Date("2026-07-14T00:00:00.000Z"),
      pct: 30,
      taskTitle: null,
    },
    {
      title: "Content migrated",
      dueDate: null,
      done: false,
      completedAt: null,
      pct: 0,
      taskTitle: "Migrate pages",
    },
  ],
  meetings: [{ title: "Kickoff", when: new Date("2026-07-01T15:00:00.000Z") }],
  links: [
    { title: "Vendor quote", url: "https://example.com/quote" },
    { title: "No URL yet", url: null },
  ],
  tasks: [
    {
      title: "Migrate pages",
      done: true,
      createdAt: new Date("2026-07-02T00:00:00.000Z"),
      completedAt: new Date("2026-07-09T00:00:00.000Z"),
    },
    { title: "Write copy", done: false, createdAt: new Date("2026-07-03T00:00:00.000Z"), completedAt: null },
  ],
  timeline: [
    { date: new Date("2026-07-14T00:00:00.000Z"), label: "Milestone completed: Design locked" },
    { date: new Date("2026-07-01T15:00:00.000Z"), label: "Meeting: Kickoff" },
  ],
};

console.log("\n# full document");
{
  const md = composeProjectMarkdown(full);
  check("title is the h1", md.startsWith("# Website Relaunch\n"));
  check("summary lands verbatim after the title", md.includes("\nA ground-up rebuild of the site.\n"));
  const order = ["## People", "## Milestones", "## Meetings", "## Links", "## Tasks", "## Timeline"];
  const idx = order.map((h) => md.indexOf(h));
  check("every section present", idx.every((i) => i > 0), JSON.stringify(idx));
  check(
    "sections in Tyler's order (summary, people, milestones, meetings, links, tasks, timeline)",
    idx.every((v, i) => i === 0 || v > idx[i - 1])
  );
  check("people listed", md.includes("- Brandon Collins") && md.includes("- Tyler Collins"));
  check("a done milestone is checked with due + completed dates", md.includes("- [x] Design locked — due Jul 15, 2026 · completed Jul 14, 2026 · 30% of project"));
  check("an open task-linked milestone names its task", md.includes("- [ ] Content migrated — completes with “Migrate pages”"));
  check("a meeting carries its wall-clock time", md.includes("- Kickoff — Jul 1, 2026, 10:00 AM"));
  check("a link is a clickable markdown link", md.includes("- [Vendor quote](https://example.com/quote)"));
  check("a url-less link degrades to plain text", md.includes("- No URL yet") && !md.includes("[No URL yet]"));
  check("a done task shows added + completed", md.includes("- [x] Migrate pages — added Jul 2, 2026 · completed Jul 9, 2026"));
  check("an open task shows only added", md.includes("- [ ] Write copy — added Jul 3, 2026"));
  // Timeline was given out of order; it must compose ascending.
  const kickoff = md.indexOf("Meeting: Kickoff");
  const designDone = md.indexOf("Milestone completed: Design locked");
  check("timeline sorts ascending regardless of input order", kickoff > 0 && designDone > kickoff);
  check("ends with a trailing newline", md.endsWith("\n"));
}

console.log("\n# sparse document");
{
  const md = composeProjectMarkdown({
    title: "",
    summary: "",
    timezone: TZ,
    people: [],
    milestones: [],
    meetings: [],
    links: [],
    tasks: [],
    timeline: [],
  });
  check("an empty project is just its (untitled) h1", md === "# Untitled\n");
  check("no empty section headers", !md.includes("##"));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
