// Where each arrival path lands (ADR-249). One select per INBOX_SOURCES row:
// queue it in the Inbox, file it straight away, or drop it into a project.
// Save-on-change to /api/settings, the same shape SettingsForm uses.
//
// Destinations are PROJECTS ONLY, matching the task-add card's picker, so the
// "project" relation role createItem writes is always honest. The list is
// passed in from the server page (no client fetch).
"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { INBOX_SOURCES } from "@/lib/inbox-sources";

export default function CaptureRoutes({
  initial,
  projects,
}: {
  initial: Record<string, string>;
  projects: { id: string; title: string }[];
}) {
  const [routes, setRoutes] = useState(initial);
  const [saved, setSaved] = useState(false);
  const router = useRouter();

  const save = async (source: string, route: string) => {
    const next = { ...routes, [source]: route };
    setRoutes(next);
    try {
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inboxRoutes: next }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 1200);
      // The Inbox nav slot hides itself when nothing routes to it (ADR-249),
      // and the nav renders server-side, so a change has to refresh to show up.
      router.refresh();
    } catch {
      /* offline; the next change retries */
    }
  };

  return (
    <section>
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-neutral-200">Where captures land</h2>
        {saved && <span className="text-xs text-neutral-500">Saved</span>}
      </div>
      <p className="mt-0.5 text-sm text-neutral-500">
        Each way something arrives in Ledgr can queue in the Inbox for triage,
        file itself straight away, or drop into a project. Anything that asks you
        where it should go (the task card&rsquo;s own picker, for one) ignores
        these and does what you picked.
      </p>
      <div className="mt-3 flex flex-col gap-3">
        {INBOX_SOURCES.map(({ key, label, help, defaultRoute }) => {
          const value = routes[key] ?? defaultRoute;
          // A destination project that has since been trashed is still the
          // stored value, so keep it selectable rather than letting the select
          // silently show "Inbox" instead. Captures fall back to the Inbox
          // meanwhile, and restoring the project restores the routing.
          const missing =
            value !== "inbox" && value !== "filed" && !projects.some((p) => p.id === value);
          return (
            <label key={key} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
              <span className="w-44 shrink-0 text-neutral-300">
                {label}
                <span className="block text-xs text-neutral-500">{help}</span>
              </span>
              <select
                value={value}
                onChange={(e) => void save(key, e.target.value)}
                className="w-56 rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-sm text-neutral-200 outline-none focus:border-neutral-600"
              >
                <option value="inbox">Inbox</option>
                <option value="filed">File it</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title || "Untitled project"}
                  </option>
                ))}
                {missing && <option value={value}>Project in Trash (goes to Inbox)</option>}
              </select>
            </label>
          );
        })}
      </div>
    </section>
  );
}
