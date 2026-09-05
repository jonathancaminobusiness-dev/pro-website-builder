import { expect, test } from '@playwright/test';

test('captain can drive the fixture through all three gates', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Carregar briefing fixo' }).click();
  await page.getByRole('button', { name: 'Executar próxima etapa' }).click();
  for (let index = 0; index < 3; index += 1) {
    await page.getByRole('button', { name: 'Aprovar gate' }).click();
    if (index < 2) await page.getByRole('button', { name: 'Executar próxima etapa' }).click();
  }
  await expect(page.getByRole('button', { name: 'Export concluído' })).toBeVisible();
  await expect(page.locator('iframe[title="Preview do site"]')).toHaveAttribute('sandbox', '');
  await expect(page.locator('.qa-chip')).toContainText('0 erros');
});
