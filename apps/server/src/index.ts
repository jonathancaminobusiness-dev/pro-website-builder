import { mkdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { RenderHub } from '@pwb/render-hub';
import { renderDesign } from '@pwb/renderer';
import { RenderHubEvidenceSource } from '@pwb/stage-prototype';
import type { IdentityStageDeadlines } from '@pwb/stage-identity';
import { createApiServer, RunConflictError } from './api.js';
import { openDatabase, ProjectRepository } from './db/repository.js';
import { FixtureRun } from './fixture-run.js';
import { IdentityRun } from './identity-run.js';
import { createPreviewServer } from './preview.js';
import { createIdentityProvider, createModelProvider, createRasterProvider, modelAlias, modelProviderName } from './provider.js';
import { PrototypeRunRegistry } from './prototype-api.js';
import { identityDeadlinesFromEnvironment, identityProviderTimeoutMs } from './identity-deadlines.js';

export async function startServer(options: { dbPath?: string; renderCacheDir?: string; releaseRoot?: string; evidenceDir?: string; fontsDir?: string; apiPort?: number; previewPort?: number; modelProvider?: string; identityDeadlines?: Partial<IdentityStageDeadlines> } = {}): Promise<{ api: ReturnType<typeof createApiServer>; preview: ReturnType<typeof createPreviewServer>; close: () => Promise<void> }> {
  const root = process.cwd();
  const dbPath = options.dbPath ?? process.env.PWB_DB_PATH ?? join(root, '.treehouse', 'pro-website-builder.sqlite');
  const renderCacheDir = options.renderCacheDir ?? process.env.PWB_RENDER_CACHE ?? join(root, '.treehouse', 'render-cache');
  await mkdir(join(dbPath, '..'), { recursive: true });
  await mkdir(renderCacheDir, { recursive: true });
  // Recognised once, at startup: every consumer below is handed the resolved
  // name rather than a raw string it would have to compare for itself.
  const providerName = modelProviderName(options.modelProvider ?? process.env.PWB_MODEL_PROVIDER);
  const provider = createModelProvider(providerName);
  const identityDeadlines = options.identityDeadlines ?? identityDeadlinesFromEnvironment();
  const identityProvider = createIdentityProvider(providerName, { timeoutMs: identityProviderTimeoutMs(identityDeadlines) });
  const raster = createRasterProvider();
  const database = openDatabase(dbPath);
  const repository = new ProjectRepository(database);
  const runs = new Map<string, FixtureRun>();
  const identityRuns = new Map<string, IdentityRun>();
  const claimed = new Set<string>();
  const fontsDir = options.fontsDir ?? process.env.PWB_FONTS_DIR ?? join(root, 'fonts');
  const identityClaimed = new Set<string>();
  // One run object per id, even when two cold requests arrive together: a
  // second instance would decide Gate 1 from a ledger the first has already
  // moved on from.
  const identityLoading = new Map<string, Promise<IdentityRun | undefined>>();
  const alias = modelAlias(providerName);
  const newIdentityRun = (id: string, briefing?: string): IdentityRun => new IdentityRun({ runId: id, repository, provider: identityProvider, raster, renderCacheDir, modelAlias: alias, ...(briefing !== undefined ? { briefing } : {}), ...(identityDeadlines ? { deadlines: identityDeadlines } : {}) });
  const previewPort = options.previewPort ?? Number(process.env.PWB_PREVIEW_PORT ?? 4311);
  let prototypes: PrototypeRunRegistry | undefined;
  const preview = createPreviewServer((versionId) => {
    for (const run of runs.values()) { const snapshot = run.snapshot(); if (snapshot.currentVersion.id === versionId) return renderDesign(snapshot.currentVersion.ir, { routePrefix: `/preview/${versionId}` }); }
    for (const run of identityRuns.values()) { const rendered = run.renderedFor(versionId); if (rendered) return rendered; }
    return prototypes?.preview(versionId);
    // The preview reads the faces itself and memoises them against the manifest,
    // so a face added or replaced while the studio runs still reaches the captain.
  }, previewPort, fontsDir);
  // The preview listens before the gate is wired, because a caller that asks for port 0 — as the
  // convention for parallel checkouts requires — only learns the origin the browser must visit here.
  await preview.start();
  // The captain approves a measured revision: the gate reads the real RenderHub over the isolated
  // preview origin, so contrast, focus, axe, overflow and stability are observed rather than assumed.
  const registry = new PrototypeRunRegistry({
    repository,
    modelProvider: providerName,
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
  // Gate 3 compares the faces the captain was actually served against the ones
  // the bundle ships, so the preview is read when a release is prepared.
  const release = {
    releaseRoot, evidenceDir, fontsDir, siteUrl, siteName,
    previewFaces: () => preview.servedFaces(),
  };
  const api = createApiServer({
    runs,
    prototypes: registry,
    createRun: async (id) => {
      if (runs.has(id) || claimed.has(id)) throw new RunConflictError(id);
      claimed.add(id);
      try {
        const run = new FixtureRun({ repository, provider, release, modelProvider: providerName });
        await run.initialize(id);
        runs.set(id, run);
        return run;
      } finally { claimed.delete(id); }
    },
    loadRun: async (id) => {
      const existing = runs.get(id);
      if (existing) return existing;
      const run = new FixtureRun({ repository, provider, release, modelProvider: providerName });
      if (!await run.restore(id)) return undefined;
      runs.set(id, run);
      return run;
    },
    identity: {
      runs: identityRuns,
      createRun: async (id, briefing) => {
        if (identityRuns.has(id) || identityClaimed.has(id)) throw new RunConflictError(id);
        identityClaimed.add(id);
        try {
          const run = newIdentityRun(id, briefing);
          await run.initialize();
          identityRuns.set(id, run);
          return run;
        } finally { identityClaimed.delete(id); }
      },
      loadRun: async (id) => {
        const existing = identityRuns.get(id);
        if (existing) return existing;
        const inFlight = identityLoading.get(id);
        if (inFlight) return inFlight;
        const loading = (async () => {
          const run = newIdentityRun(id);
          if (!await run.restore()) return undefined;
          identityRuns.set(id, run);
          return run;
        })();
        identityLoading.set(id, loading);
        try { return await loading; } finally { identityLoading.delete(id); }
      },
    },
  });
  const apiPort = options.apiPort ?? Number(process.env.PWB_PORT ?? 4310);
  await new Promise<void>((resolve) => api.listen(apiPort, '127.0.0.1', resolve));
  return { api, preview, close: async () => { await preview.close(); await new Promise<void>((resolve, reject) => api.close((error) => error ? reject(error) : resolve())); database.sqlite.close(); } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().then(({ api, preview }) => { const { port } = api.address() as AddressInfo; console.log(`pro-website-builder server listening on http://127.0.0.1:${port}; preview on ${preview.origin}`); }).catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Server failed.'); process.exitCode = 1; });
}
