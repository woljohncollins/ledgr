// Shared count formatting (ui-refresh S1). One place that decides how a numeric
// badge/count renders, so nav bubbles, dashboard stat cards, and "recently
// touched" counts all agree instead of each re-implementing the `> 99 ? "99+"`
// check (the audit found a raw `8940` badge). `cap` is configurable for the rare
// surface that wants a higher ceiling.
export function badgeCount(n: number, cap = 99): string {
  if (!Number.isFinite(n)) return "";
  const v = Math.max(0, Math.floor(n));
  return v > cap ? `${cap}+` : String(v);
}

// Shared byte formatting (ADR-237): one place that decides when KB becomes MB,
// after three surfaces grew their own copies and one showed "1009 KB" (Tyler:
// "kb is hard to read"). Steps up a unit at 1000 of the previous one, so the
// value shown never exceeds three digits.
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1000) return `${Math.floor(n)} B`;
  if (n < 1000 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1000 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
