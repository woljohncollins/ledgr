// New-template form (ADR-093): name + type only. Creating a template mints a
// registry row plus an empty hidden prototype item; we then jump straight into
// that prototype in the normal canvas, where the template's body, subtasks,
// properties, and relations are authored exactly like any item (no second
// editor). This replaces the old TemplateBuilder body/defaults form.
"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { openItem } from "@/lib/item-nav";
import type { TypeDefinition } from "@/lib/types";

const fieldClass =
  "rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-200 outline-none focus:border-neutral-600";

export default function NewTemplateForm({
  types,
  defaultType,
}: {
  types: TypeDefinition[];
  defaultType?: string;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [typeKey, setTypeKey] = useState(defaultType ?? types[0]?.key ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    if (busy) return;
    setError(null);
    if (!name.trim()) {
      setError("Give the template a name.");
      return;
    }
    if (!typeKey) {
      setError("Pick a type.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), type: typeKey }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? `create failed (${res.status})`);
        setBusy(false);
        return;
      }
      const { template } = (await res.json()) as {
        template: { prototypeItemId: string };
      };
      // Author the template by opening its prototype in the normal canvas.
      openItem(router, template.prototypeItemId);
      router.refresh();
    } catch {
      setError("create failed (offline?)");
      setBusy(false);
    }
  }

  return (
    <div className="mt-6 flex max-w-lg flex-col gap-4">
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-neutral-400">Name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Weekly review"
          className={fieldClass}
          autoFocus
        />
        <span className="text-xs text-neutral-600">
          What this starting point is called, e.g. “Roger 1:1” or “Sermon outline”.
        </span>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-neutral-400">Type</span>
        <select
          value={typeKey}
          onChange={(e) => setTypeKey(e.target.value)}
          className={fieldClass}
        >
          {types.map((t) => (
            <option key={t.key} value={t.key}>
              {t.label}
            </option>
          ))}
        </select>
        <span className="text-xs text-neutral-600">
          Which kind of item this template creates. Fixed once created.
        </span>
      </label>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <div>
        <button
          onClick={() => void create()}
          disabled={busy}
          className="rounded bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-50"
        >
          {busy ? "Creating…" : "Create + open canvas"}
        </button>
        <p className="mt-2 text-xs text-neutral-600">
          You’ll land in the editor to build out the template: its body,
          subtasks, properties, and related items, just like any item.
        </p>
      </div>
    </div>
  );
}
