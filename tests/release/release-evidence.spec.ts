import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { writeEvidenceArtifact, artifactHash } from '../../packages/stage-finalization/src/index.js';
import type { EvidenceArtifact } from '../../packages/domain/src/index.js';

const EVIDENCE_DIR = process.env.PWB_EVIDENCE_DIR ?? join(process.cwd(), 'artifacts', 'release');
const WIDTHS = [360, 768, 1440] as const;

/** The harness publishes its ephemeral origin and the release it serves here; see tests/release/global-setup.ts. */
function fromEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is unset; the release harness did not start.`);
  return value;
}

function origin(): string { return fromEnvironment('PWB_RELEASE_ORIGIN'); }

/**
 * What the running measurement still owes.
 *
 * Gate 3 reads artifacts and nothing else, so each scope leaves one artifact
 * under a stable id, written whether it finished or not: the per-route artifacts
 * alone would read as full coverage of routes and widths no browser ever
 * finished measuring, and a record only an aborted run writes would outlive the
 * run it describes and veto every clean one after it. A body that never started
 * leaves nothing, because an engine that could not launch on this host is a
 * missing engine the captain accepts in writing, not a failed measurement.
 */
const progress: { started: boolean; completed: boolean; scope: string; planned: number; pending: string[] } = { started: false, completed: false, scope: 'render', planned: 0, pending: [] };

function begin(scope: string): void { progress.started = true; progress.completed = false; progress.scope = scope; progress.planned = 0; progress.pending = []; }

function plan(entries: string[]): void { progress.planned = entries.length; progress.pending = entries; }

interface Harness { digest: string; irHash: string; routes: Array<{ route: string; title: string; releasePath: string; previewPath: string }> }

async function harness(page: Page): Promise<Harness> {
  const response = await page.request.get(`${origin()}/harness.json`);
  expect(response.ok(), 'the release harness must be serving the compiled bundle').toBe(true);
  return response.json() as Promise<Harness>;
}

/** Watches for the failures a static release must never have, in every engine. */
function watch(page: Page): { consoleErrors: string[]; requestFailures: string[] } {
  const consoleErrors: string[] = [];
  const requestFailures: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  page.on('requestfailed', (request) => requestFailures.push(`${request.url()}: ${request.failure()?.errorText ?? 'failed'}`));
  return { consoleErrors, requestFailures };
}

test.describe('release evidence', () => {
  test.afterEach(async ({}, testInfo) => {
    if (!progress.started) return;
    progress.started = false;
    const engine = testInfo.project.name as EvidenceArtifact['engine'];
    const covered = progress.completed && progress.pending.length === 0;
    const reason = (testInfo.error?.message ?? 'a execução foi interrompida antes de medir tudo').replaceAll(/\u001b\[\d+m/g, '');
    await writeEvidenceArtifact(EVIDENCE_DIR, {
      id: `playwright-${engine}-${progress.scope}-coverage`,
      runner: 'playwright', engine,
      releaseDigest: fromEnvironment('PWB_RELEASE_DIGEST'), irHash: fromEnvironment('PWB_RELEASE_IR_HASH'),
      route: '/', state: `${progress.scope}-coverage`,
      status: covered ? 'passed' : 'failed',
      path: 'tests/release/release-evidence.spec.ts',
      hash: artifactHash(progress.pending),
      metrics: { planned: progress.planned, pending: progress.pending.length },
      notes: covered
        ? [`A medição ${progress.scope} cobriu as ${progress.planned} combinação(ões) que este release pede no ${engine}.`]
        : [
          `A medição ${progress.scope} não chegou ao fim no ${engine} (${testInfo.status ?? 'interrompida'}): ${reason}`,
          ...(progress.pending.length > 0 ? [`Sem medição: ${progress.pending.join(', ')}`] : []),
        ],
    });
  });

  test('renders every route at every width with no console error, no failed request and no horizontal overflow', async ({ page }, testInfo) => {
    begin('render');
    const { routes, digest, irHash } = await harness(page);
    const engine = testInfo.project.name as EvidenceArtifact['engine'];
    plan(routes.flatMap((route) => WIDTHS.map((width) => `${route.route} @${width}px`)));
    for (const route of routes) {
      for (const width of WIDTHS) {
        const observed = watch(page);
        await page.setViewportSize({ width, height: 900 });
        const response = await page.goto(`${origin()}${route.releasePath}`, { waitUntil: 'load' });
        expect(response?.status(), `${route.route} must be served`).toBe(200);
        // The faces are awaited through the promise the platform settles when it
        // finishes loading them. Polling `document.fonts.status` instead runs the
        // predicate in `requestAnimationFrame`, and an engine that stops painting
        // after a viewport change never calls it back: the wait has no timeout of
        // its own, so it takes the whole measurement down with the test timeout.
        await page.evaluate(async () => { await document.fonts.ready; });
        const metrics = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
          title: document.title,
          hasStyleAttribute: document.querySelectorAll('[style]').length,
          styleElements: document.querySelectorAll('style').length,
          nodes: document.querySelectorAll('[data-node-id]').length,
        }));
        const overflow = metrics.scrollWidth > metrics.clientWidth;
        const notes = [
          ...observed.consoleErrors.map((error) => `console: ${error}`),
          ...observed.requestFailures.map((failure) => `request: ${failure}`),
          ...(overflow ? [`overflow: scrollWidth ${metrics.scrollWidth} exceeds clientWidth ${metrics.clientWidth}`] : []),
        ];
        await writeEvidenceArtifact(EVIDENCE_DIR, {
          id: `playwright-${engine}-${route.route === '/' ? 'home' : route.route.slice(1)}-${width}`,
          runner: 'playwright', engine, releaseDigest: digest, irHash, route: route.route, state: `width-${width}`,
          status: notes.length === 0 ? 'passed' : 'failed',
          path: route.releasePath,
          hash: artifactHash({ metrics, notes }),
          metrics: { scrollWidth: metrics.scrollWidth, clientWidth: metrics.clientWidth, nodes: metrics.nodes }, notes,
        });
        progress.pending = progress.pending.filter((entry) => entry !== `${route.route} @${width}px`);
        expect(observed.consoleErrors, `${route.route} at ${width}px must log no console error`).toEqual([]);
        expect(observed.requestFailures, `${route.route} at ${width}px must have no failed request`).toEqual([]);
        expect(overflow, `${route.route} at ${width}px must not scroll horizontally`).toBe(false);
        // The compiler moved every style into the stylesheet so the policy can forbid inline styles.
        expect(metrics.hasStyleAttribute, 'the release must ship no inline style attribute').toBe(0);
        expect(metrics.styleElements, 'the release must ship no inline stylesheet').toBe(0);
        expect(metrics.nodes).toBeGreaterThan(0);
      }
    }
    progress.completed = true;
  });

  test('scans every critical state with axe and records what it found', async ({ page }, testInfo) => {
    begin('axe');
    const { routes, digest, irHash } = await harness(page);
    const engine = testInfo.project.name as EvidenceArtifact['engine'];
    const states = [{ name: 'default', width: 1440, reducedMotion: 'no-preference' as const }, { name: 'reduced-motion', width: 1440, reducedMotion: 'reduce' as const }, { name: 'narrow', width: 360, reducedMotion: 'no-preference' as const }];
    plan(routes.flatMap((route) => states.map((state) => `${route.route} (${state.name})`)));
    for (const route of routes) {
      for (const state of states) {
        await page.emulateMedia({ reducedMotion: state.reducedMotion });
        await page.setViewportSize({ width: state.width, height: 900 });
        await page.goto(`${origin()}${route.releasePath}`, { waitUntil: 'load' });
        const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
        const counts = { critical: 0, serious: 0, moderate: 0, minor: 0, incomplete: results.incomplete.length };
        for (const violation of results.violations) {
          const impact = (violation.impact ?? 'minor') as keyof typeof counts;
          counts[impact] = (counts[impact] ?? 0) + 1;
        }
        await writeEvidenceArtifact(EVIDENCE_DIR, {
          id: `axe-${engine}-${route.route === '/' ? 'home' : route.route.slice(1)}-${state.name}`,
          runner: 'axe', engine, releaseDigest: digest, irHash, route: route.route, state: state.name,
          status: counts.critical + counts.serious > 0 ? 'failed' : 'passed',
          path: route.releasePath,
          hash: artifactHash(results.violations.map((violation) => [violation.id, violation.impact, violation.nodes.length])),
          metrics: counts,
          // axe finds part of what WCAG requires and returns `incomplete` where a
          // human must look: the artifact says so instead of implying a clean bill.
          notes: [
            ...results.violations.map((violation) => `${violation.impact ?? 'minor'} ${violation.id}: ${violation.nodes.length} node(s) — ${violation.help}`),
            `axe returned ${results.incomplete.length} incomplete check(s) that need a human review.`,
          ],
        });
        progress.pending = progress.pending.filter((entry) => entry !== `${route.route} (${state.name})`);
      }
    }
    progress.completed = true;
  });
});
