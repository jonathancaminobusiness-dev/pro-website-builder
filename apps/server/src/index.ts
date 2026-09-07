import { mkdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { RenderHub } from '@pwb/render-hub';
import { renderDesign } from '@pwb/renderer';
import { RenderHubEvidenceSource } from '@pwb/stage-prototype';
import { createApiServer, RunConflictError } from './api.js';
import { openDatabase, ProjectRepository } from './db/repository.js';
import { FixtureRun } from './fixture-run.js';
import { createPreviewServer } from './preview.js';
import { createModelProvider } from './provider.js';
import { PrototypeRunRegistry } from './prototype-api.js';

export async function startServer(options: { dbPath?: string; exportRoot?: string; renderCacheDir?: string; releaseRoot?: string; evidenceDir?: string; fontsDir?: string; apiPort?: number; previewPort?: number; modelProvider?: string } = {}): Promise<{ api: ReturnType<typeof createApiServer>; preview: ReturnType<typeof createPreviewServer>; close: () => Promise<void> }> {
  const root = process.cwd();
  const dbPath = options.dbPath ?? process.env.PWB_DB_PATH ?? join(root, '.treehouse', 'pro-website-builder.sqlite');
  const exportRoot = options.exportRoot ?? process.env.PWB_EXPORT_ROOT ?? join(root, 'exports');
  const renderCacheDir = options.renderCacheDir ?? process.env.PWB_RENDER_CACHE ?? join(root, '.treehouse', 'render-cache');
  await mkdir(join(dbPath, '..'), { recursive: true });
  await mkdir(exportRoot, { recursive: true });
  await mkdir(renderCacheDir, { recursive: true });
  const provider = createModelProvider(options.modelProvider ?? process.env.PWB_MODEL_PROVIDER);
  const database = openDatabase(dbPath);
  const repository = new ProjectRepository(database);
  const runs = new Map<string, FixtureRun>();
  const claimed = new Set<string>();
  const previewPort = options.previewPort ?? Number(process.env.PWB_PREVIEW_PORT ?? 4311);
  let prototypes: PrototypeRunRegistry | undefined;
  const preview = createPreviewServer((versionId) => {
    for (const run of runs.values()) { const snapshot = run.snapshot(); if (snapshot.currentVersion.id === versionId) return renderDesign(snapshot.currentVersion.ir, { routePrefix: `/preview/${versionId}` }); }
    return prototypes?.preview(versionId);
  }, previewPort);
  // The preview listens before the gate is wired, because a caller that asks for port 0 — as the
  // convention for parallel checkouts requires — only learns the origin the browser must visit here.
  await preview.start();
  // The captain approves a measured revision: the gate reads the real RenderHub over the isolated
  // preview origin, so contrast, focus, axe, overflow and stability are observed rather than assumed.
  const registry = new PrototypeRunRegistry({
    repository,
    modelProvider: options.modelProvider ?? process.env.PWB_MODEL_PROVIDER ?? 'fake',
    evidence: new RenderHubEvidenceSource({
      hub: new RenderHub({ cacheDir: renderCacheDir }),
      baseUrl: preview.origin,
      previewPrefix: (versionId) => `/preview/${versionId}`,
    }),
  });
  prototypes = registry;
  // A review the captain already paid minutes of browser time for survives a restart.
  await registry.restore();
  const siteUrl = process.env.PWB_SITE_URL ?? 'https://site.invalid';
  const siteName = process.env.PWB_SITE_NAME ?? 'pro-website-builder';
  const releaseRoot = options.releaseRoot ?? process.env.PWB_RELEASE_ROOT ?? join(root, 'releases');
  const evidenceDir = options.evidenceDir ?? process.env.PWB_EVIDENCE_DIR ?? join(root, 'artifacts', 'release');
  await mkdir(releaseRoot, { recursive: true });
  const fontsDir = options.fontsDir ?? process.env.PWB_FONTS_DIR ?? join(root, 'fonts');
  const release = { releaseRoot, evidenceDir, fontsDir, siteUrl, siteName, modelProvider: options.modelProvider ?? process.env.PWB_MODEL_PROVIDER ?? 'fake' };
  const api = createApiServer({
    runs,
    prototypes: registry,
    createRun: async (id) => {
      if (runs.has(id) || claimed.has(id)) throw new RunConflictError(id);
      claimed.add(id);
      try {
        const run = new FixtureRun({ repository, provider, release });
        await run.initialize(id);
        runs.set(id, run);
        return run;
      } finally { claimed.delete(id); }
    },
    loadRun: async (id) => {
      const existing = runs.get(id);
      if (existing) return existing;
      const run = new FixtureRun({ repository, provider, release });
      if (!await run.restore(id)) return undefined;
      runs.set(id, run);
      return run;
    },
  });
  const apiPort = options.apiPort ?? Number(process.env.PWB_PORT ?? 4310);
  await new Promise<void>((resolve) => api.listen(apiPort, '127.0.0.1', resolve));
  return { api, preview, close: async () => { await preview.close(); await new Promise<void>((resolve, reject) => api.close((error) => error ? reject(error) : resolve())); database.sqlite.close(); } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().then(({ api, preview }) => { const { port } = api.address() as AddressInfo; console.log(`pro-website-builder server listening on http://127.0.0.1:${port}; preview on ${preview.origin}`); }).catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Server failed.'); process.exitCode = 1; });
}
