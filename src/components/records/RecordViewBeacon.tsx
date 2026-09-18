"use client";

// Fires one best-effort "I looked at this record" beacon per page mount
// (Tyler, 2026-08-17: viewing IS the check-in — no manual button). The route
// throttles to one stamp per 12h, so this can fire freely. Renders nothing;
// failures are silently ignored (offline, etc. — staleness just isn't reset).
import { useEffect } from "react";

export default function RecordViewBeacon({ itemId }: { itemId: string }) {
  useEffect(() => {
    void fetch(`/api/items/${itemId}/viewed`, { method: "POST", keepalive: true }).catch(
      () => undefined
    );
  }, [itemId]);
  return null;
}
