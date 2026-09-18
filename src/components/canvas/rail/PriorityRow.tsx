// The rail's "Priority" row (ADR-108): the P1–P6 urgency as a compact row that
// opens a small swatch menu (None + P1–P6), replacing the bare <select>.
// Optimistic PATCH of urgency + refresh. Stored column stays `urgency`; surfaced
// as "Priority" (ADR-096).
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { beginSave, endSave } from "@/lib/save-status";
import { PRIORITIES, priorityStyle, type Priority } from "@/lib/priority";
import Popover from "@/components/ui/Popover";
import { RowFace, MenuItem, FlagGlyph } from "./row-ui";
import { RAIL_TRIGGER } from "./styles";

export default function PriorityRow({
  itemId,
  initial,
}: {
  itemId: string;
  initial: number | null;
}) {
  const router = useRouter();
  const [val, setVal] = useState<number | null>(initial);
  const [prev, setPrev] = useState(initial);
  if (initial !== prev) {
    setPrev(initial);
    setVal(initial);
  }

  async function pick(n: number | null, close: () => void) {
    const before = val;
    setVal(n);
    close();
    beginSave();
    try {
      const res = await fetch(`/api/items/${itemId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urgency: n }),
      });
      if (!res.ok) throw new Error(String(res.status));
      endSave(true);
      router.refresh();
    } catch {
      setVal(before);
      endSave(false);
    }
  }

  const cur = val ? priorityStyle(val as Priority) : null;
  return (
    <Popover
      ariaLabel="Priority"
      align="right"
      width={208}
      triggerClassName={RAIL_TRIGGER}
      trigger={
        <RowFace
          label="Priority"
          empty={val == null}
          inline
          icon={<FlagGlyph className={cur ? cur.text : "text-ink-faint"} />}
        >
          {cur ? <span className={cur.text}>{cur.label}</span> : "Add"}
        </RowFace>
      }
    >
      {(close) => (
        <div className="flex flex-col">
          <MenuItem active={val == null} onClick={() => pick(null, close)}>
            <span className="h-2.5 w-2.5 rounded-full border border-neutral-600" />
            <span className="text-neutral-400">None</span>
          </MenuItem>
          {PRIORITIES.map((n) => {
            const s = priorityStyle(n);
            return (
              <MenuItem key={n} active={val === n} onClick={() => pick(n, close)}>
                <span className={`h-2.5 w-2.5 rounded-full ${s.dot}`} />
                <span className={s.text}>{s.label}</span>
              </MenuItem>
            );
          })}
        </div>
      )}
    </Popover>
  );
}
