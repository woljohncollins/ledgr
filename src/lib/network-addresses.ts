// "Other devices reach this instance at…" (ADR-212).
//
// The real fix for the hub-URL guesswork, per Brandon: adding a spoke should be
// copy-from-one-screen, paste-into-another, with nothing to derive. So a hub
// shows its OWN addresses rather than making the owner work out the form.
//
// Ordered by preference, and the order is the advice:
//   0. The published address, when the install has one. Nothing here can detect
//      a Cloudflare Tunnel or a Funnel, so it is read from this install's own
//      NEXT_PUBLIC_APP_URL rather than sniffed (2026-09-17: Brandon's hub moved
//      to https://ledgr.brasco.fyi and this page still advertised the tailnet).
//   1. The tailnet hostname (MagicDNS). Readable, and it survives a re-address,
//      which the raw 100.x does not.
//   2. The tailnet IP. Same reachability, uglier, works if MagicDNS is off.
//   3. The LAN address. Works only on this network — worth showing, worth
//      labelling as limited.
//
// A device that can join the tailnet (a phone, a laptop) needs no public address
// at all: tailnet-internal addressing is enough and is more private. A public
// address is only for callers that cannot join a tailnet, and the load-bearing
// one is the claude.ai MCP connector, because that fetch comes from Anthropic's
// servers rather than a device the owner controls.
export type ReachableAddress = {
  url: string;
  label: string;
  // Why you would (or would not) use this one.
  note: string;
  // The one to reach for first.
  preferred: boolean;
};

export type TailscaleState = {
  // Is the binary there at all?
  installed: boolean;
  // Running and logged in? "NeedsLogin"/"Stopped" are the common not-yet cases.
  running: boolean;
  // MagicDNS name, trailing dot stripped. Null when MagicDNS is off.
  dnsName: string | null;
  ips: string[];
  // Whatever the CLI said when it did not work, for showing the owner.
  detail: string | null;
};

export const TAILSCALE_ABSENT: TailscaleState = {
  installed: false,
  running: false,
  dnsName: null,
  ips: [],
  detail: null,
};

/**
 * Parse `tailscale status --json`, tolerantly. Anything unexpected reads as
 * "installed but not usable" rather than throwing — this feeds a help panel,
 * and a help panel that 500s is worse than one that says "not set up".
 *
 * Counterpart: `parseTailscaleJson()` / `hubUrlHint()` in supervisor/lib.mjs do
 * the same read for the setup wizard, which cannot import TypeScript. Keep them
 * in step.
 */
export function parseTailscaleStatus(raw: string): TailscaleState {
  let v: {
    BackendState?: unknown;
    Self?: { DNSName?: unknown; TailscaleIPs?: unknown };
  };
  try {
    v = JSON.parse(raw) as typeof v;
  } catch {
    return { ...TAILSCALE_ABSENT, installed: true, detail: "could not read tailscale status" };
  }
  const state = typeof v.BackendState === "string" ? v.BackendState : "";
  const dns = typeof v.Self?.DNSName === "string" ? v.Self.DNSName.replace(/\.$/, "") : "";
  const ips = Array.isArray(v.Self?.TailscaleIPs)
    ? v.Self.TailscaleIPs.filter((i): i is string => typeof i === "string")
    : [];
  return {
    installed: true,
    running: state === "Running",
    dnsName: dns || null,
    ips,
    detail:
      state === "Running"
        ? null
        : state === "NeedsLogin"
          ? "Tailscale is installed but not signed in yet."
          : state
            ? `Tailscale is installed but not running (${state}).`
            : "Tailscale is installed but its state could not be read.",
  };
}

/** Tailscale hands out 100.64.0.0/10, so its addresses show up as ordinary
 * interfaces too. Filtering them keeps the LAN row from duplicating the
 * tailnet row under a misleading label. */
export function isTailnetIp(ip: string): boolean {
  const m = /^100\.(\d+)\./.exec(ip);
  return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127;
}

/**
 * The published address, if this install has one worth handing out. A localhost
 * value is what a plain dev run carries, and telling another device to visit
 * localhost is worse than saying nothing.
 */
export function normalizePublicUrl(raw: string | null | undefined): string | null {
  if (!raw || !raw.trim()) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".localhost")) return null;
  return u.origin;
}

/**
 * The list a hub shows. Pure, so the ordering and the labelling are testable
 * without a tailnet.
 */
export function reachableAddresses(opts: {
  tailscale: TailscaleState;
  lanIps: string[];
  port: number;
  // This install's own published address, if it has one: the Cloudflare Tunnel
  // / Funnel / reverse-proxy hostname already configured as NEXT_PUBLIC_APP_URL.
  // Nothing in here can detect a tunnel, so it is told to us.
  publicUrl?: string | null;
}): ReachableAddress[] {
  const out: ReachableAddress[] = [];
  const { tailscale: ts, port } = opts;

  const published = normalizePublicUrl(opts.publicUrl);
  if (published) {
    out.push({
      url: published,
      label: "Public address",
      note: "Use this one. It works from anywhere, including callers that cannot join your tailnet. The Claude connector is the one that matters.",
      preferred: true,
    });
  }
  if (ts.running && ts.dnsName) {
    out.push({
      url: `http://${ts.dnsName}:${port}`,
      label: "Tailnet hostname",
      note: "Works from any device signed into your tailnet, anywhere, and it keeps working if the addresses change.",
      preferred: out.length === 0,
    });
  }
  for (const ip of ts.running ? ts.ips.filter((i) => !i.includes(":")) : []) {
    out.push({
      url: `http://${ip}:${port}`,
      label: "Tailnet address",
      note: "Same reach as the hostname above. Use it if MagicDNS is off.",
      preferred: out.length === 0,
    });
  }
  for (const ip of opts.lanIps.filter((i) => !isTailnetIp(i))) {
    out.push({
      url: `http://${ip}:${port}`,
      label: "Local network",
      note: "Only works from devices on this same network, and it changes when the router reassigns it.",
      preferred: out.length === 0,
    });
  }
  return out;
}

// ── The impure half ─────────────────────────────────────────────────────────

/** Ask the local Tailscale CLI. Never throws: not installed is a normal answer. */
export async function readTailscaleState(): Promise<TailscaleState> {
  // AWAITED, not spawnSync (2026-09-02, ADR-246). The app is one Node process,
  // so a synchronous child here froze every other request for up to the 5s
  // timeout below while the Network page asked one question. Same defect that
  // made the hourly snapshot look like an outage, just smaller and rarer.
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  // On Windows the name needs its .exe: spawn does no PATHEXT resolution, so a
  // bare "tailscale" is ENOENT even when the CLI is on PATH — which is exactly
  // how this read first reported "not installed" on a machine that had it.
  const candidates =
    process.platform === "win32"
      ? ["tailscale.exe", "C:\\Program Files\\Tailscale\\tailscale.exe"]
      : ["tailscale", "/usr/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];
  for (const bin of candidates) {
    try {
      const res = await run(bin, ["status", "--json"], {
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 4 * 1024 * 1024,
      });
      if (typeof res.stdout === "string" && res.stdout.trim()) {
        return parseTailscaleStatus(res.stdout);
      }
      // Ran, said nothing usable: installed, not usable.
      return {
        ...TAILSCALE_ABSENT,
        installed: true,
        detail: (res.stderr || "").trim() || "Tailscale is installed but not signed in yet.",
      };
    } catch (err) {
      // A missing binary means "try the next candidate". Anything else means
      // this IS the CLI and it failed us: `tailscale status` exits non-zero
      // when the node is stopped or signed out, and that answer is installed-
      // but-unusable, which the old `res.error` check could not distinguish.
      const e = err as { code?: string | number; stdout?: string; stderr?: string };
      if (e.code === "ENOENT") continue;
      if (typeof e.stdout === "string" && e.stdout.trim()) {
        return parseTailscaleStatus(e.stdout);
      }
      return {
        ...TAILSCALE_ABSENT,
        installed: true,
        detail: (e.stderr || "").trim() || "Tailscale is installed but not signed in yet.",
      };
    }
  }
  return TAILSCALE_ABSENT;
}

/** This machine's own LAN IPv4 addresses. */
export async function readLanIps(): Promise<string[]> {
  const { networkInterfaces } = await import("node:os");
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const n of list ?? []) {
      if (n.family === "IPv4" && !n.internal) out.push(n.address);
    }
  }
  return out;
}
