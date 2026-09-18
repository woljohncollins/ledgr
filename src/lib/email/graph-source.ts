// Graph mail source (slice 26). Reads the "Ledgr Import" Outlook folder
// app-only over the shared Graph client (slice 21); needs Mail.ReadWrite
// (read to import, write to mark-read + move). messages/delta returns only
// what's new since the stored token; imported messages move to an "Imported"
// subfolder so they never re-import. Verified live only (a stub covers the
// engine); needs the §1c Mail.ReadWrite grant + the Outlook folder.
import { graphFetch, getGraphMailboxUpn, GraphError, graphGet } from "@/lib/graph/client";
import type { MailAttachment, MailSource, NormalizedMessage } from "./types";

const IMPORT_FOLDER = "Ledgr Import";
const IMPORTED_SUBFOLDER = "Imported";
const SELECT = "id,internetMessageId,subject,from,receivedDateTime,body,hasAttachments";
const MAX_PAGES = 50;

type GraphMessage = {
  id: string;
  internetMessageId?: string;
  subject?: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  receivedDateTime?: string;
  body?: { contentType?: string; content?: string };
  hasAttachments?: boolean;
  "@removed"?: unknown;
};

type GraphFileAttachment = {
  "@odata.type"?: string;
  id: string;
  name?: string;
  contentType?: string;
  size?: number;
  isInline?: boolean;
};

type DeltaPage = {
  value: GraphMessage[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
};

export class GraphMailSource implements MailSource {
  private importFolderId: string | null = null;
  private importedFolderId: string | null = null;

  constructor(private upn: string) {}

  private base(path: string): string {
    return `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(this.upn)}${path}`;
  }

  // Resolve (and cache) the import folder + its Imported subfolder, creating
  // the subfolder if it doesn't exist yet.
  private async resolveFolders(): Promise<{ importId: string; importedId: string }> {
    if (this.importFolderId && this.importedFolderId) {
      return { importId: this.importFolderId, importedId: this.importedFolderId };
    }
    const folders = await graphGet<{ value: { id: string; displayName: string }[] }>(
      this.base(`/mailFolders?$filter=${encodeURIComponent(`displayName eq '${IMPORT_FOLDER}'`)}&$select=id,displayName`)
    );
    const importFolder = folders.value[0];
    if (!importFolder) {
      throw new GraphError(`Outlook folder "${IMPORT_FOLDER}" not found (runbook §5.3 setup)`, "request", 404);
    }
    this.importFolderId = importFolder.id;

    const children = await graphGet<{ value: { id: string; displayName: string }[] }>(
      this.base(`/mailFolders/${importFolder.id}/childFolders?$filter=${encodeURIComponent(`displayName eq '${IMPORTED_SUBFOLDER}'`)}&$select=id,displayName`)
    );
    if (children.value[0]) {
      this.importedFolderId = children.value[0].id;
    } else {
      const created = await graphFetch(this.base(`/mailFolders/${importFolder.id}/childFolders`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: IMPORTED_SUBFOLDER }),
      });
      if (!created.ok) throw new GraphError(`could not create "${IMPORTED_SUBFOLDER}" subfolder (${created.status})`, "request", created.status);
      this.importedFolderId = ((await created.json()) as { id: string }).id;
    }
    return { importId: this.importFolderId, importedId: this.importedFolderId! };
  }

  // Attachment metadata only ($select drops contentBytes — we link to the
  // original mail, never download the bytes). Inline images (email signatures,
  // embedded logos) are skipped: they're noise, and copying them was the bulk
  // of the storage churn this design removes.
  private async fetchAttachments(messageId: string): Promise<MailAttachment[]> {
    const res = await graphGet<{ value: GraphFileAttachment[] }>(
      this.base(`/messages/${encodeURIComponent(messageId)}/attachments?$select=id,name,contentType,size,isInline`)
    );
    const out: MailAttachment[] = [];
    for (const a of res.value) {
      if (a["@odata.type"] !== "#microsoft.graph.fileAttachment" || a.isInline) continue;
      out.push({
        name: a.name || "attachment",
        contentType: a.contentType || "application/octet-stream",
        size: a.size ?? 0,
      });
    }
    return out;
  }

  // Resolve the live "open in Outlook" URL for a message from its stable
  // internetMessageId. Used by the /api/email/open redirect — re-resolving on
  // click means the link still works after the message is moved (which changes
  // the Graph id, and thus any webLink captured at import time).
  async resolveWebLink(internetMessageId: string): Promise<string | null> {
    const filter = encodeURIComponent(`internetMessageId eq '${internetMessageId.replace(/'/g, "''")}'`);
    const res = await graphGet<{ value: { webLink?: string }[] }>(
      this.base(`/messages?$filter=${filter}&$select=webLink&$top=1`)
    );
    return res.value[0]?.webLink ?? null;
  }

  private normalize(m: GraphMessage): NormalizedMessage {
    const isHtml = (m.body?.contentType ?? "").toLowerCase() === "html";
    return {
      id: m.id,
      internetMessageId: m.internetMessageId ?? null,
      subject: m.subject ?? "",
      fromName: m.from?.emailAddress?.name ?? null,
      fromEmail: m.from?.emailAddress?.address?.toLowerCase() ?? null,
      receivedAt: m.receivedDateTime ?? null,
      bodyHtml: isHtml ? (m.body?.content ?? null) : null,
      bodyText: !isHtml ? (m.body?.content ?? null) : null,
      attachments: [],
    };
  }

  // One walk of the delta stream from `startUrl`. Separate from
  // listNewMessages so a re-sync can start it over with an empty accumulator:
  // a walk abandoned part-way must not contribute its messages to the retry.
  private async walkDelta(
    startUrl: string,
    resumed: string | null
  ): Promise<{ messages: NormalizedMessage[]; nextDeltaToken: string | null }> {
    let url: string | null = startUrl;
    const messages: NormalizedMessage[] = [];
    let nextDeltaToken: string | null = resumed;
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const data: DeltaPage = await graphGet<DeltaPage>(url);
      for (const raw of data.value ?? []) {
        if (raw["@removed"]) continue; // moved/deleted out of the folder
        const norm = this.normalize(raw);
        if (raw.hasAttachments) norm.attachments = await this.fetchAttachments(raw.id);
        messages.push(norm);
      }
      if (data["@odata.deltaLink"]) {
        nextDeltaToken = data["@odata.deltaLink"];
        url = null;
      } else {
        url = data["@odata.nextLink"] ?? null;
      }
    }
    return { messages, nextDeltaToken };
  }

  async listNewMessages(
    deltaToken: string | null
  ): Promise<{ messages: NormalizedMessage[]; nextDeltaToken: string | null }> {
    const { importId } = await this.resolveFolders();
    const fresh = this.base(`/mailFolders/${importId}/messages/delta?$select=${SELECT}`);
    if (!deltaToken) return this.walkDelta(fresh, null);
    try {
      return await this.walkDelta(deltaToken, deltaToken);
    } catch (err) {
      // Graph expires a delta token and answers 410 ("resync required") — after
      // about 30 days, or whenever the mailbox's own sync state rolls over.
      // Keeping it means asking the same rejected question every ten minutes
      // forever, which is how email import stayed dead from 2026-08-24 to
      // 2026-08-29. The documented recovery is the only recovery: drop the
      // token and read the folder whole.
      //
      // Re-reading cannot duplicate anything: an imported message is MOVED to
      // the Imported subfolder, so a full read of the import folder returns
      // only what has not been imported yet.
      if (!(err instanceof GraphError) || err.status !== 410) throw err;
      return this.walkDelta(fresh, null);
    }
  }

  async markImported(messageId: string): Promise<void> {
    const { importedId } = await this.resolveFolders();
    const read = await graphFetch(this.base(`/messages/${messageId}`), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isRead: true }),
    });
    if (!read.ok) throw new GraphError(`mark-read failed (${read.status})`, "request", read.status);
    const moved = await graphFetch(this.base(`/messages/${messageId}/move`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ destinationId: importedId }),
    });
    if (!moved.ok) throw new GraphError(`move-to-Imported failed (${moved.status})`, "request", moved.status);
  }
}

export function getGraphMailSource(): GraphMailSource | null {
  const upn = getGraphMailboxUpn();
  return upn ? new GraphMailSource(upn) : null;
}
