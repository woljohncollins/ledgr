// Module registration boot site (the M6 gap — `registerModule` had no live
// caller until the first real module). Importing this for its side effect
// registers every workflow module onto core. It's pure (manifests only, no
// component imports), so a node verify script can import it to register modules
// without dragging in React. Idempotent: guarded against the duplicate-id throw
// so Next's dev HMR re-evaluating the module graph can't crash the boundary.
//
// NOTE (two-builder repo): where modules register is a core-shared concern — see
// the plan's collaboration note. This is imported for effect by module-wiring.tsx
// (the canvas-dispatch path), so a `song` resolves its `chord` canvas before any
// page renders one.
import { allModules, registerModule, type ModuleManifest } from "@/lib/modules";
import { fileModule } from "@/lib/modules/files";
import { mindmapModule } from "@/lib/modules/mindmap";
import { paperModule } from "@/lib/modules/papers";
import { songModule } from "@/lib/modules/songs";

const WORKFLOW_MODULES: ModuleManifest[] = [songModule, paperModule, mindmapModule, fileModule];

for (const m of WORKFLOW_MODULES) {
  if (!allModules().some((existing) => existing.id === m.id)) {
    registerModule(m);
  }
}
