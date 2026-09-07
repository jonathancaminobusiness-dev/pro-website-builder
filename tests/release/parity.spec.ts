import { expect, test, type Page } from '@playwright/test';

/**
 * Preview/release parity in a real browser.
 *
 * The Vitest fixtures prove the two documents describe the same styles; this
 * proves the engine resolves them the same way, on Chromium, Firefox and WebKit.
 */
const PROPERTIES = ['color', 'background-color', 'font-family', 'padding', 'border-radius', 'gap', 'display'] as const;

interface Harness { routes: Array<{ route: string; releasePath: string; previewPath: string }> }

/** The harness publishes its ephemeral origin here; see tests/release/global-setup.ts. */
function origin(): string {
  const value = process.env.PWB_RELEASE_ORIGIN;
  if (!value) throw new Error('PWB_RELEASE_ORIGIN is unset; the release harness did not start.');
  return value;
}

async function computedByNode(page: Page, path: string): Promise<Record<string, Record<string, string>>> {
  await page.goto(`${origin()}${path}`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.fonts?.status === 'loaded');
  return page.evaluate((properties) => {
    const result: Record<string, Record<string, string>> = {};
    for (const element of document.querySelectorAll('[data-node-id]')) {
      const styles = window.getComputedStyle(element);
      const id = element.getAttribute('data-node-id');
      if (!id) continue;
      result[id] = Object.fromEntries(properties.map((property) => [property, styles.getPropertyValue(property)]));
    }
    return result;
  }, PROPERTIES as unknown as string[]);
}

test('the release resolves the same styles and text as the preview the captain reviewed', async ({ page }) => {
  const harness = await (await page.request.get(`${origin()}/harness.json`)).json() as Harness;
  for (const route of harness.routes) {
    const preview = await computedByNode(page, route.previewPath);
    const previewText = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim());
    const release = await computedByNode(page, route.releasePath);
    const releaseText = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim());
    expect(Object.keys(release).sort(), `${route.route} must expose the same nodes`).toEqual(Object.keys(preview).sort());
    expect(release, `${route.route} must resolve the same styles`).toEqual(preview);
    expect(releaseText, `${route.route} must show the same text`).toBe(previewText);
  }
});
