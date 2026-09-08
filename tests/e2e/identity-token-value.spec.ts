import { expect, test } from '@playwright/test';

/**
 * A token value the captain types is emitted verbatim into one declaration of the
 * preview's `:root` block, so a value that leaves a string or a function open would
 * swallow the declarations after it. The refusal has to reach the captain on the same
 * screen: the gate they just closed stays closed and the message says why.
 */
test('refuses a token value that would not close its own CSS declaration, and takes the complete one', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Gate 1 · identidade' }).click();
  await page.getByRole('button', { name: 'Criar execução de identidade' }).click();
  await page.getByRole('button', { name: 'Executar etapa de identidade' }).click();
  await expect(page.locator('.direction-card')).toHaveCount(3);

  await page.getByLabel(/Motivo da decisão/).fill('A direção modular declara a medida.');
  await page.locator('.direction-card', { hasText: 'modular-technical' }).getByRole('button', { name: 'Aprovar esta direção' }).click();
  await expect(page.getByText('aprovado', { exact: true })).toBeVisible();

  const banner = page.locator('.error-banner');
  for (const [tokenPath, value, reason] of [
    ['color.accent', '#ff7a0', /hex colour of 3, 4, 6 or 8 digits/],
    ['color.accent', 'rgb(255 0 0', /closed CSS colour function/],
    ['type.body', '"Inter, Arial, sans-serif', /leaves a quoted string open/],
  ] as const) {
    await page.getByLabel('Token', { exact: true }).fill(tokenPath);
    await page.getByLabel('Novo valor').fill(value);
    await page.getByRole('button', { name: 'Aplicar mudança de token' }).click();
    await expect(banner).toContainText(reason);
    // Nothing was committed: the gate the captain closed is still closed.
    await expect(page.getByText('aprovado', { exact: true })).toBeVisible();
    await expect(page.locator('.gate-check.blocked')).toHaveCount(0);
  }

  // A complete value of the same kinds still goes through and reopens the gate.
  await page.getByLabel('Token', { exact: true }).fill('type.body');
  await page.getByLabel('Novo valor').fill('"O\'Neil Sans", Inter, sans-serif');
  await page.getByRole('button', { name: 'Aplicar mudança de token' }).click();
  await expect(page.locator('.gate-check.blocked')).toContainText('Gate 1 reaberto');
  await expect(banner).toHaveCount(0);

  await page.getByLabel('Token', { exact: true }).fill('color.accent');
  await page.getByLabel('Novo valor').fill('oklch(0.72 0.18 45)');
  await page.getByRole('button', { name: 'Aplicar mudança de token' }).click();
  await expect(page.locator('.gate-check.blocked')).toContainText('color.accent');
  await expect(banner).toHaveCount(0);
});
