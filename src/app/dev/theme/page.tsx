import { notFound } from "next/navigation";

// S1 light-mode PROOF screen (ui-refresh, ADR-141). NOT a shipped theme — this
// exists to prove the token mechanism: the SAME markup renders dark (default
// tokens) on the left and light (the `data-theme` attribute flips --n-* + the semantic
// layer) on the right, using only ordinary neutral utilities + the new semantic
// classes. If both panels read correctly, a future light theme is a variable
// flip, not a rewrite. Gated off in production so it never ships as a route.
export default function ThemeProofPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="ui-title mb-1">Token proof · light-mode mechanism</h1>
      <p className="ui-meta mb-8">
        Left = dark (default tokens). Right panels = the three themes (<code>data-theme</code> light, gray, sepia; same markup, ramp flipped). Dev-only.
      </p>
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        <Sample label="Dark (default)" />
        <div data-theme="light" className="rounded-card">
          <Sample label="Light (light)" />
        </div>
        <div data-theme="gray" className="rounded-card">
          <Sample label="Gray (gray)" />
        </div>
        <div data-theme="sepia" className="rounded-card">
          <Sample label="Sepia (sepia)" />
        </div>
      </div>
    </main>
  );
}

// One representative slice of chrome, styled from BOTH the raw neutral utilities
// (tier 1) and the semantic classes (tier 2), so the flip is proven for both.
function Sample({ label }: { label: string }) {
  return (
    <div className="rounded-card border border-line bg-surface-0 p-5">
      <div className="ui-section-label mb-3">{label}</div>

      {/* semantic surfaces */}
      <div className="space-y-2">
        <div className="rounded-card bg-surface-1 p-3">
          <div className="text-ink">Surface 1 · primary ink</div>
          <div className="text-ink-muted text-sm">Muted ink — secondary text</div>
          <div className="text-ink-subtle text-xs">Subtle ink — meta / timestamp</div>
        </div>
        <div className="rounded-card bg-surface-2 p-3 text-ink">Surface 2 · raised / hover</div>
        <div className="rounded-card bg-surface-3 border border-line-strong p-3 text-ink">
          Surface 3 · popover (line-strong border)
        </div>
      </div>

      {/* tier-1 raw neutral utilities (existing code path) */}
      <div className="mt-4 border-t border-neutral-800 pt-4">
        <div className="mb-2 text-xs text-neutral-500">Raw neutral utilities (unchanged code):</div>
        <div className="rounded-md bg-neutral-900 p-3">
          <span className="text-neutral-100">neutral-100</span>{" "}
          <span className="text-neutral-300">neutral-300</span>{" "}
          <span className="text-neutral-500">neutral-500</span>
        </div>
      </div>

      {/* accent unaffected by the flip */}
      <button
        className="mt-4 rounded-md px-3 py-1.5 text-sm font-medium text-white"
        style={{ background: "var(--accent-gradient, var(--accent))" }}
      >
        Accent action
      </button>
    </div>
  );
}
