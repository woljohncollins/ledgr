// Set, show, or VERIFY the R2 bucket CORS policy. Presigned browser uploads
// PUT straight to the bucket from the app origin, and R2 buckets ship with no
// CORS policy at all, so without this every upload dies in preflight with a
// bare "network" error the browser refuses to explain.
//
//   node scripts/r2-cors.mjs --check   # probe every origin for real (no creds needed)
//   node scripts/r2-cors.mjs           # apply the policy below, then verify it
//   node scripts/r2-cors.mjs --show    # just show the current policy
//
// --check is the diagnostic: it sends a real preflight per origin and prints
// pass/fail. Run it first when "file insertion doesn't work"; it needs no
// credentials and no permissions, so it works on any install from any machine.
//
// Credentials come from supervisor/config.json `extraEnv` (a local install) or
// .env.local (a dev checkout), whichever is present — BOM/CRLF-safe, because
// PowerShell wrote them. Reading and writing a bucket's CORS policy needs an
// "Admin Read & Write" R2 API token; the app's own token is object-scoped and
// gets 403 here, which is expected, not a bug: in that case this script prints
// the paste-ready JSON and the dashboard link instead of failing silently.
// Set R2_CORS_ACCESS_KEY_ID / R2_CORS_SECRET_ACCESS_KEY to use an admin token
// for this script alone, without putting admin credentials in the app's env.
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { AwsClient } from "aws4fetch";

const env = {};
if (existsSync("supervisor/config.json")) {
  const cfg = JSON.parse(
    readFileSync("supervisor/config.json", "utf8").replace(/^﻿/, "")
  );
  Object.assign(env, cfg.extraEnv ?? {});
}
if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8")
    .replace(/^﻿/, "")
    .split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)="?([^"]*)"?$/);
    if (m && !(m[1] in env)) env[m[1]] = m[2];
  }
}
// A real environment variable wins, so R2_CORS_* can be supplied for one run.
for (const [k, v] of Object.entries(process.env)) if (v) env[k] = v;

// EVERY origin that shares this bucket must be listed, because a PUT ?cors
// REPLACES the whole policy — there is no per-origin append. This is the
// SUPERSET across both instances (runbook §1): each install has its own
// bucket, so listing the other's origins is harmless (the presigned signature
// is the credential, not CORS), and one shared list means running this from
// either machine can't clobber the other's origins.
//
// THIS install's own address is appended automatically below. Keeping the list
// current by hand is not enough: the local install's address moved to a
// Cloudflare Tunnel on 2026-09-13, the edit was written here but never applied
// (the app's object-scoped token 403s on the ?cors write, and the old script
// reported that as a hard failure with no other route), and every browser
// upload from the local install failed in preflight until 2026-09-16.
const origins = [
  // Brandon's cloud install (Vercel).
  "https://ledgr-teal.vercel.app",
  // Tyler's cloud install (Vercel).
  "https://ledgr-sandy.vercel.app",
  // Tyler's cloud install, custom domain (Clerk production, 2026-08-31).
  "https://ledgr.tylerjcollins.com",
  // Vercel branch previews (either instance) — what lets a preview upload.
  "https://*.vercel.app",
  // Brandon's local install, public address via Cloudflare Tunnel.
  "https://ledgr.brasco.fyi",
  // Brandon's local install, the older Tailscale Funnel address (kept as a spare).
  "https://bc-edgewood.char-arcturus.ts.net",
  // A local install and `npm run dev` on the machine itself.
  "http://localhost:3000",
];
const ownOrigin = env.NEXT_PUBLIC_APP_URL
  ? new URL(env.NEXT_PUBLIC_APP_URL).origin
  : null;
if (ownOrigin && !origins.includes(ownOrigin)) origins.push(ownOrigin);

const { R2_BUCKET: bucket, R2_ENDPOINT: endpoint } = env;
if (!bucket || !endpoint) {
  console.error("R2_BUCKET / R2_ENDPOINT missing; see runbook.md §1.");
  process.exit(1);
}
const base = endpoint.replace(/\/+$/, "");
const corsUrl = `${base}/${bucket}?cors`;

// Only PUT needs CORS: presigned uploads. Reads are a 302 from /files/<id> to a
// signed GET, followed by a plain <img>/<a>, which never preflights.
const rule = {
  AllowedOrigins: origins,
  AllowedMethods: ["PUT"],
  AllowedHeaders: ["content-type"],
  MaxAgeSeconds: 3600,
};
const corsXml = `<?xml version="1.0" encoding="UTF-8"?>
<CORSConfiguration>
  <CORSRule>
${origins.map((o) => `    <AllowedOrigin>${o}</AllowedOrigin>`).join("\n")}
    <AllowedMethod>PUT</AllowedMethod>
    <AllowedHeader>content-type</AllowedHeader>
    <MaxAgeSeconds>3600</MaxAgeSeconds>
  </CORSRule>
</CORSConfiguration>`;

// The real preflight, exactly as a browser sends it before a presigned PUT.
// A wildcard entry can't be probed as written (no browser ever sends
// `*.vercel.app` as an Origin), so it is checked with a host that matches it.
async function check() {
  let bad = 0;
  for (const o of origins) {
    const probe = o.replace("*.", "ledgr-preview-probe.");
    const res = await fetch(`${base}/${bucket}/cors-probe`, {
      method: "OPTIONS",
      headers: {
        Origin: probe,
        "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    const ok = res.headers.get("access-control-allow-origin") === probe;
    if (!ok) bad++;
    console.log(
      `${ok ? "OK  " : "FAIL"}  ${o}${o === ownOrigin ? "   <- this install" : ""}`
    );
  }
  if (bad) {
    console.error(
      `\n${bad} origin(s) rejected. Browser uploads from those addresses die in ` +
        `preflight. Fix: node scripts/r2-cors.mjs`
    );
    process.exitCode = 1;
  } else {
    console.log("\nAll origins allowed. Browser uploads will preflight cleanly.");
  }
}

// The dashboard route, for when the only token available is object-scoped.
function manual() {
  const account = new URL(base).hostname.split(".")[0];
  console.log(
    `\nPaste this at Cloudflare -> R2 -> ${bucket} -> Settings -> CORS Policy -> Edit:\n` +
      `  https://dash.cloudflare.com/${account}/r2/default/buckets/${bucket}/settings\n\n` +
      JSON.stringify([rule], null, 2) +
      `\n\nThen verify: node scripts/r2-cors.mjs --check`
  );
}

if (process.argv.includes("--check")) {
  await check();
  process.exit();
}

const accessKeyId = env.R2_CORS_ACCESS_KEY_ID || env.R2_ACCESS_KEY_ID;
const secretAccessKey = env.R2_CORS_SECRET_ACCESS_KEY || env.R2_SECRET_ACCESS_KEY;
if (!accessKeyId || !secretAccessKey) {
  console.error("No R2 credentials found.");
  manual();
  process.exit(1);
}
const client = new AwsClient({
  accessKeyId,
  secretAccessKey,
  service: "s3",
  region: "auto",
});

async function show() {
  const res = await fetch(await client.sign(new Request(corsUrl)));
  const body = await res.text();
  if (res.status === 404) console.log("No CORS policy is set on the bucket.");
  else console.log(`GET ?cors -> ${res.status}\n${body}`);
  return res.status;
}

if (process.argv.includes("--show")) {
  if ((await show()) === 403) manual();
  process.exit();
}

const put = await fetch(
  await client.sign(
    new Request(corsUrl, {
      method: "PUT",
      body: corsXml,
      headers: {
        "Content-Type": "application/xml",
        // S3 PutBucketCors requires Content-MD5.
        "Content-MD5": createHash("md5").update(corsXml).digest("base64"),
      },
    })
  )
);
if (!put.ok) {
  console.error(`PUT ?cors -> ${put.status}. This token cannot manage bucket settings.`);
  console.error(
    put.status === 403
      ? "Expected for an object-scoped token. Either paste the policy below, or set " +
          "R2_CORS_ACCESS_KEY_ID / R2_CORS_SECRET_ACCESS_KEY to an Admin Read & Write " +
          "token and rerun."
      : await put.text()
  );
  manual();
  process.exit(1);
}
console.log(`CORS policy applied for: ${origins.join(", ")}`);
await check();
