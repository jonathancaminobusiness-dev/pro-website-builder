import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { openDatabase, ProjectRepository } from '../apps/server/src/db/repository.js';
import { FixtureRun, type FixtureSnapshot } from '../apps/server/src/fixture-run.js';
import { createPreviewServer } from '../apps/server/src/preview.js';
import { createModelProvider } from '../apps/server/src/provider.js';
import { createRenderCases, RenderHub } from '../packages/render-hub/src/index.js';

const root = process.cwd();
const databasePath = process.env.PWB_DB_PATH ?? join(root, '.treehouse', 'cli-fixture.sqlite');
const exportRoot = process.env.PWB_EXPORT_ROOT ?? join(root, 'exports');
const renderCacheDir = process.env.PWB_RENDER_CACHE ?? join(root, '.treehouse', 'render-cache');
const previewPort = Number(process.env.PWB_PREVIEW_PORT ?? 4311);

async function renderMatrix(snapshot: FixtureSnapshot): Promise<unknown> {
  const versionId = snapshot.currentVersion.id;
  const preview = createPreviewServer((requested) => requested === versionId ? snapshot.rendered : undefined, previewPort);
  await preview.start();
  try {
    const cases = createRenderCases(snapshot.currentVersion.ir, `/preview/${versionId}`);
    const results = await new RenderHub({ cacheDir: renderCacheDir }).render(snapshot.rendered, preview.origin, cases);
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
  await mkdir(exportRoot, { recursive: true });
  const database = openDatabase(databasePath);
  try {
    const run = new FixtureRun({ repository: new ProjectRepository(database), exportRoot, provider: createModelProvider(process.env.PWB_MODEL_PROVIDER) });
    await run.initialize('cli-fixture');
    const snapshot = await run.runAll();
    const render = process.argv.includes('--render') ? await renderMatrix(snapshot) : undefined;
    console.log(JSON.stringify({ runId: snapshot.runId, status: snapshot.status, versionId: snapshot.currentVersion.id, exportDirectory: snapshot.exportManifest?.directory, routes: snapshot.exportManifest?.routes, ...(render ? { render } : {}) }, null, 2));
    if (snapshot.status !== 'succeeded') process.exitCode = 1;
  } finally { database.sqlite.close(); }
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Fixture run failed.'); process.exitCode = 1; });
