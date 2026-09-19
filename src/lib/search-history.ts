// Recent search history, client-side only (localStorage). Up to 12 unique
// query strings, most recent first. No React here so both the command
// palette and the full search page can import it.
const KEY = "ledgr:search-history";
const CAP = 12;

export function readSearchHistory(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// Push a query to the front, deduped, capped at CAP.
export function pushSearchHistory(query: string): void {
  const q = query.trim();
  if (!q) return;
  try {
    const existing = readSearchHistory().filter((x) => x !== q);
    localStorage.setItem(KEY, JSON.stringify([q, ...existing].slice(0, CAP)));
  } catch {
    /* localStorage unavailable; skip */
  }
}
