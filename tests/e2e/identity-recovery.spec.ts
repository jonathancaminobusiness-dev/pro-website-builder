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
  await recovery.getByRole('button', { name: 'Manter esta execução' }).click();
  await expect(recovery).toContainText(runId);

  // A question left unanswered here is not carried to the screen that follows.
  await recovery.getByRole('button', { name: 'Criar execução nova' }).click();
  await expect(recovery).toContainText('Uma execução nova substitui');

  await page.unroute('**/api/identity/**');
  await recovery.getByRole('button', { name: 'Tentar novamente' }).click();
  await expect(page.getByText('Uma execução nova substitui')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Nova execução' })).toBeVisible();

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

  // A question the captain opens and never answers before the run starts
  // working is dropped, not held until the work ends.
  await page.getByRole('button', { name: 'Nova execução' }).click();
  await expect(page.getByText('Uma execução nova substitui')).toBeVisible();

  let releaseStart = (): void => {};
  const held = new Promise<void>((resolve) => { releaseStart = resolve; });
  await page.route('**/api/identity/runs/*/start', async (route) => { await held; await route.continue(); });
  await page.getByRole('button', { name: 'Executar etapa de identidade' }).click();
  await expect(page.getByText('Uma execução nova substitui')).toHaveCount(0);

  // The stop is offered only while there is something to stop, and while the
  // run is working it is the only way out: neither control that would replace
  // the run this browser remembers is on offer.
  const cancel = page.getByRole('button', { name: 'Cancelar execução' });
  await expect(cancel).toBeVisible();
  await expect(page.getByLabel('Abrir outra execução')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Nova execução' })).toBeDisabled();
  await cancel.click();
  await expect(page.getByText('cancelada', { exact: true })).toBeVisible();

  releaseStart();
  await page.unroute('**/api/identity/runs/*/start');

  // A stopped run is over: the stage cannot be run on it and no card appears.
  await expect(page.getByRole('button', { name: 'Execução cancelada' })).toBeDisabled();
  await expect(page.locator('.direction-card')).toHaveCount(0);
  await expect(cancel).toHaveCount(0);
  // Nothing is working any more, so both ways to another run come back — as
  // offers, not as the unanswered question the stop interrupted.
  await expect(page.getByLabel('Abrir outra execução')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Nova execução' })).toBeEnabled();
  await expect(page.getByText('Uma execução nova substitui')).toHaveCount(0);
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

/**
 * A tab that did not issue the start still has to see the work. Landing inside
 * the fan-out is a race against a fake provider that answers in about a second,
 * so the server's own snapshot is read and the two fields it really carries
 * mid-run — `running` with no directions yet — are put back on it, once. The
 * second reading is the server's untouched answer, so the screen leaving the
 * running state proves the poll followed it there.
 */
test('a reloaded tab offers the stop while the stage is working, and follows it to the end', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Gate 1 · identidade' }).click();
  await page.getByRole('button', { name: 'Criar execução de identidade' }).click();
  await page.getByRole('button', { name: 'Executar etapa de identidade' }).click();
  await expect(page.locator('.direction-card')).toHaveCount(3);

  let midRun = true;
  await page.route('**/api/identity/runs/*', async (route) => {
    const answer = await route.fetch();
    const snapshot = await answer.json() as Record<string, unknown>;
    if (!midRun) { await route.fulfill({ response: answer, json: snapshot }); return; }
    midRun = false;
    await route.fulfill({ json: { ...snapshot, status: 'running', directions: [] } });
  });
  await page.reload();
  await page.getByRole('button', { name: 'Gate 1 · identidade' }).click();

  // The stop is offered on the strength of the server's answer alone, and the
  // stage cannot be asked for a second time while it is already working.
  await expect(page.getByRole('button', { name: 'Cancelar execução' })).toBeVisible();
  const start = page.getByRole('button', { name: 'Etapa em execução' });
  await expect(start).toBeVisible();
  await expect(start).toBeDisabled();
  // While the stage is working the stop is the only way out of the run.
  await expect(page.getByRole('button', { name: 'Nova execução' })).toBeDisabled();
  await expect(page.getByLabel('Abrir outra execução')).toHaveCount(0);

  // No click follows: the screen learns on its own that the fan-out finished.
  await expect(page.locator('.direction-card')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Cancelar execução' })).toHaveCount(0);
  await page.unroute('**/api/identity/runs/*');
});

/**
 * The one pointer this browser keeps is the only way back to a decided run, so
 * replacing it is never a single click while a run is on screen, and any
 * earlier run stays reachable by id from the same row.
 */
test('a new run needs a second yes, and the run on screen stays reachable', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Gate 1 · identidade' }).click();
  await page.getByRole('button', { name: 'Criar execução de identidade' }).click();
  await page.getByRole('button', { name: 'Executar etapa de identidade' }).click();
  await expect(page.locator('.direction-card')).toHaveCount(3);
  const runId = (await page.locator('.run-id code').innerText()).trim();

  // The first click only asks, naming the run it would replace.
  await page.getByRole('button', { name: 'Nova execução' }).click();
  await expect(page.locator('.gate-actions')).toContainText(runId);
  await page.getByRole('button', { name: 'Manter esta execução' }).click();
  await expect(page.locator('.run-id code')).toHaveText(runId);
  await expect(page.locator('.direction-card')).toHaveCount(3);

  // Creating one takes the second yes, and the first run is still openable by id.
  await page.getByRole('button', { name: 'Nova execução' }).click();
  await page.getByRole('button', { name: 'Criar mesmo assim' }).click();
  await expect(page.locator('.run-id code')).not.toHaveText(runId);
  await expect(page.locator('.direction-card')).toHaveCount(0);

  await page.getByLabel('Abrir outra execução').fill(runId);
  await page.locator('.gate-actions').getByRole('button', { name: 'Abrir' }).click();
  await expect(page.locator('.run-id code')).toHaveText(runId);
  await expect(page.locator('.direction-card')).toHaveCount(3);
});
