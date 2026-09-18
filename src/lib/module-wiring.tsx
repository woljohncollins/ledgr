// The wiring half of the module-registration boundary (M6, ADR-043) — the one
// thing that can't be pure: a canvas id → its React component. The *policy*
// (which canvas id a type uses) lives in `modules.ts`, kept pure so it stays
// node-testable; this file maps those ids to the actual components, so a verify
// script (or any pure import of the registry) never drags the editor bundle in.
// The two halves are linked by the `canvasId` string a module declares on its
// type. A `?? MarkdownCanvas` fallback keeps a policy/wiring drift (an id with no
// component) from crashing the page.
//
// A workflow module adds its canvas component here (a chord grid, a paper
// workspace); core wires the default markdown canvas and the shared longform
// document canvas (notes, links, journal, prayer, … — ADR-041/157).
import ChordCanvas from "@/components/canvas/ChordCanvas";
import EventCanvas from "@/components/canvas/EventCanvas";
import FileCanvas from "@/components/canvas/FileCanvas";
import LongformCanvas from "@/components/canvas/LongformCanvas";
import MarkdownCanvas from "@/components/canvas/MarkdownCanvas";
import MindmapCanvas from "@/components/canvas/MindmapCanvas";
import TaskCanvas from "@/components/canvas/TaskCanvas";
import PaperCanvas from "@/components/canvas/PaperCanvas";
import WidgetCanvas from "@/components/canvas/WidgetCanvas";
import { DEFAULT_CANVAS, type CanvasComponent } from "@/lib/modules";
// Side-effect import: registers the workflow modules (Songs, …) onto core so a
// `song` resolves its `chord` canvas. This is the canvas-dispatch path
// (ItemCanvas imports this file), so registration happens before any render.
import "@/lib/modules/register";

const CANVAS_COMPONENTS: Record<string, CanvasComponent> = {
  [DEFAULT_CANVAS]: MarkdownCanvas,
  event: EventCanvas,
  longform: LongformCanvas,
  chord: ChordCanvas,
  file: FileCanvas,
  paper: PaperCanvas,
  task: TaskCanvas,
  mindmap: MindmapCanvas,
  widgets: WidgetCanvas,
};

// Resolve a canvas id (from `canvasIdForType`) to its component. Anything
// unwired falls back to the default markdown canvas.
export function canvasComponentFor(canvasId: string): CanvasComponent {
  return CANVAS_COMPONENTS[canvasId] ?? MarkdownCanvas;
}
