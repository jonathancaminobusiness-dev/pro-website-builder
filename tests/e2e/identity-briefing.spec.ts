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
  // The replacement briefing is written from scratch: nothing is carried over
  // from the run being replaced, so there is nothing to create until the
  // captain says what the new identity is about.
  const replacement = page.getByLabel('Briefing do projeto');
  await expect(replacement).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Criar mesmo assim' })).toBeDisabled();

  await replacement.fill('Nicho de marcenaria autoral para apartamentos pequenos.');
  await page.getByRole('button', { name: 'Criar mesmo assim' }).click();

  await expect(page.locator('.run-id code')).not.toHaveText(initialRunId);
  await expect(page.locator('.gate-briefing')).toHaveText('Nicho de marcenaria autoral para apartamentos pequenos.');
});

test('keeps the persisted briefing on screen after reload and never reuses it for the next run', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Gate 1 · identidade' }).click();
  await page.getByLabel('Briefing do projeto').fill('Nicho de encadernação artesanal para bibliotecas independentes.');
  await page.getByRole('button', { name: 'Criar execução de identidade' }).click();
  await expect(page.locator('.gate-briefing')).toHaveText('Nicho de encadernação artesanal para bibliotecas independentes.');

  await page.reload();
  await page.getByRole('button', { name: 'Gate 1 · identidade' }).click();
  await expect(page.locator('.gate-briefing')).toHaveText('Nicho de encadernação artesanal para bibliotecas independentes.');
  const initialRunId = (await page.locator('.run-id code').innerText()).trim();

  await page.getByRole('button', { name: 'Nova execução' }).click();
  const replacement = page.getByLabel('Briefing do projeto');
  await expect(replacement).toHaveValue('');
  await replacement.fill('Nicho de tipografia para editoras independentes.');
  await page.getByRole('button', { name: 'Criar mesmo assim' }).click();

  await expect(page.locator('.run-id code')).not.toHaveText(initialRunId);
  await expect(page.locator('.gate-briefing')).toHaveText('Nicho de tipografia para editoras independentes.');
});

test('caps the briefing editor at the supported character limit', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Gate 1 · identidade' }).click();

  const briefing = page.getByLabel('Briefing do projeto');
  await expect(briefing).toHaveAttribute('maxlength', '8000');
  await briefing.fill('a'.repeat(8001));
  await expect(briefing).toHaveValue('a'.repeat(8000));
  await expect(page.getByText('8000/8000 caracteres')).toBeVisible();
});
