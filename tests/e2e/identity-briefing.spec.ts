import { expect, test } from '@playwright/test';

test('captain can replace the example with a free niche briefing', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Gate 1 · identidade' }).click();

  const briefing = page.getByLabel('Briefing do projeto');
  await expect(briefing).toBeVisible();
  await expect(page.getByText(/\/8000 caracteres/)).toBeVisible();

  await briefing.fill('  Nicho editorial para oficinas de bairro.  ');
  await expect(page.getByText('44/8000 caracteres')).toBeVisible();
  await page.getByRole('button', { name: 'Criar execução de identidade' }).click();

  await expect(page.locator('.gate-briefing')).toHaveText('Nicho editorial para oficinas de bairro.');
  const initialRunId = (await page.locator('.run-id code').innerText()).trim();

  await page.getByRole('button', { name: 'Nova execução' }).click();
  await expect(page.getByText('Uma execução nova substitui')).toBeVisible();
  await page.getByRole('button', { name: 'Criar mesmo assim' }).click();

  await expect(page.locator('.run-id code')).not.toHaveText(initialRunId);
  await expect(page.locator('.gate-briefing')).toHaveText('Nicho editorial para oficinas de bairro.');
});
