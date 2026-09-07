import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createFixtureIR } from '../../packages/domain/src/index.js';
import { renderDesign } from '../../packages/renderer/src/index.js';
import { RenderHub, type RenderCase } from '../../packages/render-hub/src/index.js';
import { createPreviewServer } from '../../apps/server/src/preview.js';

test('render hub captures a screenshot, DOM and accessibility snapshot, then reuses its cache', async () => {
  const ir = createFixtureIR();
  const rendered = renderDesign(ir);
  const preview = createPreviewServer((versionId) => versionId === ir.meta.versionId ? rendered : undefined, 4313);
  await preview.start();
  const cacheDir = await mkdtemp(join(tmpdir(), 'pwb-render-hub-'));
  try {
    const hub = new RenderHub({ cacheDir });
    const renderCase: RenderCase = { route: `/preview/${ir.meta.versionId}/`, width: 1440, state: 'default', reducedMotion: false };
    const [first] = await hub.render(rendered, preview.origin, [renderCase]);
    expect(first?.cached).toBe(false);
    expect((await stat(first!.screenshotPath)).size).toBeGreaterThan(0);
    expect(first!.dom).toContain('data-node-id="home-title"');
    expect(JSON.stringify(first!.accessibility)).toContain('Toda escolha tem motivo.');
    expect(first!.qa.passed).toBe(true);
    const [second] = await hub.render(rendered, preview.origin, [renderCase]);
    expect(second?.cached).toBe(true);
    expect(second?.screenshotPath).toBe(first?.screenshotPath);
  } finally {
    await preview.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
});
