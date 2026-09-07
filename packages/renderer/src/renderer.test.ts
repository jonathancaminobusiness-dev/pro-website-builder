import { describe, expect, it } from 'vitest';
import { createFixtureIR, resolveTokens } from '@pwb/domain';
import { renderDesign } from './index.js';

/** Parses the emitted stylesheet into the rules a node carries outside any container query. */
function nodeRule(css: string, nodeId: string): string {
  const components = css.slice(css.indexOf('@layer components'));
  return new RegExp(`\\n  \\[data-node-id="${nodeId}"\\] \\{ ([^}]*)\\}`).exec(components)?.[1]?.trim() ?? '';
}

/** Parses the emitted stylesheet into the container queries a browser would apply, widths in px. */
function containerQueries(css: string): Array<{ minWidthPx: number; selector: string; declarations: string }> {
  return [...css.matchAll(/@container \(min-width: ([^)]+)\) \{\s*([^{]+?) \{ ([^}]*)\}/g)].map((match) => {
    const size = /^(\d*\.?\d+)(px|rem|em)?$/.exec(match[1]!.trim())!;
    const amount = Number.parseFloat(size[1]!);
    return { minWidthPx: size[2] === 'rem' || size[2] === 'em' ? amount * 16 : amount, selector: match[2]!.trim(), declarations: match[3]!.trim() };
  });
}

describe('deterministic renderer', () => {
  it('renders semantic routes with token custom properties and container queries', () => {
    const result = renderDesign(createFixtureIR());
    expect(result.html).toContain('<main');
    expect(result.css).toContain('@layer tokens');
    expect(result.css).toContain('--color-ink: #18252d');
    expect(result.css).toContain('@container');
    expect(result.routes.map((route) => route.route)).toEqual(['/', '/proof', '/contact']);
    expect(result.routes[0]!.html).toContain('<!doctype html>');
    expect(result.html).not.toContain('<script');
  });

  it('opens the shell padding at the identity\'s widest declared breakpoint, on a container it does not own', () => {
    const ir = createFixtureIR();
    const shell = containerQueries(renderDesign(ir).css).filter((block) => block.selector === 'main');
    // The identity declares where the layout may transform; the renderer never invents a width.
    const declared = ir.identity.gridGrammar.breakpointTokens.map((reference) => String(resolveTokens(ir.identity.tokens).values[reference.slice(1, -1)]));
    expect(shell).toHaveLength(1);
    expect(shell[0]!.minWidthPx).toBe(960);
    expect(declared).toContain('60rem');

    const css = renderDesign(ir).css;
    const containers = [...css.matchAll(/([a-z]+) \{[^}]*container-type: inline-size/g)].map((match) => match[1]);
    expect(containers).toContain('body');
    expect(containers).not.toContain('main');
  });

  it('refuses to render when the identity declares a breakpoint no token backs', () => {
    const ir = createFixtureIR();
    ir.identity.gridGrammar = { ...ir.identity.gridGrammar, breakpointTokens: ['{breakpoint.compact}', '{breakpoint.absent}'] };
    expect(() => renderDesign(ir)).toThrow(/breakpoint\.absent/);
  });

  it('gives a node and its container query the same specificity, with the query last', () => {
    const ir = createFixtureIR();
    const [compact] = ir.identity.gridGrammar.breakpointTokens as [string, string];
    ir.pages.routes[0]!.nodes[0]!.responsive = [{ minWidth: compact, props: { gap: '{space.xl}' } }];
    const css = renderDesign(ir).css;

    // A style attribute would outrank the query; the same selector in the same layer cannot.
    expect(renderDesign(ir).routes[0]!.html).not.toContain('style=');
    expect(nodeRule(css, 'home-root')).toContain('gap: var(--space-lg);');
    const query = containerQueries(css).find((block) => block.selector === '[data-node-id="home-root"]')!;
    expect(query.minWidthPx).toBeGreaterThan(390);
    expect(query.minWidthPx).toBeLessThan(1024);
    expect(query.declarations).toContain('gap: var(--space-xl);');
    // Source order is what decides between them, so the query's copy of the selector comes last.
    expect(css.lastIndexOf('[data-node-id="home-root"]')).toBeGreaterThan(css.indexOf('[data-node-id="home-root"]'));
  });

  it('emits a node\'s breakpoints widest last, so the wider condition is the one that wins', () => {
    const ir = createFixtureIR();
    // '{space.lg}' sorts before '{space.md}' as a string, and the two are 3rem and 1.5rem as widths.
    ir.pages.routes[0]!.nodes[0]!.responsive = [
      { minWidth: '{space.md}', props: { gap: '{space.sm}' } },
      { minWidth: '{space.lg}', props: { gap: '{space.xl}' } },
    ];
    const queries = containerQueries(renderDesign(ir).css).filter((block) => block.selector === '[data-node-id="home-root"]');

    expect(queries.map((block) => block.minWidthPx)).toEqual([24, 48]);
    // Both conditions match a 4rem container, and the last block in source order decides.
    expect(queries[queries.length - 1]!.declarations).toContain('gap: var(--space-xl);');
  });

  it('refuses a responsive width whose token is not a length', () => {
    const ir = createFixtureIR();
    ir.pages.routes[0]!.nodes[0]!.responsive = [{ minWidth: '{type.body}', props: { gap: '{space.md}' } }];
    expect(() => renderDesign(ir)).toThrow(/not a length/);
  });

  it('resolves a dark scheme to literals, so a pair that swaps two roles is not a custom-property cycle', () => {
    const ir = createFixtureIR();
    ir.identity.schemes = { dark: { 'color.paper': 'color.ink', 'color.ink': 'color.paper' } };
    const dark = /@media \(prefers-color-scheme: dark\) \{\s*:root \{([\s\S]*?)\}/.exec(renderDesign(ir).css)?.[1] ?? '';

    expect(dark).toContain('--color-paper: #18252d;');
    expect(dark).toContain('--color-ink: #f4efe6;');
    expect(dark).not.toContain('var(');
  });

  it('keeps a hidden node out of the layout even when its kind carries a display', () => {
    const css = renderDesign(createFixtureIR()).css;
    const layers = /@layer (base|components) \{([\s\S]*?)\n\}/g;
    const blocks = new Map([...css.matchAll(layers)].map((match) => [match[1]!, match[2]!]));

    expect(blocks.get('components')).toMatch(/\[data-node-kind="stack"\][^\n]*display: grid/);
    // The hidden rule is important and sits in an earlier layer, so it outranks that display.
    expect(blocks.get('base')).toContain('[hidden] { display: none !important; }');
  });

  it('produces byte-identical output for the same document', () => {
    const ir = createFixtureIR();
    expect(renderDesign(ir)).toEqual(renderDesign(ir));
  });

  it('renders each node inside the parent that declares it in a slot', () => {
    const html = renderDesign(createFixtureIR()).routes[0]!.html;
    const root = /<div data-node-id="home-root"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';
    expect(root).toContain('data-node-id="home-title"');
    expect(root).toContain('data-node-id="home-proof"');
    expect(html.indexOf('data-node-id="home-title"')).toBeLessThan(html.indexOf('data-node-id="home-proof"'));
  });

  it('refuses raw visual values that no token backs', () => {
    const ir = createFixtureIR();
    ir.pages.routes[0]!.nodes[0]!.props.color = '#ff00ff';
    expect(() => renderDesign(ir)).toThrow(/token/i);
  });

  it('emits real CSS property names for every token-backed visual prop', () => {
    const ir = createFixtureIR();
    (ir.identity.tokens as { shadow?: Record<string, unknown> }).shadow = { card: { $value: '0 1px 2px rgba(0,0,0,.2)', $type: 'shadow' } };
    const node = ir.pages.routes[0]!.nodes[2]!;
    node.props.shadow = '{shadow.card}';
    node.props.paddingInline = '{space.lg}';
    node.props.maxWidth = '{space.xl}';
    node.props.fontSize = '{space.md}';
    node.props.background = '{color.paper}';
    const rule = nodeRule(renderDesign(ir).css, 'home-proof');
    expect(rule.split(';').map((declaration) => declaration.split(':')[0]!.trim())).toEqual(
      expect.arrayContaining(['box-shadow', 'padding-inline', 'max-width', 'font-size', 'background-color']),
    );
    expect(rule).not.toMatch(/(^|;)\s*(shadow|paddingInline|maxWidth|fontSize):/);
  });

  it('names the page once, in the document title', () => {
    const html = renderDesign(createFixtureIR()).routes[0]!.html;
    expect(html).toContain('<title>Oficina — início</title>');
    expect(html.match(/<h1/g)).toHaveLength(1);
  });

  it('builds the base layer from the identity token roles', () => {
    const ir = createFixtureIR();
    ir.identity.tokenRoles.surface = 'color.accent';
    expect(renderDesign(ir).css).toContain('background: var(--color-accent)');
    ir.identity.tokenRoles.surface = 'color.absent';
    expect(() => renderDesign(ir)).toThrow(/color\.absent/);
  });

  it('refuses token values and token names that cannot be emitted into CSS', () => {
    const escaped = createFixtureIR();
    (escaped.identity.tokens as { color: { accent: { $value: string } } }).color.accent.$value = "#000</style><script>alert(1)</script><style>";
    expect(() => renderDesign(escaped)).toThrow(/cannot be emitted into CSS/i);
    const colliding = createFixtureIR();
    (colliding.identity.tokens as { color: Record<string, unknown> }).color['ink-strong'] = { $value: '#000000', $type: 'color' };
    (colliding.identity.tokens as { color: { ink: Record<string, unknown> } }).color.ink = { strong: { $value: '#ffffff', $type: 'color' } };
    colliding.identity.tokenRoles.text = 'color.ink-strong';
    expect(() => renderDesign(colliding)).toThrow(/compile to the CSS custom property/i);
  });

  it('renders a ready asset a media node references so generated images reach preview and export', () => {
    const ir = createFixtureIR();
    ir.assets.items = [{ id: 'hero', kind: 'raster', uri: 'data:image/png;base64,iVBORw0KGgo=', alt: 'Bancada da oficina', provenance: { source: 'higgsfield', author: 'higgsfield', license: 'fixture license', date: '2026-09-07', hash: 'hero' }, status: 'ready' }];
    const page = ir.pages.routes[0]!;
    page.nodes.push({ id: 'home-media', kind: 'media', semantic: 'figure', props: { text: 'Bancada' }, slots: {}, assetId: 'hero' });
    page.nodes[0]!.slots = { children: [...(page.nodes[0]!.slots.children ?? []), 'home-media'] };
    const html = renderDesign(ir).routes[0]!.html;
    expect(html).toContain('<img src="data:image/png;base64,iVBORw0KGgo=" alt="Bancada da oficina">');
  });

  it('omits the image for an asset that is not ready and refuses an unknown asset reference', () => {
    const ir = createFixtureIR();
    ir.assets.items = [{ id: 'hero', kind: 'raster', uri: 'about:blank', alt: 'Placeholder', provenance: { source: 'higgsfield', author: 'higgsfield', license: 'fixture license', date: '2026-09-07', hash: 'hero' }, status: 'placeholder' }];
    const page = ir.pages.routes[0]!;
    page.nodes.push({ id: 'home-media', kind: 'media', semantic: 'figure', props: { text: 'Bancada' }, slots: {}, assetId: 'hero' });
    page.nodes[0]!.slots = { children: [...(page.nodes[0]!.slots.children ?? []), 'home-media'] };
    expect(renderDesign(ir).routes[0]!.html).not.toContain('<img');
    page.nodes.at(-1)!.assetId = 'absent';
    expect(() => renderDesign(ir)).toThrow(/unknown asset absent/);
  });
});
