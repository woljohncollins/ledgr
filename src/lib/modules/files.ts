// The Files module (Files as a first-class citizen, ADR-236). Pure manifest,
// like the songs/papers/mindmap modules: it declares the `file` type — the
// item IS the file, the markdown body is the description around it — and its
// `file` canvas by id (the component is wired in module-wiring.tsx). The type
// row itself ships in migration 0061 / seed.mjs; this manifest is what routes
// it to FileCanvas and keeps markdown its canonical body format.
import { MARKDOWN_FORMAT } from "@/lib/body";
import type { ModuleManifest } from "@/lib/modules";

export const fileModule: ModuleManifest = {
  id: "files",
  label: "Files",
  enabledByDefault: true,
  types: [
    {
      key: "file",
      label: "File",
      icon: "document",
      canonicalFormat: MARKDOWN_FORMAT,
      canvasId: "file",
    },
  ],
  exporters: [],
};
