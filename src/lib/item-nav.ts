// Programmatic item navigation that keeps the item panel's close() honest.
// Modal.tsx marks <body data-item-panel="open"> while the panel/modal owns the
// URL; navigating to another item then must REPLACE the history entry, not push
// one, so a single close() (router.back()) always returns to the launching
// surface instead of walking back through every item viewed in the panel.
// Anchor clicks get the same treatment from Modal's capture-phase interceptor;
// this helper is for the router.push call sites (mention chips, planner cells,
// create-then-open flows). Use it for any programmatic "open this item".
import type { useRouter } from "next/navigation";

type Router = ReturnType<typeof useRouter>;

export function openItem(router: Router, id: string) {
  const panelOpen =
    typeof document !== "undefined" &&
    document.body.dataset.itemPanel === "open";
  if (panelOpen) router.replace(`/items/${id}`, { scroll: false });
  else router.push(`/items/${id}`);
}
