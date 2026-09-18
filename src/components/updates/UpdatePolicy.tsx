"use client";

// The update policy form on Build → Updates: how this machine takes new
// versions. Writes <supervisorDir>/update-policy.json through
// /api/local/update-policy; the local service re-reads it within a minute, so
// there is no restart and the form says so. The tray icon's Settings tab edits
// the same file, for the owner sitting at the machine with no login.
import { useState } from "react";
import type { UpdatePolicy } from "@/lib/update-policy";
import { MAX_EVERY_MINUTES, MIN_EVERY_MINUTES } from "@/lib/update-policy";

const button =
  "rounded-card border border-line-strong bg-surface-2 px-2.5 py-1 text-xs text-ink hover:bg-surface-3 disabled:opacity-60";
const field =
  "rounded-card border border-line bg-surface-0 px-2 py-1 text-sm text-ink disabled:opacity-60";

const DEFAULTS: UpdatePolicy = { mode: "auto", everyMinutes: 15, branch: "main", repo: "", updatedAt: null };

export default function UpdatePolicyForm({ initial }: { initial: UpdatePolicy | null }) {
  const start = initial ?? DEFAULTS;
  const [mode, setMode] = useState<UpdatePolicy["mode"]>(start.mode);
  const [every, setEvery] = useState(String(start.everyMinutes));
  const [branch, setBranch] = useState(start.branch);
  const [repo, setRepo] = useState(start.repo);
  const [saved, setSaved] = useState<UpdatePolicy | null>(initial);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; tone: "ok" | "bad" } | null>(null);

  const dirty =
    !saved ||
    saved.mode !== mode ||
    String(saved.everyMinutes) !== every ||
    saved.branch !== branch.trim() ||
    saved.repo !== repo.trim();

  async function save() {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/local/update-policy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode, everyMinutes: Number(every), branch: branch.trim(), repo: repo.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; policy?: UpdatePolicy };
      if (!res.ok || !data.policy) throw new Error(data.error ?? "That could not be saved.");
      setSaved(data.policy);
      setNote({ text: "Saved. The service picks it up within a minute, no restart.", tone: "ok" });
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : String(e), tone: "bad" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="text-sm">
      {!initial && (
        <p className="ui-meta mb-3 text-ink-subtle">
          No policy is written yet. The service writes one from its config on its first start; saving here writes it now.
        </p>
      )}

      <fieldset className="space-y-2">
        <legend className="ui-meta text-ink-subtle">When to take updates</legend>
        <label className="flex flex-wrap items-center gap-2 text-ink">
          <input type="radio" name="update-mode" checked={mode === "auto"} onChange={() => setMode("auto")} disabled={busy} />
          <span>Check on its own every</span>
          <input
            type="number"
            className={`${field} w-20 tabular-nums`}
            min={MIN_EVERY_MINUTES}
            max={MAX_EVERY_MINUTES}
            value={every}
            disabled={busy || mode !== "auto"}
            onChange={(e) => setEvery(e.target.value)}
            aria-label="Minutes between update checks"
          />
          <span>minutes</span>
        </label>
        <label className="flex items-center gap-2 text-ink">
          <input type="radio" name="update-mode" checked={mode === "manual"} onChange={() => setMode("manual")} disabled={busy} />
          <span>Only when I press Update now</span>
        </label>
      </fieldset>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="ui-meta block text-ink-subtle">Branch to follow</span>
          <input type="text" className={`${field} mt-1 w-full font-mono`} value={branch} disabled={busy} onChange={(e) => setBranch(e.target.value)} spellCheck={false} />
        </label>
        <label className="block">
          <span className="ui-meta block text-ink-subtle">Repository (git URL, blank keeps the current one)</span>
          <input type="text" className={`${field} mt-1 w-full font-mono`} value={repo} disabled={busy} onChange={(e) => setRepo(e.target.value)} spellCheck={false} placeholder="https://github.com/owner/repo.git" />
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" className={button} disabled={busy || !dirty} onClick={() => void save()}>
          {busy ? "Saving…" : "Save"}
        </button>
        {note && <span className={`ui-meta ${note.tone === "ok" ? "text-emerald-400" : "text-rose-400"}`}>{note.text}</span>}
        {!note && saved?.updatedAt && (
          <span className="ui-meta text-ink-subtle">Last changed {new Date(saved.updatedAt).toLocaleString()}.</span>
        )}
      </div>
      <p className="ui-meta mt-3 text-ink-subtle">
        A public repository needs no token or account. If an update fails to build or migrate, the version you are on keeps serving.
      </p>
    </div>
  );
}
