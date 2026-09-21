// "Using Ledgr" — the owner-facing user guide, held once and served three ways.
//
// This is the answer to a real problem: a second builder kept asking for
// features he already had, because nothing in the system tells you what the
// system can do. CLAUDE.md says how it is built, ledgr-prd.md says what was
// intended, runbook.md says how to operate it — none of them say "here is what
// you can do, and where." This file does.
//
// ONE SOURCE, THREE DOORWAYS. The markdown below is the only copy:
//   1. MCP resource `ledgr://guide/using-ledgr` — any connected AI can read it.
//   2. /build/guide — the same markdown rendered in-app (Build → MAINTAIN).
//   3. The Work "More" menu and the command palette both link at that route.
// A `.ts` wrapper around a template literal rather than a `.md` file read at
// runtime, matching guide.ts: no bundler config, no fs, no tracing rules, and it
// works identically in the serverless MCP route and a server component.
//
// INSTANCE-AGNOSTIC. Both deploys (Brandon's and Tyler's) serve this same text,
// so it describes capabilities that exist in the code and never one owner's
// actual types, views, or data. For "what do *I* have," the guide points a
// reading AI at describe_workspace / list_types, which are per-owner and live.
//
// KEEPING IT CURRENT is a process rule, not automation (ADR-189): a slice that
// changes what the owner can do updates this file in the same PR. The /ship
// pre-merge gate asks. Nothing generates this from code — a generated index
// would be worse prose than a maintained one, and the reminder sits in the two
// places every slice already passes through.
//
// Pure (no DB, no Next, no env), like guide.ts. guide.ts's readGuideResource
// serves it; server.ts lists it.

// Stable, opaque URI. Sibling of ledgr://guide/workspace-shaping and
// ledgr://guide/memory-protocol — additive, per the ADR-183 carve-out.
export const USER_GUIDE_URI = "ledgr://guide/using-ledgr";

// The route the in-app copy renders at, exported so the Build sidebar, the
// command palette, and the guide text itself all name it from one place.
export const USER_GUIDE_ROUTE = "/build/guide";

// The resources/list descriptor. The description doubles as the model-facing
// hint for *when* to read it: this is the "what can the owner do" guide, as
// distinct from workspace-shaping's "how do I change the workspace."
export const USER_GUIDE_RESOURCE = {
  uri: USER_GUIDE_URI,
  name: "using-ledgr",
  title: "Using Ledgr: what it does and where to find it",
  description:
    "A complete index of what the owner can do in Ledgr and where each " +
    "feature lives — capturing and writing, organizing, finding, getting " +
    "data in and out, and the AI surface. Read this when the owner asks " +
    "what Ledgr can do, how to do something in the app, or where a feature " +
    "is. For what THIS owner actually has (their types, views, dashboards), " +
    "call describe_workspace instead.",
  mimeType: "text/markdown",
} as const;

// The guide body. Written for the owner, in plain language: short sentences,
// one idea per bullet, and a route on every feature so the reader can go there.
//
// ONLY TWO HEADING LEVELS, and no document title — both are deliberate.
// markdownToHtml shifts headings down one so the page's own <h1> stands (`#` →
// h2, `##` → h3), and `.ledgr-prose` styles h1–h3 only, because the editor never
// offers H4. A third level here would render as unstyled body text and the index
// would stop being scannable. Keep it flat; if a section outgrows two levels,
// split the section. The title is omitted because both readers already have one:
// the page prints "User Guide" above this, and the MCP descriptor carries
// USER_GUIDE_RESOURCE.title.
export const USING_LEDGR_GUIDE = `What Ledgr can do, and where each thing lives. This is an index, not a tutorial:
scan for the feature, go to the route.

It describes the app itself, not your copy of it. For your actual types, views,
dashboards and navigation, an AI assistant should call \`describe_workspace\` and
\`list_types\`.

# Start here

## Two surfaces: Work and Build

**Work is for using the system. Build is for building it.**

- **Work** is your daily surface. It is glanceable and works on a phone. Its
  navigation bar is yours to configure.
- **Build** is where you shape the system: types, views, dashboards, navigation,
  and the maintenance tools. It is desktop-first, with a fixed left sidebar,
  grouped as **DATA** (the data model), **INTERFACE** (how you see and reach
  it), **MAINTAIN** (understand and care for what exists), and **SYSTEM** (the
  software and the machine it runs on: Updates, Network, Scheduled Jobs,
  Backups).

Switch between them with **Ctrl/⌘+Shift+B**, the **Build** button in the Work
"More" menu, or "Back to Work" at the bottom of the Build sidebar.

The split is a default, not a wall. Any Build tool can be pulled into your Work
navigation if you use it daily.

## Everything is an item

Tasks, events, notes, links, people, and every type you invent are all rows in
one table. That is why anything can link to anything, one search covers
everything, and a note can become a meeting without being retyped.

Seven types are built in and cannot be deleted: **task**, **event**, **note**,
**link**, **person**, **project**, and **tag** (plus the milestone and
transcript child types they use). You can still edit them, add properties, and
hide the ones you do not use — and add your own classifier types (a "category",
a "topic") alongside tag whenever one grouping axis isn't enough.

## Three ways to reach anything

- **Command palette:** **Ctrl/⌘+K** anywhere. Searches your items, pages, saved
  views, types, Build sections and settings at once.
- **Quick capture:** press **q** anywhere, or the **+ New** button in the nav.
- **The nav bar:** yours to arrange, at \`/build/navigation\`. On a phone, hold an
  icon on the bottom bar and drag it sideways to reorder the bar in place.

# Capturing things

## Quick capture

Press **q** or **+ New**. A capture card opens with a type picker.

- **It defaults to "Unsorted",** not Task. Capture the thought now, decide what
  it is later.
- **It lands in the Inbox** (\`/inbox\`) by default, until you triage it. Where
  quick capture goes is yours to change at \`/build/capture\`.
- **Type the details into the title.** "Call Bob tomorrow p1 every week" pulls
  out the date, the priority and the repeat rule, shows them as chips, and
  leaves the title clean. It understands "every other Tuesday", "first Sunday of
  the month" and "the 3rd of the month".
- **Type \`@\` to link something** while capturing. \`@/person bob\` narrows the
  picker to one type. Picking an item adds a removable "Linked" chip.
- **Offline captures queue up** and send themselves when you reconnect. A pill
  shows how many are waiting.

## The Inbox

\`/inbox\` is where untriaged things collect. Assign a type, dates, priority and
people inline, or open a row for a deeper pass. The nav badge counts what is
waiting, and clears only when you actually triage.

**The Inbox is optional, per arrival path.** \`/build/capture\` lists the seven
ways things arrive without you filing them — quick capture, the phone share
sheet, the web clipper, email in, Todoist, new items from an \`@\`-mention, and
an AI assistant — and each one can queue in the Inbox, file itself straight
away, or drop into a project. Six of them start in the Inbox; an AI assistant
starts filed. Anything that asks you where it should go, like the task
card's own picker, does what you picked and ignores the routing. When nothing
routes to the Inbox and nothing is left in it, the Inbox drops out of your nav
— the page still works and is one click away from \`/build/capture\`.

**Triage mode** (\`/inbox/triage\`) deals with a backlog one card at a time:
**→** triaged, **←** trash, **↓** or **Space** skip, **Backspace** undo.

## Capturing from outside the app

- **From your phone's share sheet:** share a URL, some text, or a text file into
  Ledgr. A URL becomes a link item with the page's readable text; a text file
  becomes a transcript and asks which meeting it belongs to.
- **From your desktop browser:** the web clipper bookmarklet saves the page's
  article text as a link item. Drag it to your bookmarks bar from **\`/build/capture\`
  → Save from the web** — there is no token to generate
  and nothing to paste. Clicking it opens a small Ledgr popup that does the
  save; if you are not signed in, that popup asks you to, once. It is text
  only; images are stripped. Clipping the same page twice within a couple of
  minutes lands on the item you already have (the popup says "Already in your
  Inbox") instead of filing a second copy.
- **By email:** put a message in the **"Ledgr Import"** folder in Outlook and it
  becomes a note. Start the subject with **\`task:\`** and it becomes
  a task instead. Attachments are linked back to the original mail, not copied.
- **From an AI assistant:** any connected client can create items over MCP.
- **From your own app:** create a credential in **User Settings → API
  credentials** and post to the HTTP API. The same credential reads content back
  out, whole and unaltered, which is how an app moves a note's text somewhere
  else without anything retyping it. \`/build/api\` has the details.

## Video transcripts

Save a YouTube video the way you save anything else and Ledgr can write the
whole transcript into that link item, so the words are searchable, readable
offline, and quotable without scrubbing through the video.

- **Switch it on** at \`/build/jobs\` → **Video transcripts**. It is off until
  you turn it on.
- **It starts as soon as you save.** A video saved on the copy doing the work
  begins at once; anything else is picked up within ten minutes.
- **Captions first, listening second.** Most videos already carry captions, which
  take seconds. A video with none is transcribed by Whisper on the graphics
  card, which takes minutes. Either way it is free and nothing leaves the
  machine.
- **This needs a computer of your own.** It cannot run on a cloud copy: YouTube
  refuses data-center addresses. Nothing is lost meanwhile, because the waiting
  list is simply your saved videos with no transcript yet, worked oldest first
  whenever a capable copy runs. Which machine that is comes from **Scheduled
  work** on the same page.
- **A video that cannot be transcribed says so in the item**, as one line giving
  the reason (private, removed, members only). Delete that line to have another
  go.

## Templates

A template is a real item you author normally, prototype and all: body,
subtasks, properties, relations. Applying one clones the whole thing.

- **Manage them** at \`/build/templates\`.
- **Set a default per type** and it drives that type's "+ New" button. The rest
  appear in a chooser.
- **Variables resolve on apply:** \`{{today}}\`, \`{{ask:Label}}\` (which prompts you
  for a value), and date-offset rules.
- **Apply to an existing item** to fill in its blanks or overwrite them.

# Writing

The body of every item is Markdown. What you see is formatted text, and what is
stored is portable Markdown you could read in any text editor.

## Three ways to view a body

A segmented pill above the body switches between them.

- **Rich text** — the formatted editor. The normal way to write.
- **Markdown source** — the raw text. This is the mode that stays fast on a very
  large note.
- **Preview** — read-only rendered output. **The only view where live tokens show
  their values.**

A very large note opens in Preview on purpose, with "Edit as text" as the way in.

## Formatting

Everything below has a toolbar button. Hover any button and its tooltip names it
and shows its shortcut for the keyboard you're on (⌘/⌥ on a Mac, Ctrl/Alt on
Windows). Every button can be hidden individually in **User Settings → Editor
toolbar**.

| What | Type this | Or press |
|---|---|---|
| Bold | \`**text**\` | Ctrl/⌘+B |
| Italic | \`*text*\` | Ctrl/⌘+I |
| Underline | — | Ctrl/⌘+U |
| Strikethrough | \`~~text~~\` | Ctrl/⌘+Shift+S |
| Inline code | \`\` \`code\` \`\` | Ctrl/⌘+E |
| Heading | \`#\`, \`##\`, \`###\` then a space | Ctrl/⌘+Alt+1…6 |
| Bulleted list | \`-\` then a space | Ctrl/⌘+Shift+8 |
| Numbered list | \`1.\` then a space | Ctrl/⌘+Shift+7 |
| Checklist | \`[]\` then a space | Ctrl/⌘+Shift+9 |
| Quote | \`>\` then a space | Ctrl/⌘+Shift+B |
| Divider | \`---\` | — |

Underline is the one exception to "type it and it works": typing \`++text++\` does
not convert as you go. Use the button or Ctrl/⌘+U.

**Tab** nests a list item and **Shift+Tab** un-nests it. On a phone, the indent
and outdent buttons do that job. **Backspace** at the start of a bullet merges it
into the line above.

## The "/" menu

Type **/** at the start of a line for an insert menu: Heading 1–3, Bulleted
list, Numbered list, Checklist, Quote, Code block, Table, Divider, Toggle, and
"Turn into toggle".

## Colour, and marking text for other purposes

Four separate channels, so they can all sit on the same words at once.

- **Text colour** — nine colours, from the "A" button.
- **Highlight** — nine translucent washes, from the marker button, plus **My
  highlight** at the end of the row: your own accent colour from Settings, so
  the marker pen matches the rest of the app. It is a live reference, not a
  fixed colour, so changing your accent in Settings restyles every "My
  highlight" you have already made. If your accent is a gradient, the highlight
  is that gradient. (Outside Ledgr, in a plain Markdown reader, it shows as
  that reader's ordinary highlight; the Save Offline and PDF copies keep your
  colour.)
- **Slide mark** — "put this on the screen". Shows as a blue rule bracketing the
  span, and drives the presentation export.
- **Comment** — a private note to yourself, anchored to the selected text.

## Comments

Select some text and press the comment button. Your note shows as a card in the
margin, or as a tappable speech bubble on a narrow screen. Hovering either one
lights up both.

- **Notes are Markdown** — bold, links, and \`@\` mentions all work inside one.
- **A comment can span several paragraphs** and stays one comment.
- **Comments never reach a reader.** Print, share and Word exports strip them.
  They stay in your own read view and in search, because searching them is the
  point.
- **They survive export**, because they are stored in the Markdown itself.

## Linking to other items

Type **@** anywhere in a body. The picker searches every type as you keep
typing, spaces and all.

- **Narrow it with a type:** \`@/person bob\`. Typing \`@/person\` alone browses
  recent people.
- **Create as you write:** if nothing matches, a **Create** row makes the item
  and links it, without leaving the page.
- **Link a Bible passage** with \`@/ref John 3:16\`. The chip links to a page
  showing everything in Ledgr that cites an overlapping passage.
- **The chip stays live.** It shows the target's current icon, and a mention of a
  task carries a working checkbox you can tick from here.
- **Saving creates the relation** automatically, so mentions show up in the
  linked item's "Linked here" list too.
- **Local file links** (a \`file:///…\` URL on a link item) can't be opened by
  a browser from a web page — that's a browser security rule, not a Ledgr
  choice — so clicking one **copies the link** instead, ready to paste into
  the address bar or Finder → Go.

## Live tokens

Type **{{** for a menu of tokens that resolve from the item's current state
every time the page renders.

- **About this item:** \`{{item.title}}\`, \`{{item.status}}\`, \`{{item.due:long}}\`,
  \`{{item.props.<key>}}\`.
- **Today's date, always current:** \`{{now}}\`, \`{{now.tomorrow}}\`,
  \`{{now.today+7d}}\`, \`{{now.sunday}}\`.
- **Related items:** \`{{item.children}}\`, \`{{item.related.person}}\`,
  \`{{attendees}}\`, \`{{absentees}}\`.
- **The parent item:** \`{{parent.title}}\`, \`{{parent.due:long}}\`.

Date suffixes: \`:long\`, \`:short\`, \`:iso\`, \`:us\`, \`:day\`. Offsets: \`+7d\`, \`-1w\`,
\`+1m\`. Add \`:ul\` or \`:ol\` to a list token, alone on its own line, to get a real
list. Put a backslash in front to keep a token literal.

**Tokens show as plain text while you write, and resolve in Preview.**

## Blocks and structure

- **Toggle** — a collapsible block with a chevron. From the toolbar or \`/toggle\`.
  It stays a real disclosure on print, share and export.
- **Collapsible headings** — fold a heading to hide its section. View only;
  nothing is written into the body.
- **Table** — a real Markdown table, with drag-resizable columns.
- **Canvas tabs** — split one body into named tabs. Everyone else reading the
  item sees the whole document as titled sections.
- **Outline** — an automatic table of contents built from your headings, at the
  right edge. It can be pinned open as a resizable sidebar, remembered per item,
  and it lists your comments too.

## Images and files

Paste a file, drop one on the editor, use the toolbar's Image or Attach
buttons, or type **/file** — the slash menu's File command opens the picker
right where you're writing. Images upload and embed where they land; any other
file type (a PDF, a Word doc, an HTML page) uploads and lands as a link on its
filename. Clicking that link opens the file in a new tab — HTML pages and PDFs
render in the browser, everything else downloads.

## Linking to one line

The "copy a link to this line" button stamps a hidden marker on the current line
and copies a URL straight to it. Opening that link scrolls to the line and
flashes it. The marker never appears on a printed or shared copy.

## Turning a note into tasks

On a meeting's notes, hover any checkbox line for a **→ task** button. It opens
the ordinary task add card, pre-filled with that line as the name and its
sub-bullets as the description, and the task is linked back to the meeting, to
everyone in it, and to that exact line. The line then shows a **✓ task** badge
that opens it.

Because it's the same add card, everything you can write in a quick capture
works in an action line too: a due date in plain words ("Friday", "every other
Tuesday"), a **p1**–**p6** priority, **#tag**, **+project**, and **@name** to
link a person or any other item. Those get parsed out of the line and set on the
task instead of sitting in its name. A multi-word name is written the way a
multi-word tag is: **@Elder-Board**. Anything that matches nothing is left alone
as plain words, and you can still edit every field in the card before creating.

# Organizing

## Types and properties

Build your own kinds of item at \`/build/types\`.

- **Properties** can be text, number, date, checkbox, URL, phone, email, select,
  multi-select, or a relation to another type.
- **A date field can carry a time, an end, or both.** On a Date property, tick
  **Include a time of day** and the record shows a date-and-time picker instead
  of a plain date; tick **Has an end (a range)** and a second "to" picker
  appears beside it. A time log's Date can be one 9:06 to 9:15 PM range that
  the Planner and a History spine place by the hour. Values you already saved
  as plain days stay readable; nothing rewrites them.
- **Phone and email fields are tappable.** Pick the Phone or Email kind and the
  value becomes a tap-to-call or tap-to-mail link, on the record and in a table
  view, with the right keyboard on a phone. Type the number however you like —
  it is stored exactly as you enter it, extension and all.
- **Statuses are yours per type.** Name your own stages and colours. Or choose no
  status at all, or a plain done/undone checkbox. Each stage sits in one of four
  fixed groups (Not Started, In Progress, Done, Closed), and the arrows on each
  row reorder stages **within** their group — which is exactly the left-to-right
  order a board's columns read in, so a stage you add later doesn't have to stay
  stuck at the end.
- **Hide a type you do not use.** It disappears from capture, "+ New", tabs and
  pickers without deleting anything.
- **Deleting a type is undoable.** It goes to Trash as a restorable unit, and can
  take its items with it.
- **Change an item's type** from its ⋯ menu, with a preview of what carries over.
  Properties the new type does not have are kept in the body rather than lost.
- **Bespoke tools** at \`/build/tools\` attach a ready-made capability — chord
  chart, paper workspace, tabs, longform document, widget homepage — to a type
  you name yourself.
- **Workflows and wikis** at \`/build/new\` ask a few questions and generate a
  type, its properties, and starter views in one go.
- **A paper or a song opens on Notes.** Both types spend their main body on a
  finished artifact (a paper's draft, a song's chord chart), so each has a
  separate Notes tab for the thinking that comes first. Notes take tabs of their
  own, so you can keep sources, argument and feedback side by side on one record.
  Notes stay out of print, share, the .docx export and the Planning Center copy:
  they are working material, not the artifact.

## Relations

- **Every item shows what links to it,** both directions, grouped by type.
- **Typed relation fields** ("Author", "Attendees", "Tags") live under
  Properties. Everything else shows under **Linked here**.
- **On a task, linking lives in the rail.** A **Linked** row sits with Project,
  Tags and People (they are all links, after all): the "+" adds one, and the
  caret opens the list of what is already connected. The full **Linked here**
  panel under the body is still where you check things off, change their dates,
  or unlink them.
- **+ Relate and + Task.** Under the panel, **+ Relate** links something that
  already exists, and **+ Task** creates a task already attached to this item
  (you can still send it to the Inbox or another project). **+ Task** is hidden
  on tasks and on project-style pages, where "Add subtask" and the Tasks widget
  already do that job.
- **Create as you link.** Typing a name that does not exist makes it. That
  includes an event's **+ person** and **+ group**: someone who isn't in Ledgr
  yet can be added to the meeting from the meeting, without leaving to create
  them first.
- **Tags are just a type.** A tag's page shows everything tagged with it.
- **Groups** have a member roster. An event can be *for* a group, and a task can
  link to one from the add card's Group chip.
- **A resource can belong to several records.** Docs, meetings and links can be
  attached to more than one project at a time; tasks and milestones live in one.
- **Discover** suggests items you probably should link but have not, ranked by
  shared text, shared neighbours, shared attributes and timing. One click links
  them.
- **Related Explorer** turns that into a map you can walk, re-anchoring as you
  go, with a breadcrumb trail.
- **Loose Ends** (\`/build/loose-ends\`) inverts it across everything: your
  least-connected items with their best suggestions inline.

## Tasks

Ledgr is its own task manager. Nothing else needs to be running.

- **Six tabs at \`/tasks\`:** Today (overdue + due, grouped by priority), All
  (every open task), Upcoming (week-paged days), **Overdue** (every past-due
  task in one sweepable list — click each row's date to reschedule in place),
  Projects (each project with its open tasks), and Planner (drag-to-schedule
  calendar).
- **A subtask shows in one place, under its parent.** Across the task lists, a
  subtask whose parent is on the same list (same day, on Upcoming) nests under
  the parent instead of appearing as its own peer row. On dated surfaces
  (Today, Upcoming's days, Overdue) the parent starts expanded so the dated
  subtask is visible without a click; on All everything starts collapsed —
  click the arrow. A dated subtask whose parent isn't on the list still gets
  its own flat row, and an overdue subtask never hides behind a merely
  due-today parent. Completing a parent with open subtasks is always allowed —
  the toast just tells you how many are still open.
- **Dates in the subtask tree are click-to-edit** — the same picker as the
  rows, wherever a subtask's date shows under its parent's arrow; an undated
  subtask gets a "＋ date" on hover. **Completed subtasks tuck away** behind a
  "Show N completed" line at the bottom of the tree.
- **Type "/" while naming a task** to jump to its description: everything
  after the slash lands in the task's body. Word-boundary only, so dates like
  9/13 and URLs never trigger it.
- **The add card's chip row** carries Date, Priority, **Tag**, **Person** and
  **Group** pickers (sigils still work: "#" adds a tag, "@" links any item,
  "+project" files the task under that project), and the **⋯** chip opens any
  other custom property on the task type so you can set it at creation. Group
  works exactly like Person — pick Pastors or Elders and the task links to
  that group. It only shows if you have a group type. Picking a tag with "@"
  tags the task the same way "#" or the Tag chip does — it's never just a link.
- **People get faces.** The person type ships with a built-in **Image**: a
  square picture box on the person's page — click it to upload a photo (it's
  center-cropped square automatically) or paste an image URL, and Remove lives
  in the same panel. Project cards' people circles and a task row's person
  chips then show the face, falling back to initials or the person glyph
  without one.
- **Any type can carry a picture.** Add a field of kind "Image (upload or
  URL)" to a type at Build → Types, and every record of that type gets the
  same click-to-upload box the person page has — upload a photo or paste a
  direct image URL, Remove in the same panel. A list view's column for that
  field shows a small thumbnail instead of the raw address.
- **Two dates, on purpose.** *Scheduled* is when you plan to do it; *due* is the
  deadline. Most of the app sorts by the plan date and falls back to the
  deadline. On a task they sit as a pair at the top of the details rail,
  Schedule then Due.
- **Dates move together.** Bump a task and its whole checklist follows: every
  dated subtask shifts by the same number of days, all the way down, and the
  deadline keeps whatever gap it had from the plan date. A repeating task
  carries its deadline and its subtasks forward each time it advances, so
  nothing is left dated to last cycle. You never set a rule for this \u2014 the gap
  is simply whatever the two dates currently are, and changing either one
  restates it.
- **Moved something by mistake?** When a bump carries subtasks along, a toast
  says how many moved and offers **Undo**, which puts every one of them back
  exactly where it was.
- **Pin a date to hold it still.** Open the Due row and it says "Follows the
  plan date"; click that to pin, and the deadline becomes a hard external date
  that ignores every move (Apr 15, a grant deadline, a hand-off). A pinned
  deadline shows a small pin on the rail row, so you can tell at a glance that a
  bump won't carry it.
- **A deadline before the plan date gets flagged,** not blocked \u2014 sometimes you
  genuinely missed it. Where the deadline is still ahead, one click moves the
  plan onto it. A deadline on the same day as the plan simply doesn't print, so
  rows stop showing you the same date twice.
- **Six priorities,** P1 to P6, colour-coded. They drive the checkbox colour, row
  chips and grouping.
- **Subtasks nest,** with an "n of m done" rollup and a breadcrumb. **Add
  subtask** on a task's page opens the same full add card as anywhere else —
  date, priority, tag and person chips, "/" to description, "@" links, the
  custom-property kebab — so a subtask is born as complete as any task.
- **Rows tell you more at a glance.** A task row shows its title, the first
  line of its body as a one-line description, an **n/m pill** that folds its
  subtasks out underneath, its tag and
  connection chips (people, records — scroll the strip sideways when there
  are many), and the project it belongs to on the right.
- **Click the date on any row to change it.** The row's date is a button
  opening a full scheduler: quick picks (Tomorrow, Later this week, This
  weekend, Next week, No date), a month calendar, a free-text box ("next fri
  9am"), and Time / Repeat controls. It edits what's shown — the scheduled
  date if the task has one, otherwise the due date — and a repeat glyph
  beside it marks a repeating task. The same picker backs the Schedule popover
  on the task page. Clicking a date still changes that date, everywhere in the
  app: a chip reading "due Sep 14" edits the deadline, a plain date edits the
  plan.
- **Reschedule fast:** Today / Tomorrow / +1wk chips, or type "in 3 days" or
  "next Tuesday".
- **Roll overdue tasks forward** in one click from Today. It moves the plan and
  leaves the missed deadline alone.
- **Defer** a task by scheduling it ahead. It stays off Today until then.
- **Star three things** as Today's Focus. It sits at the top of Today and clears
  overnight.
- **Give a task a start time and duration** and it becomes a real timed block in
  your calendar feed.

## Repeating tasks

A repeating task is **one item** holding the rule plus a log of which dates are
done. Nothing stacks up when you miss a week.

- **Set a rule** in plain words, or with the controls: daily, weekly, monthly,
  yearly, intervals, weekdays, "first Sunday of the month", ending after N times
  or on a date.
- **Completing it advances it** to the next date rather than closing it.
- **A month grid** on the task lets you tick or untick any date, in any order.
- **Carve out one date** with "edit next occurrence" when that one is different.
  The series skips past it.
- **Editing the rule keeps the history** of what you already did.
- **Subtask dates follow the parent.** Pick a date and it is stored as an offset,
  recalculated whenever the parent moves.

## Projects and records

A project is a hub page composed of **tools**: the things that live in it, an
activity log, a next action, progress, milestones, a timeline, a mindmap. The
**Add a Tool** button below the grid adds any tool not already on the page.

**Any type you create can be a project-style hub, and any type can be a tool.**
Check **Project-style page** on a type's edit page (Build → Types) and its
records open as this same tool-composed page — make a "Book" or "Video" type
and its records carry tasks, milestones, docs, progress, the timeline, all of
it. Leave it unchecked and records open as a plain document page. And the
reverse: flip **Offer as a tool** on the same edit page and the type joins the
Add a Tool menu everywhere — so a "Chapter" type becomes a Chapters card on
your Book, with its own "+ Add chapter" and a full-page drill-down. Build the
shape your work actually has.

**Your own fields show up on the page.** A project-style record carries a
**Properties** card holding the type's own fields, the scalar ones (a Scope
select, a Live URL, a Stack) and the relation ones alike, editable right there.
Until 2026-09-14 it didn't: fields rendered only on plain document pages, so a
field you added to a project-style type was invisible on every record that had
it, and the only way to set one was the list page's select mode. The card shows
on any project-style type that actually defines fields, and like every other
tool it can be removed and added back from the menu.

**Finishing a project.** The record header carries a **Mark this project done**
checkbox beside the status pill. It does two things at once: sets the project to
its Done status, and completes everything still open inside it, so a finished
project stops trailing open tasks through your task lists and its progress bar
actually reaches 100%. Because that is a lot of writes, it asks first and names
the real numbers — "completes this project and 18 tasks, 3 milestones" — and
raises an **Undo** toast afterwards that puts every one of them back exactly as
it was. Two things it deliberately leaves alone, and says so in the box:
**repeating tasks** (completing one advances it to its next date instead of
closing it) and items of a type with no done state (a note, link, event or
receipt — give that type a Done checkbox in Build and it starts being included).
Unchecking the box later reopens the **project only** and leaves its tasks done;
the Undo toast is the way to take a whole sweep back.

You can still set Done from the status pill alone if you only want to move the
project and leave its contents untouched.

**Rename any tool card.** Every card's hover gear has a **Rename** box: call
the Docs card "Sermon research" on one project without touching any other.
The rename is per record, the card's full drill-down page follows it, and
saving it empty restores the default name.

**Group the task list, if you want.** The Tasks card's hover gear has a
**Group by** choice: none (flat, the default), **milestone** (tasks section
under the milestone they complete), or **priority**. The full task list
follows whatever the card chooses.

**Favorites show on cards.** Star a project (⋯ → favorite) and its card wears
a small accent star and a subtle glow, everywhere cards render. Just a visual
marker — nothing reorders.

**Quiet projects ask for a check-in.** If an active project isn't opened or
touched for its quiet window (14 days by default), it surfaces at the top of
**Tasks → Today** as a P1-styled "Check on …" row. Opening the project IS the
check-in — the row disappears on its own; there's no button to press. Each
project's **Check-ins** control (bottom of its page) turns this off or changes
the window.

Choose the default tools every new record starts with, and their order, on the
type's edit page under **Tools** — or per record, from the record itself. The
**Overview** reads directly under the title when you've written one; empty, it
collapses to a small lines icon that opens it for typing. Each collection
card's hover gear sets how many rows it previews (3–50, or **All**); the Tasks
card lists open tasks only — completed ones move off the card and stay on its
full collection page.

**Subtasks ride along with their parent.** Put a task on a project and its
subtasks come too, without cluttering the surface: on the Tasks card and the
full task list, a task with subtasks wears an **n/m pill** that folds them out
in place, and each subtask completion becomes a tick on the review timeline.

**Every tool's full page carries the tool's own powers.** A card's "Showing N
of M" used to land on a bare list; now each full collection page renders the
same rows as its card, plus the card's add box pre-bound to the record. Tasks:
complete in place, swipe or use the row menu, expand subtasks under their
parent. Milestones: the same mode-aware circles, badges, and points chips.
Meetings, docs, links, mindmaps: the same rows and "+ Add" as their cards.
Select mode and bulk actions stay on all of them.

**Every card can also take something you already have.** Beside each card's
"+ Add" is an **Attach**: search items of that card's type and pick one, and it
shows in the card like a freshly created one. Tasks, meetings, milestones,
docs, links, mindmaps and custom tools all have it.

**What attaching does depends on the kind of thing.** A resource, meaning
anything with no Done state (a doc, a meeting, a link), can be relevant to
several records at once: attaching adds it here and leaves it where it already
was. Anything that completes (a task, a milestone) is filed under one record,
because that is the record whose progress bar it counts toward and whose "mark
this project done" would close it, so attaching re-files it here and out of
wherever it was. The toast says which one happened.

Filed under is not inside. Deleting a record does not delete what is filed
under it: those items stay, they just stop having a record they file under.
Only subtasks follow their parent into Trash.

**A row with an ✕ is a visitor.** On a card, a small ✕ at the end of a row means
that item is related to this record rather than filed in it. Click it to detach,
which removes the association and never the item, with undo. A row without an ✕
lives here.

**Completed tasks fold away, and milestones flag their tasks.** Done tasks
leave both the Tasks card and its full list; a quiet **"N tasks completed"**
line at the bottom of each opens them when you want the history. And a task
that completes a milestone ("Completes with task") wears a small flag chip
naming that milestone on the project's task surfaces — milestones are the
natural grouping for a project's tasks, so the membership is visible where the
tasks are.

**Milestones complete three ways**, decided by what you give one when you add
it (the "+ Milestone" box takes a title, an optional date, optional points, and
an optional completing task):

- **Linked to a task** (pick an existing task or create one right there): the
  milestone completes when that task does. Its circle checks the task off — one
  gesture for both. A date on it is a target, not a trigger.
- **Dated, no task**: it counts as passed once the date arrives — no checkbox,
  it happens whether you act or not.
- **Undated, no task**: a work milestone you check off yourself.

Set **Points (% of project)** to make a milestone worth that share of the
project's progress bar, however many tasks it has; milestones without points
share the bar's remainder with the tasks and meetings.

**The Timeline card** previews the meetings and milestones nearest today, with
open undated milestones in an **Upcoming** tail (rename that group per type
under Build → the type's **Tools**) — completing one moves it onto the axis at
the day it finished. Its "Showing N of M" opens the **review timeline**: the
whole project's history on one vertical line — meetings and milestones large,
task completions, notes, and links as small ticks between them, month markers
and a Today line down the spine. Scroll it to re-live the project.

Three controls sit above the spine. **Group by** sets how much time each marker
covers, from an hour out to five years. **Order** flips it to newest-first.
**Show** switches whole collections off, so a year-old project can be read as
just its meetings and milestones. They are plain links, so any combination is a
URL you can bookmark or share.

**The whole project as one markdown file:** ⋯ → **Markdown** on a project
renders it as a single readable document — summary, people, milestones,
meetings, clickable links, tasks with added/completed dates, and the timeline —
composed live from the project's current state, with Copy and **Download .md**.
Hand the file to anyone; it reads without Ledgr.

**Project cards, everywhere you list projects.** The rich card from the
Projects list — title, status, progress bar, counts, people — now renders on
any saved **list or board view** of projects too, so a kanban of projects shows
the same card as the grid. Pick which elements every card carries at **Build →
Types → Project → Card elements** (status pill, counts, progress bar, people,
key links, a Timeline button); a saved view can override that set in its own
editor. The pieces are buttons: "6 tasks" opens the full task list, the
Timeline chip opens the review timeline, and a key-link chip opens the link.

# Finding and seeing

## Search

- **Command palette (Ctrl/⌘+K)** — the fast one. Items, pages, views, types,
  saved searches, Build sections and settings. A leading \`/type\` scopes it, as
  in \`/task budget\`. It remembers your last query: close it and reopen, and
  your text and results are still there.
- **Recent searches.** Both the palette (with the box empty) and \`/search\`
  (before you've searched) show your last searches as clickable rows or chips,
  so you can jump back into one without retyping it.
- **Search box on every view and dashboard.** Under the title of a saved view
  (\`/views\`) or a dashboard, including Home, there is a one-line search box.
  Type and press Enter to land on \`/search\` with those words already run.
- **Advanced search** (\`/search\`) — full text over titles and bodies with
  phrases, \`OR\`, and \`-exclusions\`, plus filters.
- **Agenda views drag between days and into order.** An agenda view (tasks
  grouped under a day divider) lists each day highest priority first: P1, then P2,
  then P3, then unranked. Drag any row onto another day, including an empty one in
  the next two weeks, or to a new spot within a day. A drop sets the task's date
  (start and due together) and, when you drop it among other tasks, it takes the
  priority of the tasks it lands next to and keeps that position. Drop on "No
  date" to clear the date. On a phone, hold a row for a moment, then drag.
- **Priorities P1, P2, P3.** A task row is tinted blue for P1, green for P2, and
  yellow for P3, with a matching chip. To change one, right-click the row (or
  long-press on a phone) and pick P1, P2, P3, or the dash for none. The same menu's
  quick dates set the task's start and due day together.
- **Focused today card.** A dashboard card over a "focused today" view lists
  what you starred for today. Drag a task from a day list onto it to focus it;
  drag a focused task back onto a day to unfocus it and give it that day. A day
  list can be told to hide focused tasks (view filter excludeFocusedToday) so each
  task shows in one place. Desktop mouse drag; on a phone use the row menu.
- **Dashboard cards can hide when empty.** In a view widget's gear, tick "Hide this
  card when it has nothing to show" and the card drops out of the grid until its
  view has items again. Edit mode always shows every card.
- **Unfinished tasks roll forward every night.** A little after 1:00 AM Eastern,
  any open task whose day has passed is moved to today, and today becomes its new
  due date. Nothing is left behind in yesterday. The "Roll N overdue" button on
  Today does the same thing on demand.
- **Sort a table by clicking its header.** On a table view, the Title header
  and every date, urgency, and custom-property column header are links: click
  once to sort ascending, again to flip. The arrow marks the active column. It
  changes only what you see; the view's saved sort is untouched.
- **Save search.** On \`/search\`, once you have a query or filters set, **Save
  search** names and keeps the whole search (words, filters, and Tune
  criteria). Saved searches sync across your devices, show as chips on
  \`/search\` to restore or delete, and show up in the command palette too.
- **Tune** — for when you half-remember something. Stack up what you recall
  (words, a rough date, a type, a person, a tag) and set **how sure you are about
  each piece separately**. Results rank by the total instead of filtering down to
  nothing. A date never hard-filters, however sure you are.
- **Your own synonyms.** Teach it that "teaching" also means "preaching" in
  **User Settings → Search dictionary**.
- **One Search icon.** What it opens — the popup or the full page — is your choice
  at \`/build/navigation\`. Ctrl/⌘+K always opens the popup.

## Lists

Every type has a list page, reachable from \`/list\`.

- **Tabs (lenses)** across the top: Recent, Newest, A→Z, Most linked, each
  reversible. Add your own — a field, a property, or a whole saved view as a tab.
  Configure them on the type's edit page.
- **Projects open on a Board.** The project list leads with a status kanban:
  a column per status, ordered left to right the way the statuses are ordered,
  with cards you drag between columns to change status (long-press to drag on a
  phone). On a phone the columns are full-width and swipe one at a time.
- **Finished columns collapse.** Done (and anything archived) starts as a narrow
  rail showing just its count, so a board reads as live work — click it to
  expand, and drop a card on the rail to complete it without expanding. Any
  column collapses; each board remembers what you left collapsed.
- **A Completed tab** closes the project strip: every finished project, with a
  search box for finding one again by name months later.
- **Select mode** is a toggle above the list. It reveals checkboxes (shift-click
  for a range) and a floating bar: delete to Trash, set a status, property or
  date, or move items under a parent.
- **Row menu** — right-click, or long-press on touch: Complete, Focus today,
  Schedule, Move to Trash.
- **Swipe** on a phone: right completes, left opens the schedule picker. Trash is
  never a swipe.
- **Undo** appears as a toast after anything destructive, and survives a refresh.

## Saved views

A view is a saved filter, sort and layout you reach by name. Build them at
\`/build/views\`, run them at \`/views\`.

- **Five layouts:** list, table, board, calendar, agenda.
- **Read any list as a timeline.** Pick the calendar layout, then set **Default
  view** to **History**: the same vertical spine as a project's review timeline,
  over whatever the view holds. **Group by** sets the marker span (hour through
  five years) and the view's sort **Direction** decides whether the newest sits
  at the top. It works on any type, so a work log becomes a scrollable record of
  what you did, filtered to one category if you like.
- **Place items by your own date property.** The calendar and agenda **Date
  field** now offers a type's own date properties beside the built-in ones, so a
  type that keeps its date in a property (a log entry's Date, a journal's Date)
  can finally land on a calendar, a timeline, or a History spine. If that
  property includes a time of day, the entry lands at its hour, and a table
  column shows the day and clock rather than a raw timestamp.
- **Filter on anything,** including your own properties, with operators that fit
  the property kind. A day-of-month or date field can filter against "today"
  itself, so a rule like "day is today" always matches the current date without
  editing the view.
- **Write simple rules:** "tagged A OR tagged B", combined with the view's other
  filters.
- **Sort by anything,** including priority and custom properties.
- **Pick your columns** for list, table and agenda layouts, and for a History
  spine, where they become each entry's second line.
- **Boards drag,** including on a phone with a long press.

## Dashboards

Any number of named dashboards, each a grid you drag and resize. Manage them at
\`/dashboards\`; assign one as your Home or Today.

Widget kinds: a **view** (live list, compact or laid out faithfully), a **stat**
(one count), an **action** button, a **text** heading, a **tree** (parents with
their children), an **embed** (another item, editable right there), a
**container** (tabs or sections), and an **image**.

Each widget has a gear for its own settings: item limit, sort, title, header and
border, background colour. The dashboard itself can carry a full-bleed colour,
gradient or image background with an adjustable scrim.

**Dashboards are for doing, not just reading.** Rows have the row menu, list
widgets have an inline add, board widgets drag, and removals are undoable.

## Daily Devotions

\`Daily Devotions\` on your Work nav is a dashboard for a devotional rhythm
built on the day of the month: today's attribute of God, today's morning and
evening prayer from *A Diary of Private Prayers*, your open prayer requests,
recent journal entries, and a quiet Library row for the books and your own
devotional writings.

- **Attribute of God** is its own type: one item per attribute, tagged with the
  day or days of the month it belongs to.
- **Book** holds a devotional book as one parent item with a child item per
  entry or chapter, the same shape as a commentary. *A Diary of Private
  Prayers* carries a day and a time of day (morning or evening) on each entry;
  *New Morning Mercies* and *Whiter Than Snow* carry a chapter or a calendar
  date instead, so they read but don't rotate.
- **The three-year Bible reading plan** is one long reference note, not a set
  of items: it's an archive to browse or print, not something Ledgr tracks
  day by day.
- **Your own devotional writings** carry a "Devotional Writing" tag, so the
  Library row's link always finds them; tag a new one the same way to add it
  to the shelf.

## Planner

\`/planner\` is a calendar you drag tasks onto to decide when you will do them.

- **Month and Timeline views.** Timeline is a zoomable horizontal axis, from
  hours out to five years.
- **Anything with a date shows up,** not only tasks. What is writable can be
  dragged; what has a start and an end can be resized.
- **Show your real calendar behind it** with the calendar toggle. Those events
  are read-only, there to plan around.
- **The unscheduled rail** holds what has no date. Drag onto the grid to schedule
  it, or off the grid to clear it.

## The Desk

\`/desk\` is a desktop workspace for working across several items at once:
resizable, tabbed panels holding items, saved views and dashboards. Every panel
is a live editor, so clicking between them is seamless. Save named workspaces;
the arrangement survives closing the app.

Send things there from any row menu or mention chip with "Open in Desk" or "Open
beside".

## Item pages

- **Opening from a list** docks a peek panel beside it on a wide screen, a modal
  on a narrower one, and a bottom sheet on a phone.
- **Each type gets a canvas that fits it** — a document layout for prose, a
  compact rail for tasks, a two-pane notes-plus-details layout for meetings.
- **Rearrange it yourself** by adding \`?arrange=1\` to the URL: every field and
  section becomes a card you can drag, widen, or hide, saved per type and per
  screen size. A card is always exactly as tall as its content (nothing scrolls
  inside a card), and the Details, Save Offline, Share, and Version History
  cards always settle beneath everything else.
- **Lock an item** from its ⋯ menu to make it read-only.
- **Version history** snapshots the body as you write, and restores.
- **A cross-device guard** stops a stale tab from overwriting a newer edit. If
  you have no unsaved work, it just reloads quietly.

## Listen (read aloud)

Turn this on per type at \`/build/types\` (expand a type's row and flip the
"Listen" switch). A type with it on gets a **Listen** entry in the item's ⋯
menu, which reads the note aloud
using your browser's own read-aloud voice. Choosing it opens a small strip
with Play, pause, stop, and a reading-speed picker. It works best in Microsoft
Edge, which has noticeably better free voices than most other browsers — an
optional second setting next to Listen, "Open in Edge," sends the ⋯ menu's
Listen straight to Edge instead of playing locally when you are not already
there.

# Getting data in and out

## Save Offline

The **Save Offline** button, under "Export & sharing" on any item, does three
things in one press:

1. **Exports to OneDrive** immediately.
2. **Pins a self-contained copy into your browser,** images and all, so the item
  opens with no network. It checks the pin actually landed before it says saved.
3. **Makes that copy print-ready**, so your browser's print-to-PDF is the PDF.

**Opening the app with no connection lists what you saved.** You get a page of
everything pinned on that device, newest first, with the date you saved each one,
so you can find Sunday's sermon without remembering its address. Tap a row and it
opens from the saved copy. The same page is at \`/offline.html\` when you *do* have
a connection, which is how you check on Saturday night that your pins landed.

This is the fallback path. Nothing you need on a Sunday should depend on the app
being up.

## OneDrive export

Every item is written out as a Markdown file, nightly and on demand, to
\`/Export/{type}/{year}/\`. Attachments are copied alongside. Deleted items move to
an \`_archive\` folder rather than vanishing.

**It is one-way.** Ledgr writes the files and never reads them back, so editing
an exported file changes nothing here.

## Sharing one item

The **Share link** control mints an unguessable, read-only link to a single item.
No sign-in for whoever you send it to. You can revoke it, and each press makes a
fresh one, so a leaked link can be killed on its own. Comments are never
included. **Opens in** picks the theme the shared page starts in (it defaults
to your own). The page itself has an **Appearance** dropdown at the top right,
so whoever you send it to can switch between Dark, Light, Gray, and Sepia; their
browser remembers the choice for every Ledgr document they open.

## Presentation export

For a talk or a sermon. Mark the spans you want on screen with the **slide mark**,
then one press gives you two documents:

1. **A stripped manuscript** with colours flattened, private notes removed, and a
  **[SLIDE N]** cue at every marked span.
2. **A slides document** listing each marked passage, numbered to match.

The slides document is rewritten each time rather than piling up. The old version
stays in the item's history.

## Your tasks in your calendar app

**User Settings → Task calendar feed (ICS)** publishes a subscribe URL that
Outlook, Apple Calendar or Google can follow. Your open dated tasks appear as
entries, so **your calendar app fires the reminders**. Timed tasks show as real
blocks; repeating tasks repeat properly. Set a per-task reminder lead time from
the task itself.

The URL is the password. Rotate it from the same place if it leaks.

## Other exports

- **Word (.docx)** for papers, rendered fresh from the Markdown each time.
- **Chord charts** for songs, including a Planning Center Lyrics & Chords format.

## Attachments

Attach any file type, anywhere you can write: paste, drop, the toolbar's Attach
button, or **/file**. Images embed in the body; anything else becomes a link
that opens in a new tab. Files go from your browser straight to storage, and an
upload that puts you past 80% of your quota says so.

Limits: about **10 GB** in total, **100 MB** per file, and **2 GB** for an audio
or video file.

**Deleting a file for real** is the **Delete** on a file row (a File item's
panel, or a record's Files card) — that removes it from storage. Deleting a
link or image out of a body does **not** delete the file behind it; it keeps
counting against your quota until deleted. When you DO delete a file, every
link to it cleans itself up: your text stays, unlinked, with a "(file deleted)"
note after it — an embedded image becomes the note alone. Purging an item from
Trash deletes its files with it.

**Every item shows its own files.** An item carrying files gets a collapsible
**Files** section above Export & sharing — on a task it sits in the details
rail instead, just above Linked (it appears the moment your first upload
lands): each file with Open, **Download** (saves it to your device under its
real filename, instead of opening in a tab), **Copy link** (a markdown link to
paste back into the body), Share, and Delete — plus a "not linked" mark when nothing
in the item points at the file anymore. So a link you backspaced out of the
body is never stranded invisibly, and **dragging a file row into the body
links it right where it lands** — no re-upload. On a type with a customized
page layout, Files is an arrangeable card like the rest: put it wherever you
want it.

**To see everything you have stored:** **Build → Files** (\`/build/files\`)
lists every file, its size, the item it belongs to, and the same "not linked"
mark — with Delete on each row. The **Unused files** tool on Data Hygiene
narrows to what you can likely reclaim: files whose item no longer links them
(delete per row), and orphans with no item at all — **Recover all** turns each
orphan into a note linking it, or **Delete all** reclaims the storage.

**A link can BE one of your files:** the URL field takes a dropped file (or the
paperclip beside it) — the file uploads and its permanent address becomes the
link's URL, so your own PDF or page sits in a project's Links card like any web
link.

## Files as items

Sometimes the file IS the thing — an HTML page, a spreadsheet, a scan — and the
body is just context around it. The **File** type is for that: the file leads
the page, and the markdown below is your description of it, for finding it
later. The filename opens the file in a new tab, and **Share** copies a public
link anyone can open without signing in — an uploaded HTML page opens as a live
web page, which makes this the way to hand someone a page you made. The link
rides the item's share link, so revoking that share link kills the file link
with it (and a link to one file on an item unlocks that item's other files).

Records get the same panel as a tool: add the **Files** card to a project (or
any project-style page) from Add a Tool, and files upload, open, share, and
remove right on the record.

## Your calendar and email

- **Calendar** — Ledgr keeps a private copy of the next four weeks of your Outlook
  calendar. Events it recognizes become real items automatically, with the right
  people attached. The rest wait in the **Calendar** lens on the event list with
  an **Add** button. A promoted event tracks reality: if the meeting moves, the
  item moves.
- **Teaching it to recognize a meeting:** confirm the people on an event, then
  **pin it as a rule**. Future matching meetings get the same treatment.
- **Meeting prep** assembles itself when you open a meeting: the people's open
  tasks, your last few meetings with them, and the agenda. It is never written
  into the body.
- **Which tasks a meeting pulls in** is a per-event rule: by the people on it, by
  a tag, by a group, or a combination.

## Meeting transcripts

Paste a transcript into a meeting's transcript panel and it becomes a linked
child item marked "needs minutes", collected in a saved view. Uploading audio
transcribes it with speaker labels, if your instance has a transcription
provider configured. Audio is purged 30 days after its transcript exists.

## Giving another app access

**User Settings → API credentials** is where you hand something access to your
data over HTTP, with no sign-in: an outside app, a script on your own machine,
or an AI client that takes a static credential.

Name it, tick what it is allowed to do, and submit. You get two things back:

- A **key ID**, which is public. It stays in the list so you can always tell
  which credential is which.
- A **secret**, which is shown once and cannot be read back. Copy it then. If
  you lose it, revoke that credential and create another.

The app sends both, as HTTP Basic auth. With curl that is
\`-u "keyID:secret"\`; a client that only understands bearer tokens can send
\`Bearer keyID:secret\` instead.

Tick only what the thing actually needs. The permissions are: read and write
your items (the HTTP API), act as an AI assistant (MCP), run scheduled jobs, and
a ping-only permission for checking that a credential works. Nothing is ticked
for you, and a credential can never grant itself more than you gave it.

The same page lists every credential you have created, with its permissions,
when you made it, and when it was last used, so you can tell a live one from a
forgotten one. **Revoke** stops that one credential on its very next request and
leaves everything else alone: your other credentials, your MCP connection, and
your phone connector all keep working.

\`/build/api\` is the reference page: what each permission reaches, the exact
headers, and worked examples.

# Working with an AI

Ledgr speaks MCP, so Claude — or any MCP client — can read and change your data
with your permission. Set it up at \`/build/claude\`.

- **Claude Code and similar:** generate a token there and run the \`claude mcp add\`
  command it gives you.
- **claude.ai, desktop and phone:** add a custom connector using the endpoint URL
  and sign in. That covers all three at once.

Either way, connecting ends on an approval page naming the app that is asking:
press **Authorize** to grant it access (or **Cancel** to refuse) and you are
sent back to the app. If the browser then shows a "can't connect to localhost"
page, the handoff already happened — check the client, which is usually
connected; that dead-end tab is the client closing its one-time listener.

## What an assistant can do

- **Find and read** — search your items, list them by type, status, date window
  or what they relate to, and read one in full.
- **Create and change** — file tasks and notes, update fields, convert an item to
  another type, and make one exact edit to a note you are writing.
- **Set your own stages** — if a type has named stages, an assistant can put an
  item on any of them by name ("mark that goal Active", "move the project to
  Waiting for Others"), at creation or later. You should not have to open the app
  to fix the stage afterwards. It can also filter and list by a custom stage.
- **Work with tasks** — break one into subtasks, set a repeat rule in plain
  words, tick a single date of a repeating task.
- **Add a meeting off your calendar** — see your upcoming Outlook events that
  are not in Ledgr yet and add one, exactly as the **Add** button on the
  Calendar lens does. The added meeting keeps its attendees, join link and
  calendar id, so calendar sync recognizes it later instead of making a second
  copy. Use this rather than "create an event" whenever the meeting is really on
  your calendar: "put next Monday's staff meeting in Ledgr and hang this agenda
  item on it."
- **Handle files** — attach by URL or upload, then embed in the body.
- **Link things** — relate and unrelate items, and confirm suggested links.
- **Build the workspace** — create and edit types, views and dashboards, add
  widgets, arrange a record's sections, set the tab strip on a type's list page,
  and rearrange your nav. It reads \`describe_workspace\` first and should confirm
  with you before committing. Asking for "a tab on Projects for my personal ones"
  is a single request now: it builds the view and puts it on the strip, instead
  of building the view and leaving you the Build click. It can also hide a type
  from everyday surfaces, set which dashboard opens as Home or Today, and choose
  where each capture path lands — the Inbox, filed straight away, or a project —
  the same controls as Build → Types, /dashboards, and /build/capture.

## Two features that are off until you turn them on

Both are in **User Settings**.

- **AI Memory** lets an assistant keep durable facts about you in Ledgr, linked
  into your relation graph, instead of forgetting between sessions. It adds
  \`/build/memory\`, where you can see exactly what is stored. Only the ones you
  mark **pinned** load into every session; everything else is searched out when a
  task mentions the person, project, or system it covers. Pin standing rules
  ("always hand me PowerShell, never bash"), not facts about people. Each stump
  shows its age, so a claim that was true a year ago reads as one. When the
  world changes, the assistant files a new memory that **supersedes** the old
  one: the old stump stays, marked superseded with a link to its replacement,
  so nothing is ever silently rewritten or lost.
- **Live editing context** lets an assistant see which note you have open and
  what you have highlighted, so "rework this sentence" works. Nothing is tracked
  while it is off.

## Guides an assistant can read

Three, all plain Markdown over MCP:

- **\`ledgr://guide/using-ledgr\`** — this document.
- **\`ledgr://guide/workspace-shaping\`** — how to build types, views, dashboards
  and navigation correctly.
- **\`ledgr://guide/memory-protocol\`** — how to recall and when to remember. Only
  served when AI Memory is on.

# Settings

**User Settings** is on the Work "More" menu and in the Build sidebar.

| Area | What you can change |
|---|---|
| You | Display name, timezone |
| Appearance | Theme (Dark, Light, Gray, Sepia), accent colour, interface density (desktop and mobile separately), text size, section style |
| Navigation | Position (top, bottom, left, right), spacing |
| Editor | Which toolbar buttons show; collapsible headings; toggle blocks |
| Capture | Which actions appear on the task capture card |
| Data | Trash retention, in days |
| Search | Your own synonym dictionary |
| Feeds | The task calendar (ICS) feed; the web clipper |
| AI | AI Memory; live editing context |

Some settings live where you use them: nav slots and what the Search icon opens
at \`/build/navigation\`, Home and Today at \`/dashboards\`, type visibility at
\`/build/types\`, and per-type tabs, statuses and sections on a type's edit page.

# Safety nets

- **Nothing is deleted immediately.** Deletes go to Trash for 30 days by default,
  and a parent restores with its children.
- **Bodies are versioned** as you write, and can be restored.
- **Undo** appears after destructive actions and survives a refresh.
- **The database is backed up** weekly, with daily snapshots.
- **On an instance running on your own machine,** the whole database can also be
  snapshotted every hour and kept on a thinning schedule, so recent mistakes have
  a recent restore point (see Snapshots under "Backups").
- **\`/health\`** reports whether everything is running.

# Staying up to date

**Updates** (\`/build/updates\`) answers whether this instance is running the
latest Ledgr, and whether its database has caught up with the version it is
running. Those are two separate things, and the page reports them separately.

- **Ledgr version.** Ledgr is one shared codebase running as a separate instance
  per person. If yours is set up as its own copy, new versions wait until you
  take them, and the page lists what changed and offers **Update now**. Pressing
  it pulls the latest version and rebuilds, which takes a minute or two. If your
  instance instead runs directly from the shared codebase, it already receives
  every change automatically and the page tells you so. On an instance running
  on your own machine, **Update now** hands the update to the background service
  that runs it, which rebuilds and restarts in place; if anything about the
  update fails, the version you were on keeps serving. Checking for updates and
  reading the version history need no GitHub token: those only read a public
  repository. A token is only needed to write, for the shared collab notes and
  a satellite's fork merge.
- **Database.** Some updates change the database structure. When the code has
  moved ahead of the database, the page names the changes still to apply. That
  gap is the usual reason pages start failing right after an update.

Whether the Update button appears at all is a setting on the instance, because
an update that changes the database needs the database migrated as part of
applying it. When it is not available, the page says why.

**Update policy** (only on a machine you run yourself) decides how that instance
looks for new versions, without editing any file or signing in to Windows:

- **Check on its own, or only when you press Update now.** Left on its own, it
  checks every so many minutes and applies what it finds; switched off, nothing
  happens until you press the button yourself.
- **How often**, in minutes, when it checks on its own.
- **The branch to follow** — \`main\` for every change as it lands, or a release
  branch for one that moves only when someone deliberately ships it.
- **The repository**, if this instance should follow a different fork. Leave it
  blank to keep the one it already follows.

A saved change takes effect within a minute, with no restart. The same form is
also on the tray icon's Settings tab (see "The dot near the clock" below), so you
can change it from the desktop without opening a browser. Even when an instance
follows the shared repository rather than its own fork, it still checks for its
own pending commits and lists them here — it is not only "receives every push
automatically" the way a satellite reads.

The **Changelog** (\`/changelog\`) has the full history behind each version.

**Start with the computer.** On an instance that runs on your own machine,
Updates also carries the switch every desktop app has: whether Ledgr comes back
on its own after a reboot. Without it, a restart leaves it down until someone
starts it by hand, and anything pointed at it — your phone, Claude, your other
devices — stays down with it. Two choices, and the difference is real: *when I
sign in* needs no administrator prompt but waits for you to log in, which suits
a laptop; *at boot, always on* is what a machine other devices rely on needs,
and Windows asks your permission in the ordinary consent dialog — click Yes and it
registers, with no terminal involved. You are never asked for your Windows
password, and none is stored: Ledgr registers the task the passwordless way, so
it runs with nobody signed in on its own. Two things it tells you rather than let
you assume. Dismiss the consent prompt and it says so, so you can tick the box
again. And if the task registered but Windows will only run it while you are
signed in, it says that too — a reboot nobody logs into is the exact case *always
on* exists for, so it should not happen, and if it does the page tells you what to
try. If a change cannot be applied at all, the page still shows the
exact command to run instead. It will not quietly let you believe a reboot is
covered when it is not. The service re-checks this registration with Windows on
every start, so an old warning here does not outlive the restart that fixed it.

**This machine's Ledgr service** (only on a machine you run yourself). The
service is what holds the database, serves the app and triggers the scheduled
work covered under "Scheduled Jobs" below. It starts with the computer, so most
of the time there is nothing to do here. Two things it will tell you. If an
update has arrived that the running service predates — an update can change the
service itself, and a running one keeps the version it started with — it says
so, because until it restarts, part of what you installed is not in effect. And
after a restart it says whether that came back healthy.

**Restart it** is a button, not a command to type. It asks first, tells you what
it costs (Ledgr on that machine is unreachable for about half a minute, from your
phone and from Claude too), and then waits until a *different* copy of the
service is answering before it says it worked — so "restarted" means the machine
came back, not that the request was filed. Nothing is lost: the database is shut
down cleanly and started again, and scheduled work waits rather than being
skipped. If it has not come back in two minutes the page says so instead of
spinning, and names the one terminal command that reports where it is stuck.

**Coming back from a bad shutdown.** A power cut, a crash, or a restart that did
not let things close properly used to be able to leave the service unable to
start at all — not broken, just blocked by leftover files naming processes that
no longer exist. It now clears those on its own at startup and comes back
unattended, usually in a few seconds. It is careful about it: it checks what a
process actually *is* rather than trusting a number, so it will never start a
second copy on top of a database that is genuinely running.

**The dot near the clock** (Windows, on a machine you run yourself). The service
has no window, which leaves an awkward gap: the one place that could tell you
whether Ledgr is running is Ledgr, and that is exactly what is missing when the
answer is no. So there is a small icon in the notification area, at the
right-hand end of the taskbar. Green means Ledgr is running, amber means it is
starting up or the app is down while its database is fine, red means nothing is
running. Right-click it to open Ledgr, check what is answering, or start,
restart and stop the service without a terminal. Stopping the *icon* and
stopping *Ledgr* are deliberately worded as different things, because they are.
Turn the icon on with \`npm run local:tray\`, off with the same command and
\`-- --uninstall\`; either way the service itself is untouched.

**Ledgr status…**, on the same right-click menu, opens a small window with two
tabs. **Status** shows whether it is running, its version and when it last
updated, its update policy, disk use per data folder, its scheduled jobs, and its
place in the sync network, plus buttons to open Ledgr, its data folder, or its
logs. **Settings** is the same update-policy form described above. Both read and
write the machine directly, with nothing to sign in to.

# Scheduled Jobs

\`/build/jobs\` covers what runs on a schedule, on which machine, and how often.

**Scheduled jobs on this machine.** An instance in the cloud gets its nightly
work from the platform it runs on. One on your own machine has no such timer, so
it runs its own — and this page lists them: what each job is, how often it runs,
when it last succeeded, when it runs next, and the reason if the last attempt
failed. Two are on by default, because every copy of Ledgr needs to do them for
itself: emptying expired Trash (which is also what keeps the sync log from
growing forever) and refreshing the connection suggestions behind Discover and
Loose Ends. The rest — the OneDrive export, calendar sync, email-in, Todoist —
are off unless you turn them on, because each writes somewhere shared and only
one device should be doing it. A job marked as one only this device should run is
labelled as such in the list. A failure is also recorded in this instance's error
log, so it counts on the health report rather than passing quietly.

**Scheduled work.** Some jobs write somewhere shared: one OneDrive folder, one
mailbox, one Todoist account. Exactly one of your machines may do each of them,
so this is where you say which one. Every device shows the same answer, because
two machines doing the same job is the mistake worth catching.

Each job has a **Runs on** dropdown listing every copy of Ledgr you have, so you
can send a job to a machine you are not sitting at. Naming a machine is all it
takes: there is nothing to switch on over there, and nothing to restart. The
default is **leave it to the cloud**, which is what every job does until you say
otherwise, and you can also pause a job everywhere. If the machine holding a job
stops doing it, the page says so rather than looking fine.

**It moves at your sync schedule, not instantly.** The copy you are looking at
stops doing the job the moment you confirm, and the machine you chose picks it up
the next time it checks in with your other copies. For these jobs that gap is
harmless, because each one catches up on its next run. If you want it closed now,
**Check in now** on that machine's Network page does it immediately.

**Offline backup, Calendar sync and Email capture can be moved today.** Each one
picks up cleanly wherever it left off, whichever machine takes it. A job that
cannot be moved yet says so in its own row, with the reason, instead of offering a
dropdown that would quietly lose track of something. Moving a job to a machine
asks you to confirm, and tells you the trade first: the job only runs while that
machine is switched on, so a calendar event or a forwarded message shows up late
if it sleeps. Nothing is lost either way. If you point a job at a copy nothing has
heard from in days, the confirmation says so, because that is how a job ends up
running nowhere at all.

**Your copies of Ledgr** is the list behind that dropdown. Every copy adds itself
and checks in once a day, so this is the one place that knows about all of them at
once: which is which, which has gone quiet, and which is running a different
version. You name a machine when you set it up, and you can rename any of them
later from any device (on Network, under "Your copies of Ledgr"). Two copies
sharing a name is called out, because then the dropdown cannot tell you which
machine a job is on.

Moving the **offline backup** is the one worth doing if you run Ledgr on your own
machine: in the cloud it has to finish inside a one-minute limit, so it copies
about 30 items a night, and on your own machine there is no limit and it clears
the whole queue at once.

**Video transcripts** are also covered on this page — see "Video transcripts"
under "Capturing things" above for what they do and how to switch them on.

# Backups

\`/build/backups\` covers restore points on this machine, and where the weekly
backup and export run.

**Snapshots.** On your own machine: a complete copy of the database, taken every
hour, so a mistake bigger than one item can be answered by looking at how things
were an hour ago instead of waiting for the weekly backup.

They are **off until you switch them on**, since they cost disk space, and the
switch is a checkbox on this page: *Keep hourly restore points on this machine*.
Ticking it takes effect at the next hourly snapshot, and unticking it stops
taking new ones without deleting the ones you already have. Underneath it you
set one number, *how many restore points to keep*, and Ledgr works out the
spread: many recent ones, fewer old ones, thinning out over weeks. The page says
the spread in plain words, estimates the disk it will use, shows what is
actually on disk, and lists every restore point with its time.

**Snapshot now** takes one immediately, which is what you want before anything
you might need to undo: a large import, a bulk edit, a change you are unsure
about. It takes a few seconds to a minute and tells you the size of what it
saved.

Opening one never replaces your live database, on purpose: on a machine that
syncs, rewinding in place would send weeks-old versions to your other devices as
if you had just typed them. Instead, a terminal command
(\`npm run local:snapshot -- browse <time>\`) opens the chosen snapshot as a
separate read-only copy, so you (or Claude) can look through it and copy out what
you need. The page names the command.

**The weekly database backup and the OneDrive export** run as scheduled jobs like
any other. Which machine does them is chosen on \`/build/jobs\` under "Scheduled
work," not here.

# The sync network

**Network** (\`/build/network\`) is every copy of your data on one page: where
this device sends its changes, and which devices sync from it.

**It opens with the answer.** One sentence at the top says whether everything is
in step, and when it is not, it says what is wrong in plain words and gives you
the one thing that fixes it. Everything below that sentence is the evidence for
it, so on a normal day you can read the first line and leave. Each section has a
"what is this?" fold if you want the concepts, and each row's settings fold away
until you open them.

**Both directions are on the page, on every copy.** Syncing has two halves and
they are not the same question: *where your changes go* from here, and *which
devices send their changes here*. A main copy usually sends its changes nowhere
— everything pushes into it instead — so on that one the opening sentence tells
you how many devices send here rather than pretending it is on its own. On a copy
in the middle you get both in one line.

- **Where your changes go.** Every other copy this one sends to, with its
  state, when it last synced, how far behind it is, and its place in the
  priority order (the list order is the priority). **Add a copy** asks for that
  copy's web address and a one-time code you get there — the mirror image of
  adding a device below. **Remove** stops syncing to it; the data on both sides
  stays where it is. Changes take effect within seconds, no restart. One thing
  that is deliberately not a button: pointing this machine at a different main
  copy needs its data re-filled from that copy first
  (\`npm run local:restore -- --from-url\`), because changing the address alone
  would merge two diverged databases.
- **Each copy has three settings, and they are independent.** **How often** is
  the schedule, and it is the ordinary ladder: continuously (every few
  seconds — right for another machine of yours), every minute, every 5, every
  15, hourly, once a day, or once a week. A longer gap suits a copy you keep as
  an archive, and means it can be that far behind. Once a week is the longest
  gap offered, and a longer one is refused with the reason: a copy that misses
  two checks in a row falls outside the history the other side keeps for it, and
  then it needs everything sent again instead of catching up. **Fall back to
  it** is trust: *automatically* means this machine reads from that copy without
  asking; *ask me first* means it only sends changes there, and if every
  automatic copy goes down it will ask before it starts reading from this one.
  The arrows on each row change the priority order. At least one copy always has
  to be automatic, or this machine would sit waiting for you instead of syncing.
- **Only on changes** skips a check that has nothing to send. **How often**
  still sets the pace, as the fastest that copy is contacted; this decides
  whether a due check is worth making at all. So "hourly, only on changes"
  means at most once an hour while you are working, and nothing whatsoever on a
  day you never touched Ledgr. Turn it on for a copy hosted in the cloud, where
  a check-in with nothing to say costs exactly what a useful one costs, because
  it wakes that copy's database either way, and a woken database stays awake
  and billable for several minutes afterwards. Two things to know. Changes made on
  another copy cannot arrive while this one stays quiet, since this machine has
  no way to know they exist until it asks, so leave this off for a second
  machine of yours and use it for an archive that writes nothing. And no matter
  how long the quiet lasts, this machine still checks in about once a week,
  because a copy silent longer than that loses its place in the history the
  other side keeps for it and would need everything sent again.
- **Check in now** exchanges with every copy immediately, whatever the schedule
  says. A schedule works in both directions: between check-ins your changes are
  waiting here, and changes made on another copy have not arrived yet. This is
  the button for when you do not want to wait for either — after moving a
  scheduled job to this machine, for instance.
- **Your changes always go to every copy.** Sending a copy somewhere can never
  harm you, and a backup that stops receiving is not a backup, so every one
  gets your changes on its own schedule whatever its trust setting. Reading is
  the half that gets gated, because reading from a stale copy quietly makes
  everything look fresher than it is.
- **When the usual copies go down**, and they have all been failing for about
  fifteen minutes, a **Needs your decision** block appears at the top of this
  page (and the navigation dot turns amber). It shows what each usual copy
  actually said, when the backup last exchanged, and how many of your changes
  the backup has not received yet — then offers to start reading from it. If the
  backup is on anything slower than continuous you can also ask for it to be
  checked continuously while you are leaning on it. Either way it undoes itself:
  as soon as one of the usual copies is fully caught up again, the approval and
  any speed-up clear on their own. **Stop reading from it now** ends it early.
- **This device.** The connection state: whether this machine sends its own
  changes or only receives, whether changes are waiting to go out, when the
  last exchange happened, and the last problem. When a large first send is
  being held (the guard against a bad restore), a **Send anyway** button
  releases it one-shot after you confirm the pending changes are real. A
  syncing machine also carries a small dot in the navigation with the same
  state at a glance — green when synced, amber while changes are waiting or
  while on a backup, red when nothing is answering; clicking it opens this
  page. A device that has been away so long that the other copy no longer
  holds the history it missed is refused rather than left silently incomplete:
  this section says "too far behind, re-fill required", its own recent changes
  still get through, and the remedy is re-filling from that copy
  (\`npm run local:restore -- --from-url\`, documented in the supervisor
  README).
- **Other devices reach this instance at.** On an instance running on your own
  machine, this lists the addresses to hand to another device, best first, each
  with a **Copy** button — so adding a spoke is copy from one screen, paste into
  another, with nothing to work out. If the instance has a published address
  (the public hostname it is configured to answer on), that one is listed first
  and is the one to use: it works from anywhere, including callers that cannot
  join your tailnet. Otherwise the tailnet name is the one to use: it works from
  any device signed into your tailnet, from anywhere, and it keeps working if the
  addresses change. A local-network address is offered too and
  labelled for what it is: only good on that network. Nothing is exposed to the
  internet by any of this — a phone or laptop that can join your tailnet needs
  no more than this. Publishing the instance publicly is a separate step, and
  the only thing that really needs it is the Claude connector, because that
  request comes from Anthropic's servers rather than from a device of yours.
- **How long a device's history is kept.** For another device to reconnect and
  simply carry on, this instance has to keep the changes it missed. That costs
  storage that cannot be cleaned up while it waits, so each device has a
  window — 14 days by default, changeable per device. Inside the window it
  reconnects and catches up. Past it, the device can still come back, but it
  needs a full re-fill from this instance rather than just reconnecting. You
  will be told **before** that happens: once a device has been away for most
  of its window, a note appears here naming it, saying what will happen, and
  offering the two answers — **keep its history** (for a machine you know is
  coming back; it holds indefinitely and the storage keeps accruing) or **let
  it go** (frees the storage now). A device that syncs regularly never
  triggers any of this.
- **Devices that sync from this instance.** **Add device** names a new one
  and shows its access token exactly once; copy it into that device's setup,
  because it cannot be shown again. A new device can be added **pull-only**,
  meaning it can only receive changes and never push its own — the safe
  default when proving out a fresh device — and can be flipped between
  pull-only and full at any time from here, even if the device itself is
  unreachable. **Revoke** shuts a device out remotely, **Restore** lets it
  back in, and a revoked device can then be deleted.

# Not here yet

Listed so you do not go looking.

- **Notifications and push are paused.** The notification centre, the bell, and
  the morning and meeting-prep pushes are all switched off. Reminders come from
  the task calendar (ICS) feed instead, fired by your own calendar app.
- **Import & Migration** (\`/build/import\`) is a placeholder. The page describes
  the plan; there are no actions on it. (Data Hygiene has its first real tool —
  the orphaned-files sweep; the rest of that page is still the plan.)
- **Light mode** is not shipped. The mechanism exists; the theme does not.
- **Todoist sync is off** and is not the normal setup. Ledgr is its own task
  manager. Todoist remains an option your instance can be configured to use.
- **Footnotes, superscripts and citations** are not in the shared editor.
  Footnotes work only inside the Papers module. The Draft tab is now the normal
  writing canvas (slash menu, mentions, attachments, rich/source/preview), and
  it is the one surface that keeps \`[^id]\` markers and their \`[^id]:\` definitions
  intact through a save, because the .docx export reads them. Typed anywhere
  else, that syntax is just literal text.
- **Nested toggles** are a known limitation.
`;
