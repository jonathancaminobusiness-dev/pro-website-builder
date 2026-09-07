import { expect, test } from '@playwright/test';

test('captain can drive the fixture through all three gates', async ({ page }) => {
  await page.goto('/');
  const gate = page.locator('.gate3-panel');
  await page.getByRole('button', { name: 'Carregar briefing fixo' }).click();

  // The first two gates are approved on the stage row; the third is Gate 3.
  for (const stage of ['identity', 'prototype']) {
    await page.getByRole('button', { name: 'Executar próxima etapa' }).click();
    await page.getByRole('button', { name: 'Aprovar gate' }).click({ timeout: 30_000 });
    expect(stage).toBeTruthy();
  }
  await page.getByRole('button', { name: 'Executar próxima etapa' }).click();
  await expect(page.getByText('Aprovar é publicar o bundle no Gate 3 abaixo')).toBeVisible();

  await gate.getByRole('button', { name: 'Preparar release' }).click();
  await expect(gate.locator('.verdict')).toBeVisible({ timeout: 30_000 });
  // Publishing over an open escalation takes a written reason; a report with
  // nothing open is published as it stands.
  const acceptance = gate.locator('.acceptance textarea');
  if (await acceptance.count() > 0) await acceptance.fill('Aceito publicar com a evidência que este ambiente produziu.');
  await gate.getByRole('button', { name: 'Publicar bundle e aprovar o gate' }).click();

  // Publishing is the finalization approval, so the pipeline closes with it.
  await expect(gate.getByRole('button', { name: 'Bundle publicado' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Release publicado' })).toBeVisible();
  await expect(page.locator('.stage-row').nth(2).getByText('Aprovado pelo capitão')).toBeVisible();
  await expect(page.locator('iframe[title="Preview do site"]')).toBeVisible();
  await expect(page.locator('iframe[title="Preview do site"]')).toHaveAttribute('sandbox', '');
  await expect(page.frameLocator('iframe[title="Preview do site"]').locator('main[data-route="/"]')).toBeVisible();
  await expect(page.locator('.review-panel .qa-chip')).toContainText('0 erros');
});
