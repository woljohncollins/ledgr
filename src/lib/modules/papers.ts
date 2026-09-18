// The Papers module (Tyler's lane, on the M6 boundary; ADR-042 — modules sit on
// core). Pure manifest: it declares the `paper` type as markdown-canonical with
// its own `paper` canvas (the Quote Bank · Outline · Draft workspace), imports no
// React component (the canvas is wired by id in module-wiring.tsx) and nothing
// heavy, so it stays node-pure like the rest of the registry.
//
// No exporter is declared here on purpose: the paper's deliverable is an MSM
// .docx, a *binary* render, and ExporterDef.render returns a string. The docx
// ships through a dedicated route (app/api/items/[id]/render-docx) instead of the
// exporter slot, which keeps the core module contract untouched (a both-builder
// concern). The citation engine + docx renderer are the module's real work and
// live in src/lib/papers/.
import { MARKDOWN_FORMAT } from "@/lib/body";
import type { ModuleManifest, SurfaceDef } from "@/lib/modules";

// The paper's five surfaces (ADR-260), in the canvas's own workflow order:
// Notes (think) → Shape (set up sections) → Quote Bank (gather) → Outline
// (assemble) → Draft (write). Declared once here so MCP, the REST API, and the
// canvas all agree on what each one is for — before this, only the canvas knew
// that `body` was the deliverable and `properties.notes` was scratch, which is
// how an agent asked for "notes" ended up writing into the draft.
const PAPER_SURFACES: SurfaceDef[] = [
  {
    id: "notes",
    label: "Notes",
    storage: { kind: "property", key: "notes" },
    format: "markdown",
    description:
      "Thinking space: the argument being circled, what the assignment actually asks for, anything to come back to. Deliberately NOT part of the draft or the .docx export. This is where free-form notes about the paper belong.",
  },
  {
    id: "shape",
    label: "Shape",
    storage: { kind: "property", key: "sections" },
    format: "json",
    description:
      "The paper's section scaffold: an ordered array of sections the outline and quote bank file against. Structured data, edited through the Shape tab. Each section holds an array of paragraphs, and quotes file under a section or a paragraph by id.",
    readOnly: true,
    elements: {
      "!id": "Stable unique id for the section (a uuid). Quotes reference it by sectionId.",
      "!title": "The section heading. Becomes a `##` header in the draft skeleton.",
      note: "The writer's prose plan for the section (markdown). Optional.",
      "!paragraphs": "Array of { !id, title?, note? }. REQUIRED, and must be present even if empty of content: every renderer maps over it, so a section without it cannot be displayed. A section with no real paragraphs still carries one placeholder entry.",
    },
  },
  {
    id: "quotes",
    label: "Quote Bank",
    storage: { kind: "property", key: "quoteBank" },
    format: "json",
    description:
      "Gathered quotes with their sources and where each is filed, used to generate Midwestern Style Manual citations. Structured data, edited through the Quote Bank tab.",
    readOnly: true,
    elements: {
      "!id": "Stable unique id for the quote (a uuid).",
      "!text": "The quoted text itself. NOT `quote` — that key is ignored.",
      "!source": "An object, NOT a citation string. Either { kind: \"book\", author, authorLast, title, shortTitle, editor?, city, publisher, year } or { kind: \"video\", author, authorLast, title, shortTitle, url, accessed }. The `kind` discriminant is what the citation engine switches on.",
      page: "Page number as a string (books only). Optional.",
      sectionId: "Files the quote under a section, by that section's id. Optional.",
      paragraphId: "Files it under a specific paragraph, by that paragraph's id. Takes precedence over sectionId. Optional; a quote with neither is Unsorted.",
    },
  },
  {
    id: "outline",
    label: "Outline",
    storage: { kind: "derived", from: ["shape", "quotes"] },
    format: "markdown",
    description:
      "A read-only assembly of the sections and their filed quotes, used as the drafting reference. It stores nothing of its own: to change it, edit Shape or the Quote Bank.",
    readOnly: true,
  },
  {
    id: "draft",
    label: "Draft",
    storage: { kind: "body" },
    format: "markdown",
    description:
      "The paper itself, and the surface the Word (.docx) export renders. Carries `[^id]` footnote markers and their `[^id]: …` definitions, which are hand-parsed by the exporter, so leave that syntax intact. This is the finished artifact: do not write scratch notes here.",
    primary: true,
  },
];

export const paperModule: ModuleManifest = {
  id: "papers",
  label: "Papers",
  enabledByDefault: true,
  types: [
    {
      key: "paper",
      label: "Paper",
      icon: "file-text",
      canonicalFormat: MARKDOWN_FORMAT,
      canvasId: "paper",
      surfaces: PAPER_SURFACES,
    },
  ],
  exporters: [],
  // SPIKE (bespoke-tool catalog, next_steps.md:94): the paper workspace offered
  // up for attachment to a user-named type, so the Quote Bank · Outline · Draft
  // canvas isn't locked to the `paper` key.
  capabilities: [
    {
      id: "paper-workspace",
      label: "Paper Workspace",
      description:
        "A writing workspace with a quote bank, outline, and draft, plus a Word (.docx) title-page render.",
      usage:
        "Use it for a seminary paper, but also for an article, a long-form study, or any researched piece that grows from quotes to outline to draft.",
      canvasId: "paper",
      canonicalFormat: MARKDOWN_FORMAT,
      surfaces: PAPER_SURFACES,
    },
  ],
};
