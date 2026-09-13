import { expect, test } from '@playwright/test';

/**
 * Gate 1 is a comparison of whole documents. Each card renders the page of the
 * very version it would approve, from the isolated preview origin, while the
 * decision is still open — the captain never decides from token cards alone.
 */
test('every direction opens the isolated preview of its own version before the decision', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Gate 1 · identidade' }).click();
  await page.getByRole('button', { name: 'Criar execução de identidade' }).click();
  await page.getByRole('button', { name: 'Executar etapa de identidade' }).click();

  const cards = page.locator('.direction-card');
  await expect(cards).toHaveCount(3);
  const previews = page.locator('.direction-card iframe.direction-preview');
  await expect(previews).toHaveCount(3);

  // Nothing has been decided: the previews are what the decision is made on.
  await expect(page.locator('.direction-card.selected')).toHaveCount(0);

  const studioOrigin = new URL(page.url()).origin;
  const sources: string[] = [];
  for (const directionId of ['editorial-material', 'modular-technical', 'typographic-low-chroma']) {
    const card = cards.filter({ hasText: directionId });
    const versionId = (await card.locator('.version-line code').first().textContent())?.trim();
    expect(versionId).toBeTruthy();

    const frame = card.locator('iframe.direction-preview');
    await expect(frame).toHaveAttribute('sandbox', '');
    const source = await frame.evaluate((node) => (node as HTMLIFrameElement).src);
    expect(new URL(source).origin).not.toBe(studioOrigin);
    expect(new URL(source).pathname).toBe(`/preview/${versionId}/`);
    sources.push(source);

    // The page really renders on that origin, so the card shows a document.
    await expect(card.frameLocator('iframe.direction-preview').locator('main').first()).toBeVisible();
  }

  // Three documents, never the same one three times.
  expect(new Set(sources).size).toBe(3);
});
