// The Build-mode left sidebar (ADR-063). The clean paradigm break from Work:
// where Work uses the configurable bottom bar / rail, Build uses a fixed,
// hardcoded left sidebar with the three grouped sections (DATA / INTERFACE /
// MAINTAIN) from build-nav.ts — modeled on Vercel's dashboard nav. Desktop-first;
// on mobile it collapses to a drawer behind a hamburger (mobile Build is not a
// focus this phase, but you must still be able to navigate and get back to Work).
//
// "Build Mode" wordmark glows at the top (the "you are here" state); a Cmd+K
// search box opens the universal command palette (owned by NavShell, opened via
// onOpenSearch); "Back to Work" leaves. Most entries are flat links; Types &
// Properties expands to the user's actual types for a quick edit-jump.
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import NavGlyph from "@/components/nav/NavGlyph";
import { BUILD_NAV } from "@/lib/build-nav";
import { BUILD_SIDEBAR_W } from "@/lib/nav-layout";

type BuildType = { key: string; label: string; icon: string | null };

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

function BackArrow() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 5 4 12l7 7" />
      <path d="M4 12h12.5a3.5 3.5 0 0 1 3.5 3.5V19" />
    </svg>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`ml-auto transition-transform ${open ? "rotate-90" : ""}`}
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

function HamburgerIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}

// The sidebar body, shared by the desktop rail and the mobile drawer.
function SidebarContent({
  types,
  aiMemoryEnabled,
  onOpenSearch,
  onNavigate,
}: {
  types: BuildType[];
  aiMemoryEnabled: boolean;
  onOpenSearch: () => void;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  // Types & Properties starts expanded when you're inside it; otherwise closed.
  const [typesOpen, setTypesOpen] = useState(pathname.startsWith("/build/types"));

  // Model Overview is `/build` exactly; the others match their full subtree so a
  // child route (e.g. /build/types/new) still lights up its entry.
  const entryActive = (href: string) =>
    href === "/build"
      ? pathname === "/build"
      : pathname === href || pathname.startsWith(`${href}/`);

  const linkClass = (active: boolean) =>
    `flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors ${
      active
        ? "bg-neutral-800 text-neutral-100"
        : "text-neutral-400 hover:bg-neutral-800/60 hover:text-neutral-200"
    }`;

  return (
    <div className="flex h-full flex-col gap-1 overflow-y-auto p-3">
      {/* Wordmark: the glowing "you are here" state. */}
      <Link
        href="/build"
        onClick={onNavigate}
        aria-label="Build Mode — Model Overview"
        className="build-wordmark mb-1 px-1 text-lg font-bold tracking-tight text-[var(--accent)]"
        style={{ fontFamily: "var(--font-logo), var(--font-geist-sans)" }}
      >
        Build Mode
      </Link>

      {/* Universal search (Cmd+K). Opens the palette owned by NavShell. */}
      <button
        type="button"
        onClick={() => {
          onNavigate?.();
          onOpenSearch();
        }}
        className="mb-2 flex items-center gap-2 rounded-lg border border-neutral-800 bg-neutral-900 px-2.5 py-2 text-sm text-neutral-500 hover:border-neutral-700 hover:text-neutral-300"
      >
        <SearchIcon />
        <span>Jump to anything…</span>
        <kbd className="ml-auto rounded border border-neutral-700 px-1 text-[10px] text-neutral-600">⌘K</kbd>
      </button>

      {BUILD_NAV.map((group) => (
        <div key={group.label} className="mt-2">
          <p className="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-neutral-600">
            {group.label}
          </p>
          {group.entries
            .filter((entry) => entry.gatedBy !== "aiMemoryEnabled" || aiMemoryEnabled)
            .map((entry) => {
            const active = entryActive(entry.href);
            // The one expandable entry this phase: Types & Properties, whose
            // dropdown lists the user's actual types for a quick edit-jump.
            if (entry.expandable && entry.href === "/build/types") {
              return (
                <div key={entry.href}>
                  <div className="flex items-stretch">
                    <Link
                      href={entry.href}
                      onClick={onNavigate}
                      aria-current={active ? "page" : undefined}
                      className={`${linkClass(active)} min-w-0 flex-1`}
                    >
                      <NavGlyph icon={entry.icon} size={18} />
                      <span className="truncate">{entry.label}</span>
                    </Link>
                    {types.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setTypesOpen((o) => !o)}
                        aria-label={typesOpen ? "Collapse types" : "Expand types"}
                        aria-expanded={typesOpen}
                        className="rounded-lg px-1.5 text-neutral-500 hover:bg-neutral-800/60 hover:text-neutral-300"
                      >
                        <Chevron open={typesOpen} />
                      </button>
                    )}
                  </div>
                  {typesOpen && types.length > 0 && (
                    <div className="mb-1 ml-3 flex flex-col gap-0.5 border-l border-neutral-800 pl-2">
                      {types.map((t) => {
                        const href = `/build/types/${t.key}/edit`;
                        const tActive = pathname === href;
                        return (
                          <Link
                            key={t.key}
                            href={href}
                            onClick={onNavigate}
                            aria-current={tActive ? "page" : undefined}
                            className={`flex items-center gap-2 rounded px-2 py-1 text-[13px] ${
                              tActive
                                ? "bg-neutral-800 text-neutral-100"
                                : "text-neutral-500 hover:bg-neutral-800/60 hover:text-neutral-300"
                            }`}
                          >
                            <NavGlyph icon={t.icon ?? "items"} size={15} />
                            <span className="truncate">{t.label}</span>
                          </Link>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            }
            return (
              <Link
                key={entry.href}
                href={entry.href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={linkClass(active)}
              >
                <NavGlyph icon={entry.icon} size={18} />
                <span className="truncate">{entry.label}</span>
              </Link>
            );
          })}
        </div>
      ))}

      <div className="mt-auto pt-3">
        <div className="mb-1 border-t border-neutral-800" />
        <Link
          href="/"
          onClick={onNavigate}
          className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm text-neutral-400 hover:bg-neutral-800/60 hover:text-neutral-200"
        >
          <BackArrow />
          Back to Work
        </Link>
      </div>
    </div>
  );
}

export default function BuildSidebar({
  types,
  aiMemoryEnabled,
  onOpenSearch,
}: {
  types: BuildType[];
  aiMemoryEnabled: boolean;
  onOpenSearch: () => void;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <>
      {/* Desktop: a fixed full-height left rail. */}
      <aside
        className="fixed inset-y-0 left-0 z-40 hidden border-r border-neutral-800 bg-neutral-900/95 shadow-xl shadow-black/30 backdrop-blur sm:block"
        style={{ width: BUILD_SIDEBAR_W }}
        aria-label="Build navigation"
      >
        <SidebarContent types={types} aiMemoryEnabled={aiMemoryEnabled} onOpenSearch={onOpenSearch} />
      </aside>

      {/* Mobile: a hamburger that opens the same content as a slide-in drawer.
          Mobile Build is intentionally minimal this phase — enough to navigate
          and return to Work. */}
      <button
        type="button"
        onClick={() => setDrawerOpen(true)}
        aria-label="Open Build menu"
        className="fixed left-3 top-[calc(0.75rem+var(--safe-top))] z-40 flex items-center gap-2 rounded-lg border border-[var(--accent)] bg-[var(--accent)]/15 px-2.5 py-1.5 text-sm font-semibold text-[var(--accent)] shadow-[0_0_14px_-3px_var(--accent)] backdrop-blur sm:hidden"
      >
        <HamburgerIcon />
        Build
      </button>
      {drawerOpen && (
        <div className="fixed inset-0 z-50 sm:hidden" role="dialog" aria-modal="true" aria-label="Build menu">
          <div className="absolute inset-0 bg-black/60" onClick={() => setDrawerOpen(false)} />
          <div
            className="absolute inset-y-0 left-0 border-r border-neutral-800 bg-neutral-900 pt-[var(--safe-top)]"
            style={{ width: BUILD_SIDEBAR_W }}
          >
            <SidebarContent
              types={types}
              aiMemoryEnabled={aiMemoryEnabled}
              onOpenSearch={onOpenSearch}
              onNavigate={() => setDrawerOpen(false)}
            />
          </div>
        </div>
      )}
    </>
  );
}
