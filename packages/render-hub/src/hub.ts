import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import type { RenderedDocument } from '@pwb/renderer';
import { cacheKey, evaluateQa, type QaResult, type RenderCase } from './cases.js';

export interface RenderCaseResult { renderCase: RenderCase; screenshotPath: string; dom: string; accessibility: unknown; qa: QaResult; cached: boolean; }

export class RenderHub {
  constructor(private readonly options: { cacheDir: string; browser?: Browser }) {}

  async render(rendered: RenderedDocument, baseUrl: string, cases: RenderCase[]): Promise<RenderCaseResult[]> {
    await mkdir(this.options.cacheDir, { recursive: true });
    const browser = this.options.browser ?? await chromium.launch({ headless: true });
    const ownsBrowser = !this.options.browser;
    const results: RenderCaseResult[] = [];
    try {
      for (const renderCase of cases) {
        const key = cacheKey(rendered, renderCase);
        const manifestPath = join(this.options.cacheDir, `${key}.json`);
        try { results.push({ ...(JSON.parse(await readFile(manifestPath, 'utf8')) as RenderCaseResult), cached: true }); continue; } catch { /* cache miss */ }
        const page = await browser.newPage({ viewport: { width: renderCase.width, height: 900 }, reducedMotion: renderCase.reducedMotion ? 'reduce' : 'no-preference' });
        const consoleErrors: string[] = [];
        const networkErrors: string[] = [];
        page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
        page.on('requestfailed', (request) => networkErrors.push(`${request.url()}: ${request.failure()?.errorText ?? 'failed'}`));
        await page.goto(new URL(renderCase.route, baseUrl).toString(), { waitUntil: 'networkidle' });
        await page.waitForFunction(() => document.fonts?.status === 'loaded');
        const metrics = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, dom: document.documentElement.outerHTML }));
        const accessibilityApi = (page as unknown as { accessibility?: { snapshot: () => Promise<unknown> } }).accessibility;
        const accessibility = accessibilityApi ? await accessibilityApi.snapshot() : await page.locator('body').ariaSnapshot();
        const qa = evaluateQa({ ...metrics, consoleErrors, networkErrors });
        const screenshotPath = join(this.options.cacheDir, `${key}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true });
        await page.close();
        const result: RenderCaseResult = { renderCase, screenshotPath, dom: metrics.dom, accessibility, qa, cached: false };
        await writeFile(manifestPath, JSON.stringify(result), 'utf8');
        results.push(result);
      }
    } finally { if (ownsBrowser) await browser.close(); }
    return results;
  }
}
