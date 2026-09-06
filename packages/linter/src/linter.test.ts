import { describe, expect, it } from 'vitest';
import { createFixtureIR } from '@pwb/domain';
import { lintDesign } from './index.js';

describe('identity linter', () => {
  it('reports raw visual values as token-only errors', () => {
    const ir = createFixtureIR();
    ir.pages.routes[0]!.nodes[0]!.props.color = '#ff00ff';
    const report = lintDesign(ir);
    expect(report.findings.some((finding) => finding.id === 'TOK-001' && finding.severity === 'error')).toBe(true);
  });

  it('reports forbidden defaults and unresolved token aliases', () => {
    const ir = createFixtureIR();
    ir.pages.routes[0]!.nodes[0]!.props.font = 'Inter-only hero';
    ir.pages.routes[0]!.nodes[0]!.props.color = '{tokens.missing}';
    const ids = lintDesign(ir).findings.map((finding) => finding.id);
    expect(ids).toEqual(expect.arrayContaining(['DEF-010', 'TOK-001', 'TOK-002']));
  });

  it('does not lint page prose as if it were a visual value', () => {
    const ir = createFixtureIR();
    ir.pages.routes[0]!.nodes[1]!.props.text = 'Trocamos a Inter-only hero por uma fonte autoral, sem {nome do cliente}.';
    expect(lintDesign(ir).findings).toEqual([]);
  });
});
