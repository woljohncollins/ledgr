"use server";
// Server actions behind the API-credentials section of User Settings (ADR-224).
// Each is owner-gated (resolveOwner → the signed-in owner, never a raw
// request) and owner-scoped, the same posture as mint-actions.ts.
//
// The raw secret crosses this boundary exactly once, in the create result. It
// is never stored (only its hash is), never logged, and there is no action
// that can read it back — the only recovery from a lost secret is a new
// credential.
import { resolveOwner } from "@/lib/owner";
import {
  createCredential,
  listCredentials,
  revokeCredential,
  type CredentialSummary,
} from "@/lib/auth/credentials";

export type CreateCredentialResult =
  | { keyId: string; secret: string; credentials: CredentialSummary[] }
  | { error: string };

export async function createApiCredential(
  name: string,
  scopes: string[]
): Promise<CreateCredentialResult> {
  const owner = await resolveOwner();
  if (!owner) return { error: "Not signed in." };
  // Shapes are re-validated inside createCredential (a server action is a
  // public entry point); this only narrows the inputs to the right types.
  const safeScopes = Array.isArray(scopes) ? scopes.filter((s) => typeof s === "string") : [];
  const result = await createCredential(
    owner.id,
    typeof name === "string" ? name : "",
    safeScopes
  );
  if (!result.ok) return { error: result.error };
  return {
    keyId: result.keyId,
    secret: result.secret,
    credentials: await listCredentials(owner.id),
  };
}

export type CredentialListResult =
  | { credentials: CredentialSummary[] }
  | { error: string };

export async function revokeApiCredential(id: string): Promise<CredentialListResult> {
  const owner = await resolveOwner();
  if (!owner) return { error: "Not signed in." };
  if (typeof id !== "string" || !id) return { error: "Unknown credential." };
  const revoked = await revokeCredential(owner.id, id);
  if (!revoked) return { error: "That credential is already revoked, or not yours." };
  return { credentials: await listCredentials(owner.id) };
}

export async function refreshApiCredentials(): Promise<CredentialListResult> {
  const owner = await resolveOwner();
  if (!owner) return { error: "Not signed in." };
  return { credentials: await listCredentials(owner.id) };
}
