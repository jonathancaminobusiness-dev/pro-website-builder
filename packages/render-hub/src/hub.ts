import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { hashJson, type DesignIR } from '@pwb/domain';
import type { AxeViolation, FocusSample, RenderContext, RenderEvidence } from '@pwb/qa-deterministic';
import type { RenderedDocument } from '@pwb/renderer';
import { cacheKey, evaluateQa, type QaResult, type RenderCase } from './cases.js';
import { applyRenderState, collectRenderEvidence, readFocusSample, type CollectedPage } from './collect.js';
import { conditionFor, type StateCondition } from './matrix.js';

export interface RenderCaseResult { renderCase: RenderCase; screenshotPath: string; dom: string; accessibility: string; qa: QaResult; cached: boolean; }
export interface EvidenceCapture { renderCase: RenderCase; evidence: RenderEvidence; dom: string; accessibility: string; status: number | null; cached: boolean; }

export interface CaptureRequest {
  ir: DesignIR;
  rendered: RenderedDocument;
  baseUrl: string;
  /** Path segment that addresses this revision on the preview origin, such as `/preview/v-abc`. */
  previewPrefix: string;
  cases: RenderCase[];
  signal?: AbortSignal;
}

/** Keyboard focus is walked, never scripted, so `:focus-visible` behaves as it does for a real user. */
const MAX_TAB_STOPS = 25;
/**
 * TypeScript transpilers that keep function names (esbuild, tsx) wrap every function in a `__name`
 * helper, and that helper travels with a function Playwright serializes into the page. This identity
 * shim is injected as raw text before navigation so the collectors run; it defines one no-op global
 * and touches nothing the capture measures.
 */
const KEEP_NAMES_SHIM = 'globalThis.__name = globalThis.__name || ((value) => value);';
let axeSourceText: Promise<string> | undefined;
/** axe-core publishes its own bundle as a string, so the runner never has to resolve a file path. */
function axeSource(): Promise<string> {
  axeSourceText ??= import('axe-core').then((module) => (module.default ?? module).source);
  return axeSourceText;
}

interface AxeResult { violations: Array<{ id: string; impact: string | null; help: string; nodes: Array<{ target: string[] }> }>; }

export class RenderHub {
  private readonly maxConcurrency: number;

  constructor(private readonly options: { cacheDir: string; browser?: Browser; maxConcurrency?: number }) {
    this.maxConcurrency = Math.max(1, options.maxConcurrency ?? 3);
  }

  /**
   * Captures the full deterministic evidence bundle for every case: screenshot, DOM, accessibility
   * snapshot, per-node geometry, contrast and focus samples, console and network errors, and a
   * stability read. Results are content-addressed, so an unchanged revision never reopens a browser.
   */
  async capture(request: CaptureRequest): Promise<EvidenceCapture[]> {
    return this.withBrowser(async (browser) => this.eachCase(request.cases, async (renderCase) => {
      const key = cacheKey(request.rendered, renderCase);
      const cached = await this.readCache<EvidenceCapture>(`${key}.evidence.json`);
      if (cached) return { ...cached, cached: true };
      const condition = conditionFor(request.ir, renderCase.state);
      const url = new URL(`${request.previewPrefix}${renderCase.route}`, request.baseUrl).toString();
      const capture = await this.capturePage(browser, renderCase, condition, url, join(this.options.cacheDir, `${key}.evidence.png`), request.signal);
      await this.writeCache(`${key}.evidence.json`, capture);
      return capture;
    }));
  }

  /** The single-condition capture the fixture CLI and the phase 0 tests drive. */
  async render(rendered: RenderedDocument, baseUrl: string, cases: RenderCase[]): Promise<RenderCaseResult[]> {
    return this.withBrowser(async (browser) => this.eachCase(cases, async (renderCase) => {
      const key = cacheKey(rendered, renderCase);
      const cached = await this.readCache<RenderCaseResult>(`${key}.json`);
      if (cached) return { ...cached, cached: true };
      const condition: StateCondition = { state: renderCase.state, description: renderCase.state, reducedMotion: renderCase.reducedMotion, hiddenNodeIds: [], focusNodeId: null };
      const url = new URL(renderCase.route, baseUrl).toString();
      const capture = await this.capturePage(browser, renderCase, condition, url, join(this.options.cacheDir, `${key}.png`));
      const { evidence } = capture;
      const result: RenderCaseResult = {
        renderCase, screenshotPath: evidence.screenshotPath, dom: capture.dom, accessibility: capture.accessibility,
        qa: evaluateQa({ scrollWidth: evidence.documentMetrics.scrollWidth, clientWidth: evidence.documentMetrics.clientWidth, status: capture.status, consoleErrors: evidence.consoleErrors, networkErrors: evidence.networkErrors }),
        cached: false,
      };
      await this.writeCache(`${key}.json`, result);
      return result;
    }));
  }

  private async capturePage(browser: Browser, renderCase: RenderCase, condition: StateCondition, url: string, screenshotPath: string, signal?: AbortSignal): Promise<EvidenceCapture> {
    const colorScheme = renderCase.colorScheme ?? 'light';
    const page = await browser.newPage({
      viewport: { width: renderCase.width, height: 900 },
      reducedMotion: renderCase.reducedMotion ? 'reduce' : 'no-preference',
      colorScheme,
    });
    const consoleErrors: string[] = [];
    const networkErrors: string[] = [];
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('pageerror', (error) => consoleErrors.push(error.message));
    page.on('requestfailed', (request) => networkErrors.push(`${request.url()}: ${request.failure()?.errorText ?? 'failed'}`));
    try {
      signal?.throwIfAborted();
      await page.addInitScript(KEEP_NAMES_SHIM);
      const response = await page.goto(url, { waitUntil: 'networkidle' });
      const status = response?.status() ?? null;
      await page.waitForFunction(() => document.fonts?.status === 'loaded');
      await page.evaluate(applyRenderState, { hiddenNodeIds: condition.hiddenNodeIds, state: condition.state });
      if (condition.focusNodeId) await this.focusNode(page, condition.focusNodeId);
      const first = await page.evaluate(collectRenderEvidence);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      const second = await page.evaluate(collectRenderEvidence);
      const focus = await this.walkFocusOrder(page);
      const axeViolations = await this.runAxe(page);
      const accessibility = await page.locator('body').ariaSnapshot();
      const context: RenderContext = { route: renderCase.route, viewport: renderCase.width, state: renderCase.state, colorScheme, reducedMotion: renderCase.reducedMotion };
      const evidence: RenderEvidence = {
        context,
        documentMetrics: second.documentMetrics,
        nodes: second.nodes,
        contrast: second.contrast,
        focus,
        axeViolations,
        consoleErrors,
        networkErrors,
        stable: layoutHash(first) === layoutHash(second),
        status,
        screenshotPath,
        domHash: hashJson(second.dom),
      };
      return { renderCase, evidence, dom: second.dom, accessibility, status, cached: false };
    } finally {
      await page.close();
    }
  }

  private async focusNode(page: Page, nodeId: string): Promise<void> {
    const target = page.locator(`[data-node-id="${nodeId}"]`).first();
    if (await target.count() === 0) return;
    await target.evaluate((element: HTMLElement) => {
      const focusable = element.matches('a[href], button, input, select, textarea, [tabindex]') ? element : element.querySelector<HTMLElement>('a[href], button, input, select, textarea, [tabindex]');
      focusable?.focus();
    });
  }

  private async walkFocusOrder(page: Page): Promise<FocusSample[]> {
    const samples: FocusSample[] = [];
    const seen = new Set<string>();
    await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); });
    for (let stop = 0; stop < MAX_TAB_STOPS; stop += 1) {
      await page.keyboard.press('Tab');
      const sample = await page.evaluate(readFocusSample);
      if (!sample || seen.has(sample.nodeId)) break;
      seen.add(sample.nodeId);
      samples.push(sample);
    }
    return samples;
  }

  private async runAxe(page: Page): Promise<AxeViolation[]> {
    // The preview origin serves `script-src 'none'` and must keep doing so, so axe is evaluated
    // through the debugging protocol instead of injected as a page script.
    await page.evaluate(await axeSource());
    const raw = await page.evaluate(async () => {
      const runner = (window as unknown as { axe?: { run: (context: Document, options: unknown) => Promise<unknown> } }).axe;
      if (!runner) return { violations: [] };
      return await runner.run(document, { resultTypes: ['violations'] }) as unknown;
    }) as AxeResult;
    const impacts = new Set(['critical', 'serious', 'moderate', 'minor']);
    return raw.violations.map((violation) => ({
      id: violation.id,
      impact: (impacts.has(violation.impact ?? '') ? violation.impact : 'minor') as AxeViolation['impact'],
      help: violation.help,
      nodeIds: [...new Set(violation.nodes.flatMap((node) => node.target.flatMap((target) => /\[data-node-id="([^"]+)"\]/.exec(target)?.[1] ?? [])))],
    }));
  }

  private async withBrowser<T>(work: (browser: Browser) => Promise<T>): Promise<T> {
    await mkdir(this.options.cacheDir, { recursive: true });
    const browser = this.options.browser ?? await chromium.launch({ headless: true });
    try { return await work(browser); }
    finally { if (!this.options.browser) await browser.close(); }
  }

  /** Runs the cases through a bounded pool while preserving the order the caller asked for. */
  private async eachCase<T>(cases: RenderCase[], work: (renderCase: RenderCase) => Promise<T>): Promise<T[]> {
    const results = new Array<T>(cases.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (let index = next++; index < cases.length; index = next++) results[index] = await work(cases[index]!);
    };
    await Promise.all(Array.from({ length: Math.min(this.maxConcurrency, cases.length) }, worker));
    return results;
  }

  private async readCache<T>(name: string): Promise<T | undefined> {
    try { return JSON.parse(await readFile(join(this.options.cacheDir, name), 'utf8')) as T; }
    catch { return undefined; }
  }

  private async writeCache(name: string, value: unknown): Promise<void> {
    await writeFile(join(this.options.cacheDir, name), JSON.stringify(value), 'utf8');
  }
}

/** Two reads of the same page must agree on geometry before the capture counts as stable. */
function layoutHash(page: CollectedPage): string {
  return hashJson([page.documentMetrics, page.nodes.map((node) => [node.nodeId, node.box, node.displayed])]);
}
