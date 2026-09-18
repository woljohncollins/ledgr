// The "N words" chrome label. A client island so it can follow the body editor's
// live text (src/lib/word-count.ts) instead of only the server-rendered count;
// `initial` is that server count, shown until the editor publishes.
"use client";

import { useWordCount } from "@/lib/word-count";

export default function WordCount({
  itemId,
  initial,
  initialPerTab = false,
  live = true,
}: {
  itemId: string;
  initial: number;
  // The server count covers only the first canvas tab (a tabbed body, ADR-095),
  // so the label says so until the editor publishes a newer scope.
  initialPerTab?: boolean;
  // false = show the server count as-is. Used by widget-home records, whose
  // count covers the COMPOSED project document (ADR-197): the Overview editor
  // publishes overview-only text, which must not overwrite the document count.
  live?: boolean;
}) {
  const liveCount = useWordCount(itemId, initial, initialPerTab);
  const n = live ? liveCount.count : initial;
  const perTab = live ? liveCount.perTab : initialPerTab;
  return (
    <>
      {n.toLocaleString()} {n === 1 ? "word" : "words"}
      {perTab ? " (this tab)" : ""}
    </>
  );
}
