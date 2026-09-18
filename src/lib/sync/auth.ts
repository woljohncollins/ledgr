// Device-token auth for /api/machine/sync (plan decision 15). Same hashing +
// constant-time compare as the env machine tokens (src/lib/auth/machine.ts),
// but the sha256 hash lives on a sync_peers row, so the hub can revoke a
// device with a row flip instead of an env edit + redeploy. A device token
// never carries Clerk identity.
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { syncPeers } from "@/db/schema";
import { hashToken, digestsMatch } from "@/lib/auth/machine";

export type SyncPeerIdentity = {
  deviceId: string;
  name: string;
  pullOnly: boolean;
  // Push-dedupe boundary (ADR-208): ops at or below this seq from this
  // device were already applied; a re-delivered batch is dropped, not
  // re-applied.
  lastPushedSeq: number;
};

/**
 * Verifies a Bearer device token from an incoming sync request against the
 * non-revoked sync_peers rows. Returns the peer's identity when valid, else
 * null; callers turn null into a 401 and never explain which check failed.
 */
export async function verifySyncDevice(
  authorizationHeader: string | null
): Promise<SyncPeerIdentity | null> {
  if (!authorizationHeader?.startsWith("Bearer ")) return null;
  const token = authorizationHeader.slice("Bearer ".length).trim();
  if (!token) return null;

  const digest = hashToken(token);
  const peers = await getDb()
    .select({
      deviceId: syncPeers.deviceId,
      name: syncPeers.name,
      tokenHash: syncPeers.tokenHash,
      pullOnly: syncPeers.pullOnly,
      lastPushedSeq: syncPeers.lastPushedSeq,
    })
    .from(syncPeers)
    .where(eq(syncPeers.revoked, false));
  for (const peer of peers) {
    if (digestsMatch(digest, peer.tokenHash)) {
      return {
        deviceId: peer.deviceId,
        name: peer.name,
        pullOnly: peer.pullOnly,
        lastPushedSeq: peer.lastPushedSeq,
      };
    }
  }
  return null;
}
