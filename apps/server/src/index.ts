import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createApiServer } from './api.js';
import { openDatabase, ProjectRepository } from './db/repository.js';
import { FixtureRun } from './fixture-run.js';
import { createPreviewServer } from './preview.js';
import { createModelProvider } from './provider.js';

export async function startServer(options: { dbPath?: string; exportRoot?: string; apiPort?: number; previewPort?: number; modelProvider?: string } = {}): Promise<{ api: ReturnType<typeof createApiServer>; preview: ReturnType<typeof createPreviewServer>; close: () => Promise<void> }> {
  const root = process.cwd();
  const dbPath = options.dbPath ?? process.env.PWB_DB_PATH ?? join(root, '.treehouse', 'pro-website-builder.sqlite');
  const exportRoot = options.exportRoot ?? process.env.PWB_EXPORT_ROOT ?? join(root, 'exports');
  await mkdir(join(dbPath, '..'), { recursive: true });
  await mkdir(exportRoot, { recursive: true });
  const provider = createModelProvider(options.modelProvider ?? process.env.PWB_MODEL_PROVIDER);
  const database = openDatabase(dbPath);
  const repository = new ProjectRepository(database);
  const runs = new Map<string, FixtureRun>();
  const api = createApiServer({ runs, createRun: async (id) => { const run = new FixtureRun({ repository, exportRoot, provider }); await run.initialize(id); runs.set(id, run); return run; } });
  const preview = createPreviewServer(() => [...runs.values()][0]?.snapshot().rendered, options.previewPort ?? Number(process.env.PWB_PREVIEW_PORT ?? 4311));
  const apiPort = options.apiPort ?? Number(process.env.PWB_PORT ?? 4310);
  await new Promise<void>((resolve) => api.listen(apiPort, '127.0.0.1', resolve));
  await preview.start();
  return { api, preview, close: async () => { await preview.close(); await new Promise<void>((resolve, reject) => api.close((error) => error ? reject(error) : resolve())); database.sqlite.close(); } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().then(() => { console.log('pro-website-builder server listening on http://127.0.0.1:4310; preview on http://127.0.0.1:4311'); }).catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Server failed.'); process.exitCode = 1; });
}
