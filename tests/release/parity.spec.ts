import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { artifactHash, writeEvidenceArtifact } from '../../packages/stage-finalization/src/index.js';
import type { EvidenceArtifact } from '../../packages/domain/src/index.js';

/**
 * Preview/release parity in a real browser.
 *
 * The Vitest fixtures prove the two documents describe the same styles; this
 * proves the engine resolves them the same way, on Chromium, Firefox and WebKit.
 *
 * Every difference is collected rather than thrown, so the run always writes its
 * typed artifact: a divergence the browser sees has to reach Gate 3 as a failed
 * measurement, not only as a red test nothing on disk records.
 */
const PROPERTIES = ['color', 'background-color', 'font-family', 'padding', 'border-radius', 'gap', 'display'] as const;
const EVIDENCE_DIR = process.env.PWB_EVIDENCE_DIR ?? join(process.cwd(), 'artifacts', 'release');

interface Harness {
  routes: Array<{ route: string; releasePath: string; previewPath: string }>;
  /** The faces the release self-hosts; the preview must load exactly these too. */
  fonts: Array<{ family: string; weight: string; style: string }>;
}

/** The harness publishes its ephemeral origin and the release it serves here; see tests/release/global-setup.ts. */
function fromEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is unset; the release harness did not start.`);
  return value;
}

function origin(): string { return fromEnvironment('PWB_RELEASE_ORIGIN'); }

/**
 * What this run has measured so far.
 *
 * The artifact is written from the teardown rather than the test body, because
 * the run that most needs to leave a trace is the one that never finishes: a
 * page that never loads takes the body down with the per-test timeout, and Gate
 * 3 reads artifacts and nothing else. A comparison that never started is a
 * different thing — an engine that could not launch on this host measured
 * nothing, which the gate reports as a missing engine for the captain to accept,
 * not as a release that diverges — so it leaves no artifact at all.
 */
const measured: { started: boolean; routes: number; faces: number; differences: string[]; completed: boolean } = { started: false, routes: 0, faces: 0, differences: [], completed: false };

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

function styleDifferences(route: string, preview: Record<string, Record<string, string>>, release: Record<string, Record<string, string>>): string[] {
  const differences: string[] = [];
  for (const id of [...new Set([...Object.keys(preview), ...Object.keys(release)])].sort()) {
    const before = preview[id];
    const after = release[id];
    if (!before) { differences.push(`${route}: o nó ${id} existe no release e não no preview.`); continue; }
    if (!after) { differences.push(`${route}: o nó ${id} existe no preview e não no release.`); continue; }
    for (const property of PROPERTIES) {
      if (before[property] !== after[property]) differences.push(`${route}: o nó ${id} resolve ${property} como ${before[property]} no preview e ${after[property]} no release.`);
    }
  }
  return differences;
}

test.afterEach(async ({}, testInfo) => {
  if (!measured.started) return;
  const engine = testInfo.project.name as EvidenceArtifact['engine'];
  const reason = (testInfo.error?.message ?? 'a execução foi interrompida antes de comparar todas as rotas').replaceAll(/\u001b\[\d+m/g, '');
  const differences = measured.completed
    ? measured.differences
    : [...measured.differences, `A comparação entre preview e release não chegou ao fim no ${engine} (${testInfo.status ?? 'interrompida'}): ${reason}`];
  await writeEvidenceArtifact(EVIDENCE_DIR, {
    id: `parity-${engine}`,
    runner: 'playwright',
    engine,
    releaseDigest: fromEnvironment('PWB_RELEASE_DIGEST'),
    irHash: fromEnvironment('PWB_RELEASE_IR_HASH'),
    route: '/',
    state: 'preview-parity',
    status: differences.length === 0 ? 'passed' : 'failed',
    path: 'tests/release/parity.spec.ts',
    hash: artifactHash(differences),
    metrics: { routes: measured.routes, faces: measured.faces, differences: differences.length },
    notes: differences.length === 0
      ? [`O release resolveu os mesmos estilos, o mesmo texto e as mesmas ${measured.faces} face(s) que o preview em ${measured.routes} rota(s) no ${engine}.`]
      : [`Preview e release divergem em ${differences.length} ponto(s) no ${engine}.`, ...differences.slice(0, 20)],
  });
});

test('the release resolves the same styles, text and faces as the preview the captain reviewed', async ({ page }) => {
  measured.started = true;
  try {
    const response = await page.request.get(`${origin()}/harness.json`);
    if (!response.ok()) throw new Error(`O harness respondeu ${response.status()} em /harness.json.`);
    const harness = await response.json() as Harness;
    measured.routes = harness.routes.length;
    measured.faces = harness.fonts.length;
    for (const route of harness.routes) {
      const preview = await computedByNode(page, route.previewPath);
      const previewText = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim());
      const previewFaces = await loadedFaces(page, harness.fonts);
      const release = await computedByNode(page, route.releasePath);
      const releaseText = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim());
      const releaseFaces = await loadedFaces(page, harness.fonts);

      measured.differences.push(...styleDifferences(route.route, preview, release));
      if (previewText !== releaseText) measured.differences.push(`${route.route}: o texto difere entre preview e release.`);
      // The same computed font-family stack proves nothing if one side has no
      // face to resolve it to, so both sides are asked what they actually loaded.
      if (JSON.stringify(previewFaces.declared) !== JSON.stringify(releaseFaces.declared)) {
        measured.differences.push(`${route.route}: as faces declaradas divergem: preview ${JSON.stringify(previewFaces.declared)}, release ${JSON.stringify(releaseFaces.declared)}.`);
      }
      for (const face of Object.keys(releaseFaces.usable)) {
        if (!previewFaces.usable[face]) measured.differences.push(`${route.route}: o preview não conseguiu carregar a face ${face}.`);
        if (!releaseFaces.usable[face]) measured.differences.push(`${route.route}: o release não conseguiu carregar a face ${face}.`);
      }
    }
  } catch (error) {
    measured.differences.push(`A comparação não pôde ser concluída: ${error instanceof Error ? error.message : 'erro desconhecido'}`);
  }
  measured.completed = true;

  expect(measured.differences, 'o release tem de resolver o mesmo que o preview em cada rota').toEqual([]);
});
