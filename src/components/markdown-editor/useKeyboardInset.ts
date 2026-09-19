import { useEffect, useState } from "react";

// How many pixels the on-screen (software) keyboard overlaps the layout
// viewport from the bottom. 0 when no keyboard is shown or when the platform
// has no visualViewport (older/embedded webviews) — callers then fall back to
// docking at the bottom edge.
//
// This is the one genuinely new primitive for the mobile editor: a bottom-pinned
// formatting bar must sit on *top* of the keyboard, and a plain
// `position: fixed; bottom: 0` sits behind it. The layout viewport doesn't
// shrink when the keyboard opens, but the visual viewport does, so the overlap
// is innerHeight - (visualViewport height + its top offset).
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const overlap = window.innerHeight - (vv.height + vv.offsetTop);
      // iOS Safari emits transient values mid-animation; clamp and round.
      setInset(Math.max(0, Math.round(overlap)));
    };
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    update();
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);
  return inset;
}

// Whether the on-screen keyboard is up. The visual viewport shrinks by the
// keyboard's height whether or not the layout viewport does (iOS never
// shrinks it, Chrome Android with interactive-widget=resizes-content shrinks
// both), so "open" is the viewport being well shorter than the tallest it has
// been at this width. Keyboards are 250px+; the threshold ignores a browser
// toolbar collapsing on scroll. Orientation changes reset the baseline.
//
// Exists for one iOS behaviour: the keyboard's own dismiss button hides the
// keyboard WITHOUT blurring the focused editor, so anything keyed off blur
// (the Work nav bar, hidden while editing) never came back until the user
// tapped elsewhere.
const KEYBOARD_MIN_PX = 150;
export function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let baseW = vv.width;
    let baseH = vv.height;
    const update = () => {
      if (Math.abs(vv.width - baseW) > 1) {
        baseW = vv.width;
        baseH = vv.height;
      }
      baseH = Math.max(baseH, vv.height);
      setVisible(baseH - vv.height > KEYBOARD_MIN_PX);
    };
    vv.addEventListener("resize", update);
    update();
    return () => vv.removeEventListener("resize", update);
  }, []);
  return visible;
}
