// Import & Migration (2026-09-22): drop or pick .md files shared from another
// Ledgr (or any Markdown), or paste text, and each becomes an item here.
"use client";

import Link from "next/link";
import { useRef, useState } from "react";

type Result = { name: string; ok: boolean; id?: string; title?: string; type?: string; tags?: string[]; error?: string };

export default function ImportDropzone() {
  const [results, setResults] = useState<Result[]>([]);
  const [busy, setBusy] = useState(false);
  const [pasted, setPasted] = useState("");
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function importText(name: string, text: string): Promise<Result> {
    try {
      const res = await fetch("/api/import/ledgr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        return { name, ok: false, error: j?.error ?? `HTTP ${res.status}` };
      }
      const { item } = (await res.json()) as { item: { id: string; title: string; type: string; tags: string[] } };
      return { name, ok: true, ...item };
    } catch (e) {
      return { name, ok: false, error: e instanceof Error ? e.message : "failed" };
    }
  }

  async function handleFiles(files: FileList | File[]) {
    const list = Array.from(files).filter((f) => /\.(md|markdown|txt)$/i.test(f.name) || f.type.startsWith("text/"));
    if (!list.length) return;
    setBusy(true);
    const out: Result[] = [];
    for (const f of list) {
      out.push(await importText(f.name, await f.text()));
      setResults([...out]);
    }
    setBusy(false);
  }

  async function handlePaste() {
    if (!pasted.trim()) return;
    setBusy(true);
    const r = await importText("Pasted text", pasted);
    setResults((rs) => [...rs, r]);
    if (r.ok) setPasted("");
    setBusy(false);
  }

  return (
    <div className="mt-6 space-y-6">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void handleFiles(e.dataTransfer.files);
        }}
        className={`rounded-xl border-2 border-dashed p-8 text-center ${over ? "border-[var(--accent)] bg-surface-2" : "border-neutral-700"}`}
      >
        <p className="text-sm text-neutral-300">Drop .md files here</p>
        <p className="mt-1 text-xs text-neutral-500">
          Files shared from another Ledgr keep their type, properties and tags. Plain Markdown becomes a note.
        </p>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="mt-4 rounded-md border border-neutral-700 px-3 py-1.5 text-sm text-neutral-200 hover:border-neutral-500 disabled:opacity-60"
        >
          {busy ? "Importing…" : "Choose files"}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".md,.markdown,.txt,text/markdown,text/plain"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) void handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      <div>
        <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-500">Or paste the text</label>
        <textarea
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
          rows={6}
          placeholder="Paste a shared note here…"
          className="mt-1.5 w-full rounded-md border border-neutral-700 bg-transparent p-2 text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
        />
        <button
          type="button"
          onClick={() => void handlePaste()}
          disabled={busy || !pasted.trim()}
          className="mt-2 rounded-md border border-[var(--accent)] px-3 py-1.5 text-sm text-[var(--accent)] hover:brightness-110 disabled:opacity-50"
        >
          Import pasted text
        </button>
      </div>

      {results.length > 0 && (
        <ul className="space-y-1 text-sm">
          {results.map((r, i) => (
            <li key={`${r.name}-${i}`} className="flex items-center gap-2">
              {r.ok ? (
                <>
                  <span className="text-emerald-400">✓</span>
                  <Link href={`/items/${r.id}`} className="text-neutral-200 hover:underline">
                    {r.title}
                  </Link>
                  <span className="text-xs text-neutral-500">
                    {r.type}
                    {r.tags && r.tags.length ? ` · ${r.tags.join(", ")}` : ""}
                  </span>
                </>
              ) : (
                <>
                  <span className="text-red-400">✕</span>
                  <span className="text-neutral-300">{r.name}</span>
                  <span className="text-xs text-red-400">{r.error}</span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
