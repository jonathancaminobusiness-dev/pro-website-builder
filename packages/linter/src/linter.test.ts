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

  it('reports a forbidden default that a token-only document hides behind a token', () => {
    const ir = createFixtureIR();
    ir.identity.forbiddenDefaults.fonts.push('system-ui');
    (ir.tokens as { type: { body: { $value: string } } }).type.body.$value = 'system-ui, sans-serif';
    const report = lintDesign(ir);
    const def = report.findings.find((finding) => finding.id === 'DEF-010');
    expect(def).toMatchObject({ path: '/tokens/type/body', stage: 'prototype', severity: 'error' });
    expect(report.errorCount).toBe(1);
  });

  it('reports unresolved token aliases with the stage declared by their rule', () => {
    const ir = createFixtureIR();
    ir.pages.routes[0]!.nodes[0]!.props.color = '{tokens.missing}';
    const findings = lintDesign(ir).findings;
    expect(findings.map((finding) => finding.id)).toEqual(expect.arrayContaining(['TOK-002']));
    expect(findings.every((finding) => finding.stage === 'identity')).toBe(true);
  });

  it('does not lint page prose as if it were a visual value', () => {
    const ir = createFixtureIR();
    ir.pages.routes[0]!.nodes[1]!.props.text = 'Trocamos a Inter-only hero por uma fonte autoral, sem {nome do cliente}.';
    expect(lintDesign(ir).findings).toEqual([]);
  });
});
