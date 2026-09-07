import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { expect, test, type Page } from '@playwright/test';
import { createFixtureIR, type DesignIR } from '../../packages/domain/src/index.js';
import { DerivedEvidenceSource } from '../../packages/stage-prototype/src/index.js';
import { openDatabase, ProjectRepository } from '../../apps/server/src/db/repository.js';
import { PrototypeRunRegistry } from '../../apps/server/src/prototype-api.js';
import { handlePrototypeRequest } from '../../apps/server/src/prototype-routes.js';

/**
 * A revision with a defect the critics are guaranteed to report, so the review surfaces that only exist
 * once a repair was applied — the A/B pair of two different revisions and the annotated issues — are
 * exercised. It is a test fixture, never a briefing the product offers.
 */
function createOffRhythmControlIR(): DesignIR {
  const ir = createFixtureIR();
  const space = ir.identity.tokens.space as Record<string, { $value: string; $type: 'dimension' }>;
  ir.identity.tokens = { ...ir.identity.tokens, space: { ...space, beat: { $value: '0.625rem', $type: 'dimension' } } };
  ir.identity.gridGrammar = { ...ir.identity.gridGrammar, rhythmToken: '{space.beat}' };
  return ir;
}

/**
 * Serves the Gate 2 screen from a registry seeded with that revision, through the product's own route
 * handler and its own rendered previews. Synthesized evidence keeps this UI test browserless on the
 * server side; the measured path the server itself wires is covered by gate2-measured-evidence.spec.ts.
 */
async function serveSeededRun(page: Page): Promise<() => Promise<void>> {
  const dir = await mkdtemp(join(tmpdir(), 'pwb-gate2-seeded-'));
  const database = openDatabase(join(dir, 'gate2.sqlite'));
  const registry = new PrototypeRunRegistry({
    repository: new ProjectRepository(database),
    evidence: new DerivedEvidenceSource(),
    seed: createOffRhythmControlIR,
  });

  await page.route('**/api/prototype/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const readBody = (): Promise<Record<string, unknown>> => Promise.resolve(JSON.parse(request.postData() ?? '{}') as Record<string, unknown>);
    const handled = await handlePrototypeRequest(registry, { method: request.method() } as IncomingMessage, pathname, readBody);
    await route.fulfill({
      status: handled?.status ?? 404,
      contentType: 'application/json; charset=utf-8',
      headers: { 'access-control-allow-origin': new URL(page.url()).origin },
      body: JSON.stringify(handled?.payload ?? { error: 'Not found.' }),
    });
  });

  await page.route('**/preview/**', async (route) => {
    const requested = /^\/preview\/([^/]+)(\/.*)?$/.exec(new URL(route.request().url()).pathname);
    const document = requested ? registry.preview(requested[1]!) : undefined;
    const match = document?.routes.find((candidate) => candidate.route === (requested?.[2] || '/'));
    await route.fulfill(match
      ? { status: 200, contentType: 'text/html; charset=utf-8', body: match.html }
      : { status: 404, contentType: 'text/plain; charset=utf-8', body: 'Preview unavailable' });
  });

  return async () => { database.sqlite.close(); await rm(dir, { recursive: true, force: true }); };
}

test.describe('Gate 2 review screen', () => {
  test.setTimeout(300_000);

  test('compares A with B on the same route and width, and records the captain decision', async ({ page }) => {
    await page.goto('/#/gate-2');
    await expect(page.getByRole('heading', { name: 'Hierarquia, comportamento e caráter' })).toBeVisible();

    await page.getByRole('button', { name: 'Executar a etapa de protótipo' }).click();

    // The start request answers at once with the run id, which the URL keeps while the stage measures.
    await expect(page).toHaveURL(/#\/gate-2\/gate2-\d+$/, { timeout: 30_000 });
    const reviewUrl = page.url();
    const runId = reviewUrl.split('/').pop()!;
    await expect(page.locator('.eyebrow').first()).toContainText(runId);

    const compare = page.locator('.compare');
    // The run measures every declared state at the representative widths in a real browser.
    await expect(compare).toBeVisible({ timeout: 240_000 });

    // A reload finds the same run: the review is addressable, not held in a tab's memory.
    await page.reload();
    expect(page.url()).toBe(reviewUrl);
    await expect(compare).toBeVisible({ timeout: 30_000 });

    // A and B are always both offered, at the same route and the same width.
    const frames = page.locator('.compare iframe');
    await expect(frames).toHaveCount(2);
    for (const attribute of await frames.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('sandbox')))) {
      expect(attribute).toBe('');
    }
    const sources = await frames.evaluateAll((nodes) => nodes.map((node) => (node as HTMLIFrameElement).src));
    const previewOrigins = new Set(sources.map((source) => new URL(source).origin));
    expect(previewOrigins.size).toBe(1);
    expect([...previewOrigins][0]).not.toBe(new URL(page.url()).origin);
    expect(sources.every((source) => new URL(source).pathname.startsWith('/preview/'))).toBe(true);
    expect(sources.every((source) => source.endsWith('/'))).toBe(true);
    await expect(page.frameLocator('.compare .base iframe').locator('main[data-route="/"]')).toBeVisible();
    await expect(page.frameLocator('.compare .top iframe').locator('main[data-route="/"]')).toBeVisible();

    // The same controls drive both sides.
    await page.getByRole('button', { name: '/proof', exact: true }).click();
    await page.getByLabel('Largura').selectOption('390');
    await expect(frames.first()).toHaveAttribute('width', '390');
    await expect(frames.last()).toHaveAttribute('width', '390');
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
    await expect(page.locator('.gate2-critic p').first()).toContainText('Leitura');

    await page.getByPlaceholder('Motivo da decisão do gate').fill('Hierarquia e comportamento aprovados pelo capitão.');
    await page.getByRole('button', { name: 'Aprovar o Gate 2' }).click();
    await expect(page.getByRole('status')).toContainText('Gate aprovado');
  });

  test('annotates every issue with its node, evidence and repair, and records the decision', async ({ page }) => {
    const close = await serveSeededRun(page);
    try {
      await page.goto('/#/gate-2');
      await page.getByRole('button', { name: 'Executar a etapa de protótipo' }).click();
      await expect(page).toHaveURL(/#\/gate-2\/gate2-\d+$/, { timeout: 30_000 });
      await expect(page.locator('.compare')).toBeVisible({ timeout: 60_000 });

      // A repair was applied, so the two sides really are two different revisions.
      const sources = await page.locator('.compare iframe').evaluateAll((nodes) => nodes.map((node) => (node as HTMLIFrameElement).src));
      expect(new Set(sources).size).toBe(2);
      await expect(page.frameLocator('.compare .base iframe').locator('main[data-route="/"]')).toBeVisible();

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
    } finally { await close(); }
  });

  test('keeps the pipeline screen reachable and starts no model work on its own', async ({ page }) => {
    await page.goto('/#/gate-2');
    await expect(page.locator('.compare')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Executar a etapa de protótipo' })).toBeVisible();
    await page.getByRole('link', { name: '← pipeline' }).click();
    await expect(page.getByRole('heading', { name: 'Compilador de identidade' })).toBeVisible();
  });

  test('lists the runs this server holds, so a review whose tab was closed is reachable', async ({ page }) => {
    const close = await serveSeededRun(page);
    try {
      await page.goto('/#/gate-2');
      await page.getByRole('button', { name: 'Executar a etapa de protótipo' }).click();
      await expect(page.locator('.compare')).toBeVisible({ timeout: 60_000 });
      const runId = new URL(page.url()).hash.split('/').pop()!;

      // The captain closes the review and comes back to the entry screen.
      await page.goto('/#/gate-2');
      await expect(page.locator('.gate2-runs')).toBeVisible();
      await page.locator(`.gate2-runs a[href$="${runId}"]`).click();
      await expect(page.locator('.compare')).toBeVisible({ timeout: 30_000 });
    } finally { await close(); }
  });
});
