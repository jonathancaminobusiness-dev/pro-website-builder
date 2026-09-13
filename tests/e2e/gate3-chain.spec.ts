import { expect, test } from '@playwright/test';

/**
 * Gate 3 compiles the captain's own work. Once Gate 1 is decided, the
 * finalization line on the pipeline names that chain — the identity execution
 * and the version it approved — instead of the fixed briefing this screen also
 * offers, and it says plainly what is still missing before a release can be
 * prepared from it.
 */
test('the finalization line points at the identity → prototype chain once Gate 1 is decided', async ({ page }) => {
  await page.goto('/');

  // With no identity decided, the line says so rather than implying the fixture is the captain's.
  const line = page.locator('.chain-line');
  await expect(line).toContainText('Nenhuma identidade aprovada');
  await expect(line).toContainText('briefing fixo');

  await page.getByRole('button', { name: 'Gate 1 · identidade' }).click();
  await page.getByRole('button', { name: 'Criar execução de identidade' }).click();
  await page.getByRole('button', { name: 'Executar etapa de identidade' }).click();
  await expect(page.locator('.direction-card')).toHaveCount(3, { timeout: 60_000 });
  await page.getByLabel(/Motivo da decisão/).fill('Esta direção é a identidade do produto.');
  await page.locator('.direction-card', { hasText: 'modular-technical' }).getByRole('button', { name: 'Aprovar esta direção' }).click();
  const record = page.locator('.gate-record');
  await expect(record).toContainText('Decisão registrada.');
  const approvedVersionId = (await record.textContent())?.match(/v-[0-9a-f]{12}/)?.[0];
  expect(approvedVersionId).toBeTruthy();

  await page.getByRole('button', { name: 'Pipeline' }).click();
  // The line now names the chain: the Gate 1 execution and the version it closed on.
  await expect(line).toContainText('Cadeia identidade → protótipo');
  await expect(line).toContainText(approvedVersionId!);
  await expect(line).toContainText('o Gate 2 ainda não aprovou');
  // And it sends the captain to the gate that is actually missing.
  await expect(page.getByRole('link', { name: /Meça e aprove o protótipo no Gate 2/ })).toBeVisible();

  // And Gate 3 is now armed for that chain rather than for the fixed briefing,
  // which was never loaded on this screen.
  await expect(page.locator('.gate3-panel').getByRole('button', { name: 'Preparar release' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Carregar briefing fixo' })).toBeVisible();
});
