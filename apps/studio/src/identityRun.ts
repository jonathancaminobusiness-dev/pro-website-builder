/**
 * The one identity run this browser last worked on. A Gate 1 the captain left
 * open — or closed — outlives both the tab and the server process, and it is
 * what the next two gates run on: Gate 2 measures the identity it approved and
 * Gate 3 compiles what came out of that. Both screens read it from here, so the
 * chain survives a reload on either of them.
 */
const IDENTITY_RUN_KEY = 'pwb.gate1.runId';

export function rememberedIdentityRun(): string {
  try { return window.localStorage.getItem(IDENTITY_RUN_KEY) ?? ''; } catch { return ''; }
}

export function rememberIdentityRun(runId: string): void {
  try { window.localStorage.setItem(IDENTITY_RUN_KEY, runId); } catch { /* a browser that refuses storage still decides the gate in this session */ }
}

export function forgetIdentityRun(): void {
  try { window.localStorage.removeItem(IDENTITY_RUN_KEY); } catch { /* nothing to forget */ }
}
