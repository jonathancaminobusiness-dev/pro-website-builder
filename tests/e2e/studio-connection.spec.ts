import { expect, test } from '@playwright/test';

/**
 * The captain's report was three console errors and a screen that said the
 * server had not answered. Following the README, the Studio is routinely open
 * before the API finishes building its dependencies and listening, so that
 * window has to be waited out — and the causes waiting cannot fix have to name
 * themselves instead.
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

function isApi(url: URL): boolean {
  return url.pathname === '/health' || url.pathname.startsWith('/api/');
}

test('waits for an API that is not listening yet and reads the run once it answers', async ({ page }) => {
  // The Studio is opened first: nothing answers on the API origin at all.
  let listening = false;
  await page.route('**/127.0.0.1:*/**', async (route) => {
    const url = new URL(route.request().url());
    if (!isApi(url)) { await route.continue(); return; }
    if (!listening) { await route.abort(); return; }
    if (url.pathname === '/health') { await route.fulfill({ status: 200, contentType: 'text/plain', body: 'ok' }); return; }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        runId: rememberedRun, status: 'queued', baseVersionId: 'version-root',
        briefing: 'Um briefing determinístico para o Gate 1.',
        directions: [], setCritique: { scores: [], rubricGaps: [], unscoredDimensions: [], blocking: [], abstained: false },
        gate: { state: 'open', reason: 'O capitão decide.' }, approvals: [], assets: [], failures: [],
      }),
    });
  });

  await openGate1WithRememberedRun(page);

  // No fault is reported while the server may still be starting.
  await expect(page.getByText(/^Aguardando o servidor em http:\/\/127\.0\.0\.1:\d+…$/)).toBeVisible();
  await expect(page.locator('.error-banner')).toHaveCount(0);

  // The API finishes starting, and the screen reads the run without being told to.
  listening = true;
  await expect(page.locator('.run-id code')).toHaveText(rememberedRun);
  await expect(page.locator('.error-banner')).toHaveCount(0);
});

test('names the refused origin and the single-origin remedy when the server is up', async ({ page }) => {
  // What a real CORS refusal looks like from the page: every request that
  // carries the origin check fails, while the opaque one still reaches the
  // server — and it keeps failing, so this is not a server that just started.
  await page.route('**/127.0.0.1:*/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!isApi(url)) { await route.continue(); return; }
    // The opaque probe is the one that carries no `Origin`: a `no-cors` GET
    // sends none, which is precisely why a browser lets it through when the
    // origin check would have refused it.
    if (!request.headers().origin) { await route.fulfill({ status: 200, contentType: 'text/plain', body: 'ok' }); return; }
    await route.abort();
  });

  await openGate1WithRememberedRun(page);

  const banner = page.locator('.error-banner').filter({ hasText: 'recusou a origem' });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('PWB_STUDIO_ORIGIN=');
});
