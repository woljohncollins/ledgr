// Apply pending Drizzle migrations from ./drizzle against DATABASE_URL.
// Run via: npm run db:migrate (loads .env / .env.local if present).
//
// Driver branch mirrors src/db/index.ts: a Neon URL migrates over neon-http
// (pooler enforced); anything else (a local hub/spoke Postgres) uses
// node-postgres.
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. See .env.example.");
  process.exit(1);
}
const hostname = new URL(url).hostname;
const isNeon = hostname.endsWith(".neon.tech");
if (isNeon && !hostname.includes("-pooler")) {
  console.error(
    "DATABASE_URL must be the Neon pooler connection string (runbook.md §1)."
  );
  process.exit(1);
}

// Announce the target so a prod vs dev run is never ambiguous (host only,
// never the credential). db:migrate uses .env.local (dev); db:migrate:prod
// uses .env.production.local (prod).
console.log(`Applying migrations to ${hostname} ...`);
if (isNeon) {
  const { neon } = await import("@neondatabase/serverless");
  const { drizzle } = await import("drizzle-orm/neon-http");
  const { migrate } = await import("drizzle-orm/neon-http/migrator");
  const db = drizzle(neon(url));
  await migrate(db, { migrationsFolder: "./drizzle" });
} else {
  const { default: pg } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  const pool = new pg.Pool({ connectionString: url });
  await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
  await pool.end();
}
console.log("Migrations applied.");
