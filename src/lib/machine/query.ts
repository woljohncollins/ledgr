// Query-string parsing shared by the /api/machine/* read routes (ADR-262).
//
// It exists because the old GET /api/machine/items ignored anything it didn't
// recognize. `?id=<uuid>` was dropped on the floor and answered with an
// unfiltered list, so a caller asking for one item got a different one back,
// with a 200 and no hint that the filter had not applied. A read surface that
// silently discards half a request is worse than one that refuses: the refusal
// costs a retry, the silence costs a wrong answer nobody notices.

// Unknown parameters, in the order they appeared. Empty means the request only
// used names the route understands.
export function unknownParams(
  params: URLSearchParams,
  known: ReadonlySet<string>
): string[] {
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (!known.has(key)) seen.add(key);
  }
  return [...seen];
}

// The 400 message for the above: names what it didn't understand AND what it
// would have understood, so the fix is in the error rather than in the docs.
export function unknownParamsError(
  unknown: string[],
  known: ReadonlySet<string>
): string {
  return `unknown query parameter${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. Accepted: ${[...known].sort().join(", ")}`;
}

// Query-string booleans. Strict on purpose: a bare `?includeBody` and
// `?includeBody=true` both read as "on" to a human, and `?includeBody=false`
// reads as "off" — treating anything non-empty as true (the usual shortcut)
// gets that last one exactly backwards.
export function parseBoolParam(
  name: string,
  raw: string
): { ok: true; value: boolean } | { ok: false; error: string } {
  const v = raw.trim().toLowerCase();
  if (v === "" || ["true", "1", "yes", "on"].includes(v)) {
    return { ok: true, value: true };
  }
  if (["false", "0", "no", "off"].includes(v)) return { ok: true, value: false };
  return { ok: false, error: `${name} must be true or false (got "${raw}")` };
}
