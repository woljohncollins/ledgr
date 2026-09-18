// Shared config + preflight for the satellite-instance scripts
// (new-instance.mjs, sync-instances.mjs).
//
// A "satellite" is another person's single-tenant deploy of this same codebase:
// their GitHub fork, their Vercel project, their Neon database, their Clerk app.
// Code reaches them by syncing their fork; SCHEMA does not travel with it (there
// is no migrate-on-deploy), which is the whole reason these scripts exist.
//
// The roster lives in instances.local.json (gitignored — it holds connection
// strings). instances.example.json is the committed template.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

export const CONFIG_PATH = "instances.local.json";

const DEFAULTS = { upstream: "strategicli/ledgr", branch: "main" };

/** Read + validate instances.local.json. Throws with a usable message. */
export function loadConfig(path = CONFIG_PATH) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error(
        `No ${path} found.\n` +
          `Copy instances.example.json to ${path} and fill in the roster.\n` +
          `It is gitignored: it holds connection strings.`
      );
    }
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${err.message}`);
  }

  const upstream = parsed.upstream || DEFAULTS.upstream;
  const branch = parsed.branch || DEFAULTS.branch;
  const list = Array.isArray(parsed.instances) ? parsed.instances : [];
  if (list.length === 0) {
    throw new Error(`${path} has no instances. See instances.example.json.`);
  }

  const seen = new Set();
  const instances = list.map((entry, i) => {
    const name = entry.name;
    if (!name) throw new Error(`${path}: instance #${i + 1} has no "name".`);
    if (seen.has(name)) throw new Error(`${path}: duplicate instance "${name}".`);
    seen.add(name);
    if (!entry.fork) {
      throw new Error(`${path}: instance "${name}" has no "fork" (owner/repo).`);
    }
    if (!/^[^/\s]+\/[^/\s]+$/.test(entry.fork)) {
      throw new Error(
        `${path}: instance "${name}" fork "${entry.fork}" must be owner/repo.`
      );
    }
    return {
      name,
      fork: entry.fork,
      branch: entry.branch || branch,
      appUrl: entry.appUrl || null,
      ownerEmail: entry.ownerEmail || null,
      databaseUrl: resolveDatabaseUrl(entry, name, path),
    };
  });

  return { upstream, branch, instances };
}

/**
 * A connection string may be inline ("databaseUrl") or named ("databaseUrlEnv",
 * read from the environment) for anyone who would rather keep it out of a file.
 */
function resolveDatabaseUrl(entry, name, path) {
  if (entry.databaseUrlEnv) {
    const value = process.env[entry.databaseUrlEnv];
    if (!value) {
      throw new Error(
        `${path}: instance "${name}" points at env var ${entry.databaseUrlEnv}, which is not set.`
      );
    }
    return value;
  }
  if (!entry.databaseUrl) {
    throw new Error(
      `${path}: instance "${name}" needs "databaseUrl" (or "databaseUrlEnv").`
    );
  }
  return entry.databaseUrl;
}

/** Narrow a roster to --only a,b (or all of it when the flag is absent). */
export function selectInstances(instances, only) {
  if (!only) return instances;
  const wanted = only
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const known = new Set(instances.map((i) => i.name));
  const missing = wanted.filter((w) => !known.has(w));
  if (missing.length > 0) {
    throw new Error(
      `Unknown instance(s): ${missing.join(", ")}. ` +
        `Known: ${[...known].join(", ")}.`
    );
  }
  return instances.filter((i) => wanted.includes(i.name));
}

/**
 * The pooler check migrate.mjs and seed.mjs both make, hoisted so these scripts
 * fail on a bad roster entry before touching anything (serverless requirement,
 * runbook.md §1).
 */
export function assertPooler(databaseUrl, name) {
  let hostname;
  try {
    hostname = new URL(databaseUrl).hostname;
  } catch {
    throw new Error(`Instance "${name}": databaseUrl is not a valid URL.`);
  }
  if (hostname.endsWith(".neon.tech") && !hostname.includes("-pooler")) {
    throw new Error(
      `Instance "${name}": databaseUrl must be the Neon POOLER string (runbook.md §1).`
    );
  }
  return hostname;
}

/** Host only, never the credential — these scripts print progress to a terminal. */
export function hostOf(databaseUrl) {
  try {
    return new URL(databaseUrl).hostname;
  } catch {
    return "(unparseable host)";
  }
}

/** `gh` is how forks get synced; fail early and specifically if it can't. */
export function assertGh() {
  try {
    execFileSync("gh", ["auth", "status"], { stdio: "pipe" });
  } catch (err) {
    const detail = err.code === "ENOENT" ? "not installed" : "not authenticated";
    throw new Error(
      `The GitHub CLI is ${detail}.\n` +
        `Install it (brew install gh) and run: gh auth login`
    );
  }
}

export function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** Head commit of a branch, or null when the repo/branch isn't reachable. */
export function headSha(repo, branch) {
  try {
    return gh(["api", `repos/${repo}/commits/${branch}`, "--jq", ".sha"]).trim();
  } catch {
    return null;
  }
}
