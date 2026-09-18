// Pure checks for the storage-usage warning (2026-08-28). No DB: storageUsageFrom
// is the one place the thresholds and the wording live, so pinning it here keeps
// every surface (upload response, MCP tools, any future gauge) consistent.
import {
  QUOTA_BYTES,
  QUOTA_WARN_FRACTION,
  QUOTA_CRITICAL_FRACTION,
  storageUsageFrom,
} from "../src/lib/attachments";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}
const at = (f: number) => storageUsageFrom(Math.round(QUOTA_BYTES * f));

console.log("\n# thresholds");
check("quota is 10GB", QUOTA_BYTES === 10 * 1024 * 1024 * 1024);
check("warns at 80%", QUOTA_WARN_FRACTION === 0.8);
check("critical at 95%", QUOTA_CRITICAL_FRACTION === 0.95);

console.log("\n# levels");
check("empty is ok", at(0).level === "ok");
check("half full is ok", at(0.5).level === "ok");
check("just under 80% is still ok", at(0.799).level === "ok", at(0.799).level);
check("exactly 80% warns", at(0.8).level === "warn", at(0.8).level);
check("90% warns", at(0.9).level === "warn");
check("exactly 95% is critical", at(0.95).level === "critical", at(0.95).level);
check("full is critical", at(1).level === "critical");
check("over quota is critical, not a crash", at(1.5).level === "critical");

console.log("\n# message: silent until it matters, then specific");
check("no message while ok", at(0.5).message === null);
check("warn says the percentage", (at(0.85).message ?? "").includes("85%"), at(0.85).message ?? "");
check("warn names the free tier", (at(0.85).message ?? "").includes("free tier"));
check("critical says almost full", (at(0.97).message ?? "").includes("almost full"), at(0.97).message ?? "");
check(
  "sizes render in GB",
  (at(0.85).message ?? "").includes("8.5GB") && (at(0.85).message ?? "").includes("10.0GB"),
  at(0.85).message ?? ""
);

console.log("\n# shape");
const u = at(0.85);
check("reports bytes and quota", u.quotaBytes === QUOTA_BYTES && u.usedBytes > 0);
check("fraction is a ratio, not a percent", u.fraction > 0.84 && u.fraction < 0.86, String(u.fraction));

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
