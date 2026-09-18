"use server";
// Server actions behind the AI & MCP mint buttons (ADR-160). Each
// is owner-gated (resolveOwner → the signed-in owner, never a raw request) and
// refuses to mint until the purpose's signing secret is set, so a click can't
// hand back a token no route will accept. The raw token is returned to the
// caller once and never stored (stateless model, oauth.ts).
import { resolveOwner } from "@/lib/owner";
import {
  appConfigured,
  isValidTokenLabel,
  oauthConfigured,
  signAppToken,
  signMcpToken,
} from "@/lib/auth/oauth";

export type MintResult = { token: string } | { error: string };

export async function mintMcpToken(): Promise<MintResult> {
  const owner = await resolveOwner();
  if (!owner) return { error: "Not signed in." };
  if (!oauthConfigured())
    return { error: "Set LEDGR_OAUTH_SECRET on your host and redeploy first." };
  return { token: signMcpToken(owner.email) };
}

// The clipper's minter is gone (ADR-238): the bookmarklet carries no token, so
// nothing asks for one. signClipperToken/clipperConfigured stay in oauth.ts,
// and verifyApiToken still ACCEPTS a clipper token, so a bookmarklet dragged
// before that change keeps working and LEDGR_CLIPPER_SECRET remains its kill
// switch. A server action is a public entry point, though, and one that mints
// credentials with no caller is a door left open onto an empty room.

// An api-scoped token for an external app (ADR-179). Takes the app's label so
// the token names its caller in machine-route logs; the label is validated here
// too (not just in the form) since a server action is a public entry point.
export async function mintAppToken(label: string): Promise<MintResult> {
  const owner = await resolveOwner();
  if (!owner) return { error: "Not signed in." };
  if (!appConfigured())
    return { error: "Set LEDGR_APP_SECRET on your host and redeploy first." };
  const trimmed = label.trim().toLowerCase();
  if (!isValidTokenLabel(trimmed))
    return {
      error:
        "Name must be 1–32 characters, lowercase letters, digits, and hyphens only.",
    };
  return { token: signAppToken(owner.email, trimmed) };
}
