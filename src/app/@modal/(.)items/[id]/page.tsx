// Intercepted /items/[id]: a client-side navigation to an item opens the
// canvas in a center modal over whatever list launched it (PRD §4.13,
// Notion-default). The URL is the real item URL, so refresh or a shared
// link lands on the full page in src/app/items/[id].
import ItemCanvas from "@/components/canvas/ItemCanvas";
import Modal from "@/components/canvas/Modal";
import { getItem } from "@/lib/items";
import { isItemFavorited } from "@/lib/favorites";
import { canvasIdForType } from "@/lib/modules";
import { resolveOwner } from "@/lib/owner";
import { DEFAULT_SETTINGS, getSettings, type ItemOpenMode } from "@/lib/settings";
import { getType } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function ItemModal({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // Widen the modal only for a canvas that needs the room (a song's two-column
  // chart). The default modal width is the "Tablet" surface (ADR-069, Brandon
  // 2026-06-17): a saved item layout renders its `md` arrangement here, while the
  // full-page expand is the wider "Desktop" surface — so each maps to a
  // breakpoint. Best-effort: any failure just yields the default-width modal, and
  // ItemCanvas surfaces the real not-found/auth handling.
  let wide = false;
  let title = "";
  let type = "";
  let typeLabel = "";
  let typeIcon: string | null = null;
  let isTemplate = false;
  let locked = false;
  let favorited = false;
  // Where this owner wants an item to open (left/right dock, center popup, or the
  // measured default). Resolved server-side and handed to the client Modal, which
  // still narrows it by what the layout allows — a phone is always the sheet, and
  // a docked nav rail wins the edge it's on.
  let itemOpenMode: ItemOpenMode = DEFAULT_SETTINGS.itemOpenMode;
  try {
    const owner = await resolveOwner();
    if (owner) {
      const item = await getItem(owner.id, id);
      itemOpenMode = (await getSettings(owner.id)).itemOpenMode;
      // Resolve through the capability too (SPIKE), so a user type borrowing the
      // chord chart widens the modal like a real song.
      const typeDef = await getType(item.type).catch(() => null);
      wide = canvasIdForType(item.type, owner.id, typeDef?.capability) === "chord";
      title = item.title;
      type = item.type;
      typeLabel = typeDef?.label ?? item.type;
      typeIcon = typeDef?.icon ?? null;
      isTemplate = item.isTemplate;
      locked = Boolean(
        (item.properties as Record<string, unknown> | null)?.locked
      );
      favorited = await isItemFavorited(owner.id, id);
    }
  } catch {
    // ignore — render the default modal width
  }
  return (
    <Modal
      itemId={id}
      wide={wide}
      title={title}
      type={type}
      typeLabel={typeLabel}
      typeIcon={typeIcon}
      isTemplate={isTemplate}
      locked={locked}
      favorited={favorited}
      openMode={itemOpenMode}
    >
      <ItemCanvas id={id} variant="modal" />
    </Modal>
  );
}
