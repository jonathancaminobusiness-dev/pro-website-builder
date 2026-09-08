import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { openDatabase, ProjectRepository } from '../apps/server/src/db/repository.js';
import { FixtureRun, type FixtureSnapshot } from '../apps/server/src/fixture-run.js';
import { createPreviewServer } from '../apps/server/src/preview.js';
import { createModelProvider } from '../apps/server/src/provider.js';
import { createRenderMatrix, qaFor, RENDER_VIEWPORTS, REPRESENTATIVE_VIEWPORTS, RenderHub, type RenderCase } from '../packages/render-hub/src/index.js';
import { renderDesign } from '../packages/renderer/src/index.js';

interface RenderMatrixSummary { cases: number; passed: number; cached: number; failed: (RenderCase & { status: number | null; overflow: boolean; consoleErrors: string[]; networkErrors: string[] })[]; }

const root = process.cwd();
const databasePath = process.env.PWB_DB_PATH ?? join(root, '.treehouse', 'cli-fixture.sqlite');
const releaseRoot = process.env.PWB_RELEASE_ROOT ?? join(root, 'releases');
const evidenceDir = process.env.PWB_EVIDENCE_DIR ?? join(root, 'artifacts', 'release');
const fontsDir = process.env.PWB_FONTS_DIR ?? join(root, 'fonts');
const renderCacheDir = process.env.PWB_RENDER_CACHE ?? join(root, '.treehouse', 'render-cache');

async function renderMatrix(snapshot: FixtureSnapshot): Promise<RenderMatrixSummary> {
  const versionId = snapshot.currentVersion.id;
  const reviewed = renderDesign(snapshot.currentVersion.ir, { routePrefix: `/preview/${versionId}` });
  // Port 0 keeps this CLI off the developer ports, so it runs beside the dev server and other checkouts.
  const preview = createPreviewServer((requested) => requested === versionId ? reviewed : undefined, 0, fontsDir);
  await preview.start();
  try {
    // `createRenderMatrix` owns the matrix; this CLI only chooses how wide a sweep to pay for and
    // addresses each case through the prefix the reviewed document was rendered for.
    const viewports = process.argv.includes('--full-matrix') ? RENDER_VIEWPORTS : REPRESENTATIVE_VIEWPORTS;
    const cases = createRenderMatrix(snapshot.currentVersion.ir, { viewports });
    // `capture` is the only entry point that resolves a case's state against the document, so every
    // enumerated state is really applied instead of being counted as coverage it never had.
    const captures = await new RenderHub({ cacheDir: renderCacheDir }).capture({
      ir: snapshot.currentVersion.ir, rendered: reviewed, baseUrl: preview.origin, previewPrefix: `/preview/${versionId}`, cases,
    });
    const results = captures.map((capture) => ({ renderCase: capture.renderCase, cached: capture.cached, qa: qaFor(capture) }));
    return {
      cases: results.length,
      passed: results.filter((result) => result.qa.passed).length,
      cached: results.filter((result) => result.cached).length,
      failed: results.filter((result) => !result.qa.passed).map((result) => ({ ...result.renderCase, status: result.qa.status, overflow: result.qa.overflow, consoleErrors: result.qa.consoleErrors, networkErrors: result.qa.networkErrors })),
    };
  } finally { await preview.close(); }
}

async function main(): Promise<void> {
  await mkdir(join(databasePath, '..'), { recursive: true });
  await mkdir(releaseRoot, { recursive: true });
  const database = openDatabase(databasePath);
  try {
    const run = new FixtureRun({
      repository: new ProjectRepository(database),
      provider: createModelProvider(process.env.PWB_MODEL_PROVIDER),
      release: { releaseRoot, evidenceDir, fontsDir, ...(process.env.PWB_MODEL_PROVIDER ? { modelProvider: process.env.PWB_MODEL_PROVIDER } : {}) },
    });
    await run.initialize('cli-fixture');
    let snapshot = await run.runAll();
    const report = run.releaseSnapshot()?.report;
    // A script never signs for the captain. It prints what Gate 3 found and
    // publishes only a release that left nothing for a human to accept.
    const open = report ? report.escalations : ['A etapa de finalização não chegou ao Gate 3.'];
    const publishable = report !== undefined && !report.blocked && open.length === 0;
    if (publishable) {
      await run.publishRelease(run.releaseSnapshot()!.digest, 'Publicado por scripts/run-fixture.ts, sem decisão humana: o Gate 3 não deixou nada a aceitar.', 'fixture');
      snapshot = run.snapshot();
    }
    const render = process.argv.includes('--render') ? await renderMatrix(snapshot) : undefined;
    console.log(JSON.stringify({
      runId: snapshot.runId,
      status: snapshot.status,
      versionId: snapshot.currentVersion.id,
      gate: report ? { digest: report.bundleDigest, blocked: report.blocked, vetoes: report.vetoes, escalations: report.escalations, rubric: report.rubric } : undefined,
      releaseDirectory: snapshot.exportManifest ? join(releaseRoot, snapshot.exportManifest.digest) : undefined,
      routes: snapshot.exportManifest?.routes.map((route) => route.route),
      ...(render ? { render } : {}),
    }, null, 2));
    if (!publishable || (render && render.failed.length > 0)) process.exitCode = 1;
  } finally { database.sqlite.close(); }
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Fixture run failed.'); process.exitCode = 1; });
