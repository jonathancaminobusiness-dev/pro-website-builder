import { expect, test } from '@playwright/test';

test('captain compares three directions and decides Gate 1, and a token change reopens it', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Gate 1 · identidade' }).click();

  await page.getByRole('button', { name: 'Criar execução de identidade' }).click();
  await expect(page.getByText('sem execução')).toHaveCount(0);

  await page.getByRole('button', { name: 'Executar etapa de identidade' }).click();
  const cards = page.locator('.direction-card');
  await expect(cards).toHaveCount(3);
  await expect(page.locator('.gate-check.ok').first()).toContainText('DIV-030 aprovado');

  // Every direction shows its axis vector, its rationale and what it excludes.
  for (const directionId of ['editorial-material', 'modular-technical', 'typographic-low-chroma']) {
    const card = page.locator('.direction-card', { hasText: directionId });
    await expect(card.locator('.axis-list > div')).toHaveCount(6);
    await expect(card.locator('.direction-rationale')).toContainText('Rationale.');
    await expect(card.getByText('Exclusões e defaults proibidos')).toBeVisible();
    await expect(card.getByText(/Decisões com evidência \(\d+\)/)).toBeVisible();
    await expect(card.getByText(/geração só após aprovação/)).toBeVisible();
  }

  // Nothing is marked until the server records a decision.
  await expect(page.locator('.direction-card.selected')).toHaveCount(0);

  await page.getByLabel(/Motivo da decisão/).fill('A direção modular declara a medida, que é a prova deste briefing.');
  await page.locator('.direction-card', { hasText: 'modular-technical' }).getByRole('button', { name: 'Aprovar esta direção' }).click();
  await expect(page.locator('.direction-card.selected')).toHaveCount(1);

  const record = page.locator('.gate-record');
  await expect(record).toContainText('Decisão registrada.');
  await expect(record).toContainText('modular-technical');
  await expect(page.getByText('aprovado', { exact: true })).toBeVisible();
  await expect(page.locator('iframe[title="Preview da identidade aprovada"]')).toHaveAttribute('sandbox', '');

  await page.getByLabel('Token', { exact: true }).fill('color.accent');
  await page.getByLabel('Novo valor').fill('#ff7a00');
  await page.getByRole('button', { name: 'Aplicar mudança de token' }).click();

  await expect(page.locator('.gate-check.blocked')).toContainText('Gate 1 reaberto');
  await expect(page.locator('.gate-check.blocked')).toContainText('color.accent');
  await expect(page.getByText('reaberto', { exact: true })).toBeVisible();

  // A reopened gate is decidable again: the captain closes it from the same screen.
  await page.getByLabel(/Motivo da decisão/).fill('Token revisado; a direção segue valendo.');
  await page.locator('.direction-card', { hasText: 'modular-technical' }).getByRole('button', { name: 'Aprovar esta direção' }).click();
  await expect(page.locator('.gate-check.blocked')).toHaveCount(0);
  await expect(page.getByText('aprovado', { exact: true })).toBeVisible();
  await expect(record).toContainText('Token revisado; a direção segue valendo.');
});
