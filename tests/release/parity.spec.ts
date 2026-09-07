import { expect, test, type Page } from '@playwright/test';

/**
 * Preview/release parity in a real browser.
 *
 * The Vitest fixtures prove the two documents describe the same styles; this
 * proves the engine resolves them the same way, on Chromium, Firefox and WebKit.
 */
const PROPERTIES = ['color', 'background-color', 'font-family', 'padding', 'border-radius', 'gap', 'display'] as const;

interface Harness {
  routes: Array<{ route: string; releasePath: string; previewPath: string }>;
  /** The faces the release self-hosts; the preview must load exactly these too. */
  fonts: Array<{ family: string; weight: string; style: string }>;
}

/** The harness publishes its ephemeral origin here; see tests/release/global-setup.ts. */
function origin(): string {
  const value = process.env.PWB_RELEASE_ORIGIN;
  if (!value) throw new Error('PWB_RELEASE_ORIGIN is unset; the release harness did not start.');
  return value;
}

/** What the engine actually resolved for the faces the document declares. */
async function loadedFaces(page: Page, families: Harness['fonts']): Promise<{ declared: string[]; usable: Record<string, boolean> }> {
  return page.evaluate((wanted) => ({
    declared: [...document.fonts].map((face) => `${face.family}|${face.weight}|${face.style}|${face.status}`).sort(),
    usable: Object.fromEntries(wanted.map((font) => [`${font.family}|${font.weight}|${font.style}`, document.fonts.check(`${font.style} ${font.weight} 1em "${font.family}"`)])),
  }), families);
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
    const previewFaces = await loadedFaces(page, harness.fonts);
    const release = await computedByNode(page, route.releasePath);
    const releaseText = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim());
    const releaseFaces = await loadedFaces(page, harness.fonts);
    expect(Object.keys(release).sort(), `${route.route} must expose the same nodes`).toEqual(Object.keys(preview).sort());
    expect(release, `${route.route} must resolve the same styles`).toEqual(preview);
    expect(releaseText, `${route.route} must show the same text`).toBe(previewText);
    // The same computed font-family stack proves nothing if one side has no face
    // to resolve it to, so both sides are asked what they actually loaded.
    expect(releaseFaces, `${route.route} must load the same faces as the preview`).toEqual(previewFaces);
    for (const [face, usable] of Object.entries(releaseFaces.usable)) {
      expect(usable, `${route.route} must serve the self-hosted face ${face}`).toBe(true);
    }
  }
});
