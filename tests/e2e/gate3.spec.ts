import { expect, test } from '@playwright/test';

test('the captain reads the release report on Gate 3 and publishes the bundle', async ({ page }) => {
  await page.goto('/');
  const gate = page.locator('.gate3-panel');
  await expect(gate.getByRole('button', { name: 'Preparar release' })).toBeDisabled();

  await page.getByRole('button', { name: 'Carregar briefing fixo' }).click();
  await gate.getByRole('button', { name: 'Preparar release' }).click();

  await expect(gate.locator('.verdict')).toBeVisible({ timeout: 30_000 });
  // Five critics, five rubric rows; every route compared against the preview.
  await expect(gate.locator('.rubric-row')).toHaveCount(8);
  await expect(gate.getByText('Paridade preview / release')).toBeVisible();
  await expect(gate.getByText('sem autoridade de gate', { exact: false })).toBeVisible();

  const verdict = await gate.locator('.verdict').textContent();
  if (verdict?.includes('bloqueado')) {
    await expect(gate.getByRole('button', { name: 'Publicar bundle (capitão)' })).toBeDisabled();
    return;
  }
  await gate.getByRole('button', { name: 'Publicar bundle (capitão)' }).click();
  await expect(gate.getByRole('button', { name: 'Bundle publicado' })).toBeVisible({ timeout: 30_000 });
  await expect(gate.getByText('Bundle imutável escrito em', { exact: false })).toBeVisible();
});
