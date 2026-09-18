// Title + body editing with debounced autosave against PATCH /api/items/:id.
// The editing core the item canvas (PRD §4.13) wraps with modal chrome and
// field zones; kept free of layout opinions for that reason. The body is
// canonical markdown (ADR-037/ADR-040): the markdown editor reads the body's
// text and emits markdown on every edit, which we wrap back into the
// { format, text } shape the API and DB store.
"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { bodyDigest, bodyMarkdown, makeMarkdownBody } from "@/lib/body";
import {
  beginSave,
  clearLocalSave,
  endSave,
  registerDirtyCheck,
  registerForceSave,
  registerSaveRetry,
  reportConflict,
  setKnownVersion,
} from "@/lib/save-status";
import { publishBodyMarkdown } from "@/lib/word-count";
import { uploadAttachment } from "@/components/attachments/upload";
import BodyEditor from "./BodyEditor";
import type { PromotedRefs } from "./block-anchor-extension";
import { useTokenAutocomplete } from "./useTokenAutocomplete";

const SAVE_DEBOUNCE_MS = 1500;

// Presigned-upload flow: the shared uploadAttachment handshake (any file type —
// the editor embeds images and links everything else), resolved to the stable
// /files/<id> address the body stores (fileUrl, not publicUrl, ADR-228).
async function uploadFile(itemId: string, file: File): Promise<string> {
  return (await uploadAttachment(itemId, file)).fileUrl;
}

export type ItemEditorProps = {
  item: { id: string; title: string; body: unknown };
  // Canvas top strip (PRD §4.13), rendered between the title and the body.
  fields?: React.ReactNode;
  // Which block to render (ADR-069 field-level canvas cards). "full" is the
  // classic stacked editor (title + fields + body). "title"/"body" render just
  // that block, bare (no canvas chrome), so each can live in its own grid card;
  // each instance keeps its own debounced autosave for the field it owns.
  slot?: "full" | "title" | "body";
  // When this item is a meeting (ADR-090): enable the body editor's per-line
  // "→ task" promote affordance, posting to this meeting's promote endpoint.
  promoteToMeetingId?: string;
  // blockRef → promoted task (ADR-090), so already-promoted lines show a badge.
  promotedRefs?: PromotedRefs;
  // Canvas tabs (ADR-094): when true, the body is editable as named tabs (a
  // strip + "+ Add tab"); tabs are sections of the same markdown body.
  tabsEnabled?: boolean;
  // Desk panels (ADR-147 D5): the active canvas-section, controlled by the
  // panel's merged sub-tab chips. When set, TabbedBody hides its own strip and
  // shows just this section. Unused by the normal item canvas.
  controlledSection?: number;
  // Body-editor presentation (the task canvas opts in): hide the formatting bar
  // behind a top-right toggle, and start one line tall + grow. Forwarded to the
  // MarkdownEditor; default off keeps the roomy always-on editor.
  collapsibleToolbar?: boolean;
  compactBody?: boolean;
  // When true (the item lock toggle): the title and body are read-only and the
  // cursor can't enter them, and the body's toolbar hides. The field strip and
  // properties are locked by their own hosts (FieldStrip / CustomProperties).
  locked?: boolean;
  // Task title slot (ADR-108): when the task is complete, strike through + dim
  // the title (the done treatment). Driven by the adjacent completion circle
  // (TaskTitle); the decoration must sit on the textarea itself, since
  // text-decoration doesn't cross a textarea's boundary from a parent.
  done?: boolean;
  // Additive live-text tap (ADR-146, the Desk). When set, every title/body edit
  // is mirrored out on the same keystroke it's queued for save — so the Desk's
  // read-only twins update live and a re-focused editor re-seeds without losing
  // unsaved text. Does NOT touch the save path (debounce/PATCH/revisions); it's
  // a read-only observation, unused by the normal item canvas.
  onLiveChange?: (next: { title?: string; markdown?: string }) => void;
  // Follower mode (ADR-165, the Desk). When true this editor is a live MIRROR of
  // the item, not the source of edits: it stays mounted and editable-looking (so
  // taking the pen is a seamless in-place flip, not a remount) but it applies the
  // source panel's live title/body from the `item` prop instead of driving them,
  // and it never publishes or saves. It also keeps its save baseline advanced to
  // the mirrored content and flushes on becoming a follower, so handing the pen
  // back and forth between panels never trips the cross-device 409 guard
  // (ADR-134). Default false = the normal, sole-source editor.
  follower?: boolean;
};

export default function ItemEditor({
  item,
  fields,
  slot = "full",
  promoteToMeetingId,
  promotedRefs,
  tabsEnabled = false,
  collapsibleToolbar = false,
  compactBody = false,
  locked = false,
  done = false,
  onLiveChange,
  controlledSection,
  follower = false,
}: ItemEditorProps) {
  const [title, setTitle] = useState(item.title);
  // Follower mode (ADR-165): mirror the source's live title. `item.title` comes
  // from the Desk doc store and updates as the source publishes; a follower
  // adopts it. Done as a render-time state adjustment (React's "adjusting state
  // on a prop change") rather than an effect, so it doesn't cascade — and so the
  // value the pen inherits when this panel later becomes the source is already
  // current. The source ignores it (its own typing drives the title).
  const [lastItemTitle, setLastItemTitle] = useState(item.title);
  if (item.title !== lastItemTitle) {
    setLastItemTitle(item.title);
    if (follower) setTitle(item.title);
  }
  // Bumped when Enter is pressed in the title, to move the caret into the body
  // editor (fix: Enter in the title should jump to the body, not just blur). 0 =
  // don't focus, so the body never steals focus on a normal load.
  const [bodyFocusSignal, setBodyFocusSignal] = useState(0);
  const pending = useRef<{ title?: string; body?: unknown }>({});
  // The markdown of the body as last persisted, seeded from what loaded. The
  // editor re-emits the loaded body once when it mounts (a programmatic editor
  // transaction, not a user edit), so opening an item would otherwise schedule
  // a debounced save of an unchanged body — flashing the save indicator and
  // (before the API-side no-op guard in updateItem) bumping the item's edit
  // date. We skip a body change identical to this; a real edit always differs.
  const savedBodyText = useRef(bodyMarkdown(item.body));
  // The body text we last successfully synced with the server, seeded from the
  // loaded body. Distinct from savedBodyText (which tracks the latest LOCAL text
  // for the on-open dedup): this is the baseline the cross-device guard digests,
  // so it advances only when a save lands, not on every keystroke (ADR-134).
  const syncedBodyText = useRef(bodyMarkdown(item.body));
  // True between a 409 conflict and its resolution, so the autosave loop stops
  // re-arming the debounce (a normal retry would just 409 again); the pending
  // body is held for "Keep mine" to force through.
  const conflictPending = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const didAutofocus = useRef(false);

  // New items land ready to type: focus the title when an item opens with an
  // empty title (the most common entry action). Once only, and never for the
  // bare body slot (which has no title input). Existing-titled items are left
  // alone so opening them to read doesn't steal focus.
  useEffect(() => {
    if (didAutofocus.current || slot === "body") return;
    didAutofocus.current = true;
    if (item.title === "") titleRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // force: "Keep mine" — resend without the cross-device guard token, knowingly
  // overwriting the other device's change (its body is still in revision history).
  const flush = useCallback(async (opts?: { force?: boolean }) => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const patch = pending.current;
    if (Object.keys(patch).length === 0 || inFlight.current) return;
    pending.current = {};
    inFlight.current = true;
    // The body text this PATCH carries (if any), to advance the sync baseline
    // once it lands.
    const sentBodyText =
      patch.body !== undefined ? bodyMarkdown(patch.body) : null;
    // Guard a body write against a concurrent edit on another device (ADR-134):
    // attach the digest of the body we last synced with, so the server refuses
    // the write if the stored body moved on. Omitted on a forced resave.
    const requestBody =
      !opts?.force && patch.body !== undefined
        ? {
            ...patch,
            expectedBodyDigest: bodyDigest(
              makeMarkdownBody(syncedBodyText.current)
            ),
          }
        : patch;
    // Report to the app-wide save signal (the floating SaveStatusIndicator);
    // the per-editor "Saved" badge was retired for it (Brandon, 2026-06-17).
    beginSave();
    try {
      const res = await fetch(`/api/items/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      if (res.status === 409) {
        // The body changed on another device since we synced. Hold the pending
        // edit for "Keep mine", surface the conflict banner, and stop — auto-
        // retrying would just 409 again. inFlight clears in `finally`.
        pending.current = { ...patch, ...pending.current };
        conflictPending.current = true;
        reportConflict();
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      // Synced: advance the guard baseline and the focus baseline from the row
      // the server returned, so our own edits never read as a remote change.
      const data = (await res.json().catch(() => null)) as {
        item?: { updatedAt?: string };
      } | null;
      if (sentBodyText !== null) syncedBodyText.current = sentBodyText;
      const advanced = Boolean(data?.item?.updatedAt);
      if (advanced) setKnownVersion(data!.item!.updatedAt!);
      conflictPending.current = false;
      endSave(true);
      // This save advanced knownVersion to the server's value, so it's fully
      // accounted for; drop the "we saved" flag so a later external change (e.g.
      // Claude editing over MCP) isn't misread as ours and swallowed (ADR-162).
      if (advanced) clearLocalSave();
    } catch {
      // Re-queue what failed under anything newer, retry on the next tick.
      pending.current = { ...patch, ...pending.current };
      endSave(false);
    } finally {
      inFlight.current = false;
      if (Object.keys(pending.current).length && !conflictPending.current) {
        schedule();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), SAVE_DEBOUNCE_MS);
  }, [flush]);

  // Wire this editor's flush to the global "Retry" affordance (the save-failed
  // pill), so a click forces an immediate re-save of the pending patch.
  useEffect(() => registerSaveRetry(() => void flush()), [flush]);
  // And to the conflict banner's "Keep mine", which resends the held body
  // without the guard token (overwriting the other device's change).
  useEffect(
    () => registerForceSave(() => void flush({ force: true })),
    [flush]
  );
  // Report unsaved state to the refresh-on-focus check (ADR-162): a queued patch
  // or an in-flight save means "dirty", so it asks before reloading rather than
  // dropping the owner's own work.
  useEffect(
    () =>
      registerDirtyCheck(
        () => Object.keys(pending.current).length > 0 || inFlight.current
      ),
    []
  );

  // While following, keep the save baseline pinned to the mirrored body: the
  // content on screen IS what the (other) source is saving, so treating it as
  // "synced" is correct. Then if the pen returns to this panel, its next save
  // digests against content the server already has — no false 409 (ADR-134).
  useEffect(() => {
    if (!follower) return;
    const md = bodyMarkdown(item.body);
    savedBodyText.current = md;
    syncedBodyText.current = md;
  }, [follower, item.body]);

  // The moment this editor becomes a follower (the pen left this panel), flush any
  // pending save so the server is up to date before another panel takes over —
  // the other panel then follows the freshly-saved content and inherits a correct
  // baseline. No-op when there's nothing pending.
  useEffect(() => {
    if (follower) void flush();
  }, [follower, flush]);

  // `{{` live-token autocomplete for the title (the body editor has its own via
  // token-suggestion.ts). Picking a token routes through the same setTitle +
  // debounced-save path as typing, so nothing about autosave changes.
  const titleAC = useTokenAutocomplete(titleRef, (next) => {
    setTitle(next);
    pending.current.title = next;
    onLiveChange?.({ title: next });
    schedule();
  });

  // Title wraps and grows with content (Brandon, 2026-06-17): keep the textarea's
  // height matched to its content after every edit, so a long title shows in full
  // instead of scrolling in one line.
  useLayoutEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [title]);

  // Flush the moment the tab is backgrounded (ADR-162): switching to the Claude
  // app fires visibilitychange → hidden (not pagehide, which is unload-only), so
  // without this a just-typed edit would sit in the 1.5s debounce and Claude
  // would read a stale body when asked "what do you think of this draft?". Uses
  // the real flush (a normal async PATCH — the page stays alive on a tab switch),
  // so it also advances the sync/known-version baseline and clears the dirty
  // flag, which is what lets the refresh-on-focus check auto-swap cleanly when
  // the owner returns.
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === "hidden") void flush();
    };
    document.addEventListener("visibilitychange", onHidden);
    return () => document.removeEventListener("visibilitychange", onHidden);
  }, [flush]);

  // A tab close inside the debounce window shouldn't lose the last edit.
  useEffect(() => {
    const onHide = () => {
      const patch = pending.current;
      if (Object.keys(patch).length === 0) return;
      pending.current = {};
      // keepalive lets the PATCH outlive the page (sendBeacon is POST-only).
      void fetch(`/api/items/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
        keepalive: true,
      });
    };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [item.id]);

  // Closing the canvas modal (or any client-side nav away) unmounts the
  // editor; edits still inside the debounce window must not be lost.
  useEffect(() => {
    return () => {
      const patch = pending.current;
      if (Object.keys(patch).length === 0) return;
      pending.current = {};
      void fetch(`/api/items/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
        keepalive: true,
      });
    };
  }, [item.id]);

  const titleInput = (
    <>
    <textarea
      ref={titleRef}
      rows={1}
      // A locked item's title is read-only and can't be clicked into.
      readOnly={locked}
      tabIndex={locked ? -1 : undefined}
      className={`w-full resize-none overflow-hidden bg-transparent text-3xl font-bold leading-tight outline-none placeholder:text-neutral-600 ${
        done ? "text-neutral-500 line-through decoration-2" : "text-neutral-100"
      } ${locked ? "pointer-events-none" : ""}`}
      placeholder="Untitled"
      value={title}
      onChange={(e) => {
        setTitle(e.target.value);
        pending.current.title = e.target.value;
        onLiveChange?.({ title: e.target.value });
        schedule();
        titleAC.sync();
      }}
      onKeyUp={titleAC.sync}
      onClick={titleAC.sync}
      onBlur={titleAC.close}
      onCompositionStart={titleAC.onCompositionStart}
      onCompositionEnd={titleAC.onCompositionEnd}
      // A title is one logical line that wraps; Enter commits it and moves the
      // caret into the body (instead of just blurring), so a new note flows
      // title → body without reaching for the mouse. In the combined layout the
      // body editor focuses off the bumped signal. In the field-card layout
      // (MarkdownCanvas/TaskCanvas/WidgetCanvas) the title is its own ItemEditor
      // instance and the body is a sibling, so we reach the body editor through
      // the DOM and drop the caret at its start; if there's no live body editor
      // on this canvas (e.g. a Preview-mode large doc), we just blur.
      onKeyDown={(e) => {
        // The token menu gets first crack at arrows/enter/tab/escape while open.
        if (titleAC.onKeyDown(e)) return;
        if (e.key === "Enter") {
          e.preventDefault();
          if (slot === "title") {
            const pm = document.querySelector<HTMLElement>(
              '.ProseMirror[contenteditable="true"]'
            );
            if (pm) {
              pm.focus();
              const sel = window.getSelection();
              if (sel) {
                const r = document.createRange();
                r.selectNodeContents(pm);
                r.collapse(true);
                sel.removeAllRanges();
                sel.addRange(r);
              }
            } else {
              e.currentTarget.blur();
            }
          } else setBodyFocusSignal((n) => n + 1);
        }
      }}
    />
    {titleAC.menu}
    </>
  );
  const onBodyChange = (markdown: string) => {
    if (markdown === savedBodyText.current) return;
    savedBodyText.current = markdown;
    // Keep the canvas chrome's word count current as you type (it's otherwise
    // only as fresh as the last page load). Recount is debounced inside; this
    // never touches the save path.
    publishBodyMarkdown(item.id, markdown);
    pending.current.body = makeMarkdownBody(markdown);
    onLiveChange?.({ markdown });
    schedule();
  };
  // Body rendering (mode + size gate) lives in BodyEditor (ADR-125): rich Tiptap
  // for normal notes (TabbedBody when the type uses tabs), a raw-markdown Source
  // textarea available on any note, and a read-only Preview that becomes the
  // default for large "document" notes the rich editor can't load. The promote
  // flow's onRequestSave flush persists a line's ^id anchor before a task is
  // created and the page refreshes.
  const bodyEditor = (
    <BodyEditor
      itemId={item.id}
      initialMarkdown={bodyMarkdown(item.body)}
      uploadFile={(file) => uploadFile(item.id, file)}
      onChange={onBodyChange}
      promoteToMeetingId={promoteToMeetingId}
      promotedRefs={promotedRefs}
      collapsibleToolbar={collapsibleToolbar}
      compact={compactBody}
      onRequestSave={flush}
      editable={!locked}
      tabsEnabled={tabsEnabled}
      controlledSection={controlledSection}
      focusSignal={bodyFocusSignal}
      follower={follower}
    />
  );

  // Field-level cards (ADR-069): render just the title or just the body, bare,
  // so each sits in its own grid cell with its own autosave.
  if (slot === "title") return titleInput;
  if (slot === "body") return bodyEditor;

  // Classic stacked editor (the default canvas). Tighter top rhythm (ui-refresh
  // S3): the title sits closer to the chrome and the field strip sits closer to
  // the body, removing the dead vertical band the audit flagged.
  return (
    <div className="mx-auto w-full max-w-3xl">
      <div className="px-2 pt-4 pb-1 sm:px-8 sm:pt-5 md:px-12">{titleInput}</div>
      {fields}
      <div className="px-2 pt-1 sm:px-8 md:px-12">{bodyEditor}</div>
    </div>
  );
}
