// "Start when Windows starts", the read side (ADR-211).
//
// The app cannot register a scheduled task itself, so the supervisor does it
// and records the outcome in <supervisorDir>/startup-state.json. This reads
// that record. Shared by the API route and the Build → Updates page so the
// first paint and the client island can never disagree.
export type StartupState = {
  enabled: boolean;
  scope: "logon" | "always";
  // False is a NORMAL state, not an exception: the always-on scope generally
  // needs elevation, which a background process does not have.
  ok: boolean;
  detail: string | null;
  // Set when the registration SUCCEEDED but will not do what the scope
  // promised (an always-on task Windows will only run while signed in).
  caveat: string | null;
  // The equivalent command, for running in an elevated prompt by hand.
  command: string | null;
  at: string | null;
};

export type StartupReport = {
  // False on any instance without a supervisor (every cloud deploy), which is
  // what keeps this fail-closed rather than pretending.
  available: boolean;
  // Null until the owner has asked for something at least once.
  state: StartupState | null;
  // A request is written but the supervisor has not acted on it yet.
  pending: boolean;
};

export const STARTUP_UNAVAILABLE: StartupReport = {
  available: false,
  state: null,
  pending: false,
};

export async function readStartupReport(dir: string | null): Promise<StartupReport> {
  if (!dir) return STARTUP_UNAVAILABLE;
  const { readFile, access } = await import("node:fs/promises");
  const { join } = await import("node:path");
  let state: StartupState | null = null;
  try {
    const raw = JSON.parse(
      await readFile(join(dir, "startup-state.json"), "utf8")
    ) as Partial<StartupState>;
    if (typeof raw.enabled === "boolean") {
      state = {
        enabled: raw.enabled,
        scope: raw.scope === "always" ? "always" : "logon",
        ok: raw.ok === true,
        detail: typeof raw.detail === "string" ? raw.detail : null,
        command: typeof raw.command === "string" ? raw.command : null,
        caveat: typeof raw.caveat === "string" ? raw.caveat : null,
        at: typeof raw.at === "string" ? raw.at : null,
      };
    }
  } catch {
    // No file yet, or unreadable: no recorded state, which is a valid answer.
  }
  let pending = false;
  try {
    await access(join(dir, "startup-requested"));
    pending = true;
  } catch {
    // absent = nothing outstanding
  }
  return { available: true, state, pending };
}
