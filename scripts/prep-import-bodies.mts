// nsx-import body prep (ADR-066 migration): produce editor-schema-VALID markdown
// for every note before import, so no note lands in Ledgr that can't be opened
// (the "contentMatchAt on invalid content" crash). Needs the real editor stack,
// which only exists in this repo — so prep runs here and writes a bodies map the
// plain-Node importer consumes.
//
//   sanitize (fix `- -` nested lists, fence heavy raw HTML)  ->  doc.check()
//   still invalid?  -> coerce via markdown-it -> ProseMirror DOMParser (always
//   yields a valid doc) -> getMarkdown  ->  doc.check() again.
//
// Usage: tsx scripts/prep-import-bodies.mts [--notebook NAME] [--out FILE]
// Output JSON: { "<notebook>/<file>.md": { body, changed, coerced } , ... }
// plus a `_invalid` list for anything that survives (should be empty).
import { parseHTML } from "linkedom";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const only: string[] = [];
let out = "C:/dev/nsx-migration/import/validated-bodies.json";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--notebook") only.push(args[++i]);
  else if (args[i] === "--out") out = args[++i];
}

const { document, window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
const g = globalThis as unknown as Record<string, unknown>;
g.document = document; g.window = window;
if (!("DOMParser" in g)) g.DOMParser = window.DOMParser;
if (!("MutationObserver" in g)) g.MutationObserver = window.MutationObserver ?? class { observe() {} disconnect() {} takeRecords() { return []; } };
g.innerHeight = 768; g.innerWidth = 1024;
const fakeSel = { rangeCount: 0, removeAllRanges() {}, addRange() {}, getRangeAt() { return null; }, anchorNode: null, focusNode: null };
(document as unknown as Record<string, unknown>).getSelection = () => fakeSel;
(window as unknown as Record<string, unknown>).getSelection = () => fakeSel;

const { Editor } = await import("@tiptap/core");
const { DOMParser: PMDOMParser } = await import("@tiptap/pm/model");
const { default: StarterKit } = await import("@tiptap/starter-kit");
const { Markdown } = await import("@tiptap/markdown");
const { TaskList, TaskItem } = await import("@tiptap/extension-list");
const { TableRow, TableHeader, TableCell } = await import("@tiptap/extension-table");
const ext = await import("@/components/markdown-editor/extensions");
const toggle = await import("@/components/markdown-editor/toggle-extension");
const { markdownToHtml } = await import("@/lib/markdown-render");

const extensions = [
  StarterKit, Markdown.configure({ indentation: { style: "space", size: 4 } }),
  TaskList, TaskItem.configure({ nested: true }),
  ext.TextColor, ext.Highlight, ext.LedgrImage,
  ext.LedgrTable.configure({ resizable: true }), TableRow, TableHeader, TableCell,
  ext.LedgrPassage, toggle.Toggle, toggle.ToggleSummary, toggle.ToggleContent,
];
let editor = new Editor({ element: document.createElement("div"), injectCSS: false, extensions });
function fresh() { try { editor.destroy(); } catch {} editor = new Editor({ element: document.createElement("div"), injectCSS: false, extensions }); }

function isValid(md: string): boolean {
  try { editor.commands.setContent(md, { contentType: "markdown" } as never); editor.state.doc.check(); editor.commands.setContent("", { contentType: "markdown" } as never); return true; }
  catch { fresh(); return false; }
}
function coerce(md: string): string {
  try {
    // markdown-it -> HTML -> ProseMirror's own DOMParser, which COERCES to a
    // schema-valid doc (Tiptap's setContent(html) yields an empty doc headless).
    const el = document.createElement("div");
    el.innerHTML = markdownToHtml(md);
    const doc = PMDOMParser.fromSchema(editor.schema).parse(el as never);
    editor.commands.setContent(doc.toJSON());
    const o = editor.getMarkdown();
    editor.commands.setContent("", { contentType: "markdown" } as never);
    return o && o.trim() ? o : md;
  } catch { fresh(); return md; }
}
// Drop empty list markers (`-`, `*`, `1.` with no content) — converter noise
// that yields empty listItems whose markdown round-trip through `marked` is
// unstable and re-invalidates the doc.
function dropEmptyBullets(md: string): string {
  return md.split("\n").filter((l) => !/^\s*(?:[-*+]|\d+\.)\s*$/.test(l)).join("\n");
}
function fixNestedLists(md: string): string {
  return md.split("\n").map((line) => {
    const m = /^(\s*)((?:[-*+]\s+){2,})(\S.*)$/.exec(line);
    if (!m) return line;
    const markers = (m[2].match(/[-*+]\s+/g) || []).length;
    return m[1] + "    ".repeat(markers - 1) + "- " + m[3];
  }).join("\n");
}
function fixRawHtml(md: string): string {
  let s = md.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  const blocks = (s.match(/<\/?(table|tr|td|th|tbody|thead|div|body|html|head|center|o:p)\b/gi) || []).length;
  if (blocks >= 5) s = "```html\n" + s.trim() + "\n```\n";
  return s;
}

// Heavy notes make the headless editor round-trip spin for minutes and stall the
// whole run; they're also text dumps (PDF/docx/epub/forwarded-email exports) that
// gain nothing from rich rendering. Above either cap we skip the editor entirely
// and take the code-fence fallback: trivially schema-valid, content preserved
// verbatim, instant. Normal notes still go through the full validate/coerce.
//   SIZE_CAP  — raw byte size (the multi-MB docx/OneNote monsters).
//   LINE_CAP  — newline count. This is the real trigger: a 74KB note that's 6,416
//   short PDF-extracted lines becomes 6,416 ProseMirror nodes, and the coerce /
//   markdown round-trip is superlinear in node count (a 3,523-line note took 42s).
//   Byte size misses these entirely, so guard on lines too.
const SIZE_CAP = 1_000_000;
const LINE_CAP = 1200;
// Force-fence list (one note rel per line). The supervisor loop appends any note
// that stalls the editor past its wall-clock budget here, then re-runs; on the
// next pass that note is fenced instead of re-stalling. Turns the "some notes are
// pathologically slow in ways no size/line heuristic predicts" problem into a
// self-healing loop, no manual triage per note.
const FORCE_FENCE_FILE = "C:/dev/nsx-migration/import/force-fence.txt";
let forceFence = new Set<string>();
try { forceFence = new Set(fs.readFileSync(FORCE_FENCE_FILE, "utf8").split(/\r?\n/).map(s => s.trim()).filter(Boolean)); } catch {}
// A fence longer than the longest backtick run inside, so content can't close it.
function fenceBody(body: string): string {
  const longest = Math.max(0, ...(body.match(/`+/g) || []).map((s) => s.length));
  const bars = "`".repeat(Math.max(3, longest + 1));
  return `${bars}text\n${body.trim()}\n${bars}`;
}

function stripFrontmatter(raw: string): { fm: Record<string,string>; body: string } {
  const clean = raw.replace(/\0/g, "");
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(clean);
  if (!m) return { fm: {}, body: clean };
  const fm: Record<string,string> = {};
  for (const line of m[1].split(/\r?\n/)) { const mm = /^([a-z_]+):\s*(.*)$/.exec(line); if (mm) fm[mm[1]] = mm[2].replace(/^"(.*)"$/, "$1"); }
  return { fm, body: m[2] };
}

const VAULT = "C:/dev/nsx-migration/vault2";
const notebooks = fs.readdirSync(VAULT, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
  .filter(nb => only.length === 0 || only.includes(nb));

type Entry = { body: string; changed: boolean; coerced: boolean; fenced?: boolean };
// Resume: reuse an existing partial output so a killed/re-run picks up where it
// left off instead of reprocessing thousands of notes. Every note is flushed to
// disk in batches, and the note currently being worked is written to a sidecar
// `.current` breadcrumb *before* the expensive editor step — so if a note spins
// (a pathological body that makes the coerce round-trip run for minutes), that
// file names the exact culprit and a re-run skips everything already done and
// lands straight back on it. `SLOW` lines flag notes that were merely slow.
const CURRENT_FILE = out + ".current";
let result: Record<string, Entry> = {};
try { result = JSON.parse(fs.readFileSync(out, "utf8")); } catch {}
const invalid: string[] = Array.isArray((result as Record<string, unknown>)._invalid)
  ? ((result as Record<string, unknown>)._invalid as string[]) : [];
delete (result as Record<string, unknown>)._invalid;
const done = new Set(Object.keys(result));
function flush() {
  (result as Record<string, unknown>)._invalid = invalid;
  fs.writeFileSync(out, JSON.stringify(result));
  delete (result as Record<string, unknown>)._invalid;
}
let n = 0, changed = 0, coercedCount = 0, slow = 0;
const resumed = done.size;
for (const nb of notebooks) {
  const dir = path.join(VAULT, nb);
  let files: string[]; try { files = fs.readdirSync(dir).filter(f => f.endsWith(".md")); } catch { continue; }
  for (const f of files) {
    const { fm, body } = stripFrontmatter(fs.readFileSync(path.join(dir, f), "utf8"));
    if (fm.ledgr_import !== "true") continue;
    const rel = `${nb}/${f}`;
    if (done.has(rel)) continue; // already prepped in a prior run
    n++;
    fs.writeFileSync(CURRENT_FILE, rel); // breadcrumb before the expensive step
    // Heavy (by bytes or line/node count) or a known staller: fence, skip editor.
    const lineCount = (body.match(/\n/g) || []).length;
    if (forceFence.has(rel) || body.length > SIZE_CAP || lineCount > LINE_CAP) {
      result[rel] = { body: fenceBody(body), changed: true, coerced: false, fenced: true };
      changed++; done.add(rel);
      const why = forceFence.has(rel) ? "forced" : "heavy";
      process.stderr.write(`…fenced ${why} note (${(body.length / 1e3).toFixed(0)}KB, ${lineCount} lines): ${rel}\n`);
      if (n % 250 === 0) flush();
      continue;
    }
    const t0 = Date.now();
    const clean = (md: string) => fixRawHtml(fixNestedLists(dropEmptyBullets(md)));
    let s = clean(body);
    let coerced = false;
    // Coerce, then re-sanitize the coerce output (getMarkdown re-emits empty
    // bullets from the doc structure that would re-invalidate on reload).
    if (!isValid(s)) { s = clean(coerce(s)); coerced = true; coercedCount++; }
    if (!isValid(s)) { s = clean(coerce(s)); } // second pass stabilizes round-trip
    if (!isValid(s)) invalid.push(rel);
    const ms = Date.now() - t0;
    if (ms > 5000) { slow++; process.stderr.write(`…SLOW ${ms}ms (${(body.length / 1e3).toFixed(0)}KB): ${rel}\n`); }
    const didChange = s !== body;
    if (didChange) changed++;
    result[rel] = { body: s, changed: didChange, coerced };
    done.add(rel);
    if (n % 250 === 0) { flush(); process.stderr.write(`…prepped ${n} (resumed ${resumed}, changed ${changed}, coerced ${coercedCount}, invalid ${invalid.length}, slow ${slow})\n`); }
  }
}
flush();
try { fs.unlinkSync(CURRENT_FILE); } catch {}
console.log(`prepped ${n} new (+${resumed} resumed = ${done.size} total) | changed ${changed} | coerced ${coercedCount} | slow ${slow} | STILL INVALID ${invalid.length}`);
if (invalid.length) console.log("invalid:\n  " + invalid.slice(0, 20).join("\n  "));
console.log("written -> " + out);
