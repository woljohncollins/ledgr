import { neon } from "@neondatabase/serverless";
import { drizzle as drizzleNeonHttp, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import * as schema from "./schema";

// Non-negotiable (CLAUDE.md, runbook.md §5): serverless functions connect
// through the Neon pooler, never directly. Local Postgres (the hub/spoke
// build) is exempt — it takes the node-postgres branch below.
function assertPooledUrl(url: string): void {
  const hostname = hostnameOf(url);
  if (hostname.endsWith(".neon.tech") && !hostname.includes("-pooler")) {
    throw new Error(
      "DATABASE_URL must be the Neon pooler connection string (hostname contains '-pooler'). See runbook.md §1."
    );
  }
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    throw new Error("DATABASE_URL is not a valid connection URL.");
  }
}

// A Neon URL keeps the neon-http path byte-identically; anything else (a local
// Postgres on a hub/spoke peer, the verify suite's ephemeral clusters) gets
// the node-postgres driver, which also brings real transactions (see
// dbSupportsTransactions and src/lib/sync/apply.ts).
function isNeonUrl(url: string): boolean {
  return hostnameOf(url).endsWith(".neon.tech");
}

// The declared shape stays NeonHttpDatabase so the ~hundreds of existing call
// sites keep typechecking unchanged. The node-postgres instance is cast to it:
// both drivers extend PgDatabase with identical query-builder surfaces, and
// `execute()` returns a `.rows`-bearing result on both, which is all any call
// site reads. ponytail: a type-level lie with a runtime-compatible surface;
// upgrade to a proper union/generic if a driver-specific result shape ever
// bites.
export type Db = NeonHttpDatabase<typeof schema>;

let db: Db | null = null;

// Lazy singleton so importing this module never throws at build time
// (DATABASE_URL is only required when a query actually runs).
export function getDb(): Db {
  if (!db) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error("DATABASE_URL is not set. See .env.example.");
    }
    if (isNeonUrl(url)) {
      assertPooledUrl(url);
      db = drizzleNeonHttp(neon(url), { schema });
    } else {
      // Loaded via an eval'd require so no bundle ever traces `pg`: this
      // module reaches CLIENT component graphs (settings.ts and friends), and
      // pg needs node builtins the browser bundle can't provide. The neon
      // path stays statically imported (fetch-based, browser-buildable).
      // Only ever executes server-side, on a non-Neon DATABASE_URL.
      // ponytail: eval-require is the one bundler-proof escape hatch here;
      // replace with a bundler alias if next.config grows one anyway.
      const req = eval("require") as (id: string) => unknown;
      const { Pool } = req("pg") as typeof import("pg");
      const { drizzle: drizzleNodePg } = req(
        "drizzle-orm/node-postgres"
      ) as typeof import("drizzle-orm/node-postgres");
      db = drizzleNodePg(new Pool({ connectionString: url }), {
        schema,
      }) as unknown as Db;
    }
  }
  return db;
}

// Whether getDb()'s driver supports real transactions (node-postgres does;
// neon-http has no session, so its drizzle instance throws on transaction()).
// The sync apply layer branches on this to SET LOCAL the origin GUC.
export function dbSupportsTransactions(): boolean {
  const url = process.env.DATABASE_URL;
  return !!url && !isNeonUrl(url);
}
