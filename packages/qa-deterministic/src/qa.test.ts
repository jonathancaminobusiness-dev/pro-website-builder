import { describe, expect, it } from 'vitest';
import { createFixtureIR } from '@pwb/domain';
import { contrastRatio, createCleanEvidence, parseColor, requiredContrast, runQa, runTier0, runTier1, type RenderContext, type RenderEvidence } from './index.js';

const context: RenderContext = { route: '/', viewport: 390, state: 'default', colorScheme: 'light', reducedMotion: false };
const ir = createFixtureIR();
const clean = (): RenderEvidence => createCleanEvidence(ir, context);

describe('contrast math', () => {
  it('parses the colour notations a browser reports', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor('#18252d')).toEqual({ r: 24, g: 37, b: 45, a: 1 });
    expect(parseColor('rgb(216, 100, 69)')).toEqual({ r: 216, g: 100, b: 69, a: 1 });
    expect(parseColor('rgba(0, 0, 0, 0.5)')).toEqual({ r: 0, g: 0, b: 0, a: 0.5 });
    expect(parseColor('not-a-colour')).toBeUndefined();
  });

  it('matches the WCAG reference ratios and thresholds', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    expect(contrastRatio('#767676', '#ffffff')!).toBeGreaterThanOrEqual(4.5);
    expect(requiredContrast(16, false)).toBe(4.5);
    expect(requiredContrast(24, false)).toBe(3);
    expect(requiredContrast(19, true)).toBe(3);
    expect(requiredContrast(19, false)).toBe(4.5);
  });

  it('composites a translucent foreground before comparing', () => {
    expect(contrastRatio('rgba(0,0,0,0)', '#ffffff')).toBeCloseTo(1, 5);
  });
});

describe('deterministic gate', () => {
  it('passes a clean capture of the fixture prototype without a veto', () => {
    const report = runQa({ ir, evidence: [clean()] });
    expect(report.vetoes).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it('vetoes an unstable capture, a dirty runtime and horizontal overflow', () => {
    const evidence = clean();
    evidence.stable = false;
    evidence.consoleErrors = ['TypeError: undefined is not a function'];
    evidence.networkErrors = ['https://example.test/font.woff2: failed'];
    evidence.documentMetrics = { ...evidence.documentMetrics, scrollWidth: 520 };
    const report = runTier0({ ir, evidence: [evidence] });
    expect(report.passed).toBe(false);
    expect(report.vetoes.map((check) => check.id)).toEqual(expect.arrayContaining(['QA0-STABILITY', 'QA0-RUNTIME', 'QA0-OVERFLOW']));
    expect(report.vetoes.filter((check) => check.id === 'QA0-RUNTIME')).toHaveLength(2);
  });

  it('vetoes clipped content but not an intentional ellipsis that keeps an accessible alternative', () => {
    const clipped = clean();
    const first = clipped.nodes[1]!;
    clipped.nodes[1] = { ...first, overflowHidden: true, scrollWidth: first.clientWidth + 40, text: 'Toda escolha tem motivo.' };
    expect(runTier0({ ir, evidence: [clipped] }).vetoes.map((check) => check.id)).toContain('QA0-CLIPPING');

    const announced = clean();
    const second = announced.nodes[1]!;
    announced.nodes[1] = { ...second, ellipsis: true, scrollWidth: second.clientWidth + 40, text: 'Toda escolha tem motivo.', accessibleName: 'Toda escolha tem motivo.' };
    expect(runTier0({ ir, evidence: [announced] }).passed).toBe(true);
    expect(runTier1({ ir, evidence: [announced] }).checks.map((check) => check.id)).toContain('QA1-TRUNCATION');
  });

  it('vetoes a truncation that hides the full text from assistive technology', () => {
    const evidence = clean();
    const node = evidence.nodes[1]!;
    evidence.nodes[1] = { ...node, ellipsis: true, scrollWidth: node.clientWidth + 40, text: 'Toda escolha tem motivo.', accessibleName: 'Toda escolha…' };
    expect(runTier0({ ir, evidence: [evidence] }).vetoes.map((check) => check.id)).toContain('QA0-TRUNCATION');
  });

  it('vetoes an orphan token reference straight from the IR, without any capture', () => {
    const broken = structuredClone(ir);
    broken.pages.routes[0]!.nodes[1]!.props.color = '{color.does-not-exist}';
    const report = runTier0({ ir: broken, evidence: [] });
    expect(report.vetoes.map((check) => check.id)).toContain('QA0-TOKEN-ORPHAN');
    expect(report.vetoes[0]!.nodeIds).toEqual(['home-title']);
  });

  it('vetoes text below AA and a focus ring that cannot be seen', () => {
    const evidence = clean();
    evidence.contrast = [{ nodeId: 'home-title', foreground: '#9a9a9a', background: '#ffffff', fontSizePx: 16, bold: false }];
    evidence.focus = [
      { nodeId: 'home-proof', outlineWidthPx: 0, outlineStyle: 'none', outlineColor: 'rgba(0,0,0,0)', surroundingColor: '#ffffff', boxShadow: 'none' },
      { nodeId: 'home-title', outlineWidthPx: 2, outlineStyle: 'solid', outlineColor: '#f2f2f2', surroundingColor: '#ffffff', boxShadow: 'none' },
    ];
    const vetoes = runTier0({ ir, evidence: [evidence] }).vetoes;
    expect(vetoes.map((check) => check.id)).toEqual(expect.arrayContaining(['QA0-CONTRAST', 'QA0-FOCUS']));
    expect(vetoes.filter((check) => check.id === 'QA0-FOCUS')).toHaveLength(2);
  });

  it('splits axe violations between the Tier 0 veto and the Tier 1 report', () => {
    const evidence = clean();
    evidence.axeViolations = [
      { id: 'color-contrast', impact: 'serious', help: 'Elements must meet minimum contrast', nodeIds: ['home-title'] },
      { id: 'region', impact: 'moderate', help: 'All content should be contained by landmarks', nodeIds: ['home-root'] },
    ];
    expect(runTier0({ ir, evidence: [evidence] }).vetoes.map((check) => check.id)).toEqual(['QA0-AXE']);
    expect(runTier1({ ir, evidence: [evidence] }).checks.map((check) => check.id)).toContain('QA1-AXE');
  });

  it('reports rhythm outside the grid grammar as a Tier 1 problem, never as a veto', () => {
    const evidence = clean();
    evidence.nodes[0] = { ...evidence.nodes[0]!, gapPx: 19 };
    const report = runQa({ ir, evidence: [evidence] });
    expect(report.passed).toBe(true);
    const rhythm = report.checks.filter((check) => check.id === 'QA1-RHYTHM');
    expect(rhythm).toHaveLength(1);
    expect(rhythm[0]!.severity).toBe('major');
    expect(rhythm[0]!.message).toContain('fora do ritmo de 24px');
  });

  it('reports sibling edges that drift by less than a gutter', () => {
    const evidence = clean();
    evidence.nodes[2] = { ...evidence.nodes[2]!, box: { ...evidence.nodes[2]!.box, x: 2 } };
    const drift = runTier1({ ir, evidence: [evidence] }).checks.filter((check) => check.id === 'QA1-ALIGNMENT');
    expect(drift).toHaveLength(1);
    expect(drift[0]!.nodeIds).toEqual(['home-proof']);
  });

  it('gives the same set of problems the same issue hash across runs and a different one when they change', () => {
    const evidence = clean();
    evidence.consoleErrors = ['boom'];
    const first = runTier0({ ir, evidence: [evidence] });
    const second = runTier0({ ir, evidence: [createCleanEvidence(ir, context)] });
    expect(runTier0({ ir, evidence: [evidence] }).issueHash).toBe(first.issueHash);
    expect(second.issueHash).not.toBe(first.issueHash);
  });
});
