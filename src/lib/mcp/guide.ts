// The workspace-shaping orientation guide, served as an MCP *resource* (ADR-102).
// It is the stable, human-written picture of how a Ledgr workspace is structured
// and how to shape it correctly — the same orientation a person gets from the
// Build sidebar, written down once so the model gets it too. This is the
// counterpart to the per-owner, per-call `describe_workspace` tool: the guide is
// the unchanging "how it works," describe_workspace is the live "what you have."
//
// Pure (no DB, no Next, no env): a constant doc + its resource descriptor + a
// reader. server.ts wires it into resources/list and resources/read, the same
// split protocol.ts/server.ts/tools.ts keep elsewhere. Keep it client-agnostic
// (any MCP-speaking AI may read it) and free of church-specific jargon, like the
// rest of the tool surface.

// The third guide — "Using Ledgr" (ADR-189) — lives in its own file because its
// body is long and it is owner-facing rather than model-facing. It is wired in
// here (readGuideResource) and in server.ts (resources/list) like the other two.
import { USER_GUIDE_URI, USING_LEDGR_GUIDE } from "./user-guide";

// A stable, opaque URI for the one guide resource. `ledgr://` keeps it clearly
// ours; the path names the topic so a future second guide is an additive sibling.
export const GUIDE_URI = "ledgr://guide/workspace-shaping";

// The resource descriptor returned by resources/list (and echoed in
// resources/read). Shape matches the MCP spec's Resource: uri + name (+ optional
// title/description/mimeType). The description doubles as the model-facing hint
// for *when* to read it.
export const GUIDE_RESOURCE = {
  uri: GUIDE_URI,
  name: "workspace-shaping-guide",
  title: "Shaping the Ledgr workspace",
  description:
    "How a Ledgr workspace is structured — types & properties, views, " +
    "dashboards & widgets, and the navigation — and how to shape it correctly " +
    "over MCP. Read this before using describe_workspace and the create_type/" +
    "update_type, create_view/update_view, create_dashboard/add_widget, and " +
    "update_nav tools.",
  mimeType: "text/markdown",
} as const;

// The AI Memory protocol (ADR-137), a second resource served only when the owner
// has AI Memory on (server.ts gates resources/list + resources/read on
// settings.aiMemoryEnabled). It is the "how to recall and when to remember"
// counterpart to the get_memory_stumps/remember tools — the rising-bar recall
// rule and the write conventions, written once so any connected AI follows them.
export const MEMORY_PROTOCOL_URI = "ledgr://guide/memory-protocol";

export const MEMORY_PROTOCOL_RESOURCE = {
  uri: MEMORY_PROTOCOL_URI,
  name: "memory-protocol",
  title: "Working with the owner's memory",
  description:
    "How to use the owner's AI memory: call get_memory_stumps at the start of a " +
    "session, recall by following a memory's links with a bar that rises each " +
    "hop, and use `remember` to file durable facts well. Read this whenever AI " +
    "Memory is enabled.",
  mimeType: "text/markdown",
} as const;

// The guide body. Written as the orientation a builder would give a teammate:
// the mental model first, the read-before-write rule, then one section per
// shapeable surface naming the exact tool + the drill-down read for detail.
export const WORKSPACE_GUIDE = `# Shaping a Ledgr workspace

This guide is for an AI assistant helping the owner *shape* their Ledgr: creating
and editing types, views, dashboards, and navigation so they don't have to learn
the Build screens themselves. The owner speaks naturally ("set up my main
toolbar", "make me a place to track sermons") and you make the Ledgr-correct
moves.

## The mental model

Ledgr stores everything the owner cares about as **typed items** (one \`items\`
table): tasks, events, notes, links, people, and any custom type are all rows.
The app has **two surfaces**:

- **Work** — *using* the system day to day. Glanceable, mobile-friendly. Its
  navigation (the bottom bar / side rail) is owner-configurable.
- **Build** — *building and maintaining* the system: the data model (types),
  the interfaces (views, dashboards, navigation), and maintenance tools.

Shaping the workspace means building on the Build side, and wiring it into Work
so the owner can reach it. The separation is the default, not a wall: a Work nav
slot may point at a Build tool if the owner wants it.

## The one rule: read before you write, and confirm

1. **Call \`describe_workspace\` first.** It returns a compact snapshot of the
   current types, views, dashboards, and navigation, plus the catalog of Build
   tools a nav slot can point at. It is your orientation — never shape blind.
2. **Drill down only as needed.** The snapshot is summaries. For a type's full
   property schema call \`list_types\`; for a view's full filter/sort call
   \`list_views\`. Pull detail for the one thing you're about to change, not
   everything.
3. **Confirm before committing.** Config changes (a new type, a nav rearrange)
   have no automatic undo. State the concrete change you're about to make and get
   the owner's go-ahead before calling a create/update tool. Nothing here
   auto-commits — you decide to call a tool, deliberately, on the owner's behalf.
4. **These tools create and update only.** There is no delete tool. Removing a
   type/view/dashboard stays in the Build UI on purpose. (Editing a type to hide
   a property, or rebuilding a view, is fine and reversible by re-editing.)

## Types & properties (\`create_type\`, \`update_type\`)

A type is a kind of item with its own set of **custom properties**. Property
kinds: \`text\`, \`number\`, \`date\`, \`checkbox\`, \`url\`, \`select\` and
\`multi_select\` (each needs an \`options\` list), and \`relation\` (a typed link
to other items — carries a \`targetType\` and \`cardinality\` of \`single\` or
\`many\`).

- The five **system types** — task, event, note, link, person — can be *edited*
  (e.g. add a property) but never deleted.
- A type's \`key\` is a lowercase slug, immutable once created (it is the stable
  identifier behind every item and relation). The \`label\` is the display name
  and can change freely.
- \`update_type\` **patches**: a field you leave out keeps its stored value, so
  renaming a label can't wipe the icon or the capability. The one field that
  still replaces wholesale *when you send it* is \`propertySchema\`, because it
  is a list: to add one property, read the current schema (\`list_types\`), then
  resend the **full** list with your addition appended. Pass \`icon: ""\` when
  you actually mean to clear the icon.
- **The owner's presentation choices are theirs.** A type's \`icon\` and each
  status term's \`color\` are picked by hand and noticed immediately when they
  change. \`list_types\` returns both, and the writes preserve them on omission,
  so neither can be lost to a round-trip. If you deliberately restyle one, say so.
- Prefer one well-shaped bespoke type over many tiny ones. "Make me a place to
  track sermons" = a \`sermon\` type with the few properties that matter
  (e.g. a \`series\` select, a \`date\`, a \`passage\` relation), not a pile of
  loose tags.

## Statuses, a.k.a. stages (\`set_type_statuses\`, and \`status\` on an item)

A status is **per type**, not global. \`open\`/\`done\`/\`archived\` is only the
default set a type inherits; a type can define its own named stages instead (a
project's Ongoing / Waiting for Others / Paused / Future / Done). Each stage maps
to one of four fixed **categories** (\`not_started\`, \`in_progress\`, \`done\`,
\`archived\`), which is what progress roll-ups and completion actually key off.

- \`list_types\` reports each type's \`statusMode\` and, in \`select\` mode, its
  stages in order with their keys, labels and categories. Those keys are exactly
  what \`create_item\`/\`update_item\` accept.
- **You can set a custom stage directly.** \`status\` is not limited to
  open/done/archived: pass the stage's key or its label
  (\`status: "active"\` or \`status: "Active"\`, either works, any case). Passing a
  name the type does not have is refused, and the error lists the type's real
  stages, so read \`list_types\` or just retry from that list.
- **Set it at creation when the stage matters.** With no \`status\`, a new item
  takes the type's default starting stage, which for named stages is often the
  waiting-est one (a new \`goal\` starts at Someday). If the owner said the goal
  is active, pass \`status\` rather than creating it and expecting them to fix it
  in the UI.
- \`set_type_statuses\` changes what the stages *are* (renaming, adding,
  re-ordering, or switching the type to a plain checkbox). That reshapes the
  type for every item of it, so confirm with the owner first.

## Views (\`create_view\`, \`update_view\`)

A view is a saved, filtered, sorted list the owner reaches by name ("This week's
tasks", a workflow board). Each has a **layout**: \`list\`, \`table\`, \`board\`
(kanban, grouped), \`calendar\`, or \`agenda\`. The **filter** can scope by type,
status, a due/scheduled/meeting date window, a related item, or a custom
\`select\`/\`multi_select\` property.

- \`create_view\` needs a \`name\` and \`layout\`; the filter/sort/grouping are
  optional and default sensibly.
- \`update_view\` is a full replace (read it via \`list_views\` first); **system
  views can't be edited.**
- Use \`run_view\` to see what a view currently returns before or after editing.

## List tabs (\`set_list_tabs\`)

A saved view is reached by name; a **list tab** puts one on a type's own list
page (\`/list/<key>\`), in the strip across the top. That is the difference
between a view the owner has to go find and a view that is simply *there* when
they open Projects, so when someone asks for "a tab", this is the tool, not
\`create_view\` alone. Create the view first, then add it as a tab.

- Every type gets four virtual defaults free (Recent, Newest, A to Z, Most
  linked). Projects also lead with **Board** (the status kanban) and close with
  **Completed**; events lead with Calendar and Agenda.
- Writing a strip **replaces** the whole thing, defaults included, so call
  \`set_list_tabs\` with only \`typeKey\` first to read the current strip, then
  resend it with your addition in place. \`reset: true\` restores the defaults.
- Tab kinds: \`view\` (a saved view, by \`viewId\`), \`sort\` (the plain list in an
  order), \`board\` and \`completed\` (a type's own kanban and its finished
  archive), plus \`calendar\` and \`timeline\` on events. A view tab's label
  defaults to the view's name.

## Dashboards & widgets (\`create_dashboard\`, \`add_widget\`)

A dashboard is a named grid of **widgets**. Widget kinds:

- \`view\` — a live list/board/etc. from a saved view (needs a real \`viewId\`).
  Settings: \`titleOverride\`, \`itemLimit\`, \`sortOverride\`, \`renderStyle\`
  (\`compact\` | \`faithful\`).
- \`stat\` — a single count from a view's filter (needs a real \`viewId\`).
  Settings: \`label\`.
- \`action\` — a button. Settings: \`action\`
  (\`quick-capture\` | \`new-from-template\` | \`link\`), \`label\`, \`icon\`,
  \`targetType\`, \`templateId\`, \`href\`.
- \`text\` — a heading/note for grouping the grid. Settings: \`heading\`,
  \`body\`.
- \`tree\` — a two-level parent → children outline over a view (needs a real
  \`viewId\`). Settings: \`titleOverride\`, \`parentLimit\`, \`childLimit\`,
  \`childSource\` (\`children\` | \`relation\`), \`relationRole\`,
  \`childType\`, \`hideCompletedChildren\`.
- \`embed\` — another item rendered inline (needs a real \`itemId\`). Settings:
  \`showBody\`.
- \`container\` — widgets grouped inside one tile. Settings: \`mode\`
  (\`tabs\` | \`stack\` | \`section\`), \`title\`, \`children\` (an array of
  widgets, **one level deep** — a nested container is dropped).
- \`image\` — a picture tile. Settings: \`url\`, \`alt\`, \`fit\`
  (\`cover\` | \`contain\`), \`link\`.

Because view/stat/tree widgets reference a saved view, **create the view first**,
then add the widget pointing at its id. Widgets auto-place on the grid when you
don't specify a layout. Create the dashboard (optionally with widgets inline),
then \`add_widget\` to append more.

Worked example — a "Home" activity board:

1. \`create_view\` "Tasks Today" (layout \`list\`, filter
   \`{ type: "task", statusCategory: "active", due: "today" }\`).
2. \`create_view\` "Events This Week" (layout \`agenda\`, filter
   \`{ type: "event", dateField: "meetingAt", due: "week" }\`).
3. \`create_dashboard\` \`{ name: "Home" }\`.
4. \`add_widget\` \`{ kind: "view", viewId: <Tasks Today> }\` — the list to work.
5. \`add_widget\` \`{ kind: "stat", viewId: <Tasks Today>, settings: { label: "Due today" } }\`.
6. \`add_widget\` \`{ kind: "view", viewId: <Events This Week> }\`.
7. \`add_widget\` \`{ kind: "action", settings: { action: "quick-capture", label: "Capture", targetType: "task" } }\`.

## Navigation (\`update_nav\`)

The Work nav has three zones: a locked **Home** (always first), the configurable
**middle slots**, then locked **New** and **More** (added automatically). You
shape the middle slots. A slot is either:

- a **destination** — one route: a built-in page, a saved view
  (\`/views/<id>\`), a type's list (\`/list/<key>\`), a dashboard, or a Build
  tool; or
- a **tools group** — a labelled button opening a small popover of destinations.

\`describe_workspace\` reports the current slots, the nav layout (position
top/bottom/left/right, rail size, density, anchor), and the Build-tool catalog.
\`update_nav\` sets the slots and/or those layout knobs. Keep slot counts modest
(≈4–5) — the bottom bar and floating pill are tight.

Worked example — "set up my main toolbar": call \`describe_workspace\`, see the
current slots and that the nav can be a side rail or a bottom/floating bar, ask
the owner which surface they mean and what they want one-tap access to, propose a
short slot list, then \`update_nav\`.

## Language

Use plain, conventional product language for anything that will render on screen
(labels, view names, slot labels) — write as if for a general audience, not
insider shorthand. The owner is one person, but the workspace should read like a
clean, portable product.
`;

// The AI Memory protocol doc (ADR-137). Model-facing, same voice as the guide:
// the shape, how to recall (the rising-bar graph walk), and when/how to write.
export const MEMORY_PROTOCOL_GUIDE = `# Working with the owner's memory

The owner keeps durable memories in Ledgr so you, and any AI they connect, act
like you know them. This is that contract: what loads on every run, how to reach
the rest, and when to write something new.

## Two axes, often confused

- **\`horizon\` is a truth property.** Does this claim stay true as time passes?
  \`evergreen\` = true indefinitely. \`seasonal\` = true for a season, expected to
  stop being true. \`episodic\` = true of a single moment. **Horizon never decides
  what loads.** Reserve \`evergreen\` for identity, convictions, standing
  preferences, and how-to-work-with-the-owner rules. Anything that carries a
  hostname, URL, port, version number, roster, price, or the current state of an
  install or project is \`seasonal\`, even when it feels permanent: an evergreen
  memory is never flagged STALE, so a misfiled one hides its own decay forever.
- **\`pinned\` is a load property.** Must you have this in front of you on every
  single run? That is the only question pinning answers.

They are independent. A fact can be permanently true and almost never needed
(evergreen, unpinned). A fact can be temporary and needed constantly (seasonal,
pinned).

## Tier 1: pinned, always loaded

\`get_memory_stumps\` returns the pinned set by default, a handful of items.
This is the CLAUDE.md equivalent: standing behavioral rules with **no
entity to search on**, so search can never reach them. Three of the current ones:

- On Windows, hand the owner PowerShell commands, never cmd.exe or bash syntax.
- The owner's tool map: which system holds documents, which holds calendar and
  email, which holds tasks and notes.
- The owner's writing style guide.

What they share: you need them cold, on every run, and no search term would
surface them. Keep the pinned set under 15. If a memory would come back from
searching a person, project, or system by name, it belongs in Tier 2.

## Tier 2: everything else, retrieved on demand

Everything unpinned is found by search, anchored on whatever entity the current
task mentions.

**When you meet an unfamiliar person, project, or system, run \`search_items\`
for it by name with \`type: "memory"\` before assuming you know nothing about
it.** Without the type filter, memories get buried under notes, transcripts, and
commentaries.

\`get_memory_stumps\` with \`includeAll: true\` returns the whole store in the same
compact form when you want the full picture.

## Reading a stump

One compact line per memory: a short id, \`[kind/horizon]\` abbreviations, the
date and relative age from \`updatedAt\`, then the title. A \`seasonal\` or
\`episodic\` memory older than 90 days also renders \`STALE\` in that parenthetical.
A memory that a newer one replaced renders \`SUPERSEDED <date> -><new id>\`
instead: read the new one, not this one. Both markers also appear on memory hits
from \`search_items\`, in the \`age\` field.

A stump is a body-free pointer. \`get_item\` its id for the detail and the people,
projects, and notes it links to. Nothing is ever auto-deleted: "this was true
once" is worth keeping.

## Writing a memory

Call \`remember\` when you learn something durable worth carrying into a later
session: a working preference, a fact about a person or a standing relationship,
or a project decision that is not obvious from the items themselves.

- **Title = a self-contained stump.** Readable without opening anything.
- **Body = the detail,** with a why and a how-to-apply when it helps.
- **Set \`kind\` and \`horizon\`.** kind: user (who they are) | feedback (how to work
  with them) | project (ongoing work) | reference (a pointer). horizon by the
  truth test above, not by how often you expect to need it.
- **Link, don't restate.** Pass the item ids the memory is about in \`about\`
  (\`search_items\` to find a person or project id) rather than repeating what
  Ledgr already holds. The links are what make recall reach further.
- **Pin only for Tier 1.** Needed cold, every run, unreachable by search.

## File new, don't rewrite history

**Never edit an old seasonal memory to keep it accurate.** When the situation
changes, file a NEW dated memory and pass the old one's id as \`supersedes\`.
The old memory stays (nothing is deleted), and from then on its stump and its
search hits render \`SUPERSEDED <date> -><new id>\`, so no reader has to compare
ages to find the current claim. Edit in place only to fix something that was
wrong when it was written, not because the world moved on. To link a pair after
the fact: \`relate_items(oldId, newId, role: "supersedes")\`.

Before filing, check for an existing memory covering the same ground: an
evergreen fact that just needs sharpening is an \`update_item\`, not a second
near-identical stump. \`remember\` helps: its response lists \`possibleOverlap\`
(existing memories with a similar title) and, when you passed no \`about\`,
\`aboutSuggestions\` (people and projects named in the title). Act on both. Add
a missing link with \`relate_items\` rather than restating the connection in
prose.

## What is not a memory

A one-time event ("met for coffee on the 3rd") is an ordinary item with the
person linked, not a memory. Memories are the durable distillations; the item
stream is the record. Don't remember what is already a well-linked item, link to
it instead.

## Routing

This Ledgr is the memory store. When the owner asks you to remember something,
\`remember\` it here, never a local notes file or a provider's own memory. One
store, reachable from every client the owner connects.
`;

// resources/read: return the contents for a known guide URI, else null so the
// dispatcher can answer an unknown URI with an error (never throwing it out to
// the transport). The memory protocol is additionally gated by the caller
// (server.ts) on aiMemoryEnabled before this is reached.
export function readGuideResource(
  uri: string
): { uri: string; mimeType: string; text: string } | null {
  if (uri === GUIDE_URI) {
    return { uri: GUIDE_URI, mimeType: "text/markdown", text: WORKSPACE_GUIDE };
  }
  if (uri === MEMORY_PROTOCOL_URI) {
    return { uri: MEMORY_PROTOCOL_URI, mimeType: "text/markdown", text: MEMORY_PROTOCOL_GUIDE };
  }
  if (uri === USER_GUIDE_URI) {
    return { uri: USER_GUIDE_URI, mimeType: "text/markdown", text: USING_LEDGR_GUIDE };
  }
  return null;
}
