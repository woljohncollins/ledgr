// Public share links (slice 31, PRD §4.12). An unguessable token maps to one
// item's read-only print render. Issuance and revocation are owner-scoped; the
// public resolve is deliberately NOT owner-scoped (the whole point is access
// without a session) but only ever yields a live, non-revoked token bound to a
// live item.
import { randomBytes } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { items, shareTokens } from "@/db/schema";
import type { Theme } from "@/lib/settings";

// 24 random bytes (~32 base64url chars, 192 bits) — unguessable, the security
// boundary for an unauthenticated link (same posture as the machine tokens).
function newToken(): string {
  return randomBytes(24).toString("base64url");
}

// Per-link render options, stored on the token so the setting travels with the
// URL. `showIcons` toggles type-aware @-mention icons on the shared/printed
// document; absent means on. `theme` is the look the page OPENS in (absent
// means the owner's app theme at render time); the recipient can switch it
// from the page's own Appearance control, which is remembered in their browser.
export type ShareOptions = {
  showIcons?: boolean;
  theme?: Theme;
};

export type ShareTokenRow = {
  id: string;
  token: string;
  options: ShareOptions;
  revokedAt: Date | null;
  createdAt: Date;
};

// Issues a new link for an item the caller owns. The item must be the owner's
// own live item; a new token is minted each call (revoke the old one to kill
// a leaked link without disturbing others). `options` are baked into the link.
export async function createShareToken(
  ownerId: string,
  itemId: string,
  options: ShareOptions = {}
): Promise<ShareTokenRow> {
  const db = getDb();
  const owned = await db
    .select({ id: items.id })
    .from(items)
    .where(and(eq(items.id, itemId), eq(items.ownerId, ownerId), isNull(items.deletedAt)));
  if (owned.length === 0) return Promise.reject(new Error("item not found"));

  const [row] = await db
    .insert(shareTokens)
    .values({ ownerId, itemId, token: newToken(), options })
    .returning({
      id: shareTokens.id,
      token: shareTokens.token,
      options: shareTokens.options,
      revokedAt: shareTokens.revokedAt,
      createdAt: shareTokens.createdAt,
    });
  return { ...row, options: (row.options as ShareOptions) ?? {} };
}

// Lists an item's links (owner-scoped), newest first. Includes revoked ones so
// the UI can show history; the UI filters to live for the "active links" list.
export async function listShareTokens(
  ownerId: string,
  itemId: string
): Promise<ShareTokenRow[]> {
  const rows = await getDb()
    .select({
      id: shareTokens.id,
      token: shareTokens.token,
      options: shareTokens.options,
      revokedAt: shareTokens.revokedAt,
      createdAt: shareTokens.createdAt,
    })
    .from(shareTokens)
    .where(and(eq(shareTokens.ownerId, ownerId), eq(shareTokens.itemId, itemId)))
    .orderBy(desc(shareTokens.createdAt));
  return rows.map((r) => ({ ...r, options: (r.options as ShareOptions) ?? {} }));
}

// Revokes a link by token, owner-scoped (a caller can only revoke its own).
// Idempotent: re-revoking is a no-op. Returns whether a row was affected.
export async function revokeShareToken(
  ownerId: string,
  token: string
): Promise<boolean> {
  const rows = await getDb()
    .update(shareTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(shareTokens.ownerId, ownerId),
        eq(shareTokens.token, token),
        isNull(shareTokens.revokedAt)
      )
    )
    .returning({ id: shareTokens.id });
  return rows.length > 0;
}

export type ResolvedShare = {
  ownerId: string;
  itemId: string;
  title: string;
  body: unknown;
  options: ShareOptions;
};

// The public path: a token → the item to render, or null. Joins so one query
// proves the token is live (not revoked) AND the item is live (not trashed).
// No owner scoping — an unauthenticated visitor has no owner — but the join to
// the token's own item is the only data it can ever reach.
export async function resolveShareToken(
  token: string
): Promise<ResolvedShare | null> {
  if (!token) return null;
  const rows = await getDb()
    .select({
      ownerId: shareTokens.ownerId,
      itemId: items.id,
      title: items.title,
      body: items.body,
      options: shareTokens.options,
    })
    .from(shareTokens)
    .innerJoin(items, eq(items.id, shareTokens.itemId))
    .where(
      and(
        eq(shareTokens.token, token),
        isNull(shareTokens.revokedAt),
        isNull(items.deletedAt)
      )
    );
  const row = rows[0];
  if (!row) return null;
  return { ...row, options: (row.options as ShareOptions) ?? {} };
}
