// Provider selection. Returns null when storage isn't configured (R2 env
// vars absent) so callers can answer "storage not configured" instead of
// crashing; the rest of the app must work without it.
import { R2Provider } from "./r2";
import type { StorageProvider } from "./types";

export type { PresignedUpload, StorageProvider } from "./types";

// No caching: constructing an R2Provider is a local, no-I/O AwsClient signer
// setup, not worth memoizing, and env can legitimately change mid-process
// (dev restarts, tests injecting fake credentials) — a cached instance would
// silently keep using stale config.
//
// FOUR vars, not five: R2_PUBLIC_BASE_URL is gone with the private bucket
// (ADR-231). There is no public base to point at, which also means one less
// thing to rotate when the storage layout changes.
export function getStorage(): StorageProvider | null {
  const {
    R2_ACCESS_KEY_ID: accessKeyId,
    R2_SECRET_ACCESS_KEY: secretAccessKey,
    R2_BUCKET: bucket,
    R2_ENDPOINT: endpoint,
  } = process.env;
  if (!accessKeyId || !secretAccessKey || !bucket || !endpoint) {
    return null;
  }
  return new R2Provider({ accessKeyId, secretAccessKey, bucket, endpoint });
}
