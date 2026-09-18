// Storage-provider interface (PRD §3.4, CLAUDE.md provider-interface
// discipline). The app talks to this, never to R2 directly, so a future
// local build can swap in a filesystem provider. Bytes never proxy through
// the app server on the way IN: uploads go browser → presigned PUT URL.
//
// The bucket is PRIVATE (ADR-231, 2026-08-28). There is no unsigned URL to any
// object, so `publicUrl` is gone: every read is a short-lived signed GET via
// presignDownload. What goes in an item body is still ADR-228's stable
// `/files/<id>` address; that route now decides WHO may read (the owner, or an
// anonymous viewer holding a live share token for the parent item) and signs
// the redirect. Bytes still never pass through the app server — it is a 302 to
// R2, never a proxy.
//
// This strengthens ADR-228 rather than undoing it: with no public base URL
// there is one less storage detail that can leak into stored content.

export type PresignedUpload = {
  // PUT the file bytes here, Content-Type header required to match.
  uploadUrl: string;
};

export interface StorageProvider {
  presignUpload(key: string, contentType: string): Promise<PresignedUpload>;
  // Server-side write, for bytes that originate server-side with no browser in
  // the loop — email-in attachments from Graph (slice 26), the MCP attach_file
  // tool (ADR-150).
  putObject(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  // A short-lived signed GET for one object. The ONLY way to read bytes.
  presignDownload(key: string, ttlSeconds?: number): Promise<string>;
  deleteObject(key: string): Promise<void>;
  // Enumerate stored objects under a key prefix (ADR-237): what the orphan
  // sweep reconciles against the attachments table. Owner-scoped callers pass
  // `${ownerId}/`. Names only what exists in storage — deciding which of those
  // are orphans is the caller's job, against the DB.
  listObjects(prefix: string): Promise<{ key: string; sizeBytes: number }[]>;
}
