import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createFixtureIR } from '../packages/domain/src/index.js';
import { lintDesign } from '../packages/linter/src/index.js';
import { Applier, PatchGate, Scheduler, VersionStore } from '../packages/orchestrator/src/index.js';
import { RENDER_VIEWPORTS, RenderHub } from '../packages/render-hub/src/index.js';
import { renderDesign } from '../packages/renderer/src/index.js';
import {
  ClaudeCritiqueRunner, ClaudeInformationArchitect, ClaudeSectionComposer,
  CodexSession,
  DerivedEvidenceSource, FakeCritiqueProvider, FakeInformationArchitect, FakeSectionComposer,
  PrototypeStage, RenderHubEvidenceSource, type CritiqueProvider, type EvidenceSource,
} from '../packages/stage-prototype/src/index.js';
import { createPreviewServer } from '../apps/server/src/preview.js';

const BRIEF = 'Fixture briefing: compile an original identity into a production site.';
const provider = process.env.PWB_MODEL_PROVIDER ?? 'fake';
const claude = provider === 'claude-code';
const codex = provider === 'codex';
const model = claude || codex;
const useBrowser = process.argv.includes('--render');
// A finalist is worth the full sweep; a revision under review is measured at the representative widths.
const fullMatrix = process.argv.includes('--full-matrix');

async function main(): Promise<void> {
  const store = new VersionStore();
  const applier = new Applier(store, new PatchGate());
  const base = applier.createRoot(createFixtureIR());

  // Port 0 keeps this CLI off the fixed developer ports, so several checkouts can run it at once.
  const preview = createPreviewServer((versionId) => { const version = store.get(versionId); return version ? renderDesign(version.ir, { routePrefix: `/preview/${versionId}` }) : undefined; }, 0);
  await preview.start();
  const { port } = preview.server.address() as AddressInfo;
  const cacheDir = process.env.PWB_RENDER_CACHE ?? await mkdtemp(join(tmpdir(), 'pwb-prototype-render-'));

  const evidence: EvidenceSource = useBrowser
    ? new RenderHubEvidenceSource({ hub: new RenderHub({ cacheDir }), baseUrl: `http://127.0.0.1:${port}`, previewPrefix: (versionId) => `/preview/${versionId}`, ...(fullMatrix ? { viewports: RENDER_VIEWPORTS } : {}) })
    : new DerivedEvidenceSource();
  const critique: CritiqueProvider = model ? new ClaudeCritiqueRunner(codex ? { session: new CodexSession() } : {}) : new FakeCritiqueProvider();

  try {
    const stage = new PrototypeStage({
      store, applier, scheduler: new Scheduler(),
      architect: model ? new ClaudeInformationArchitect(codex ? { session: new CodexSession() } : {}) : new FakeInformationArchitect(),
      composer: model ? new ClaudeSectionComposer(codex ? { session: new CodexSession() } : {}) : new FakeSectionComposer(),
      critique, evidence, brief: BRIEF,
      onEvent: (type, payload) => { if (process.env.PWB_VERBOSE) console.error(type, JSON.stringify(payload)); },
    });
    const outcome = await stage.run({ runId: 'cli-prototype', baseVersionId: base.id });
    console.log(JSON.stringify({
      runId: outcome.runId,
      provider,
      evidence: useBrowser ? 'render-hub' : 'derived',
      matrix: useBrowser && fullMatrix ? 'full' : 'representative',
      routes: outcome.manifest.routes.map((route) => route.route),
      versions: { base: outcome.baseVersionId, architect: outcome.architectVersionId, composition: outcome.compositionVersionId, reviewed: outcome.versionId },
      cycles: outcome.cycles.length,
      stopReason: outcome.stopReason,
      stopDetail: outcome.stopDetail,
      gate: outcome.gate,
      tier0Vetoes: outcome.qa.vetoes.map((check) => check.id),
      lintErrors: lintDesign(store.get(outcome.versionId)!.ir).errorCount,
      verdicts: outcome.reports.map((report) => `${report.dimension}:${report.projection.verdict}`),
    }, null, 2));
    if (outcome.gate === 'vetoed') process.exitCode = 1;
  } finally {
    await preview.close();
  }
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Prototype run failed.'); process.exitCode = 1; });
