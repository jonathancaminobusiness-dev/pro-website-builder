import { expect, test } from '@playwright/test';

/** Gate 1 puts three dense cards side by side; nothing in it may push the page sideways. */
for (const width of [1440, 768, 390] as const) {
  test(`the Gate 1 screen never scrolls sideways at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Gate 1 · identidade' }).click();
    await page.getByRole('button', { name: 'Criar execução de identidade' }).click();
    await page.getByRole('button', { name: 'Executar etapa de identidade' }).click();
    await expect(page.locator('.direction-card')).toHaveCount(3);
    for (const details of await page.locator('details').all()) await details.evaluate((element) => element.setAttribute('open', ''));
    const metrics = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
  });
}
