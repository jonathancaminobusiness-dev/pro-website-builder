import { expect, test } from '@playwright/test';

test.describe('Gate 2 review screen', () => {
  test.setTimeout(120_000);

  test('compares A with B, annotates the issues and records the captain decision', async ({ page }) => {
    await page.goto('/#/gate-2');
    await expect(page.getByRole('heading', { name: 'Hierarquia, comportamento e caráter' })).toBeVisible();

    // The control pair carries a known defect, so the critics have something to report.
    await page.getByLabel('Par de controle · ritmo impossível').check();
    await page.getByRole('button', { name: 'Executar a etapa de protótipo' }).click();

    const compare = page.locator('.compare');
    await expect(compare).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('.eyebrow').first()).toContainText('par de controle');

    // A and B are the same route at the same width, both from the isolated preview origin.
    const frames = page.locator('.compare iframe');
    await expect(frames).toHaveCount(2);
    for (const attribute of await frames.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('sandbox')))) {
      expect(attribute).toBe('');
    }
    const sources = await frames.evaluateAll((nodes) => nodes.map((node) => (node as HTMLIFrameElement).src));
    expect(new Set(sources).size).toBe(2);
    // Both sides come from the preview origin, which is never the Studio's own origin.
    const previewOrigins = new Set(sources.map((source) => new URL(source).origin));
    expect(previewOrigins.size).toBe(1);
    expect([...previewOrigins][0]).not.toBe(new URL(page.url()).origin);
    expect(sources.every((source) => new URL(source).pathname.startsWith('/preview/'))).toBe(true);
    expect(sources.every((source) => source.endsWith('/'))).toBe(true);
    await expect(page.frameLocator('.compare .base iframe').locator('main[data-route="/"]')).toBeVisible();

    // The same controls drive both sides.
    await page.getByRole('button', { name: '/proof', exact: true }).click();
    await page.getByLabel('Largura').selectOption('390');
    await expect(frames.first()).toHaveAttribute('width', '390');
    const updated = await frames.evaluateAll((nodes) => nodes.map((node) => (node as HTMLIFrameElement).src));
    expect(updated.every((source) => source.endsWith('/proof'))).toBe(true);

    await page.getByRole('button', { name: 'sobreposição' }).click();
    await expect(page.locator('.compare-overlay')).toBeVisible();
    await page.getByRole('button', { name: 'diferença' }).click();
    await expect(page.locator('.compare-difference')).toBeVisible();

    // The deterministic gate and the critics are shown apart from each other.
    await expect(page.getByRole('heading', { name: 'QA determinístico' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Opinião dos críticos' })).toBeVisible();
    await page.getByRole('button', { name: 'percepção' }).click();
    await expect(page.locator('.gate2-critic p').first()).toContainText('Leitura determinística');

    // Every issue names its node, its evidence and the repair it proposes.
    const issues = page.locator('.gate2-issue');
    await expect(issues.first()).toBeVisible();
    await expect(issues.first().locator('dd code').first()).not.toBeEmpty();
    await expect(issues.first()).toContainText('set_token');

    await issues.first().getByPlaceholder('Motivo da decisão').fill('Reparo causal; o ritmo volta ao contrato.');
    await issues.first().getByRole('button', { name: 'Aceitar' }).click();
    await expect(issues.first().locator('.gate2-decided')).toContainText('Aceito · Reparo causal');

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
