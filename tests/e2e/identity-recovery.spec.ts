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

/**
 * A run that spends three concurrent Claude processes and a raster job needs a
 * stop. The start request is held open in the browser so the in-flight state is
 * deterministic rather than a race against the fake provider, which answers in
 * milliseconds; what the captain sees and clicks is the real control.
 */
test('the captain can stop a run before its gate, and it stays stopped', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Gate 1 · identidade' }).click();
  await page.getByRole('button', { name: 'Criar execução de identidade' }).click();

  let releaseStart = (): void => {};
  const held = new Promise<void>((resolve) => { releaseStart = resolve; });
  await page.route('**/api/identity/runs/*/start', async (route) => { await held; await route.continue(); });
  await page.getByRole('button', { name: 'Executar etapa de identidade' }).click();

  // The stop is offered only while there is something to stop.
  const cancel = page.getByRole('button', { name: 'Cancelar execução' });
  await expect(cancel).toBeVisible();
  await cancel.click();
  await expect(page.getByText('cancelada', { exact: true })).toBeVisible();

  releaseStart();
  await page.unroute('**/api/identity/runs/*/start');

  // A stopped run is over: the stage cannot be run on it and no card appears.
  await expect(page.getByRole('button', { name: 'Execução cancelada' })).toBeDisabled();
  await expect(page.locator('.direction-card')).toHaveCount(0);
  await expect(cancel).toHaveCount(0);
});

/**
 * The state where a stop lands after the directors answered: the run is stopped
 * yet still holds its three cards. Reaching it depends on where inside the
 * stage the abort falls, which no browser can time, so the snapshot the server
 * really produces is read and its status alone is rewritten — everything the
 * component renders is the server's own answer.
 */
test('a stopped run shows its directions for reading and decides none of them', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Gate 1 · identidade' }).click();
  await page.getByRole('button', { name: 'Criar execução de identidade' }).click();
  await page.getByRole('button', { name: 'Executar etapa de identidade' }).click();
  await expect(page.locator('.direction-card')).toHaveCount(3);

  await page.route('**/api/identity/runs/*', async (route) => {
    const answer = await route.fetch();
    const snapshot = await answer.json() as Record<string, unknown>;
    await route.fulfill({ json: { ...snapshot, status: 'cancelled' } });
  });
  await page.reload();
  await page.getByRole('button', { name: 'Gate 1 · identidade' }).click();

  await expect(page.getByText('cancelada', { exact: true })).toBeVisible();
  const cards = page.locator('.direction-card');
  await expect(cards).toHaveCount(3);
  for (const index of [0, 1, 2]) {
    const card = cards.nth(index);
    await expect(card).toContainText('A execução foi parada antes do gate');
    await expect(card.getByRole('button', { name: 'Aprovar esta direção' })).toBeDisabled();
    await expect(card.getByRole('button', { name: 'Devolver' })).toBeDisabled();
  }
  // The decision it would be written with is not offered either.
  await expect(page.getByLabel(/Motivo da decisão/)).toHaveCount(0);
  await page.unroute('**/api/identity/runs/*');
});
