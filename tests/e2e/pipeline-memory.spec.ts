import { expect, test } from '@playwright/test';

/**
 * The pipeline execution outlives the tab. Reloading used to lose it forever:
 * the screen started with no snapshot and the only way forward was paying for a
 * new run. The screen now remembers the run the way Gate 1 remembers its own,
 * re-reads it on load, and drops the pointer only when the server says the run
 * is gone.
 */
test.describe('pipeline run memory', () => {
  test.setTimeout(180_000);

  test('a reload finds the same execution instead of offering a new one', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Carregar briefing fixo' }).click();
    const preview = page.locator('.review-panel iframe.preview-frame');
    await expect(preview).toBeVisible();

    // The first stage runs and stops at its gate; that state is the run's, not the tab's.
    await page.getByRole('button', { name: 'Executar próxima etapa' }).click();
    await expect(page.getByRole('button', { name: 'Aprovar gate' })).toBeVisible({ timeout: 120_000 });
    const before = await preview.evaluate((node) => (node as HTMLIFrameElement).src);

    await page.reload();

    // No new run is created: the screen re-read the one it remembered.
    await expect(page.getByRole('button', { name: 'Reiniciar briefing' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Aprovar gate' })).toBeVisible();
    await expect(page.locator('.stage-row.active')).toHaveCount(1);
    await expect(preview.first()).toHaveJSProperty('src', before);
  });

  test('forgets the pointer only when the server no longer knows the run', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => window.localStorage.setItem('pwb.pipeline.runId', 'studio-run-that-never-existed'));
    await page.reload();

    await expect(page.getByRole('button', { name: 'Carregar briefing fixo' })).toBeVisible();
    await expect(page.getByText('Carregue o briefing para abrir o primeiro contrato de identidade.')).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.localStorage.getItem('pwb.pipeline.runId'))).toBeNull();
  });

  test('says the undecided proposal was discarded when the restarted server rewound the run', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Carregar briefing fixo' }).click();
    await expect(page.locator('.review-panel iframe.preview-frame')).toBeVisible();

    // A server restarted before the captain decided answers the restore with the
    // head it kept and names the stage whose proposal it discarded.
    await page.route('**/api/runs/*', async (route) => {
      if (route.request().method() !== 'GET') { await route.fallback(); return; }
      const response = await route.fetch();
      await route.fulfill({ json: { ...(await response.json()), discardedStage: 'identity' } });
    });
    await page.reload();

    await expect(page.getByRole('status')).toContainText('descartada quando o servidor reiniciou');
    await expect(page.getByRole('button', { name: 'Executar próxima etapa' })).toBeVisible();
  });

  test('keeps a run the server could not answer for, because a 404 is the only proof it is gone', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => window.localStorage.setItem('pwb.pipeline.runId', 'studio-unreachable'));
    await page.route('**/api/runs/studio-unreachable', (route) => route.fulfill({ status: 500, contentType: 'text/plain', body: 'boom' }));
    await page.reload();

    await expect(page.getByRole('alert')).toContainText('Não foi possível concluir a ação.');
    expect(await page.evaluate(() => window.localStorage.getItem('pwb.pipeline.runId'))).toBe('studio-unreachable');
  });
});
