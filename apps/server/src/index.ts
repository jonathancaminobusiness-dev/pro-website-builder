import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { RenderHub } from '@pwb/render-hub';
import { RenderHubEvidenceSource } from '@pwb/stage-prototype';
import { createApiServer, RunConflictError } from './api.js';
import { openDatabase, ProjectRepository } from './db/repository.js';
import { FixtureRun } from './fixture-run.js';
import { createPreviewServer } from './preview.js';
import { createModelProvider } from './provider.js';
import { PrototypeRunRegistry } from './prototype-api.js';

export async function startServer(options: { dbPath?: string; exportRoot?: string; renderCacheDir?: string; apiPort?: number; previewPort?: number; modelProvider?: string } = {}): Promise<{ api: ReturnType<typeof createApiServer>; preview: ReturnType<typeof createPreviewServer>; close: () => Promise<void> }> {
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
  // The captain approves a measured revision: the gate reads the real RenderHub over the isolated
  // preview origin, so contrast, focus, axe, overflow and stability are observed rather than assumed.
  const prototypes = new PrototypeRunRegistry({
    repository,
    modelProvider: options.modelProvider ?? process.env.PWB_MODEL_PROVIDER ?? 'fake',
    evidence: new RenderHubEvidenceSource({
      hub: new RenderHub({ cacheDir: renderCacheDir }),
      baseUrl: `http://127.0.0.1:${previewPort}`,
      previewPrefix: (versionId) => `/preview/${versionId}`,
    }),
  });
  const api = createApiServer({
    runs,
    prototypes,
    createRun: async (id) => {
      if (runs.has(id) || claimed.has(id)) throw new RunConflictError(id);
      claimed.add(id);
      try {
        const run = new FixtureRun({ repository, exportRoot, provider });
        await run.initialize(id);
        runs.set(id, run);
        return run;
      } finally { claimed.delete(id); }
    },
    loadRun: async (id) => {
      const existing = runs.get(id);
      if (existing) return existing;
      const run = new FixtureRun({ repository, exportRoot, provider });
      if (!await run.restore(id)) return undefined;
      runs.set(id, run);
      return run;
    },
  });
  const preview = createPreviewServer((versionId) => {
    for (const run of runs.values()) { const snapshot = run.snapshot(); if (snapshot.currentVersion.id === versionId) return snapshot.rendered; }
    return prototypes.preview(versionId);
  }, previewPort);
  const apiPort = options.apiPort ?? Number(process.env.PWB_PORT ?? 4310);
  await new Promise<void>((resolve) => api.listen(apiPort, '127.0.0.1', resolve));
  await preview.start();
  return { api, preview, close: async () => { await preview.close(); await new Promise<void>((resolve, reject) => api.close((error) => error ? reject(error) : resolve())); database.sqlite.close(); } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().then(() => { console.log('pro-website-builder server listening on http://127.0.0.1:4310; preview on http://127.0.0.1:4311'); }).catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Server failed.'); process.exitCode = 1; });
}
