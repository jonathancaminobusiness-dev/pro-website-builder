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
    expect(result.html).not.toContain('<script');
  });

  it('produces byte-identical output for the same document', () => {
    const ir = createFixtureIR();
    expect(renderDesign(ir)).toEqual(renderDesign(ir));
  });

  it('refuses raw visual values unless a signed exception exists', () => {
    const ir = createFixtureIR();
    ir.pages.routes[0]!.nodes[0]!.props.color = '#ff00ff';
    expect(() => renderDesign(ir)).toThrow(/token/i);
  });
});
