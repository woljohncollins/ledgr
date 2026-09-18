// User Settings form (v5). Display name, highlight accent (solid colors or a
// gradient), Trash retention, and the nav layout controls (position + spacing) —
// the same controls offered in the nav "More" menu, mirrored here. Each change
// saves to /api/settings; the accent updates the live `--accent` /
// `--accent-gradient` CSS variables immediately, and nav-layout changes
// router.refresh() so the live nav re-renders without a manual reload.
"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  HIGHLIGHT_COLORS,
  HIGHLIGHT_GRADIENTS,
  ITEM_OPEN_MODES,
  NAV_POSITIONS,
  NOTIFICATION_KINDS,
  notificationEnabled,
  SECTION_STYLES,
  TEXT_SIZES,
  TEXT_SIZE_PX,
  UI_DENSITIES,
  type RailAnchor,
  type SectionStyle,
  type TextSize,
  type UiDensity,
  type UserSettings,
  THEMES,
  THEME_LABELS,
} from "@/lib/settings";
import { accentHighlightImageCss } from "@/lib/colors";
import { TOOLBAR_ITEMS } from "@/components/markdown-editor/toolbar-icons";
import { NOTIFICATION_CENTER_ENABLED } from "@/lib/notifications-enabled";
import AiMemoryLearnMore from "@/components/settings/AiMemoryLearnMore";
import NoteEditingPromptActions from "@/components/settings/NoteEditingPromptActions";

const POSITION_LABELS: Record<UserSettings["navPosition"], string> = {
  top: "Top",
  bottom: "Bottom",
  left: "Left",
  right: "Right",
};

// Where a clicked item opens. "Automatic" names the measured behavior rather than
// hiding it, so the default is a visible choice instead of an unexplained one.
const ITEM_OPEN_LABELS: Record<UserSettings["itemOpenMode"], string> = {
  auto: "Automatic",
  left: "Panel, left",
  right: "Panel, right",
  center: "Popup",
};

const UI_DENSITY_LABELS: Record<UiDensity, string> = {
  compact: "Compact",
  default: "Default",
  comfortable: "Comfortable",
  roomy: "Roomy",
};

const SECTION_STYLE_LABELS: Record<SectionStyle, string> = {
  heavy: "Heavy",
  light: "Light",
  unified: "Unified",
};

// The full IANA zone list from the runtime, with a curated fallback for the rare
// engine without Intl.supportedValuesOf. Computed once (module scope).
const ALL_TIMEZONES: string[] = (() => {
  try {
    const sv = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    if (sv) return sv("timeZone");
  } catch {
    /* fall through */
  }
  return [
    "America/New_York",
    "America/Chicago",
    "America/Denver",
    "America/Phoenix",
    "America/Los_Angeles",
    "America/Anchorage",
    "Pacific/Honolulu",
    "UTC",
  ];
})();

export default function SettingsForm({
  initial,
  serverDefaultTz,
}: {
  initial: UserSettings;
  // The zone "Automatic" falls back to (the LEDGR_TIMEZONE env, else
  // America/New_York), shown in the label so the default is legible.
  serverDefaultTz: string;
}) {
  const [settings, setSettings] = useState<UserSettings>(initial);
  const [saved, setSaved] = useState(false);
  const router = useRouter();

  // The search dictionary (ADR-172) is stored as word -> [synonyms], but edited as
  // rows of text so the word itself stays editable without key-collision
  // weirdness mid-keystroke. Serialized back to the record on commit, where
  // blank/synonym-less rows simply drop out (parseSearchSynonyms would drop them
  // anyway; doing it here keeps the saved blob clean).
  const [dictRows, setDictRows] = useState<{ word: string; synonyms: string }[]>(() =>
    Object.entries(initial.searchSynonyms).map(([word, syns]) => ({
      word,
      synonyms: syns.join(", "),
    }))
  );
  const commitDict = (rows: { word: string; synonyms: string }[]) => {
    const next: Record<string, string[]> = {};
    for (const row of rows) {
      const word = row.word.trim().toLowerCase();
      const synonyms = row.synonyms
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (word && synonyms.length > 0) next[word] = synonyms;
    }
    void save({ searchSynonyms: next });
  };
  const setDictRow = (i: number, patch: Partial<{ word: string; synonyms: string }>) =>
    setDictRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const saveDict = () => commitDict(dictRows);

  // Timezone drives every "today" boundary and the wall-clock of every displayed
  // time. Server surfaces render it, so a change router.refresh()es to take hold.
  const setTimezone = (tz: string | null) => {
    setSettings((s) => ({ ...s, timezone: tz }));
    void save({ timezone: tz }, true);
  };
  // Ensure the currently-saved zone is always selectable even if the runtime's
  // list somehow omits it (a hand-set value, an older list).
  const zoneOptions =
    settings.timezone && !ALL_TIMEZONES.includes(settings.timezone)
      ? [settings.timezone, ...ALL_TIMEZONES]
      : ALL_TIMEZONES;

  const isRail = settings.navPosition === "left" || settings.navPosition === "right";

  // Push the chosen accent to the live CSS vars: `--accent` is always a solid
  // (so text/borders/glows stay valid); `--accent-gradient` is the gradient when
  // one is picked, else the same solid.
  //
  // `--accent-highlight-image` has to move with them (ADR-250). It is the image
  // channel of the accent highlight, and for a GRADIENT accent it is the only
  // layer you can actually see, painting over the `background-color` underneath.
  // Leaving it out here is what made changing your accent look like it did
  // nothing: `--accent` updated instantly, the highlight kept the gradient the
  // server wrote at page load, and it only corrected on a full reload. These
  // three vars are one setting; they get written together or the highlight lies.
  const applyAccent = (color: string, gradient: string | null) => {
    document.body.style.setProperty("--accent", color);
    document.body.style.setProperty("--accent-gradient", gradient ?? color);
    document.body.style.setProperty(
      "--accent-highlight-image",
      gradient ? accentHighlightImageCss(gradient) : "none"
    );
  };

  const applyTextSize = (size: TextSize) => {
    document.body.style.setProperty("--prose-font-size", TEXT_SIZE_PX[size]);
  };

  // The section style is a body attribute the CanvasSection CSS reads, so setting
  // it re-skins every item-canvas panel live, no reload.
  const applySectionStyle = (style: SectionStyle) => {
    document.body.setAttribute("data-section-style", style);
  };

  const save = async (patch: Partial<UserSettings>, refresh = false) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    try {
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 1200);
      // Nav layout is rendered server-side (Nav → NavShell); refresh so a
      // position/spacing change shows up live, matching the More-menu behavior.
      if (refresh) router.refresh();
    } catch {
      /* offline; the next change retries */
    }
  };

  // The segmented-button look from the nav "More" menu.
  const segBtn = (active: boolean) =>
    `rounded px-2 py-1.5 text-xs ${
      active
        ? "bg-neutral-700 text-neutral-100"
        : "text-neutral-300 hover:bg-neutral-800"
    }`;

  const setSpacing = (density: "spread" | "compact", anchor?: RailAnchor) =>
    void save(
      { navDensity: density, ...(anchor ? { railAnchor: anchor } : {}) },
      true
    );
  const spacingActive = (density: "spread" | "compact", anchor?: RailAnchor) =>
    settings.navDensity === density && (!anchor || settings.railAnchor === anchor);

  return (
    <div className="mt-6 flex max-w-xl flex-col gap-6">
      <section>
        <h2 className="text-sm font-semibold text-neutral-200">Display name</h2>
        <p className="mt-0.5 text-sm text-neutral-500">
          Shown wherever your name appears in the app. Leave blank to use your
          email name.
        </p>
        <input
          type="text"
          maxLength={60}
          placeholder="Your name"
          value={settings.displayName}
          onChange={(e) => setSettings({ ...settings, displayName: e.target.value })}
          onBlur={() => void save({ displayName: settings.displayName })}
          className="mt-2 w-48 rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-sm text-neutral-200 outline-none focus:border-neutral-600"
        />
      </section>

      <section>
        <h2 className="text-sm font-semibold text-neutral-200">Timezone</h2>
        <p className="mt-0.5 text-sm text-neutral-500">
          Sets what &quot;today&quot; means and the clock times shown throughout
          the app (meetings, due dates, timestamps). Traveling doesn&apos;t
          change it, so your times stay put wherever you are.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select
            value={settings.timezone ?? ""}
            onChange={(e) => setTimezone(e.target.value || null)}
            className="w-64 rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-sm text-neutral-200 outline-none focus:border-neutral-600"
          >
            <option value="">Automatic ({serverDefaultTz})</option>
            {zoneOptions.map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, " ")}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => {
              try {
                const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
                if (detected) setTimezone(detected);
              } catch {
                /* leave the current value */
              }
            }}
            className="rounded border border-neutral-800 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
          >
            Use this device&apos;s timezone
          </button>
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-neutral-200">Quick Add</h2>
        <p className="mt-0.5 text-sm text-neutral-500">
          Which actions show on the quick-capture card for tasks.
        </p>
        <div className="mt-2 flex flex-col gap-1">
          {[
            { id: "deadline", label: "Deadline (due date)" },
            { id: "priority", label: "Priority" },
            { id: "tags", label: "Tag" },
            { id: "person", label: "Person" },
            { id: "group", label: "Group" },
            { id: "assignee", label: "Assignee" },
          ].map((it) => {
            const shown = !settings.quickAddHidden.includes(it.id);
            return (
              <label key={it.id} className="flex items-center gap-2 text-sm text-neutral-300">
                <input
                  type="checkbox"
                  checked={shown}
                  onChange={() => {
                    const set = new Set(settings.quickAddHidden);
                    if (set.has(it.id)) set.delete(it.id);
                    else set.add(it.id);
                    void save({ quickAddHidden: [...set] });
                  }}
                  className="accent-[var(--accent)]"
                />
                {it.label}
              </label>
            );
          })}
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-neutral-200">Editor toolbar</h2>
        <p className="mt-0.5 text-sm text-neutral-500">
          Which buttons show in the markdown editor toolbar (every canvas).
          Unchecking hides one; takes effect on the next page load.
        </p>
        <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3">
          {TOOLBAR_ITEMS.map((it) => {
            const shown = !settings.editorToolbarHidden.includes(it.id);
            return (
              <label key={it.id} className="flex items-center gap-2 text-sm text-neutral-300">
                <input
                  type="checkbox"
                  checked={shown}
                  onChange={() => {
                    const set = new Set(settings.editorToolbarHidden);
                    if (set.has(it.id)) set.delete(it.id);
                    else set.add(it.id);
                    void save({ editorToolbarHidden: [...set] });
                  }}
                  className="accent-[var(--accent)]"
                />
                {it.label}
              </label>
            );
          })}
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-neutral-200">Editor features</h2>
        <p className="mt-0.5 text-sm text-neutral-500">
          Optional block behaviors in the markdown editor. Take effect on the
          next page load.
        </p>
        <label className="mt-2 flex items-start gap-2 text-sm text-neutral-300">
          <input
            type="checkbox"
            checked={settings.collapsibleHeadingsEnabled}
            onChange={(e) => void save({ collapsibleHeadingsEnabled: e.target.checked })}
            className="accent-[var(--accent)] mt-0.5"
          />
          <span>
            Collapsible headings
            <span className="block text-xs text-neutral-500">
              A fold arrow on each heading hides or shows the section beneath it.
              View only, nothing changes in the saved note.
            </span>
          </span>
        </label>
        <label className="mt-2 flex items-start gap-2 text-sm text-neutral-300">
          <input
            type="checkbox"
            checked={settings.toggleBlocksEnabled}
            onChange={(e) => void save({ toggleBlocksEnabled: e.target.checked })}
            className="accent-[var(--accent)] mt-0.5"
          />
          <span>
            Toggle blocks
            <span className="block text-xs text-neutral-500">
              Insert a collapsible block (a summary line that expands to reveal
              content) from the toolbar or the{" "}
              <code className="rounded bg-neutral-800 px-1 py-0.5 font-mono text-[11px] text-neutral-400">
                /toggle
              </code>{" "}
              slash command. Existing toggles still show when this is off.
            </span>
          </span>
        </label>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-neutral-200">Highlight color</h2>
        <p className="mt-0.5 text-sm text-neutral-500">
          The accent used for primary buttons and highlights.
        </p>
        <div className="mt-2 flex max-w-md flex-wrap gap-2">
          {HIGHLIGHT_COLORS.map((c) => {
            const selected = !settings.highlightGradient && settings.highlightColor === c.value;
            return (
              <button
                key={c.value}
                onClick={() => {
                  applyAccent(c.value, null);
                  void save({ highlightColor: c.value, highlightGradient: null });
                }}
                aria-label={c.name}
                aria-pressed={selected}
                title={c.name}
                className={`h-7 w-7 rounded-full border-2 ${selected ? "border-neutral-100" : "border-transparent"}`}
                style={{ background: c.value }}
              />
            );
          })}
        </div>

        <p className="mt-3 text-xs font-medium uppercase tracking-wide text-neutral-600">
          Gradients
        </p>
        <p className="mt-0.5 text-xs text-neutral-500">
          Applied to accent fills (checkboxes, count badges); text and borders use
          a matching solid tone.
        </p>
        <div className="mt-2 flex max-w-md flex-wrap gap-2">
          {HIGHLIGHT_GRADIENTS.map((g) => {
            const selected = settings.highlightGradient === g.value;
            return (
              <button
                key={g.value}
                onClick={() => {
                  applyAccent(g.accent, g.value);
                  void save({ highlightColor: g.accent, highlightGradient: g.value });
                }}
                aria-label={g.name}
                aria-pressed={selected}
                title={g.name}
                className={`h-7 w-7 rounded-full border-2 ${selected ? "border-neutral-100" : "border-transparent"}`}
                style={{ background: g.value }}
              />
            );
          })}
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-neutral-200">Trash retention</h2>
        <p className="mt-0.5 text-sm text-neutral-500">Days a trashed item is kept before it is purged.</p>
        <input
          type="number"
          min={1}
          max={365}
          value={settings.trashRetentionDays}
          onChange={(e) => void save({ trashRetentionDays: Number(e.target.value) || 30 })}
          className="mt-2 w-24 rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-sm text-neutral-200 outline-none focus:border-neutral-600"
        />
      </section>

      {/* Notification center paused (ADR-130): the per-source toggles are hidden
          while the center is detached. Flip NOTIFICATION_CENTER_ENABLED to bring
          this section (and the prefs it edits) back. */}
      {NOTIFICATION_CENTER_ENABLED && (
      <section>
        <h2 className="text-sm font-semibold text-neutral-200">Notifications</h2>
        <p className="mt-0.5 text-sm text-neutral-500">
          Which events show up in your notification center (and send a push when
          enabled). Turning one off silences both the entry and the push.
        </p>
        <div className="mt-2 flex flex-col gap-2">
          {NOTIFICATION_KINDS.map(({ kind, label, help }) => {
            const on = notificationEnabled(settings.notificationPrefs, kind);
            return (
              <label key={kind} className="flex items-start gap-2 text-sm text-neutral-300">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(e) =>
                    void save({
                      notificationPrefs: {
                        ...settings.notificationPrefs,
                        [kind]: e.target.checked,
                      },
                    })
                  }
                  className="ledgr-check mt-0.5"
                />
                <span>
                  {label}
                  <span className="block text-xs text-neutral-500">{help}</span>
                </span>
              </label>
            );
          })}
        </div>
      </section>
      )}

      <section>
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-neutral-200">AI Memory</h2>
          <AiMemoryLearnMore />
        </div>
        <p className="mt-0.5 text-sm text-neutral-500">
          Let an AI assistant keep durable memories in Ledgr, read over MCP. When
          on, a “stumps” index of what you’ve chosen to remember loads at the start
          of a session and the assistant can follow the links from a memory to the
          people, projects, and notes it’s about. Turning this on adds the{" "}
          <a href="/build/memory" className="text-[var(--accent)] hover:underline">
            Build → AI&nbsp;Memory
          </a>{" "}
          surface and exposes two memory tools to connected AI clients. Off by
          default: a fresh Ledgr behaves exactly as before, and a plain MCP client
          never sees the memory tools.
        </p>
        <label className="mt-2 flex items-start gap-2 text-sm text-neutral-300">
          <input
            type="checkbox"
            checked={settings.aiMemoryEnabled}
            onChange={(e) => void save({ aiMemoryEnabled: e.target.checked }, true)}
            className="ledgr-check mt-0.5"
          />
          <span>
            Use Ledgr to manage AI memory
            <span className="block text-xs text-neutral-500">
              Stores memories as a hidden item type and turns on the{" "}
              <code className="rounded bg-neutral-800 px-1 py-0.5 font-mono text-[11px] text-neutral-400">
                get_memory_stumps
              </code>{" "}
              and{" "}
              <code className="rounded bg-neutral-800 px-1 py-0.5 font-mono text-[11px] text-neutral-400">
                remember
              </code>{" "}
              MCP tools.
            </span>
          </span>
        </label>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-neutral-200">
          Live editing context
        </h2>
        <p className="mt-0.5 text-sm text-neutral-500">
          Let an AI assistant see the note you currently have open (and the text
          you’ve highlighted) so it can co-edit it live, the way Notion’s AI
          sidebar works. Say “use my note-editing prompt,” then things like “help
          me sharpen this” or “rework this sentence” resolve to the open note.
          When on, the open item reports what you’re viewing to a single private
          row and exposes two MCP tools ({" "}
          <code className="rounded bg-neutral-800 px-1 py-0.5 font-mono text-[11px] text-neutral-400">
            get_active_context
          </code>{" "}
          and{" "}
          <code className="rounded bg-neutral-800 px-1 py-0.5 font-mono text-[11px] text-neutral-400">
            edit_item_body
          </code>
          ) to connected AI clients, and seeds an editable “Note Editing Partner”
          prompt. Off by default: nothing is tracked and a plain MCP client never
          sees these tools.
        </p>
        <label className="mt-2 flex items-start gap-2 text-sm text-neutral-300">
          <input
            type="checkbox"
            checked={settings.liveContextEnabled}
            onChange={(e) => void save({ liveContextEnabled: e.target.checked }, true)}
            className="ledgr-check mt-0.5"
          />
          <span>
            Track the note I’m viewing for AI editing
            <span className="block text-xs text-neutral-500">
              Reports the open item and your selection while a note is open;
              clears when you close it. Your own single-user data.
            </span>
          </span>
        </label>
        {settings.liveContextEnabled && <NoteEditingPromptActions />}
      </section>

      <section>
        <h2 className="text-sm font-semibold text-neutral-200">Text size</h2>
        <p className="mt-0.5 text-sm text-neutral-500">
          Font size for the reading and editing canvas.
        </p>
        <div className="mt-2 flex gap-1">
          {TEXT_SIZES.map((size) => {
            const labels: Record<TextSize, string> = { sm: "S", base: "M", lg: "L", xl: "XL" };
            return (
              <button
                key={size}
                onClick={() => {
                  applyTextSize(size);
                  void save({ textSize: size });
                }}
                className={segBtn(settings.textSize === size)}
              >
                {labels[size]}
              </button>
            );
          })}
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-neutral-200">Section style</h2>
        <p className="mt-0.5 text-sm text-neutral-500">
          How much weight each panel on an item view carries (People, Open tasks,
          Properties, Linked here). Heavy is bordered cards; Light is a divider
          rule; Unified is flat with minimal chrome.
        </p>
        <div className="mt-2 flex gap-1">
          {SECTION_STYLES.map((style) => (
            <button
              key={style}
              onClick={() => {
                applySectionStyle(style);
                void save({ sectionStyle: style });
              }}
              className={segBtn(settings.sectionStyle === style)}
            >
              {SECTION_STYLE_LABELS[style]}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-neutral-200">Theme</h2>
        <p className="mt-0.5 text-sm text-neutral-500">
          The app&apos;s overall look. Applies everywhere you&apos;re signed in, and
          new share links open in this theme by default.
        </p>
        <div className="mt-3 flex flex-wrap gap-1">
          {THEMES.map((t) => (
            <button
              key={t}
              onClick={() => void save({ theme: t }, true)}
              className={segBtn(settings.theme === t)}
            >
              {THEME_LABELS[t]}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-neutral-200">Display density</h2>
        <p className="mt-0.5 text-sm text-neutral-500">
          How much space the whole interface uses. Menus, buttons, titles, and
          spacing all scale together, so everything stays easy to read and tap.
          Set desktop and mobile separately.
        </p>
        <div className="mt-3 flex flex-col gap-3">
          <div>
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-neutral-600">
              Desktop
            </p>
            <div className="flex flex-wrap gap-1">
              {UI_DENSITIES.map((d) => (
                <button
                  key={d}
                  onClick={() => void save({ uiDensity: d }, true)}
                  className={segBtn(settings.uiDensity === d)}
                >
                  {UI_DENSITY_LABELS[d]}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-neutral-600">
              Mobile
            </p>
            <div className="flex flex-wrap gap-1">
              <button
                onClick={() => void save({ mobileUiDensity: null }, true)}
                className={segBtn(settings.mobileUiDensity === null)}
              >
                Same as desktop
              </button>
              {UI_DENSITIES.map((d) => (
                <button
                  key={d}
                  onClick={() => void save({ mobileUiDensity: d }, true)}
                  className={segBtn(settings.mobileUiDensity === d)}
                >
                  {UI_DENSITY_LABELS[d]}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-neutral-200">Navigation position</h2>
        <p className="mt-0.5 text-sm text-neutral-500">Where the nav bar sits.</p>
        <div className="mt-2 grid w-48 grid-cols-2 gap-1">
          {NAV_POSITIONS.map((p) => (
            <button
              key={p}
              onClick={() => void save({ navPosition: p }, true)}
              className={segBtn(settings.navPosition === p)}
            >
              {POSITION_LABELS[p]}
            </button>
          ))}
        </div>
      </section>

      {/* Where an item opens when you click it from a list. Sits right after the
          nav position because the two interact: a docked rail owns its edge, so a
          left rail plus a left panel falls back to the free edge (or the popup). */}
      <section>
        <h2 className="text-sm font-semibold text-neutral-200">Opening an item</h2>
        <p className="mt-0.5 text-sm text-neutral-500">
          Where an item opens when you click it from a list. Automatic docks a
          panel on wide screens and uses the popup otherwise. A phone always uses
          the bottom sheet.
        </p>
        <div className="mt-2 grid w-48 grid-cols-2 gap-1">
          {ITEM_OPEN_MODES.map((m) => (
            <button
              key={m}
              onClick={() => void save({ itemOpenMode: m }, true)}
              className={segBtn(settings.itemOpenMode === m)}
            >
              {ITEM_OPEN_LABELS[m]}
            </button>
          ))}
        </div>
        {/* Name the collision rather than letting it look like the setting was
            ignored — the exact "invisible behavior" trap ADR-179 came from. */}
        {(settings.itemOpenMode === "left" || settings.itemOpenMode === "right") &&
          settings.navPosition === settings.itemOpenMode && (
            <p className="mt-1.5 text-xs text-amber-400/80">
              Your nav rail is docked {settings.itemOpenMode}, so the panel opens on
              the opposite edge instead.
            </p>
          )}
      </section>

      {/* Spacing mirrors the More menu: how the slots pack into the bar/rail.
          The bottom bar is always compact, so it offers no spacing choice. */}
      {settings.navPosition !== "bottom" && (
        <section>
          <h2 className="text-sm font-semibold text-neutral-200">Spacing</h2>
          <p className="mt-0.5 text-sm text-neutral-500">
            Spread the slots across the bar, or group them and anchor the cluster.
          </p>
          <div className="mt-2 grid w-48 grid-cols-1 gap-1">
            <button onClick={() => setSpacing("spread")} className={segBtn(spacingActive("spread"))}>
              Spread
            </button>
            <button
              onClick={() => setSpacing("compact", "top")}
              className={segBtn(spacingActive("compact", "top"))}
            >
              {isRail ? "Compact (top)" : "Compact (left)"}
            </button>
            <button
              onClick={() => setSpacing("compact", "center")}
              className={segBtn(spacingActive("compact", "center"))}
            >
              Compact (center)
            </button>
            <button
              onClick={() => setSpacing("compact", "bottom")}
              className={segBtn(spacingActive("compact", "bottom"))}
            >
              {isRail ? "Compact (bottom)" : "Compact (right)"}
            </button>
          </div>
        </section>
      )}

      {/* The owner's personal search dictionary (ADR-172). Fuzzy search already
          expands a word through WordNet, which knows English but not Edgewood —
          it will not connect "teaching" to "preaching", or know that "message"
          means a sermon here. This is the fix, and it's meant to stay small:
          add a line only when a search actually misses. */}
      <section>
        <h2 className="text-sm font-semibold text-neutral-200">Search dictionary</h2>
        <p className="mt-0.5 text-sm text-neutral-500">
          Extra words fuzzy search should treat as matches for each other. General
          English synonyms are already built in, so this is for your own
          vocabulary. Add one when a search misses something you knew was there.
        </p>
        <div className="mt-2 flex flex-col gap-1.5">
          {dictRows.map((row, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                type="text"
                maxLength={60}
                placeholder="teaching"
                aria-label="Word"
                value={row.word}
                onChange={(e) => setDictRow(i, { word: e.target.value })}
                onBlur={saveDict}
                className="w-32 shrink-0 rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-sm text-neutral-200 outline-none focus:border-neutral-600"
              />
              <span className="shrink-0 text-xs text-neutral-600">also matches</span>
              <input
                type="text"
                placeholder="preaching, message, lesson"
                aria-label="Synonyms, comma separated"
                value={row.synonyms}
                onChange={(e) => setDictRow(i, { synonyms: e.target.value })}
                onBlur={saveDict}
                className="min-w-0 flex-1 rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-sm text-neutral-200 outline-none focus:border-neutral-600"
              />
              <button
                type="button"
                aria-label="Remove this entry"
                onClick={() => {
                  const next = dictRows.filter((_, j) => j !== i);
                  setDictRows(next);
                  commitDict(next);
                }}
                className="rounded px-1.5 text-neutral-600 hover:bg-neutral-800 hover:text-neutral-300"
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setDictRows((prev) => [...prev, { word: "", synonyms: "" }])}
            className="w-fit rounded border border-dashed border-neutral-800 px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
          >
            + add a word
          </button>
        </div>
      </section>

      {/* Floating, not inline: the form is long and controls live throughout it,
          so an inline confirmation at the bottom is invisible when you change a
          mid-form control (e.g. Section style). A fixed pill is seen from any
          scroll position. */}
      {saved && (
        <p className="fixed bottom-4 right-4 z-50 rounded-md bg-neutral-800 px-3 py-1.5 text-xs text-neutral-200 shadow-lg ring-1 ring-neutral-700">
          Saved
        </p>
      )}
    </div>
  );
}
