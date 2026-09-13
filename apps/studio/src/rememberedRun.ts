/**
 * The one run of a kind this browser last worked on. A gate the captain left
 * open outlives both the tab and the server process, so a screen reopens it
 * from the ledger instead of starting expensive work again. Storage a browser
 * refuses is not an error: the screen still decides in this session.
 */
export function rememberedRun(key: string): string {
  try { return window.localStorage.getItem(key) ?? ''; } catch { return ''; }
}

export function rememberRun(key: string, runId: string): void {
  try { window.localStorage.setItem(key, runId); } catch { /* a browser that refuses storage still decides the gate in this session */ }
}

export function forgetRun(key: string): void {
  try { window.localStorage.removeItem(key); } catch { /* nothing to forget */ }
}
