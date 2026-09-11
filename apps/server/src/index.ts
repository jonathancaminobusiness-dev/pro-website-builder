import { mkdir } from 'node:fs/promises';
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
import { createIdentityProvider, createModelProvider, createRasterProvider } from './provider.js';
import { PrototypeRunRegistry } from './prototype-api.js';
import { identityDeadlinesFromEnvironment, identityProviderTimeoutMs } from './identity-deadlines.js';

export async function startServer(options: { dbPath?: string; renderCacheDir?: string; releaseRoot?: string; evidenceDir?: string; fontsDir?: string; apiPort?: number; previewPort?: number; modelProvider?: string; identityDeadlines?: Partial<IdentityStageDeadlines> } = {}): Promise<{ api: ReturnType<typeof createApiServer>; preview: ReturnType<typeof createPreviewServer>; close: () => Promise<void> }> {
  const root = process.cwd();
  const dbPath = options.dbPath ?? process.env.PWB_DB_PATH ?? join(root, '.treehouse', 'pro-website-builder.sqlite');
  const renderCacheDir = options.renderCacheDir ?? process.env.PWB_RENDER_CACHE ?? join(root, '.treehouse', 'render-cache');
  await mkdir(join(dbPath, '..'), { recursive: true });
  await mkdir(renderCacheDir, { recursive: true });
  const provider = createModelProvider(options.modelProvider ?? process.env.PWB_MODEL_PROVIDER);
  const identityDeadlines = options.identityDeadlines ?? identityDeadlinesFromEnvironment();
  const identityProvider = createIdentityProvider(options.modelProvider ?? process.env.PWB_MODEL_PROVIDER, { timeoutMs: identityProviderTimeoutMs(identityDeadlines) });
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
  const newIdentityRun = (id: string, briefing?: string): IdentityRun => new IdentityRun({ runId: id, repository, provider: identityProvider, raster, renderCacheDir, ...(briefing !== undefined ? { briefing } : {}), ...(identityDeadlines ? { deadlines: identityDeadlines } : {}) });
  /**
   * One run object per id, for every reader: the prototype registry asks for the
   * identity run it is seeded from through the same loader the API uses, so a
   * Gate 1 the captain decided in an earlier process is read back rather than
   * missed.
   */
  const loadIdentityRun = async (id: string): Promise<IdentityRun | undefined> => {
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
  };
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
    // Gate 2 runs on what Gate 1 approved, and on nothing else: the seed is read
    // from the identity run's own gate, so a request naming an undecided or a
    // since-changed identity is refused instead of measuring a fixture.
    identity: async ({ identityRunId, versionId }) => {
      const runId = identityRunId ?? (versionId ? repository.identityApprovalRun(versionId) : undefined);
      if (!runId) return undefined;
      const run = await loadIdentityRun(runId);
      const handoff = run?.snapshot().handoff;
      const approved = run?.approvedVersion();
      if (!run || !handoff || !approved) return undefined;
      return { identityRunId: runId, projectId: run.projectId, versionId: handoff.versionId, identityHash: handoff.identityHash, approvedAt: handoff.approvedAt, stale: handoff.stale, ir: approved.ir };
    },
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
  // Gate 3 compares the faces the captain was actually served against the ones
  // the bundle ships, so the preview is read when a release is prepared.
  const release = {
    releaseRoot, evidenceDir, fontsDir, siteUrl, siteName,
    modelProvider: options.modelProvider ?? process.env.PWB_MODEL_PROVIDER ?? 'fake',
    previewFaces: () => preview.servedFaces(),
  };
  /**
   * One run object per id, here too: gates 1 and 2 close in their own runs, so a
   * cached chain run can be behind the ledger it is judged by — but two requests
   * that reread it together must land on the same object, or the stage one of
   * them starts finishes on a run nothing can reach.
   */
  const loading = new Map<string, Promise<FixtureRun | undefined>>();
  const loadRun = async (id: string): Promise<FixtureRun | undefined> => {
    const inFlight = loading.get(id);
    if (inFlight) return inFlight;
    const load = (async () => {
      const existing = runs.get(id);
      if (existing && !existing.reloadableFromLedger(await repository.listApprovals(id))) return existing;
      const run = new FixtureRun({ repository, provider, release });
      if (!await run.restore(id)) return existing;
      runs.set(id, run);
      return run;
    })();
    loading.set(id, load);
    try { return await load; } finally { loading.delete(id); }
  };
  const api = createApiServer({
    runs,
    prototypes: registry,
    createRun: async (id) => {
      if (runs.has(id) || claimed.has(id)) throw new RunConflictError(id);
      claimed.add(id);
      try {
        // An id the ledger already holds belongs to the execution that took it —
        // an identity chain among them — and a fixture run started over it would
        // answer for that execution's gates with a document of its own.
        if (await repository.getRun(id)) throw new RunConflictError(id);
        const run = new FixtureRun({ repository, provider, release });
        await run.initialize(id);
        runs.set(id, run);
        return run;
      } finally { claimed.delete(id); }
    },
    loadRun,
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
      loadRun: loadIdentityRun,
    },
  });
  const apiPort = options.apiPort ?? Number(process.env.PWB_PORT ?? 4310);
  await new Promise<void>((resolve) => api.listen(apiPort, '127.0.0.1', resolve));
  return { api, preview, close: async () => { await preview.close(); await new Promise<void>((resolve, reject) => api.close((error) => error ? reject(error) : resolve())); database.sqlite.close(); } };
}
