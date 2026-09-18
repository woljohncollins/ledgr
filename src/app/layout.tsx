import type { Metadata, Viewport } from "next";
import type { CSSProperties } from "react";
import { Bricolage_Grotesque, Geist, Geist_Mono } from "next/font/google";
import ActionToast from "@/components/ui/ActionToast";
import UploadProgress from "@/components/attachments/UploadProgress";
import DeskSendContextMenu from "@/components/desk/DeskSendMenu";
import Nav from "@/components/nav/Nav";
import NavProgress from "@/components/nav/NavProgress";
import PwaRegister from "@/components/pwa/PwaRegister";
import OutboxSync from "@/components/pwa/OutboxSync";
import { AppAuthProvider } from "@/lib/auth/provider";
import { TimezoneProvider } from "@/components/providers/TimezoneProvider";
import { navPadVars } from "@/lib/nav-layout";
import { resolveOwner } from "@/lib/owner";
import { createLogger } from "@/lib/log";
import { accentHighlightImageCss } from "@/lib/colors";
import { DEFAULT_SETTINGS, getSettings, TEXT_SIZE_PX, THEME_PAGE_COLOR, UI_SCALE } from "@/lib/settings";
import { DEFAULT_TIMEZONE, primeAppTimezone } from "@/lib/today";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Wordmark face for the "Ledgr" logo (nav). Bricolage Grotesque is a
// contemporary display grotesque with more character than the UI type; exposed
// as --font-logo so only the logo opts in.
const logoFont = Bricolage_Grotesque({
  variable: "--font-logo",
  subsets: ["latin"],
  weight: ["600", "700"],
});

export const metadata: Metadata = {
  // `template` lets a page set just its own name (e.g. a note's title) and have
  // " · Ledgr" appended for the browser tab / history / bookmarks; `default`
  // covers pages that set no title of their own.
  title: {
    default: "Ledgr",
    template: "%s · Ledgr",
  },
  description: "Personal life management: meetings, tasks, notes, and links.",
  // Installed-PWA chrome on iOS (Android reads the manifest, slice 16).
  appleWebApp: {
    capable: true,
    title: "Ledgr",
    statusBarStyle: "black-translucent",
  },
};

// The title-bar color follows the owner's theme (settings.theme), so a light
// or sepia page doesn't sit under a black mobile status bar. Best-effort like
// the layout's own settings read: signed-out or failed → dark.
export async function generateViewport(): Promise<Viewport> {
  let themeColor = THEME_PAGE_COLOR.dark;
  try {
    const owner = await resolveOwner();
    if (owner) themeColor = THEME_PAGE_COLOR[(await getSettings(owner.id)).theme];
  } catch (err) {
    if ((err as { digest?: string })?.digest === "DYNAMIC_SERVER_USAGE") throw err;
  }
  return { ...viewportBase, themeColor };
}

const viewportBase: Viewport = {
  // Paint under the iOS home indicator; the nav bar pads itself back out
  // with safe-area-inset-bottom.
  viewportFit: "cover",
  // Keep content above the on-screen keyboard. Chrome Android's default
  // (resizes-visual) leaves the layout viewport full-height when the keyboard
  // opens, so a bottom-pinned bar sits behind it and the visualViewport-based
  // keyboardInset math is unreliable. resizes-content shrinks the layout
  // viewport to the space above the keyboard, so the editor's fixed formatting
  // bar (bottom-pinned) lands above the keyboard without JS geometry.
  interactiveWidget: "resizes-content",
};

export default async function RootLayout({
  children,
  modal,
}: Readonly<{
  children: React.ReactNode;
  // Parallel slot for the intercepted item canvas modal (src/app/@modal).
  modal: React.ReactNode;
}>) {
  // The owner's settings drive the app-wide `--accent` var and the body padding
  // that clears the nav (v6). Best-effort: signed-out / pre-DB renders fall back
  // to the defaults. The padding is set as CSS vars (--nav-pt/pb/pl/pr) that
  // globals.css applies; NavShell updates the rail var instantly on collapse.
  let accent = DEFAULT_SETTINGS.highlightColor;
  // The gradient laid over accent *fills*; defaults to the solid so non-gradient
  // accents resolve to a plain color anywhere `--accent-gradient` is used.
  let accentGradient = DEFAULT_SETTINGS.highlightColor;
  // The accent highlight's IMAGE channel (globals.css `mark.hl-accent`), set
  // only when the owner picked a gradient accent: a highlight's fill normally
  // rides the inline `background-color` the body carries, and a gradient is an
  // image, not a color, so it can only reach the mark as a background-image.
  // "none" for a solid accent, which leaves that inline color untouched.
  let accentHighlightImage = "none";
  let navPosition = DEFAULT_SETTINGS.navPosition;
  let railSize = DEFAULT_SETTINGS.railSize;
  let proseFontSize = TEXT_SIZE_PX[DEFAULT_SETTINGS.textSize];
  // Interface-density scale, resolved per surface. The mobile value mirrors the
  // desktop one unless an explicit mobile level is set. Emitted below as the
  // --ui-scale CSS var, with the mobile value behind a max-width media query.
  let uiScale = UI_SCALE[DEFAULT_SETTINGS.uiDensity];
  let mobileUiScale = uiScale;
  // Item-canvas section style (the canvas redesign) — emitted as a body attribute
  // the CanvasSection CSS reads, so the whole panel weight flips from one setting.
  let sectionStyle = DEFAULT_SETTINGS.sectionStyle;
  // App theme: data-theme on <html> (none for dark, the :root default) that
  // flips the whole token layer in globals.css. Server-rendered, so no flash.
  let theme = DEFAULT_SETTINGS.theme;
  // Resolved owner timezone: seeds the sync cache (appTimezoneSync) for the whole
  // request and is provided to client components via TimezoneProvider.
  let tz = DEFAULT_TIMEZONE;
  try {
    const owner = await resolveOwner();
    if (owner) {
      const s = await getSettings(owner.id);
      accent = s.highlightColor;
      accentGradient = s.highlightGradient ?? s.highlightColor;
      accentHighlightImage = s.highlightGradient
        ? accentHighlightImageCss(s.highlightGradient)
        : "none";
      navPosition = s.navPosition;
      railSize = s.railSize;
      proseFontSize = TEXT_SIZE_PX[s.textSize];
      uiScale = UI_SCALE[s.uiDensity];
      mobileUiScale = UI_SCALE[s.mobileUiDensity ?? s.uiDensity];
      sectionStyle = s.sectionStyle;
      theme = s.theme;
      tz = s.timezone ?? DEFAULT_TIMEZONE;
    }
  } catch (err) {
    // Next's dynamic-usage marker must propagate (it's how a build learns the
    // route is dynamic, not a failure) — rethrow it instead of logging noise.
    if ((err as { digest?: string })?.digest === "DYNAMIC_SERVER_USAGE") throw err;
    // The defaults fallback is deliberate (the shell must always render), but
    // swallowing the failure SILENTLY is how the 2026-08-19 vanished-chrome
    // incident hid — a request that wore default-blue with no nav left no
    // trace. Rule 9: say why in the drain.
    createLogger("layout.settings").warn(
      "owner/settings resolution failed; rendering default chrome",
      { error: err instanceof Error ? err.message : String(err) }
    );
  }
  primeAppTimezone(tz);
  // Per-surface interface density. Must set --ui-scale on :root (custom
  // properties inherit down, not up, and the html font-size rule in globals.css
  // reads it); a media query can't live in an inline style, so it goes in a
  // server-rendered <style>. The 639.98px ceiling complements the nav's 640px
  // (sm) desktop breakpoint, so chrome and density switch surfaces together. The
  // values are fixed numbers from UI_SCALE, so there's nothing to escape.
  const uiScaleCss = `:root{--ui-scale:${uiScale}}@media (max-width:639.98px){:root{--ui-scale:${mobileUiScale}}}`;
  return (
    <AppAuthProvider>
      <html
        lang="en"
        className={`${geistSans.variable} ${geistMono.variable} ${logoFont.variable} h-full antialiased`}
        data-theme={theme === "dark" ? undefined : theme}
      >
        <body
          className="min-h-full flex flex-col"
          data-section-style={sectionStyle}
          style={{ "--accent": accent, "--accent-gradient": accentGradient, "--accent-highlight-image": accentHighlightImage, "--prose-font-size": proseFontSize, ...navPadVars(navPosition, railSize) } as CSSProperties}
        >
          <style dangerouslySetInnerHTML={{ __html: uiScaleCss }} />
          <NavProgress />
          <TimezoneProvider tz={tz}>
            {children}
            <Nav />
            {modal}
          </TimezoneProvider>
          <ActionToast />
          {/* One global toast for row/swipe actions (S4/S5); lives outside the
              list subtree so it survives the refresh that removes the acted row. */}
          <UploadProgress />
          {/* One global upload-progress stack (bottom-right), same trick: every
              uploadAttachment reports here via a window event (ADR-236). */}
          <DeskSendContextMenu />
          {/* One global Send-to-Desk popover (ADR-146): opened at the cursor by
              inline mention/link right-clicks; desktop-only. */}
          <PwaRegister />
          <OutboxSync />
        </body>
      </html>
    </AppAuthProvider>
  );
}
