import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { createFixtureIR } from '../../packages/domain/src/index.js';
import { runTier0 } from '../../packages/qa-deterministic/src/index.js';
import { renderDesign } from '../../packages/renderer/src/index.js';
import { createRenderMatrix, qaFor, REPRESENTATIVE_VIEWPORTS, RenderHub, type RenderCase } from '../../packages/render-hub/src/index.js';
import { identityChangeImpact, pruneRenderCache } from '../../packages/stage-identity/src/gate.js';
import { createPreviewServer } from '../../apps/server/src/preview.js';

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

test('render hub captures a screenshot, DOM and accessibility snapshot, then reuses its cache', async () => {
  const ir = createFixtureIR();
  const rendered = renderDesign(ir);
  const preview = createPreviewServer((versionId) => versionId === ir.meta.versionId ? rendered : undefined, 0);
  await preview.start();
  const cacheDir = await mkdtemp(join(tmpdir(), 'pwb-render-hub-'));
  try {
    const hub = new RenderHub({ cacheDir });
    const request = { ir, rendered, baseUrl: preview.origin, previewPrefix: `/preview/${ir.meta.versionId}`, cases: [{ route: '/', width: 1440, state: 'default', reducedMotion: false }] as RenderCase[] };
    const [first] = await hub.capture(request);
    expect(first?.cached).toBe(false);
    expect((await stat(first!.evidence.screenshotPath)).size).toBeGreaterThan(0);
    expect(first!.dom).toContain('data-node-id="home-title"');
    expect(JSON.stringify(first!.accessibility)).toContain('Toda escolha tem motivo.');
    expect(qaFor(first!).passed).toBe(true);
    const [second] = await hub.capture(request);
    expect(second?.cached).toBe(true);
    expect(second?.evidence.screenshotPath).toBe(first?.evidence.screenshotPath);
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
  const origin = `http://127.0.0.1:${(preview.server.address() as AddressInfo).port}`;
  const cacheDir = await mkdtemp(join(tmpdir(), 'pwb-render-matrix-'));
  try {
    const prefix = `/preview/${ir.meta.versionId}`;
    const cases = createRenderMatrix(ir, { viewports: REPRESENTATIVE_VIEWPORTS });
    expect(cases).toHaveLength(ir.pages.routes.length * REPRESENTATIVE_VIEWPORTS.length * Object.keys(ir.stateFixtures).length);
    const results = await new RenderHub({ cacheDir }).capture({ ir, rendered, baseUrl: preview.origin, previewPrefix: prefix, cases });
    expect(results).toHaveLength(cases.length);
    expect(results.filter((result) => qaFor(result).passed)).toHaveLength(cases.length);
    expect(results.map((result) => result.status)).toEqual(cases.map(() => 200));
    expect(new Set(results.map((result) => result.evidence.screenshotPath)).size).toBe(cases.length);
    for (const [route, nodeId] of [['/', 'home-title'], ['/proof', 'proof-title'], ['/contact', 'contact-title']] as const) {
      const forRoute = results.filter((result) => result.renderCase.route === route);
      expect(forRoute).toHaveLength(REPRESENTATIVE_VIEWPORTS.length * Object.keys(ir.stateFixtures).length);
      for (const result of forRoute) expect(result.dom).toContain(`data-node-id="${nodeId}"`);
    }
  } finally {
    await preview.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test('captures every enumerated state with the nodes it hides really hidden', async () => {
  const ir = createFixtureIR();
  // A state fixture the matrix enumerates: capturing it without applying `hidden` would repeat the
  // default screenshot under another key and report it as state coverage.
  ir.stateFixtures.empty = { description: 'Sem conteúdo', values: { motion: 'full', hidden: 'home-proof' } };
  const rendered = renderDesign(ir, { routePrefix: `/preview/${ir.meta.versionId}` });
  const preview = createPreviewServer((requested) => requested === ir.meta.versionId ? rendered : undefined, 0);
  await preview.start();
  const cacheDir = await mkdtemp(join(tmpdir(), 'pwb-render-state-'));
  try {
    const cases = createRenderMatrix(ir, { viewports: [1440] as const, routes: ['/'] });
    const captures = await new RenderHub({ cacheDir }).capture({ ir, rendered, baseUrl: preview.origin, previewPrefix: `/preview/${ir.meta.versionId}`, cases });
    const byState = new Map(captures.map((capture) => [capture.renderCase.state, capture]));
    expect([...byState.keys()].sort()).toEqual(['default', 'empty', 'reduced']);
    const shown = (state: string): boolean | undefined => byState.get(state)!.evidence.nodes.find((node) => node.nodeId === 'home-proof')?.displayed;
    expect(shown('empty')).toBe(false);
    expect(shown('default')).toBe(true);
    const shot = async (state: string): Promise<Buffer> => readFile(byState.get(state)!.evidence.screenshotPath);
    expect((await shot('empty')).equals(await shot('default'))).toBe(false);
  } finally {
    await preview.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test('styles a node whose id needs escaping, because its rule and its attribute name one text', async () => {
  const ir = createFixtureIR();
  const home = ir.pages.routes[0]!;
  // Nothing constrains a node id to an identifier, and every visual prop now travels through the
  // selector that addresses it, so an id holding a quote or a backslash must still be styled.
  const quirky = 'home-"odd\\id';
  home.nodes.push({
    id: quirky, kind: 'surface', semantic: 'section', slots: {},
    props: { text: 'Prova rastreável', background: '{color.accent}', padding: '{space.xl}' },
    responsive: [{ minWidth: '{breakpoint.compact}', props: { paddingInline: '{space.sm}' } }],
  });
  home.nodes[0]!.slots = { children: ['home-title', 'home-proof', quirky] };

  const rendered = renderDesign(ir, { routePrefix: `/preview/${ir.meta.versionId}` });
  const preview = createPreviewServer((requested) => requested === ir.meta.versionId ? rendered : undefined, 0);
  await preview.start();
  const cacheDir = await mkdtemp(join(tmpdir(), 'pwb-node-id-escape-'));
  try {
    const [capture] = await new RenderHub({ cacheDir }).capture({
      ir, rendered, baseUrl: preview.origin, previewPrefix: `/preview/${ir.meta.versionId}`,
      cases: [{ route: '/', width: 1440, state: 'default', reducedMotion: false }],
    });
    const node = capture!.evidence.nodes.find((entry) => entry.nodeId === quirky)!;
    // 96px is {space.xl} from the node's own rule; 12px is {space.sm} from its container query.
    expect(node.paddingBlockPx).toBe(96);
    expect(node.paddingInlinePx).toBe(12);
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

test('applies a container query to a property the node already declares, measured at 390 and 1024', async () => {
  const ir = createFixtureIR();
  const shell = ir.pages.routes[0]!.nodes[0]!;
  // The shape every route shell has: a base shorthand plus a breakpoint that narrows one of its sides.
  shell.props = { ...shell.props, padding: '{space.md}' };
  shell.responsive = [{ minWidth: '{breakpoint.compact}', props: { paddingInline: '{space.xl}' } }];

  const rendered = renderDesign(ir, { routePrefix: `/preview/${ir.meta.versionId}` });
  const preview = createPreviewServer((requested) => requested === ir.meta.versionId ? rendered : undefined, 0);
  await preview.start();
  const cacheDir = await mkdtemp(join(tmpdir(), 'pwb-container-query-'));
  try {
    const hub = new RenderHub({ cacheDir });
    const paddingAt = async (width: 390 | 1024): Promise<{ inline: number | null; block: number | null }> => {
      const [capture] = await hub.capture({
        ir, rendered, baseUrl: preview.origin, previewPrefix: `/preview/${ir.meta.versionId}`,
        cases: [{ route: '/', width, state: 'default', reducedMotion: false }],
      });
      const node = capture!.evidence.nodes.find((entry) => entry.nodeId === 'home-root')!;
      return { inline: node.paddingInlinePx, block: node.paddingBlockPx };
    };

    // 24px is {space.md}; 96px is {space.xl}, which the query opens at 44rem.
    expect(await paddingAt(390)).toEqual({ inline: 24, block: 24 });
    expect(await paddingAt(1024)).toEqual({ inline: 96, block: 24 });
  } finally {
    await preview.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test('a token change drops the cache entries the hub actually wrote for the approved version', async () => {
  const approved = createFixtureIR();
  const versionId = approved.meta.versionId;
  const prefix = `/preview/${versionId}`;
  const rendered = renderDesign(approved, { routePrefix: prefix });
  const preview = createPreviewServer((requested) => requested === versionId ? rendered : undefined, 0);
  await preview.start();
  const cacheDir = await mkdtemp(join(tmpdir(), 'pwb-render-invalidation-'));
  try {
    // Exactly the case form the product drives the hub with, for the version the gate approved.
    const [renderCase] = createRenderMatrix(approved, { viewports: REPRESENTATIVE_VIEWPORTS });
    const [written] = await new RenderHub({ cacheDir }).capture({ ir: approved, rendered, baseUrl: preview.origin, previewPrefix: prefix, cases: [renderCase!] });
    expect(written?.cached).toBe(false);
    expect(await exists(written!.evidence.screenshotPath)).toBe(true);

    const changed = structuredClone(approved);
    (changed.identity.tokens.color as Record<string, unknown>).accent = { $value: '#ff5c00', $type: 'color' };
    const impact = identityChangeImpact(approved, changed, versionId);
    expect(impact.reopensGate).toBe(true);

    const removed = await pruneRenderCache(cacheDir, impact.staleRenderKeys);
    expect(await exists(written!.evidence.screenshotPath)).toBe(false);
    // Only the entries the hub had written are counted; the rest of the matrix was never rendered.
    expect(removed).toHaveLength(2);
  } finally {
    await preview.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
});
