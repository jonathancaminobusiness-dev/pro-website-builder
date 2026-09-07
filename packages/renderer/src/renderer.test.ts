import { describe, expect, it } from 'vitest';
import { createFixtureIR } from '@pwb/domain';
import { renderDesign } from './index.js';

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
    node.props.backgroundColor = '{color.paper}';
    const html = renderDesign(ir).routes[0]!.html;
    const style = /data-node-id="home-proof"[^>]*style="([^"]*)"/.exec(html)?.[1] ?? '';
    expect(style.split(';').map((declaration) => declaration.split(':')[0])).toEqual(
      expect.arrayContaining(['box-shadow', 'padding-inline', 'max-width', 'font-size', 'background-color']),
    );
    expect(style).not.toMatch(/(^|;)(shadow|paddingInline|maxWidth|fontSize|backgroundColor):/);
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
});
