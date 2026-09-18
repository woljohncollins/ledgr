// Action/capture widget body: a non-data block that creates or navigates.
//  - quick-capture: create a blank item of the target type → open it.
//  - new-from-template: apply a template → open the new item.
//  - link: navigate to a URL.
// Reuses the exact create/apply calls the rest of the app uses (POST /api/items,
// POST /api/templates/[id]/apply); no new server surface.
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { openItem } from "@/lib/item-nav";
import NavGlyph from "@/components/nav/NavGlyph";
import type { ActionWidgetSettings } from "@/lib/dashboard-widgets";

export default function ActionWidgetBody({ settings }: { settings: ActionWidgetSettings }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const label = settings.label || "Action";

  const glyph = settings.icon ? (
    <NavGlyph icon={settings.icon} size={22} className="text-[var(--accent)]" />
  ) : null;

  const baseClass =
    "cancel-drag flex h-full w-full flex-col items-center justify-center gap-2 p-3 text-sm text-neutral-200 hover:bg-neutral-800/40";

  // new-from-template needs a template chosen first; until then it's a hint, not
  // a button (so a click can't fall through to creating a blank item).
  if (settings.action === "new-from-template" && !settings.templateId) {
    return (
      <div className={`${baseClass} opacity-60`}>
        {glyph}
        <span className="text-center text-xs text-neutral-500">
          Pick a template in settings (⚙)
        </span>
      </div>
    );
  }

  if (settings.action === "link") {
    const href = settings.href || "#";
    const external = /^https?:\/\//.test(href);
    if (external) {
      return (
        <a href={href} target="_blank" rel="noreferrer" className={baseClass}>
          {glyph}
          {label}
        </a>
      );
    }
    return (
      <Link href={href} className={baseClass}>
        {glyph}
        {label}
      </Link>
    );
  }

  async function run() {
    if (busy) return;
    setBusy(true);
    try {
      let res: Response;
      if (settings.action === "new-from-template" && settings.templateId) {
        res = await fetch(`/api/templates/${settings.templateId}/apply`, { method: "POST" });
      } else {
        res = await fetch("/api/items", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: settings.targetType || "note" }),
        });
      }
      if (!res.ok) throw new Error("create failed");
      const { item } = (await res.json()) as { item: { id: string } };
      openItem(router, item.id);
    } catch {
      setBusy(false);
    }
  }

  return (
    <button onClick={run} disabled={busy} className={`${baseClass} disabled:opacity-50`}>
      {glyph}
      {busy ? "Working…" : label}
    </button>
  );
}
