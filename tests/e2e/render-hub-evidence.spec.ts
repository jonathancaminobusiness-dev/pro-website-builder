import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { createFixtureIR } from '../../packages/domain/src/index.js';
import { Applier, PatchGate, Scheduler, VersionStore } from '../../packages/orchestrator/src/index.js';
import { runQa, runTier0 } from '../../packages/qa-deterministic/src/index.js';
import { RenderHub } from '../../packages/render-hub/src/index.js';
import { renderDesign } from '../../packages/renderer/src/index.js';
import {
  DerivedEvidenceSource, FakeCritiqueProvider, FakeInformationArchitect, FakeSectionComposer,
  PrototypeStage, RenderHubEvidenceSource,
} from '../../packages/stage-prototype/src/index.js';
import { createPreviewServer } from '../../apps/server/src/preview.js';

test.describe('render hub evidence', () => {
  test.setTimeout(180_000);

  test('captures the full evidence bundle for a composed prototype and passes Tier 0 without a veto', async () => {
    const store = new VersionStore();
    const applier = new Applier(store, new PatchGate());
    const base = applier.createRoot(createFixtureIR());
    const stage = new PrototypeStage({
      store, applier, scheduler: new Scheduler(),
      architect: new FakeInformationArchitect(), composer: new FakeSectionComposer(),
      critique: new FakeCritiqueProvider(), evidence: new DerivedEvidenceSource(),
      brief: 'Briefing fixo para a captura real.',
    });
    const outcome = await stage.run({ runId: 'e2e-evidence', baseVersionId: base.id });
    const version = store.get(outcome.versionId)!;

    // Port 0 so parallel checkouts never contend for a fixed developer port.
    const preview = createPreviewServer((versionId) => { const record = store.get(versionId); return record ? renderDesign(record.ir, { routePrefix: `/preview/${versionId}` }) : undefined; }, 0);
    await preview.start();
    const { port } = preview.server.address() as AddressInfo;
    const cacheDir = await mkdtemp(join(tmpdir(), 'pwb-e2e-evidence-'));

    try {
      const hub = new RenderHub({ cacheDir, maxConcurrency: 3 });
      const source = new RenderHubEvidenceSource({ hub, baseUrl: `http://127.0.0.1:${port}`, previewPrefix: (versionId) => `/preview/${versionId}` });
      const bundle = await source.collect({ ir: version.ir, versionId: version.id, routes: ['/'] });

      // One route, the three representative widths, the six states the architect declares.
      expect(bundle.evidence).toHaveLength(18);
      const widths = new Set(bundle.evidence.map((entry) => entry.context.viewport));
      expect(widths).toEqual(new Set([390, 768, 1440]));
      expect(new Set(bundle.evidence.map((entry) => entry.context.state))).toEqual(new Set(['default', 'empty', 'error', 'focus', 'loading', 'reduced']));
      expect(bundle.evidence.some((entry) => entry.context.reducedMotion)).toBe(true);

      const wide = bundle.evidence.find((entry) => entry.context.viewport === 1440 && entry.context.state === 'default')!;
      expect(wide.stable).toBe(true);
      expect(wide.consoleErrors).toEqual([]);
      expect(wide.networkErrors).toEqual([]);
      expect(wide.nodes.length).toBeGreaterThan(8);
      expect(wide.nodes.every((node) => Number.isFinite(node.box.width))).toBe(true);
      expect(wide.contrast.length).toBeGreaterThan(0);
      expect(wide.status).toBe(200);
      expect((await stat(wide.screenshotPath)).size).toBeGreaterThan(0);

      // The composed call to action is a real anchor, so the keyboard walk reaches it and the focus
      // checks measure a ring instead of an empty list.
      expect(wide.nodes.find((node) => node.nodeId === 'home-hero-cta')?.focusable).toBe(true);
      expect(wide.focus.map((sample) => sample.nodeId)).toContain('home-hero-cta');
      expect(wide.focus.every((sample) => sample.outlineWidthPx >= 1 || sample.boxShadow !== '')).toBe(true);

      // A state fixture really removes its nodes from the captured document.
      const empty = bundle.evidence.find((entry) => entry.context.viewport === 1440 && entry.context.state === 'empty')!;
      expect(empty.nodes.find((node) => node.nodeId === 'home-hero-title')?.displayed).toBe(false);
      expect(empty.nodes.find((node) => node.nodeId === 'home-empty')?.displayed).toBe(true);
      expect(empty.domHash).not.toBe(wide.domHash);

      expect(runTier0({ ir: version.ir, evidence: bundle.evidence }).vetoes).toEqual([]);
      expect(runQa({ ir: version.ir, evidence: bundle.evidence }).checks.filter((check) => check.severity === 'veto')).toEqual([]);

      const cached = await source.collect({ ir: version.ir, versionId: version.id, routes: ['/'] });
      expect(cached.evidence.map((entry) => entry.screenshotPath)).toEqual(bundle.evidence.map((entry) => entry.screenshotPath));
      expect(cached.evidence[0]!.domHash).toBe(bundle.evidence[0]!.domHash);
    } finally {
      await preview.close();
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
});
