// Attachment tools (ADR-150): let an AI put an image or file into a note.
// The browser upload path (presign → PUT bytes → ![](url)) can't work over MCP
// unchanged — an AI can't PUT to a presigned URL from inside a tool call — so
// there are two doors, matched to what the AI can actually do:
//   - attach_file: the AI hands Ledgr the bytes (a sourceUrl the server fetches,
//     or inline base64) and the server does the R2 write via
//     createAttachmentFromBytes. One call; best for small/medium files and for
//     anything the AI has as a URL. base64 rides in the tool call, so it bloats
//     the context — impractical for large files.
//   - create_upload_url + embed_attachment: the presigned-PUT handshake for
//     LOCAL or LARGE files (an agent that can perform an HTTP PUT — e.g. curl).
//     create_upload_url reserves the row + returns a presigned PUT; the agent
//     PUTs the local bytes STRAIGHT to R2 (never through the tool call or the
//     app server, so size stops mattering); embed_attachment then adds the
//     reference to the body. Same handshake the ~3,900-image migration used.
// Both go through the same owner/quota/cap checks as the in-app POST
// /api/attachments. By default the reference is embedded in the item body
// (image → ![alt](url), any other file → [name](url)). Markdown stays the
// source of truth (ADR-037).
import { bodyMarkdown, makeMarkdownBody } from "@/lib/body";
import { imageToMarkdown } from "@/lib/editor/image-markdown";
import {
  createAttachment,
  createAttachmentFromBytes,
  getAttachment,
  parseAttachmentUrl,
  stableAttachmentUrl,
} from "@/lib/attachments";
import { asUuid } from "@/lib/api";
import { ItemError, getItem } from "@/lib/items";
import { updateItem } from "@/lib/item-mutations";
import { getType } from "@/lib/types";
import { optEnum, optInt, optString, reqString } from "./args";
import type { McpTool } from "./wire";

// Ceiling on bytes we'll pull from a sourceUrl in one shot. Comfortably covers
// images and documents an AI would drop into a note, without risking an OOM on
// a hostile or mistaken URL. The per-file/quota caps still apply on top of this
// (reserveAttachment), this just bounds what we buffer before those run.
const FETCH_MAX_BYTES = 50 * 1024 * 1024;

export function isImageContentType(contentType: string): boolean {
  return /^image\//i.test(contentType);
}

// File extensions we treat as inline images when a content type isn't known
// (embed_attachment infers from the public URL, which ends in the filename).
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|avif|heic|heif|bmp|tiff?)$/i;

// The filename at the tail of a URL path (decoded), or undefined.
export function basenameFromUrl(url: string): string | undefined {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    /* not an absolute URL — fall back to the raw string */
  }
  const last = path.split("/").pop() || "";
  try {
    return decodeURIComponent(last).trim() || undefined;
  } catch {
    return last.trim() || undefined;
  }
}

// Best-effort "is this URL an image?" from its filename extension, for when no
// content type is on hand (the embed_attachment path).
export function isImageByUrl(url: string): boolean {
  return IMAGE_EXT_RE.test(basenameFromUrl(url) ?? url);
}

// The markdown reference embedded in the item body: an image renders inline,
// any other file becomes a link. Escapes brackets in the label either way.
// Exported (with the parsers below) so the pure glue is node-testable, the same
// discipline image-markdown.ts follows.
// Normalizes a storage-provider URL to the stable /files/<id> address before it
// reaches a body (ADR-228). Done HERE rather than at each call site because
// embed_attachment takes a URL from the caller: an AI that passes the provider
// URL, or that reuses one it saw in an older body, still gets the stable form
// stored. Any other URL (an externally hosted image) passes through untouched.
export function embedMarkdown(
  isImage: boolean,
  url: string,
  label: string
): string {
  const src = stableAttachmentUrl(url);
  return isImage
    ? imageToMarkdown({ src, alt: label })
    : `[${label.replace(/[[\]]/g, "\\$&")}](${src})`;
}

export function buildEmbedReference(
  contentType: string,
  url: string,
  label: string
): string {
  return embedMarkdown(isImageContentType(contentType), url, label);
}

// Append a markdown reference to an item's body without clobbering it: read the
// current body, add the reference after a blank-line separator, save through the
// same owner-scoped updateItem (revision-snapshotted) the app uses. Shared by
// attach_file and embed_attachment so neither reimplements the safe merge (a
// blind bodyMarkdown replace would drop the rest of the note).
async function appendReferenceToBody(
  ownerId: string,
  itemId: string,
  ref: string
): Promise<void> {
  const item = await getItem(ownerId, itemId);
  const existing = bodyMarkdown(item.body);
  const next = existing.trim() ? `${existing.replace(/\s+$/, "")}\n\n${ref}\n` : `${ref}\n`;
  await updateItem(ownerId, itemId, { body: makeMarkdownBody(next) });
}

// Decode base64 (bare or a data: URI) to bytes without Buffer, so it works in
// any runtime. Returns the bytes plus any content type carried by a data URI.
export function decodeBase64(input: string): { bytes: Uint8Array; contentType?: string } {
  let contentType: string | undefined;
  let b64 = input;
  if (input.startsWith("data:")) {
    const comma = input.indexOf(",");
    if (comma < 0) throw new ItemError("bad_request", "malformed data: URI in dataBase64");
    const header = input.slice(5, comma); // e.g. image/png;base64
    const semi = header.indexOf(";");
    const ct = (semi >= 0 ? header.slice(0, semi) : header).trim();
    if (ct) contentType = ct;
    b64 = input.slice(comma + 1);
  }
  const clean = b64.replace(/\s+/g, "");
  let binary: string;
  try {
    binary = atob(clean);
  } catch {
    throw new ItemError("bad_request", "dataBase64 is not valid base64");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { bytes, contentType };
}

// Pull a filename out of a Content-Disposition header if it carries one.
export function filenameFromDisposition(header: string | null): string | undefined {
  if (!header) return undefined;
  const star = header.match(/filename\*=(?:UTF-8'')?([^;]+)/i);
  if (star) {
    try {
      return decodeURIComponent(star[1].replace(/^["']|["']$/g, ""));
    } catch {
      /* fall through to the plain form */
    }
  }
  const plain = header.match(/filename=("?)([^";]+)\1/i);
  return plain ? plain[2] : undefined;
}

// Fetch the bytes at a URL, guarded: http/https only, size-capped, and never
// buffering more than the ceiling. Returns bytes + best-effort content type and
// filename derived from the response.
async function fetchSource(sourceUrl: string): Promise<{
  bytes: Uint8Array;
  contentType?: string;
  filename?: string;
}> {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    throw new ItemError("bad_request", "sourceUrl is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ItemError("bad_request", "sourceUrl must be an http or https URL");
  }

  let res: Response;
  try {
    res = await fetch(url, { redirect: "follow" });
  } catch {
    throw new ItemError("bad_request", `could not fetch sourceUrl`);
  }
  if (!res.ok) {
    throw new ItemError("bad_request", `could not fetch sourceUrl (HTTP ${res.status})`);
  }

  const declared = Number(res.headers.get("content-length") || 0);
  if (declared && declared > FETCH_MAX_BYTES) {
    throw new ItemError(
      "bad_request",
      `sourceUrl is too large (${Math.round(declared / (1024 * 1024))}MB; limit ${Math.round(FETCH_MAX_BYTES / (1024 * 1024))}MB)`
    );
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > FETCH_MAX_BYTES) {
    throw new ItemError(
      "bad_request",
      `sourceUrl is too large (limit ${Math.round(FETCH_MAX_BYTES / (1024 * 1024))}MB)`
    );
  }

  const ct = res.headers.get("content-type")?.split(";")[0].trim() || undefined;
  const fromDisposition = filenameFromDisposition(res.headers.get("content-disposition"));
  const fromPath = decodeURIComponent(url.pathname.split("/").pop() || "").trim() || undefined;
  return { bytes: buf, contentType: ct, filename: fromDisposition || fromPath };
}

export const attachmentTools: McpTool[] = [
  {
    name: "attach_file",
    title: "Attach a file or image to an item",
    description:
      "Add an image or file to an item (a note, meeting, etc.) — store the bytes " +
      "in Ledgr's file storage and, by default, embed a reference in the item's " +
      "markdown body (an image shows inline as ![alt](url); any other file shows " +
      "as a [filename](url) link). Provide the bytes one of two ways: sourceUrl " +
      "(an http/https URL the server fetches — the usual way to add an image or " +
      "document you have a link to) or dataBase64 (the file's bytes as base64, or " +
      "a data: URI — for generated or pasted content). Give a filename when the " +
      "URL doesn't carry one; contentType is inferred when you omit it. Set " +
      "embedInBody=false to attach without touching the body. Requires file " +
      "storage to be configured; subject to the per-file and ~10GB quota caps.",
    inputSchema: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "The item (UUID) to attach the file to." },
        sourceUrl: {
          type: "string",
          description:
            "http/https URL to fetch the file bytes from. Use this or dataBase64.",
        },
        dataBase64: {
          type: "string",
          description:
            "The file bytes as base64, or a full data: URI (data:<type>;base64,<...>). " +
            "Use this or sourceUrl.",
        },
        filename: {
          type: "string",
          description:
            "Filename to store (e.g. diagram.png). Optional when it can be derived " +
            "from sourceUrl; recommended for dataBase64.",
        },
        contentType: {
          type: "string",
          description:
            "MIME type (e.g. image/png, application/pdf). Optional — inferred from " +
            "the response or data: URI when omitted; drives whether the body embed " +
            "renders as an inline image or a file link.",
        },
        alt: {
          type: "string",
          description:
            "Alt text / caption for the body embed (defaults to the filename). " +
            "Ignored when embedInBody is false.",
        },
        embedInBody: {
          type: "boolean",
          description:
            "Append the markdown reference to the item body (default true). Set " +
            "false to attach the file without changing the body.",
        },
        propertyKey: {
          type: "string",
          description:
            "Write the uploaded file's stable address into this image-kind custom " +
            "property of the item; embedInBody then defaults to false.",
        },
      },
      required: ["itemId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    handler: async (ownerId, args) => {
      const itemId = asUuid(args.itemId, "itemId");
      const sourceUrl = optString(args, "sourceUrl");
      const dataBase64 = args.dataBase64; // may be a large string; don't trim/normalize via optString
      const argFilename = optString(args, "filename");
      const argContentType = optString(args, "contentType");
      const alt = optString(args, "alt");
      const propertyKey = optString(args, "propertyKey");
      // A propertyKey write is the point of the call, so don't also embed in
      // the body unless explicitly asked (still honored if set true).
      const embedInBody = args.embedInBody === true || (args.embedInBody !== false && !propertyKey);

      if (propertyKey) {
        // Refuse early, before spending an upload, if the key isn't declared
        // as an image property on the item's type.
        const item = await getItem(ownerId, itemId);
        const typeDef = await getType(item.type).catch(() => null);
        const prop = typeDef?.propertySchema.find((p) => p.key === propertyKey);
        if (!prop || prop.kind !== "image") {
          throw new ItemError(
            "bad_request",
            `propertyKey '${propertyKey}' is not an image-kind property on type '${item.type}'`
          );
        }
      }

      if (!sourceUrl && (dataBase64 === undefined || dataBase64 === null)) {
        throw new ItemError("bad_request", "provide sourceUrl or dataBase64");
      }
      if (sourceUrl && dataBase64 != null) {
        throw new ItemError("bad_request", "provide only one of sourceUrl or dataBase64");
      }

      let bytes: Uint8Array;
      let contentType: string | undefined = argContentType;
      let filename: string | undefined = argFilename;

      if (sourceUrl) {
        const fetched = await fetchSource(sourceUrl);
        bytes = fetched.bytes;
        contentType = contentType || fetched.contentType;
        filename = filename || fetched.filename;
      } else {
        if (typeof dataBase64 !== "string") {
          throw new ItemError("bad_request", "dataBase64 must be a string");
        }
        const decoded = decodeBase64(dataBase64);
        bytes = decoded.bytes;
        contentType = contentType || decoded.contentType;
      }

      if (bytes.byteLength === 0) {
        throw new ItemError("bad_request", "the file has no bytes");
      }
      if (!filename) filename = "attachment";
      if (!contentType) contentType = "application/octet-stream";

      const attachment = await createAttachmentFromBytes(ownerId, {
        itemId,
        filename,
        contentType,
        bytes,
      });

      let embedded = false;
      if (embedInBody) {
        const label = alt || attachment.filename;
        const ref = buildEmbedReference(contentType, attachment.fileUrl, label);
        await appendReferenceToBody(ownerId, itemId, ref);
        embedded = true;
      }
      if (propertyKey) {
        await updateItem(ownerId, itemId, { propertyPatch: { [propertyKey]: attachment.fileUrl } });
      }

      return {
        id: attachment.id,
        itemId,
        filename: attachment.filename,
        contentType,
        sizeBytes: bytes.byteLength,
        fileUrl: attachment.fileUrl,
        publicUrl: attachment.publicUrl,
        embedded,
        propertyKey,
        // Only present once usage crosses 80% — so it reads as a warning when
        // it appears, rather than a number to tune out on every upload.
        storageWarning: attachment.usage.message ?? undefined,
      };
    },
  },
  {
    name: "create_upload_url",
    title: "Get a presigned upload URL for a local/large file",
    description:
      "Step 1 of the two-step upload for a LOCAL or LARGE file (use this instead " +
      "of attach_file when the bytes are on the local disk or too big to inline as " +
      "base64). Reserves an attachment on the item and returns a short-lived " +
      "presigned PUT `uploadUrl` plus the file's stable `fileUrl`. You then PUT the " +
      "raw file bytes straight to uploadUrl with header 'Content-Type: <the same " +
      "contentType>' (the bytes go directly to storage, never back through this " +
      "tool), and finally call embed_attachment with the returned fileUrl to add " +
      "it to the note. Requires file storage configured; subject to the per-file " +
      "and ~10GB quota caps. The URL expires in ~15 minutes.",
    inputSchema: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "The item (UUID) the file belongs to." },
        filename: { type: "string", description: "Filename to store (e.g. photo.jpg)." },
        contentType: {
          type: "string",
          description:
            "MIME type (e.g. image/jpeg, application/pdf). You MUST send this exact " +
            "value as the Content-Type header on the PUT or the signature fails.",
        },
        sizeBytes: {
          type: "integer",
          description: "The file's size in bytes (checked against the per-file + quota caps).",
          minimum: 1,
        },
      },
      required: ["itemId", "filename", "contentType", "sizeBytes"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    handler: async (ownerId, args) => {
      const itemId = asUuid(args.itemId, "itemId");
      const filename = reqString(args, "filename");
      const contentType = reqString(args, "contentType");
      const sizeBytes = optInt(args, "sizeBytes");
      if (sizeBytes === undefined) {
        throw new ItemError("bad_request", "sizeBytes is required");
      }
      const reserved = await createAttachment(ownerId, {
        itemId,
        filename,
        contentType,
        sizeBytes,
      });
      return {
        attachmentId: reserved.id,
        itemId,
        filename: reserved.filename,
        storageKey: reserved.storageKey,
        uploadUrl: reserved.uploadUrl,
        fileUrl: reserved.fileUrl,
        publicUrl: reserved.publicUrl,
        contentType,
        storageWarning: reserved.usage.message ?? undefined,
        next:
          `PUT the file bytes to uploadUrl with header 'Content-Type: ${contentType}' ` +
          `(must match exactly), then call embed_attachment with itemId ${itemId} and ` +
          `this fileUrl to add it to the note.`,
      };
    },
  },
  {
    name: "embed_attachment",
    title: "Embed an uploaded file into an item's body",
    description:
      "Step 2 of the two-step upload: after a successful PUT to a create_upload_url " +
      "uploadUrl, add the file to the item's markdown body — an image renders inline " +
      "as ![alt](url), any other file as a [name](url) link. Pass the fileUrl that " +
      "create_upload_url returned (its publicUrl also works — either is normalized to " +
      "the stable address before it is stored). Whether it renders as an image is inferred from " +
      "the URL's extension unless you set kind. Appends to the body without " +
      "disturbing the rest of it. (attach_file already embeds on its own; this is " +
      "only for the presigned-upload path.)",
    inputSchema: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "The item (UUID) to embed into." },
        publicUrl: {
          type: "string",
          description: "The publicUrl returned by create_upload_url (the file must already be PUT).",
        },
        alt: {
          type: "string",
          description: "Alt text / caption (defaults to the filename from the URL).",
        },
        kind: {
          type: "string",
          enum: ["image", "file"],
          description:
            "Force inline image vs. file link. Omit to infer from the URL extension.",
        },
      },
      required: ["itemId", "publicUrl"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    handler: async (ownerId, args) => {
      const itemId = asUuid(args.itemId, "itemId");
      const url = reqString(args, "publicUrl");
      const alt = optString(args, "alt");
      const kind = optEnum(args, "kind", ["image", "file"] as const);
      // A stable /files/<id> address has no filename and no extension, so the
      // two things normally read off the URL — is it an image, what is it
      // called — come from the attachment row instead (ADR-228). Without this,
      // every stable address embedded as a file link labelled with a UUID.
      const stableId = parseAttachmentUrl(stableAttachmentUrl(url));
      const row = stableId ? await getAttachment(ownerId, stableId) : null;
      const isImage = kind
        ? kind === "image"
        : row
          ? isImageContentType(row.contentType)
          : isImageByUrl(url);
      const label =
        alt || row?.filename || basenameFromUrl(url) || "attachment";
      const ref = embedMarkdown(isImage, url, label);
      await appendReferenceToBody(ownerId, itemId, ref);
      return { itemId, embedded: true, isImage, markdown: ref };
    },
  },
];
