// Verification for "other devices reach this instance at…" (ADR-212). All pure
// — no tailnet, no shelling out — so verify-ci.mjs discovers and runs it.
//
// Run: npx tsx scripts/verify-network-addresses.mts
import {
  isTailnetIp,
  normalizePublicUrl,
  parseTailscaleStatus,
  reachableAddresses,
  TAILSCALE_ABSENT,
} from "../src/lib/network-addresses";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

// ── Reading `tailscale status --json` ────────────────────────────────────────
//
// This feeds a help panel, so anything unexpected has to read as "not set up"
// rather than throw: a help panel that 500s is worse than one that says so.

{
  // The real shape, from this machine's own tailnet (names kept generic).
  const raw = JSON.stringify({
    BackendState: "Running",
    Self: { DNSName: "bcdesktop.example-tailnet.ts.net.", TailscaleIPs: ["100.82.212.62", "fd7a::1"] },
  });
  const ts = parseTailscaleStatus(raw);
  check("a running tailnet is recognized", ts.installed && ts.running);
  check(
    "the trailing dot is stripped off the MagicDNS name",
    ts.dnsName === "bcdesktop.example-tailnet.ts.net"
  );
  check("the tailnet IPs come through", ts.ips.includes("100.82.212.62"));
  check("nothing to report when it is working", ts.detail === null);
}

{
  const ts = parseTailscaleStatus(JSON.stringify({ BackendState: "NeedsLogin", Self: {} }));
  check("installed but not signed in is NOT reported as running", ts.installed && !ts.running);
  check("and it says so", (ts.detail ?? "").includes("not signed in"));
}

{
  const ts = parseTailscaleStatus(JSON.stringify({ BackendState: "Stopped", Self: {} }));
  check("stopped is reported as installed, not running", ts.installed && !ts.running);
  check("with the state named", (ts.detail ?? "").includes("Stopped"));
}

check("garbage output does not throw", parseTailscaleStatus("not json").installed === true);
check("garbage output is never 'running'", parseTailscaleStatus("not json").running === false);
check("empty output is never 'running'", parseTailscaleStatus("").running === false);
check(
  "MagicDNS off (no DNSName) still reads the IPs",
  parseTailscaleStatus(
    JSON.stringify({ BackendState: "Running", Self: { TailscaleIPs: ["100.1.2.3"] } })
  ).dnsName === null
);

// ── The 100.64/10 filter ────────────────────────────────────────────────────
//
// Tailscale hands out 100.64.0.0/10, so its addresses also show up as ordinary
// interfaces. Without the filter the LAN row duplicates the tailnet row under a
// label that says "only works on this network" — which would be a lie.
check("a tailnet address is recognized", isTailnetIp("100.82.212.62"));
check("the bottom of the range", isTailnetIp("100.64.0.1"));
check("the top of the range", isTailnetIp("100.127.255.254"));
check("just below the range is NOT tailnet", !isTailnetIp("100.63.255.255"));
check("just above the range is NOT tailnet", !isTailnetIp("100.128.0.1"));
check("an ordinary LAN address is not tailnet", !isTailnetIp("192.168.1.40"));
check("another private range is not tailnet", !isTailnetIp("10.0.0.5"));

// ── The list a hub hands out ─────────────────────────────────────────────────

{
  const list = reachableAddresses({
    tailscale: {
      installed: true,
      running: true,
      dnsName: "hub.example-tailnet.ts.net",
      ips: ["100.82.212.62", "fd7a::1"],
      detail: null,
    },
    lanIps: ["192.168.1.40", "100.82.212.62"],
    port: 3000,
  });
  check(
    "the MagicDNS hostname comes first and is the recommended one",
    list[0].url === "http://hub.example-tailnet.ts.net:3000" && list[0].preferred
  );
  check("only one address is recommended", list.filter((a) => a.preferred).length === 1);
  check(
    "the tailnet IP is offered as the MagicDNS-off fallback",
    list[1].url === "http://100.82.212.62:3000"
  );
  check("IPv6 tailnet addresses are left out of the URLs", !list.some((a) => a.url.includes("fd7a")));
  check(
    "the LAN address is offered last and labelled as limited",
    list[2].url === "http://192.168.1.40:3000" && list[2].note.includes("same network")
  );
  check(
    "the tailnet IP is not repeated as a LAN address",
    list.filter((a) => a.url.includes("100.82.212.62")).length === 1
  );
  check("the port is carried into every address", list.every((a) => a.url.endsWith(":3000")));
}

{
  // Tailscale down: the LAN address is all there is, and it must not be
  // presented as though it reached anywhere.
  const list = reachableAddresses({
    tailscale: { ...TAILSCALE_ABSENT, installed: true, detail: "not signed in" },
    lanIps: ["192.168.1.40"],
    port: 3002,
  });
  check("with Tailscale down, only the LAN address is offered", list.length === 1);
  check("and it is on the right port", list[0].url === "http://192.168.1.40:3002");
  check("something is still marked as the one to use", list[0].preferred);
}

{
  // Tailscale not running must never publish its addresses: they would not
  // answer, and a confidently-wrong address is worse than none.
  const list = reachableAddresses({
    tailscale: {
      installed: true,
      running: false,
      dnsName: "hub.example-tailnet.ts.net",
      ips: ["100.82.212.62"],
      detail: "not signed in",
    },
    lanIps: [],
    port: 3000,
  });
  check("a stopped tailnet publishes nothing", list.length === 0);
}

check(
  "no addresses at all is an empty list, not a crash",
  reachableAddresses({ tailscale: TAILSCALE_ABSENT, lanIps: [], port: 3000 }).length === 0
);

// ── The published address (2026-09-17) ──────────────────────────────────────
//
// A tunnel cannot be detected from in here, so it is read from the install's own
// NEXT_PUBLIC_APP_URL. It outranks the tailnet name: it is what the owner is
// actually typing, and it is the only one a caller off the tailnet can use.

check("a published address is kept, trailing slash and all", normalizePublicUrl("https://ledgr.example.com/") === "https://ledgr.example.com");
check("an unset address is nothing", normalizePublicUrl(undefined) === null);
check("a blank address is nothing", normalizePublicUrl("   ") === null);
check("junk is nothing, not a crash", normalizePublicUrl("not a url") === null);
check("localhost is never handed to another device", normalizePublicUrl("http://localhost:3000") === null);
check("nor is the loopback IP", normalizePublicUrl("http://127.0.0.1:3000") === null);

{
  const list = reachableAddresses({
    tailscale: {
      installed: true,
      running: true,
      dnsName: "hub.example-tailnet.ts.net",
      ips: ["100.82.212.62"],
      detail: null,
    },
    lanIps: ["192.168.1.40"],
    port: 3000,
    publicUrl: "https://ledgr.example.com",
  });
  check("the published address comes first", list[0].url === "https://ledgr.example.com");
  check("and it is the recommended one", list[0].preferred);
  check("still exactly one recommendation", list.filter((a) => a.preferred).length === 1);
  check("the tailnet name is still offered below it", list[1].url === "http://hub.example-tailnet.ts.net:3000");
  check("the port is not bolted onto the published address", !list[0].url.includes(":3000"));
}

{
  // A tunnelled install with no tailnet at all still has something to hand out.
  const list = reachableAddresses({
    tailscale: TAILSCALE_ABSENT,
    lanIps: [],
    port: 3000,
    publicUrl: "https://ledgr.example.com",
  });
  check("a published address alone is enough", list.length === 1 && list[0].preferred);
}

check(
  "a localhost NEXT_PUBLIC_APP_URL adds nothing",
  reachableAddresses({ tailscale: TAILSCALE_ABSENT, lanIps: [], port: 3000, publicUrl: "http://localhost:3000" })
    .length === 0
);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
