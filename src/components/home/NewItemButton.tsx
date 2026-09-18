// Creates a new item of the given type, then jumps into its editor. When the
// type has templates (ADR-093), "+ New" gains a chooser (Blank + each template).
// A per-type DEFAULT template (TPL4) is applied by the primary "+ New" click,
// with a ▾ opening the chooser for the rest; with no default, "+ New ▾" just
// opens the chooser. A template with {{ask:…}} prompts (TPL3) opens a small form
// first. Self-fetches the type's templates on mount, so every list page that
// renders <NewItemButton type=…/> gets this with no change.
"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import TemplateApplyDialog from "@/components/home/TemplateApplyDialog";
import { openItem } from "@/lib/item-nav";

type TemplateOpt = {
  id: string;
  name: string;
  isDefault: boolean;
  subtaskCount: number;
  hasBody: boolean;
};

function previewLine(t: TemplateOpt): string {
  const parts: string[] = [];
  if (t.subtaskCount > 0) parts.push(`${t.subtaskCount} subtask${t.subtaskCount === 1 ? "" : "s"}`);
  if (t.hasBody) parts.push("starter body");
  return parts.join(" · ");
}

export default function NewItemButton({ type }: { type: string }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "busy" | "error">("idle");
  const [templates, setTemplates] = useState<TemplateOpt[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  // A picked template that has {{ask:…}} prompts → the apply-time form.
  const [applyVars, setApplyVars] = useState<
    { id: string; name: string; askLabels: string[] } | null
  >(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!type) return;
    const ctrl = new AbortController();
    fetch(`/api/templates?type=${encodeURIComponent(type)}&preview=1`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { templates?: TemplateOpt[] } | null) => {
        if (d?.templates) setTemplates(d.templates);
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, [type]);

  // Close the menu on an outside click.
  useEffect(() => {
    if (!menuOpen) return;
    function onClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [menuOpen]);

  async function open(promise: Promise<Response>) {
    setState("busy");
    try {
      const res = await promise;
      if (!res.ok) throw new Error(String(res.status));
      const { item } = await res.json();
      setMenuOpen(false);
      openItem(router, item.id);
      // The list page stays mounted under the intercepting modal, so this
      // button never remounts on its own — reset it here.
      setState("idle");
    } catch {
      setState("error");
    }
  }

  const createBlank = () =>
    open(
      fetch("/api/items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type }),
      })
    );

  const createFromTemplate = async (id: string, name: string) => {
    setMenuOpen(false);
    // A template with {{ask:…}} prompts collects answers first (TPL3); otherwise
    // apply straight away. A vars-fetch failure falls through to a direct apply.
    try {
      const res = await fetch(`/api/templates/${id}/vars`);
      if (res.ok) {
        const { askLabels } = (await res.json()) as { askLabels?: string[] };
        if (askLabels && askLabels.length) {
          setApplyVars({ id, name, askLabels });
          return;
        }
      }
    } catch {
      /* fall through to a direct apply */
    }
    open(fetch(`/api/templates/${id}/apply`, { method: "POST" }));
  };

  const buttonClass =
    "rounded px-2 py-0.5 text-sm text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200 disabled:opacity-50";

  // No templates for this type: the plain button (unchanged behavior).
  if (templates.length === 0) {
    return (
      <button onClick={createBlank} disabled={state === "busy"} className={buttonClass}>
        {state === "error" ? "Failed, retry?" : "+ New"}
      </button>
    );
  }

  const defaultTpl = templates.find((t) => t.isDefault);
  // The primary "+ New" click: apply the default if there is one, else open the
  // chooser. (Error state retries the same primary action.)
  const primary = () =>
    defaultTpl ? void createFromTemplate(defaultTpl.id, defaultTpl.name) : setMenuOpen((o) => !o);

  return (
    <div ref={rootRef} className="relative inline-flex items-center text-left">
      <button
        onClick={primary}
        disabled={state === "busy"}
        aria-haspopup={defaultTpl ? undefined : "menu"}
        aria-expanded={defaultTpl ? undefined : menuOpen}
        title={defaultTpl ? `New from “${defaultTpl.name}” (default)` : undefined}
        className={buttonClass}
      >
        {state === "error" ? "Failed, retry?" : defaultTpl ? "+ New" : "+ New ▾"}
      </button>
      {defaultTpl && (
        <button
          onClick={() => setMenuOpen((o) => !o)}
          disabled={state === "busy"}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label="Choose a template"
          className={`${buttonClass} -ml-1 px-1`}
        >
          ▾
        </button>
      )}
      {menuOpen && (
        <div
          role="menu"
          className="absolute right-0 top-full z-20 mt-1 w-64 overflow-hidden rounded-lg border border-neutral-700 bg-neutral-900 py-1 shadow-xl shadow-black/50"
        >
          <button
            role="menuitem"
            onClick={createBlank}
            className="block w-full px-3 py-1.5 text-left text-sm text-neutral-200 hover:bg-neutral-800"
          >
            Blank
          </button>
          <div className="my-1 border-t border-neutral-800" />
          <p className="px-3 py-0.5 text-xs uppercase tracking-wide text-neutral-600">
            From template
          </p>
          {templates.map((t) => {
            const preview = previewLine(t);
            return (
              <button
                key={t.id}
                role="menuitem"
                onClick={() => void createFromTemplate(t.id, t.name)}
                className="block w-full px-3 py-1.5 text-left hover:bg-neutral-800"
              >
                <span className="flex items-center gap-1.5 truncate text-sm text-neutral-200">
                  {t.isDefault && <span className="text-amber-300" title="Default">★</span>}
                  <span className="truncate">{t.name}</span>
                </span>
                {preview && (
                  <span className="block truncate text-xs text-neutral-500">{preview}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
      {applyVars && (
        <TemplateApplyDialog
          templateId={applyVars.id}
          name={applyVars.name}
          askLabels={applyVars.askLabels}
          onClose={() => setApplyVars(null)}
        />
      )}
    </div>
  );
}
