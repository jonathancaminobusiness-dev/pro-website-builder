import { expect, test } from '@playwright/test';

/**
 * The captain's report was three console errors and a screen that said the
 * server had not answered. Two different situations produce exactly that, and
 * the remedy differs: start the server, or open the Studio on the one origin it
 * accepts. The screen has to name which one happened.
 */
const rememberedRun = 'identity-connection-stale';

async function openGate1WithRememberedRun(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript((stale) => {
    localStorage.clear();
    localStorage.setItem('pwb.gate1.runId', stale);
  }, rememberedRun);
  await page.goto('/');
  await page.getByRole('button', { name: 'Gate 1 · identidade' }).click();
}

test('names the API origin and the command when nothing is listening', async ({ page }) => {
  // Nothing answers on the API origin at all — the health probe included.
  await page.route('**/127.0.0.1:*/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/health' || url.pathname.startsWith('/api/')) { await route.abort(); return; }
    await route.continue();
  });

  await openGate1WithRememberedRun(page);

  const banner = page.getByRole('alert').filter({ hasText: 'Nenhum servidor respondeu em' });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('corepack pnpm --filter @pwb/server dev');
});

test('names the refused origin and the single-origin remedy when the server is up', async ({ page }) => {
  // What a real CORS refusal looks like from the page: the request that carries
  // the origin check fails, while the opaque one still reaches the server.
  await page.route('**/127.0.0.1:*/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname !== '/health' && !url.pathname.startsWith('/api/')) { await route.continue(); return; }
    // The opaque probe is the one that carries no `Origin`: a `no-cors` GET
    // sends none, which is precisely why a browser lets it through when the
    // origin check would have refused it.
    if (!request.headers().origin) { await route.fulfill({ status: 200, contentType: 'text/plain', body: 'ok' }); return; }
    await route.abort();
  });

  await openGate1WithRememberedRun(page);

  const banner = page.getByRole('alert').filter({ hasText: 'recusou a origem' });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('PWB_STUDIO_ORIGIN=');
});
