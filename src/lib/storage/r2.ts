// Cloudflare R2 implementation of the storage provider, via aws4fetch
// (SigV4 signing in ~6KB with zero dependencies; the full AWS SDK would be
// a Principle-5 violation for what amounts to one signed URL shape).
import { AwsClient } from "aws4fetch";
import type { PresignedUpload, StorageProvider } from "./types";

const UPLOAD_URL_TTL_SECONDS = 900;
// Downloads are signed per read (ADR-231). Long enough for a slow client to
// finish a large file and for a transcription vendor to pull audio off its own
// queue; short enough that a URL which escapes a browser's history or a share
// recipient's clipboard stops working the same hour. The durable address in a
// body is /files/<id>, which re-signs on every view, so this never bounds how
// long an embed keeps working.
const DOWNLOAD_URL_TTL_SECONDS = 3600;

export type R2Config = {
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  endpoint: string; // https://<account>.r2.cloudflarestorage.com
};

export class R2Provider implements StorageProvider {
  private client: AwsClient;

  constructor(private config: R2Config) {
    this.client = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      service: "s3",
      region: "auto",
    });
  }

  private objectUrl(key: string): URL {
    const base = this.config.endpoint.replace(/\/+$/, "");
    // Encode each path segment; slashes between segments are real.
    const path = key.split("/").map(encodeURIComponent).join("/");
    return new URL(`${base}/${this.config.bucket}/${path}`);
  }

  async presignUpload(
    key: string,
    contentType: string
  ): Promise<PresignedUpload> {
    const url = this.objectUrl(key);
    url.searchParams.set("X-Amz-Expires", String(UPLOAD_URL_TTL_SECONDS));
    const signed = await this.client.sign(
      new Request(url, { method: "PUT", headers: { "Content-Type": contentType } }),
      { aws: { signQuery: true } }
    );
    return { uploadUrl: signed.url };
  }

  async presignDownload(
    key: string,
    ttlSeconds = DOWNLOAD_URL_TTL_SECONDS
  ): Promise<string> {
    const url = this.objectUrl(key);
    url.searchParams.set("X-Amz-Expires", String(ttlSeconds));
    // signQuery puts the credential in the query string, so the bare URL can be
    // handed to anything that fetches — a browser following a 302, a
    // transcription vendor — with no header cooperation required.
    const signed = await this.client.sign(new Request(url, { method: "GET" }), {
      aws: { signQuery: true },
    });
    return signed.url;
  }

  async putObject(
    key: string,
    bytes: Uint8Array,
    contentType: string
  ): Promise<void> {
    // Content-Length must be set explicitly. R2 rejects a PUT that arrives
    // without a length (HTTP 411 MissingContentLength) — it doesn't accept
    // chunked uploads. Local Node's undici infers the length from a buffered
    // body, but the Node runtime on Vercel doesn't (aws4fetch can hand fetch a
    // streamed body), so server-side email-in attachment uploads 411'd in
    // production until the header was made explicit. It's signed in, so the
    // signature still matches.
    const signed = await this.client.sign(
      new Request(this.objectUrl(key), {
        method: "PUT",
        headers: {
          "Content-Type": contentType,
          "Content-Length": String(bytes.byteLength),
        },
        body: bytes as BodyInit,
      })
    );
    const res = await fetch(signed);
    if (!res.ok) throw new Error(`R2 put failed: ${res.status}`);
  }

  async listObjects(
    prefix: string
  ): Promise<{ key: string; sizeBytes: number }[]> {
    // S3 ListObjectsV2, paginated. The XML is parsed with two regexes rather
    // than an XML library (Principle 5): the response shape is fixed and the
    // only user-influenced text (the key) is entity-decoded below.
    const base = this.config.endpoint.replace(/\/+$/, "");
    const decodeXml = (s: string) =>
      s
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&");
    const out: { key: string; sizeBytes: number }[] = [];
    let token: string | undefined;
    do {
      const url = new URL(`${base}/${this.config.bucket}`);
      url.searchParams.set("list-type", "2");
      url.searchParams.set("prefix", prefix);
      url.searchParams.set("max-keys", "1000");
      if (token) url.searchParams.set("continuation-token", token);
      const signed = await this.client.sign(new Request(url, { method: "GET" }));
      const res = await fetch(signed);
      if (!res.ok) throw new Error(`R2 list failed: ${res.status}`);
      const xml = await res.text();
      for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const key = m[1].match(/<Key>([\s\S]*?)<\/Key>/)?.[1];
        const size = m[1].match(/<Size>(\d+)<\/Size>/)?.[1];
        if (key) out.push({ key: decodeXml(key), sizeBytes: Number(size ?? 0) });
      }
      token = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1];
    } while (token);
    return out;
  }

  async deleteObject(key: string): Promise<void> {
    const signed = await this.client.sign(
      new Request(this.objectUrl(key), { method: "DELETE" })
    );
    const res = await fetch(signed);
    // 404 is fine: deleting an already-gone object is success for callers.
    if (!res.ok && res.status !== 404) {
      throw new Error(`R2 delete failed: ${res.status}`);
    }
  }
}
