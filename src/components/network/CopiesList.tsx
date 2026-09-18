"use client";

// The roster, editable (ADR-220): every copy of Ledgr the owner runs, renameable
// from any of them.
//
// Renaming from anywhere is the point Brandon asked for directly: a machine is
// named once when it is set up — the wizard asks rather than silently taking the
// hostname, which is the collision guard — and the owner must be able to correct
// that later without walking to the machine.
import { useState } from "react";
import { useRouter } from "next/navigation";
import ConfirmButton from "@/components/ui/ConfirmButton";
import { installHealth, installHealthLine, labelProblem, type Install } from "@/lib/installs-plan";

export default function CopiesList({ installs }: { installs: Install[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = new Date();

  async function call(method: "PATCH" | "DELETE", body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/installs", {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "That could not be changed.");
      }
      setEditing(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function save(id: string) {
    const problem = labelProblem(draft);
    if (problem) {
      setError(problem);
      return;
    }
    void call("PATCH", { id, label: draft });
  }

  if (installs.length === 0) {
    return (
      <p className="text-sm text-ink-muted">
        No copies have checked in yet. Each one adds itself to this list the first
        time its daily tidy-up runs, so a copy set up today appears tomorrow.
      </p>
    );
  }

  const button =
    "rounded-card border border-line-strong bg-surface-2 px-2 py-0.5 text-xs text-ink hover:bg-surface-3 disabled:opacity-40";

  return (
    <div>
      <ul className="divide-y divide-line">
        {installs.map((i) => {
          const health = installHealth(i, now);
          return (
            <li key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
              <span
                className={`inline-block h-2 w-2 shrink-0 rounded-full ${
                  health === "here"
                    ? "bg-emerald-500"
                    : health === "quiet"
                      ? "bg-amber-500"
                      : "bg-neutral-500"
                }`}
                aria-hidden
              />
              <span className="min-w-0 flex-1 basis-56">
                {editing === i.id ? (
                  <span className="flex flex-wrap items-center gap-2">
                    <input
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") save(i.id);
                        if (e.key === "Escape") setEditing(null);
                      }}
                      className="w-48 rounded-card border border-line-strong bg-surface-2 px-2 py-1 text-sm text-ink"
                      aria-label="Machine name"
                    />
                    <button
                      type="button"
                      className={button}
                      disabled={busy}
                      onClick={() => save(i.id)}
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      className="ui-meta text-ink-subtle underline decoration-dotted"
                      onClick={() => setEditing(null)}
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <>
                    <span className="block text-sm text-ink">
                      {i.label}
                      {i.isSelf && <span className="ui-meta ml-2 text-ink-subtle">this one</span>}
                      {i.kind === "cloud" && (
                        <span className="ui-meta ml-2 text-ink-faint">in the cloud</span>
                      )}
                    </span>
                    <span className="ui-meta block text-ink-subtle">
                      {installHealthLine(i, now)}
                      {i.appVersion ? ` · version ${i.appVersion.slice(0, 7)}` : ""}
                    </span>
                  </>
                )}
              </span>
              {editing !== i.id && (
                <>
                  <button
                    type="button"
                    className={button}
                    disabled={busy}
                    onClick={() => {
                      setDraft(i.label);
                      setError(null);
                      setEditing(i.id);
                    }}
                  >
                    Rename
                  </button>
                  {!i.isSelf && (
                    <ConfirmButton
                      title={`Remove ${i.label} from the list?`}
                      description="Only do this for a machine you are finished with. If it is still running Ledgr, it will add itself back the next day."
                      confirmLabel="Remove it"
                      align="right"
                      trigger={<span>Remove</span>}
                      triggerClassName={button}
                      disabled={busy}
                      onConfirm={() => call("DELETE", { id: i.id })}
                    />
                  )}
                </>
              )}
            </li>
          );
        })}
      </ul>
      {error && <p className="ui-meta mt-2 text-rose-400">{error}</p>}
    </div>
  );
}
