import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { createFixtureIR } from '../../packages/domain/src/index.js';
import { runTier0 } from '../../packages/qa-deterministic/src/index.js';
import { renderDesign } from '../../packages/renderer/src/index.js';
import { createRenderMatrix, REPRESENTATIVE_VIEWPORTS, RenderHub, type RenderCase } from '../../packages/render-hub/src/index.js';
import { createPreviewServer } from '../../apps/server/src/preview.js';

test('render hub captures a screenshot, DOM and accessibility snapshot, then reuses its cache', async () => {
  const ir = createFixtureIR();
  const rendered = renderDesign(ir);
  const preview = createPreviewServer((versionId) => versionId === ir.meta.versionId ? rendered : undefined, 0);
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

test('drives the whole route, viewport and state matrix against the preview server', async () => {
  test.setTimeout(180_000);
  const ir = createFixtureIR();
  const rendered = renderDesign(ir);
  const preview = createPreviewServer((versionId) => versionId === ir.meta.versionId ? rendered : undefined, 0);
  await preview.start();
  const cacheDir = await mkdtemp(join(tmpdir(), 'pwb-render-matrix-'));
  try {
    const prefix = `/preview/${ir.meta.versionId}`;
    const cases = createRenderMatrix(ir, { viewports: REPRESENTATIVE_VIEWPORTS })
      .map((renderCase) => ({ ...renderCase, route: renderCase.route === '/' ? `${prefix}/` : `${prefix}${renderCase.route}` }));
    expect(cases).toHaveLength(ir.pages.routes.length * REPRESENTATIVE_VIEWPORTS.length * Object.keys(ir.stateFixtures).length);
    const results = await new RenderHub({ cacheDir }).render(rendered, preview.origin, cases);
    expect(results).toHaveLength(cases.length);
    expect(results.filter((result) => result.qa.passed)).toHaveLength(cases.length);
    expect(results.map((result) => result.qa.status)).toEqual(cases.map(() => 200));
    expect(new Set(results.map((result) => result.screenshotPath)).size).toBe(cases.length);
    for (const [route, nodeId] of [['/', 'home-title'], ['/proof', 'proof-title'], ['/contact', 'contact-title']] as const) {
      const forRoute = results.filter((result) => result.renderCase.route === (route === '/' ? `${prefix}/` : `${prefix}${route}`));
      expect(forRoute).toHaveLength(REPRESENTATIVE_VIEWPORTS.length * Object.keys(ir.stateFixtures).length);
      for (const result of forRoute) expect(result.dom).toContain(`data-node-id="${nodeId}"`);
    }
  } finally {
    await preview.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test('walks the keyboard to a composed link and vetoes the same page once its focus ring is gone', async () => {
  const ir = createFixtureIR();
  const home = ir.pages.routes[0]!;
  home.nodes.push({ id: 'home-cta', kind: 'component', semantic: 'link', props: { text: 'Ver a prova', href: '/proof', color: '{color.ink}', font: '{type.body}' }, slots: {}, responsive: [] });
  home.nodes[0]!.slots = { children: ['home-title', 'home-proof', 'home-cta'] };
  const rendered = renderDesign(ir, { routePrefix: `/preview/${ir.meta.versionId}` });
  // The same document with the ring overridden away: what a prototype that forgot focus measures as.
  const withoutRing = renderDesign(ir, { routePrefix: '/preview/ringless' });
  const ringless = { ...withoutRing, routes: withoutRing.routes.map((route) => ({ ...route, html: route.html.replace('</head>', '<style>:where(a, button):focus-visible { outline: none; box-shadow: none; }</style></head>') })) };

  const preview = createPreviewServer((versionId) => versionId === 'ringless' ? ringless : versionId === ir.meta.versionId ? rendered : undefined, 0);
  await preview.start();
  const { port } = preview.server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  const cacheDir = await mkdtemp(join(tmpdir(), 'pwb-focus-ring-'));
  try {
    const hub = new RenderHub({ cacheDir });
    const cases: RenderCase[] = [{ route: '/', width: 1440, state: 'default', reducedMotion: false }];
    const [visible] = await hub.capture({ ir, rendered, baseUrl: origin, previewPrefix: `/preview/${ir.meta.versionId}`, cases });
    expect(visible!.evidence.nodes.find((node) => node.nodeId === 'home-cta')?.focusable).toBe(true);
    expect(visible!.evidence.focus.map((sample) => sample.nodeId)).toEqual(['home-cta']);
    expect(runTier0({ ir, evidence: [visible!.evidence] }).vetoes.map((veto) => veto.id)).not.toContain('QA0-FOCUS');

    const [blind] = await hub.capture({ ir, rendered: ringless, baseUrl: origin, previewPrefix: '/preview/ringless', cases });
    expect(blind!.evidence.focus.map((sample) => sample.nodeId)).toEqual(['home-cta']);
    const vetoes = runTier0({ ir, evidence: [blind!.evidence] }).vetoes;
    expect(vetoes.map((veto) => veto.id)).toContain('QA0-FOCUS');
    expect(vetoes.find((veto) => veto.id === 'QA0-FOCUS')!.message).toContain('home-cta');
  } finally {
    await preview.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test('rings a visible control when the state hides the first one inside the node it names', async () => {
  const ir = createFixtureIR();
  const home = ir.pages.routes[0]!;
  const link = (id: string, text: string): (typeof home.nodes)[number] => (
    { id, kind: 'component', semantic: 'link', props: { text, href: '/proof', color: '{color.ink}', font: '{type.body}' }, slots: {}, responsive: [] }
  );
  home.nodes.push(link('home-first', 'Ver a prova'), link('home-second', 'Falar com a oficina'));
  home.nodes[0]!.slots = { children: ['home-title', 'home-proof', 'home-first', 'home-second'] };
  // Both states hide the same node, so the two captures differ only by which control takes the ring.
  ir.stateFixtures.ringed = { description: 'Foco no que sobrou', values: { motion: 'full', hidden: 'home-first', focus: 'home-root' } };
  ir.stateFixtures.ringless = { description: 'Nada focalizável', values: { motion: 'full', hidden: 'home-first', focus: 'home-title' } };

  const rendered = renderDesign(ir, { routePrefix: `/preview/${ir.meta.versionId}` });
  const preview = createPreviewServer((requested) => requested === ir.meta.versionId ? rendered : undefined, 0);
  await preview.start();
  const origin = `http://127.0.0.1:${(preview.server.address() as AddressInfo).port}`;
  const cacheDir = await mkdtemp(join(tmpdir(), 'pwb-focus-state-'));
  try {
    const hub = new RenderHub({ cacheDir });
    const shot = async (state: string): Promise<Buffer> => {
      const [capture] = await hub.capture({
        ir, rendered, baseUrl: origin, previewPrefix: `/preview/${ir.meta.versionId}`,
        cases: [{ route: '/', width: 1440, state, reducedMotion: false }],
      });
      expect(capture!.evidence.nodes.find((node) => node.nodeId === 'home-first')?.displayed).toBe(false);
      expect(capture!.evidence.nodes.find((node) => node.nodeId === 'home-second')?.displayed).toBe(true);
      return readFile(capture!.evidence.screenshotPath);
    };
    // The named node still holds a visible link, so the focus state has to show its ring.
    expect((await shot('ringed')).equals(await shot('ringless'))).toBe(false);
  } finally {
    await preview.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
});
