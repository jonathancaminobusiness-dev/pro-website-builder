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

  it('refuses raw visual values unless a signed exception exists', () => {
    const ir = createFixtureIR();
    ir.pages.routes[0]!.nodes[0]!.props.color = '#ff00ff';
    expect(() => renderDesign(ir)).toThrow(/token/i);
  });
});
