import { describe, expect, it } from 'vitest';
import { createFixtureIR } from '@pwb/domain';
import { lintDesign, ruleRegistry } from './index.js';

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

  it('keeps extension rule stubs registered for later phases', () => {
    expect(ruleRegistry.map((rule) => rule.id)).toEqual(expect.arrayContaining(['STR', 'DIV', 'GRID', 'TYPE', 'MEDIA', 'COH', 'MOTION', 'A11Y', 'SIM', 'COPY']));
  });
});
