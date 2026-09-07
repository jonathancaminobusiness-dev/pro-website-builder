import { expect, test } from '@playwright/test';

test.describe('Gate 2 review screen', () => {
  test.setTimeout(120_000);

  test('compares the reviewed revision, shows the evidence and records the captain decision', async ({ page }) => {
    await page.goto('/#/gate-2');
    await expect(page.getByRole('heading', { name: 'Hierarquia, comportamento e caráter' })).toBeVisible();

    await page.getByRole('button', { name: 'Executar a etapa de protótipo' }).click();

    const compare = page.locator('.compare');
    await expect(compare).toBeVisible({ timeout: 60_000 });

    // The fixture briefing composes cleanly, so no repair is applied and there is no B to compare A
    // against; the screen says so instead of pretending the two sides differ.
    await expect(page.locator('.gate2-versions')).toContainText('nenhum reparo foi aplicado');
    const frames = page.locator('.compare iframe');
    await expect(frames).toHaveCount(1);
    for (const attribute of await frames.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('sandbox')))) {
      expect(attribute).toBe('');
    }
    // The preview comes from the isolated origin, which is never the Studio's own.
    const source = new URL(await frames.first().evaluate((node) => (node as HTMLIFrameElement).src));
    expect(source.origin).not.toBe(new URL(page.url()).origin);
    expect(source.pathname.startsWith('/preview/')).toBe(true);
    expect(source.pathname.endsWith('/')).toBe(true);
    await expect(page.frameLocator('.compare .base iframe').locator('main[data-route="/"]')).toBeVisible();
    for (const mode of ['sobreposição', 'diferença']) {
      await expect(page.getByRole('button', { name: mode })).toBeDisabled();
    }

    // The same controls drive the comparison.
    await page.getByRole('button', { name: '/proof', exact: true }).click();
    await page.getByLabel('Largura').selectOption('390');
    await expect(frames.first()).toHaveAttribute('width', '390');
    const updated = await frames.first().evaluate((node) => (node as HTMLIFrameElement).src);
    expect(updated.endsWith('/proof')).toBe(true);

    // The deterministic gate and the critics are shown apart from each other.
    await expect(page.getByRole('heading', { name: 'QA determinístico' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Opinião dos críticos' })).toBeVisible();
    await page.getByRole('button', { name: 'percepção' }).click();
    await expect(page.locator('.gate2-critic p').first()).toContainText('Leitura determinística');

    // Nothing to repair on this revision, and the screen states that rather than showing an empty list.
    await expect(page.locator('.gate2-issue')).toHaveCount(0);
    await expect(page.locator('.gate2-issues .gate2-note')).toContainText('Nenhum crítico encontrou algo a reparar');

    await page.getByPlaceholder('Motivo da decisão do gate').fill('Hierarquia e comportamento aprovados pelo capitão.');
    await page.getByRole('button', { name: 'Aprovar o Gate 2' }).click();
    await expect(page.getByRole('status')).toContainText('Gate aprovado');
  });

  test('keeps the pipeline screen reachable and starts no model work on its own', async ({ page }) => {
    await page.goto('/#/gate-2');
    await expect(page.locator('.compare')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Executar a etapa de protótipo' })).toBeVisible();
    await page.getByRole('link', { name: '← pipeline' }).click();
    await expect(page.getByRole('heading', { name: 'Compilador de identidade' })).toBeVisible();
  });
});
