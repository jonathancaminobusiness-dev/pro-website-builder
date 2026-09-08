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
    (ir.identity.tokens as { type: { body: { $value: string } } }).type.body.$value = 'system-ui, sans-serif';
    const report = lintDesign(ir);
    const def = report.findings.find((finding) => finding.id === 'DEF-010');
    expect(def).toMatchObject({ path: '/identity/tokens/type/body', stage: 'prototype', severity: 'error' });
    expect(report.errorCount).toBe(1);
  });

  it('reports unresolved token aliases with the stage declared by their rule', () => {
    const ir = createFixtureIR();
    ir.pages.routes[0]!.nodes[0]!.props.color = '{tokens.missing}';
    const findings = lintDesign(ir).findings;
    expect(findings.map((finding) => finding.id)).toEqual(expect.arrayContaining(['TOK-002']));
    expect(findings.every((finding) => finding.stage === 'identity')).toBe(true);
  });

  it('reports an identity token role that the document does not define', () => {
    const ir = createFixtureIR();
    ir.identity.tokenRoles.bodyTypeface = 'type.absent';
    const finding = lintDesign(ir).findings.find((item) => item.id === 'TOK-003');
    expect(finding).toMatchObject({ path: '/identity/tokenRoles/bodyTypeface', severity: 'error' });
  });

  it('reports tokens that collide on or break out of a CSS custom property', () => {
    const ir = createFixtureIR();
    (ir.identity.tokens as { color: Record<string, unknown> }).color['ink-strong'] = { $value: '#000000', $type: 'color' };
    (ir.identity.tokens as { color: { ink: Record<string, unknown> } }).color.ink = { strong: { $value: '#ffffff', $type: 'color' } };
    expect(lintDesign(ir).findings.some((item) => item.id === 'TOK-004' && /compile to the CSS custom property/.test(item.message))).toBe(true);
    const injected = createFixtureIR();
    (injected.identity.tokens as { color: { accent: { $value: string } } }).color.accent.$value = '#000</style>';
    expect(lintDesign(injected).findings.some((item) => item.id === 'TOK-004' && /cannot be emitted into CSS/.test(item.message))).toBe(true);
  });

  it('names the phrasing node that was given children', () => {
    const ir = createFixtureIR();
    ir.pages.routes[0]!.nodes[1]!.slots = { children: ['home-proof'] };
    const finding = lintDesign(ir).findings.find((item) => item.id === 'DOC-020');
    expect(finding).toMatchObject({ path: '/pages/routes/page-home/nodes/home-title/slots', severity: 'error' });
    expect(finding?.message).toMatch(/home-title renders as h1/);
    expect(lintDesign(createFixtureIR()).findings.filter((item) => item.id === 'DOC-020')).toEqual([]);
  });

  it('does not lint page prose as if it were a visual value', () => {
    const ir = createFixtureIR();
    ir.pages.routes[0]!.nodes[1]!.props.text = 'Trocamos a Inter-only hero por uma fonte autoral, sem {nome do cliente}.';
    expect(lintDesign(ir).findings).toEqual([]);
  });
});
