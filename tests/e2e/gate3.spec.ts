import { expect, test } from '@playwright/test';

test('the captain reads the release report on Gate 3 and publishes the bundle', async ({ page }) => {
  await page.goto('/');
  const gate = page.locator('.gate3-panel');
  await expect(gate.getByRole('button', { name: 'Preparar release' })).toBeDisabled();

  await page.getByRole('button', { name: 'Carregar briefing fixo' }).click();
  // Gate 3 only opens once the first two gates are closed and the finalization
  // stage has produced the version the captain is looking at.
  for (let index = 0; index < 2; index += 1) {
    await page.getByRole('button', { name: 'Executar próxima etapa' }).click();
    await page.getByRole('button', { name: 'Aprovar gate' }).click({ timeout: 30_000 });
  }
  await page.getByRole('button', { name: 'Executar próxima etapa' }).click();
  await expect(page.getByText('Aprovar é publicar o bundle no Gate 3 abaixo')).toBeVisible();

  await gate.getByRole('button', { name: 'Preparar release' }).click();
  await expect(gate.locator('.verdict')).toBeVisible({ timeout: 30_000 });
  // Five critics, five rubric rows; every route compared against the preview.
  await expect(gate.locator('.rubric-row')).toHaveCount(8);
  await expect(gate.getByText('Paridade preview / release')).toBeVisible();
  await expect(gate.getByText('sem autoridade de gate', { exact: false })).toBeVisible();

  const publish = gate.getByRole('button', { name: 'Publicar bundle e aprovar o gate' });
  const verdict = await gate.locator('.verdict').textContent();
  if (verdict?.includes('bloqueado')) {
    await expect(publish).toBeDisabled();
    return;
  }
  // An open escalation does not block, but publishing over it takes a written reason.
  await expect(publish).toBeDisabled();
  await gate.locator('.acceptance textarea').fill('Aceito publicar com a evidência que este ambiente produziu.');
  await publish.click();
  await expect(gate.getByRole('button', { name: 'Bundle publicado' })).toBeVisible({ timeout: 30_000 });
  await expect(gate.getByText('Bundle imutável escrito em', { exact: false })).toBeVisible();

  // A new briefing is a new run, so Gate 3 comes back empty and ready instead of
  // showing the finished run's report.
  await page.getByRole('button', { name: 'Reiniciar briefing' }).click();
  await expect(gate.getByText('Prepare o release para compilar o bundle', { exact: false })).toBeVisible();
  await expect(gate.getByRole('button', { name: 'Preparar release' })).toBeEnabled();
});
