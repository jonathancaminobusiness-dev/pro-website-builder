import { expect, test } from '@playwright/test';

// The harness may hold its own port block; the API origin is derived the same
// way playwright.config.ts derives it, so a lane never talks to another lane.
const portBase = Number(process.env.PWB_E2E_PORT_BASE ?? 0);
const apiOrigin = `http://127.0.0.1:${portBase > 0 ? portBase : 4310}`;

/**
 * The pipeline screen holds a snapshot rather than a subscription, so a change
 * the API made — here a stop issued the way a stuck run used to be unblocked,
 * by hand — only reaches the screen when it reads the run again.
 */
test('the pipeline renames the new-run button and follows a stop made through the API', async ({ page }) => {
  await page.goto('/');
  const created = page.waitForResponse((response) => response.url().endsWith('/api/runs') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Carregar briefing fixo' }).click();
  const { runId } = (await (await created).json()) as { runId: string };

  // The button creates another run; it never restarted the one on screen.
  await expect(page.getByRole('button', { name: 'Novo briefing' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reiniciar briefing' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retomar execução' })).toHaveCount(0);
  await expect(page.locator('.stage-panel .status')).toContainText('queued');

  const stopped = await page.evaluate(async ({ id, origin }) => {
    const response = await fetch(`${origin}/api/runs/${id}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' } });
    return ((await response.json()) as { status: string }).status;
  }, { id: runId, origin: apiOrigin });
  expect(stopped).toBe('cancelled');

  // Nothing on the screen has moved yet; the tab coming back reads the run.
  await expect(page.locator('.stage-panel .status')).toContainText('queued');
  await page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); });
  await expect(page.locator('.stage-panel .status')).toContainText('cancelled');

  // A stopped run is resumed from the screen instead of with a second curl.
  await page.getByRole('button', { name: 'Retomar execução' }).click();
  await expect(page.locator('.stage-panel .status')).toContainText('queued');
});
