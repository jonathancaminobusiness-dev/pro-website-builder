import { expect, test } from '@playwright/test';

/**
 * A Gate 1 the captain decided must survive the API being away. The failure is
 * produced by refusing the studio's API calls in the browser rather than by
 * stopping the server process: Playwright owns the server's lifecycle through
 * `webServer`, and what the studio sees either way is the same — a fetch that
 * rejects with no HTTP status, which is what tells a transient outage apart
 * from a 404 saying the run is gone.
 */
test('a decided run survives an API outage and is reopened from the screen', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Gate 1 · identidade' }).click();
  await page.getByRole('button', { name: 'Criar execução de identidade' }).click();
  await page.getByRole('button', { name: 'Executar etapa de identidade' }).click();
  await expect(page.locator('.direction-card')).toHaveCount(3);

  await page.getByLabel(/Motivo da decisão/).fill('A direção modular declara a medida.');
  await page.locator('.direction-card', { hasText: 'modular-technical' }).getByRole('button', { name: 'Aprovar esta direção' }).click();
  await expect(page.locator('.gate-record')).toContainText('Decisão registrada.');

  // The run id is on the screen, which is the only way the captain can read it
  // back; the recovery state below has to name this exact run.
  const runId = (await page.locator('.run-id code').innerText()).trim();
  expect(runId).not.toBe('');

  await page.route('**/api/identity/**', (route) => route.abort());
  await page.reload();
  await page.getByRole('button', { name: 'Gate 1 · identidade' }).click();

  // The screen holds the run instead of offering a fresh start.
  const recovery = page.locator('.empty-state');
  await expect(recovery).toContainText(runId);
  await expect(recovery.getByRole('button', { name: 'Tentar novamente' })).toBeVisible();
  await expect(recovery.getByRole('button', { name: 'Criar execução de identidade' })).toHaveCount(0);
  await expect(recovery.getByLabel('Abrir outra execução')).toBeVisible();

  // Creating a new run costs the remembered id, so it takes a second decision.
  await recovery.getByRole('button', { name: 'Criar execução nova' }).click();
  await expect(recovery).toContainText('Uma execução nova substitui');
  await recovery.getByRole('button', { name: 'Cancelar' }).click();
  await expect(recovery).toContainText(runId);

  await page.unroute('**/api/identity/**');
  await recovery.getByRole('button', { name: 'Tentar novamente' }).click();

  // The decision, and the run it belongs to, come back untouched.
  await expect(page.locator('.gate-record')).toContainText('Decisão registrada.');
  await expect(page.locator('.run-id code')).toHaveText(runId);
  await expect(page.locator('.direction-card.selected')).toHaveCount(1);
});
