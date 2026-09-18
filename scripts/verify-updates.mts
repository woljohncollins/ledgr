// Verification for the Updates surface (Build → MAINTAIN): the two axes an
// instance can fall behind on, and the gate that decides whether it may update
// itself.
//
// Everything here is pure, deliberately: the decisions worth guarding (which
// migrations are pending, whether the button is allowed) are extracted from the
// I/O precisely so they can be checked with no database and no GitHub token,
// which is what lets them run on every merge. The live counterpart is
// verify-updates-live.mts.
//
// Run: npx tsx scripts/verify-updates.mts
import { readFileSync, existsSync } from "node:fs";
import {
  pendingMigrations,
  resolveApplicability,
  getInstanceIdentity,
  type InstanceIdentity,
} from "../src/lib/updates";
import type { CodeStatus } from "../src/lib/github/client";
import { isLocalPeerInstance } from "../src/lib/updates";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

// ── (1) pendingMigrations: the rule the migrator actually uses ───────────────

const entries = [
  { when: 100, tag: "0000_first" },
  { when: 200, tag: "0001_second" },
  { when: 300, tag: "0002_third" },
];

check(
  "a database with no migrations table owes every migration",
  pendingMigrations(entries, null).length === 3
);
check(
  "a fully migrated database owes nothing",
  pendingMigrations(entries, 300).length === 0
);
check(
  "a partially migrated database owes only the newer ones",
  JSON.stringify(pendingMigrations(entries, 100)) ===
    JSON.stringify(["0001_second", "0002_third"])
);
check(
  "pending is exclusive of the applied timestamp, not inclusive",
  !pendingMigrations(entries, 200).includes("0001_second")
);
// The trap COLLAB.md hit during the PJ chunk: a migration renumbered to sit
// BEFORE the newest applied entry is silently skipped by the migrator. The
// checker must agree with that behavior rather than quietly disagreeing, or the
// page would claim an instance is current in exactly the case it isn't.
check(
  "an out-of-order (older `when`) migration reports as NOT pending, matching the migrator",
  pendingMigrations([{ when: 150, tag: "0003_renumbered" }], 300).length === 0
);
check("an empty journal owes nothing", pendingMigrations([], 300).length === 0);

// ── (2) The real journal is well-formed and monotonic ───────────────────────

const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as {
  entries: { when: number; tag: string }[];
};
check("the migration journal has entries", journal.entries.length > 0, `${journal.entries.length}`);
const whens = journal.entries.map((e) => e.when);
check(
  "journal `when` values are strictly increasing (else migrations get skipped)",
  whens.every((w, i) => i === 0 || w > whens[i - 1])
);
check(
  "every journal entry has a tag",
  journal.entries.every((e) => typeof e.tag === "string" && e.tag.length > 0)
);

// ── (3) resolveApplicability: who may press the button ──────────────────────

const base: InstanceIdentity = {
  sha: "abc123",
  shortSha: "abc123",
  deployRepo: "someone/ledgr",
  upstreamRepo: "strategicli/ledgr",
  branch: "main",
  isSatellite: true,
  selfUpdate: "off",
  vercelEnv: "production",
  supervisorDir: null,
  isLocalPeer: false,
};
const behind = (touchesSchema: boolean): CodeStatus => ({
  state: "behind",
  count: 3,
  commits: [],
  touchesSchema,
  truncated: false,
});
const current: CodeStatus = { state: "current", touchesSchema: false };

check(
  "nothing to apply when already current",
  resolveApplicability({ ...base, selfUpdate: "on" }, current).canApply === false
);
check(
  "a source instance is never offered the button",
  resolveApplicability(
    { ...base, isSatellite: false, selfUpdate: "on" },
    behind(false)
  ).canApply === false
);
check(
  "a source instance explains itself rather than going silent",
  !!resolveApplicability({ ...base, isSatellite: false, selfUpdate: "on" }, behind(false))
    .blockedReason
);
check(
  "self-update off blocks even a schema-free update",
  resolveApplicability({ ...base, selfUpdate: "off" }, behind(false)).canApply === false
);
check(
  "safe mode allows an update that does not touch the schema",
  resolveApplicability({ ...base, selfUpdate: "safe" }, behind(false)).canApply === true
);
check(
  "SAFE MODE BLOCKS A SCHEMA-CARRYING UPDATE (the whole point of the gate)",
  resolveApplicability({ ...base, selfUpdate: "safe" }, behind(true)).canApply === false
);
check(
  "the schema block says why, so it isn't read as a broken button",
  /database/i.test(
    resolveApplicability({ ...base, selfUpdate: "safe" }, behind(true)).blockedReason ?? ""
  )
);
check(
  "on mode allows a schema-carrying update (it migrates during the build)",
  resolveApplicability({ ...base, selfUpdate: "on" }, behind(true)).canApply === true
);
check(
  "an unrecognized mode falls back to off, never to on",
  resolveApplicability(
    { ...base, selfUpdate: "banana" as unknown as InstanceIdentity["selfUpdate"] },
    behind(false)
  ).canApply === false
);
check(
  "an allowed satellite update carries the github-merge strategy",
  resolveApplicability({ ...base, selfUpdate: "safe" }, behind(false)).strategy ===
    "github-merge"
);
check(
  "a blocked update carries no strategy",
  resolveApplicability({ ...base, selfUpdate: "off" }, behind(false)).strategy === null
);

// ── (3b) The local-peer path (LH2, ADR-206): supervisor-signal strategy ─────

// A local peer: not on Vercel at all, with a supervisor signal dir configured.
const localPeer: InstanceIdentity = {
  ...base,
  isSatellite: false,
  deployRepo: null,
  vercelEnv: null,
  supervisorDir: "/data/ledgr",
  selfUpdate: "on",
  isLocalPeer: true,
};

// The compare-against-upstream gate (bug, 2026-09-11): a hub is not a fork, but
// it can still be behind, so it must be checked like a satellite is. Only a
// Vercel deploy of the upstream repo itself is a "source" that never lags.
check("a local peer is eligible for the upstream compare", isLocalPeerInstance(localPeer));
check(
  "a Vercel source deploy is not (it updates on push)",
  !isLocalPeerInstance({ ...base, isSatellite: false, deployRepo: "strategicli/ledgr", vercelEnv: "production", supervisorDir: null })
);
check(
  "a stray supervisor dir on a Vercel deploy does not make it a peer",
  !isLocalPeerInstance({ ...localPeer, vercelEnv: "production" })
);

check(
  "a local peer with self-update on may apply, via the supervisor signal",
  (() => {
    const r = resolveApplicability(localPeer, behind(true));
    return r.canApply === true && r.strategy === "supervisor-signal";
  })()
);
check(
  "a local peer with self-update off is blocked (fail closed)",
  resolveApplicability({ ...localPeer, selfUpdate: "off" }, behind(false)).canApply === false
);
check(
  "a local peer in safe mode blocks a schema-carrying update (same rule as satellites)",
  resolveApplicability({ ...localPeer, selfUpdate: "safe" }, behind(true)).canApply === false
);
check(
  "a local peer in safe mode allows a schema-free update",
  resolveApplicability({ ...localPeer, selfUpdate: "safe" }, behind(false)).strategy ===
    "supervisor-signal"
);
check(
  "a VERCEL deploy with a stray supervisor dir NEVER takes the supervisor path",
  resolveApplicability(
    { ...localPeer, vercelEnv: "production", isSatellite: true, deployRepo: "someone/ledgr" },
    behind(false)
  ).strategy === "github-merge"
);
check(
  "a local next-start without a supervisor dir has nothing to signal (source-instance answer)",
  (() => {
    const r = resolveApplicability({ ...localPeer, supervisorDir: null }, behind(false));
    return r.canApply === false && r.strategy === null;
  })()
);
check(
  "a current local peer has nothing to apply",
  resolveApplicability(localPeer, current).canApply === false
);

// ── (4) getInstanceIdentity: env resolution ─────────────────────────────────

const saved = { ...process.env };
function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

withEnv(
  {
    VERCEL_GIT_REPO_OWNER: "michellecollins1212-rosanne",
    VERCEL_GIT_REPO_SLUG: "ledgr",
    GITHUB_REPO: "strategicli/ledgr",
    LEDGR_UPDATE_REPO: undefined,
    LEDGR_SELF_UPDATE: "safe",
  },
  () => {
    const id = getInstanceIdentity();
    check(
      "a fork deploy is detected as a satellite with no extra config",
      id.isSatellite && id.deployRepo === "michellecollins1212-rosanne/ledgr"
    );
    check("self-update mode is read from the environment", id.selfUpdate === "safe");
  }
);

withEnv(
  {
    VERCEL_GIT_REPO_OWNER: "strategicli",
    VERCEL_GIT_REPO_SLUG: "ledgr",
    GITHUB_REPO: "strategicli/ledgr",
    LEDGR_UPDATE_REPO: undefined,
  },
  () => {
    check(
      "deploying from the shared repo is NOT a satellite",
      getInstanceIdentity().isSatellite === false
    );
  }
);

withEnv(
  {
    VERCEL_GIT_REPO_OWNER: "StrategiCLI",
    VERCEL_GIT_REPO_SLUG: "Ledgr",
    GITHUB_REPO: "strategicli/ledgr",
    LEDGR_UPDATE_REPO: undefined,
  },
  () => {
    check(
      "satellite detection is case-insensitive (GitHub names are)",
      getInstanceIdentity().isSatellite === false
    );
  }
);

withEnv({ VERCEL_GIT_REPO_OWNER: undefined, VERCEL_GIT_REPO_SLUG: undefined, LEDGR_UPDATE_REPO: undefined }, () => {
  const id = getInstanceIdentity();
  check("no git metadata means no satellite claim", id.isSatellite === false && id.deployRepo === null);
});

withEnv({ LEDGR_SELF_UPDATE: undefined }, () => {
  check("self-update defaults to off when unset", getInstanceIdentity().selfUpdate === "off");
});

withEnv({ LEDGR_SUPERVISOR_DIR: undefined }, () => {
  check(
    "supervisorDir is null when unset (the local apply path stays closed)",
    getInstanceIdentity().supervisorDir === null
  );
});
withEnv({ LEDGR_SUPERVISOR_DIR: "/data/ledgr" }, () => {
  check(
    "supervisorDir is read from the environment",
    getInstanceIdentity().supervisorDir === "/data/ledgr"
  );
});

// ── (5) Structural guards ───────────────────────────────────────────────────

const updatesSrc = readFileSync("src/lib/updates.ts", "utf8");
check(
  "the journal is a static import, not a filesystem read (it must ship in the bundle)",
  updatesSrc.includes('from "../../drizzle/meta/_journal.json"') &&
    !/readFileSync|node:fs/.test(updatesSrc)
);

const routeSrc = readFileSync("src/app/api/updates/route.ts", "utf8");
check("the updates route is owner-gated", routeSrc.includes("requireOwner"));
check(
  "the POST route re-checks applicability server-side rather than trusting the caller",
  routeSrc.includes("resolveApplicability")
);
check(
  "the POST route branches on the supervisor-signal strategy (local apply path)",
  routeSrc.includes('"supervisor-signal"') && routeSrc.includes("update-requested")
);

const navSrc = readFileSync("src/lib/build-nav.ts", "utf8");
check("Updates is registered in the Build nav", navSrc.includes('href: "/build/updates"'));
check("the Updates page exists", existsSync("src/app/build/updates/page.tsx"));

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
  scripts: Record<string, string>;
};
check(
  "build:satellite migrates BEFORE building (order is the safety property)",
  /migrate\.mjs\s*&&\s*next build/.test(pkg.scripts["build:satellite"] ?? "")
);
check("instance:new is wired", !!pkg.scripts["instance:new"]);
check("instances:sync is wired", !!pkg.scripts["instances:sync"]);

const gitignore = readFileSync(".gitignore", "utf8");
check(
  "the instance roster (which holds connection strings) is gitignored",
  gitignore.includes("instances.local.json")
);
check("the roster template is tracked", existsSync("instances.example.json"));

// The live counterpart (the real schema check against a real database) is
// verify-updates-live.mts. Kept separate on purpose: verify-ci.mjs classifies a
// script as backend-needing by looking for a connection string in its source, so
// folding the live check in here would pull these pure guards OUT of CI, and the
// fail-closed gate above is exactly the check worth running on every merge.

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
