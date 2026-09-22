// "+ New person" as a lookup (2026-09-22, John): type a name, pick the match
// from his Outlook contacts (bridge-exported directory), and the person is
// created with name / email / phone / church / role filled from the contact,
// then opened in the popup. A name with no match can still be created blank.
"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { showToast } from "@/components/ui/ActionToast";
import { openItem } from "@/lib/item-nav";

type Hit = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  title: string | null;
  city: string | null;
};

export default function PersonLookup({ nextOrder }: { nextOrder: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Debounced directory search.
  useEffect(() => {
    if (!open) return;
    const term = q.trim();
    if (!term) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      fetch(`/api/contacts/search?q=${encodeURIComponent(term)}`, { signal: ctrl.signal })
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { hits?: Hit[]; total?: number } | null) => {
          if (!d) return;
          setHits(d.hits ?? []);
          setTotal(d.total ?? null);
          setActive(0);
        })
        .catch(() => {});
    }, 150);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q, open]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  async function create(hit: Hit | null) {
    if (busy) return;
    setBusy(true);
    try {
      const properties: Record<string, unknown> = { callorder: nextOrder };
      if (hit) {
        if (hit.email) properties.email = hit.email;
        if (hit.phone) properties.phone = hit.phone;
        if (hit.company) properties.church = hit.company;
        if (hit.title) properties.role = hit.title;
        properties.outlookid = hit.id;
      }
      const res = await fetch("/api/items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "person", title: hit ? hit.name : q.trim(), properties }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const { item } = (await res.json()) as { item: { id: string } };
      setOpen(false);
      setQ("");
      openItem(router, item.id);
    } catch {
      showToast("Couldn't create the person");
    } finally {
      setBusy(false);
    }
  }

  // Stale hits are hidden (not cleared in the effect) once the box is emptied.
  const shown = q.trim() ? hits : [];
  // Options = the hits plus a trailing "create as typed" row.
  const rows = shown.length + (q.trim() ? 1 : 0);

  return (
    <div ref={boxRef} className="relative shrink-0 px-2 pt-1.5">
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="cancel-drag w-full rounded border border-dashed border-line px-2 py-1 text-left text-sm text-ink-muted hover:border-line-strong hover:bg-surface-2 hover:text-ink"
        >
          + New person… (search Outlook contacts)
        </button>
      ) : (
        <div className="cancel-drag rounded border border-line bg-[var(--background)] shadow-lg">
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, Math.max(rows - 1, 0)));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                if (active < shown.length) void create(shown[active]);
                else if (q.trim()) void create(null);
              }
            }}
            placeholder="Type a name from your Outlook contacts…"
            aria-label="Search Outlook contacts"
            className="w-full rounded-t bg-transparent px-2 py-1.5 text-sm text-ink placeholder:text-ink-faint focus:outline-none"
          />
          <ul className="max-h-64 overflow-y-auto border-t border-line text-sm">
            {shown.map((h, i) => (
              <li key={h.id}>
                <button
                  type="button"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => void create(h)}
                  disabled={busy}
                  className={`flex w-full flex-col items-start px-2 py-1.5 text-left hover:bg-surface-2 ${active === i ? "bg-surface-2" : ""}`}
                >
                  <span className="text-ink">{h.name}</span>
                  <span className="truncate text-xs text-ink-subtle">
                    {[h.company, h.title, h.phone, h.email].filter(Boolean).join(" · ")}
                  </span>
                </button>
              </li>
            ))}
            {q.trim() && (
              <li>
                <button
                  type="button"
                  onMouseEnter={() => setActive(shown.length)}
                  onClick={() => void create(null)}
                  disabled={busy}
                  className={`w-full px-2 py-1.5 text-left text-ink-muted hover:bg-surface-2 ${active === shown.length ? "bg-surface-2" : ""}`}
                >
                  {busy ? "Creating…" : `Create “${q.trim()}” without a contact`}
                </button>
              </li>
            )}
            {!q.trim() && (
              <li className="px-2 py-1.5 text-xs text-ink-subtle">
                {total === 0
                  ? "No contacts exported yet — the Outlook bridge fills this in."
                  : "Start typing to search your Outlook contacts."}
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
