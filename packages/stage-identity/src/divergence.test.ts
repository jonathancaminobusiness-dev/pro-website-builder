import { describe, expect, it } from 'vitest';
import {
  compareDirections,
  createFixtureIR,
  divergenceAxes,
  paletteSignature,
  signatureOfColors,
  toOklch,
  type DirectionVector,
} from '@pwb/domain';
import { lintDesign } from '@pwb/linter';
import { identityAxisBrief, identityAxisBriefs, overlappingAxisKeys } from './axes.js';
import { fakeIdentityFor } from './fake-identity-provider.js';

function vectorFor(directionId: Parameters<typeof fakeIdentityFor>[0], overrides: Partial<DirectionVector> = {}): DirectionVector {
  const seat = identityAxisBrief(directionId);
  const identity = fakeIdentityFor(directionId);
  const colors = Object.values(identity.tokens.color as Record<string, { $value: string }>).map((token) => token.$value);
  return {
    directionId,
    label: directionId,
    axes: Object.fromEntries(divergenceAxes.map((axis) => [axis, { key: seat.required[axis], descriptor: `${axis} descriptor for ${directionId}` }])) as DirectionVector['axes'],
    paletteSignature: signatureOfColors(colors),
    ...overrides,
  };
}

describe('divergence axes and the hue rule', () => {
  it('gives each of the three seats a different key on every axis', () => {
    expect(overlappingAxisKeys()).toEqual([]);
    expect(identityAxisBriefs).toHaveLength(3);
  });

  it('drops hue from a palette signature, so a rotated palette is not a new direction', () => {
    const base = ['#b4552f', '#1d2321', '#f2ece1'];
    const rotated = base.map((hex) => {
      const oklch = toOklch(hex)!;
      return `oklch(${oklch.l.toFixed(4)} ${oklch.c.toFixed(4)} ${(oklch.h + 137).toFixed(2)})`;
    });
    expect(paletteSignature(rotated).entries).toEqual(paletteSignature(base).entries);
    const lighter = base.map((hex) => {
      const oklch = toOklch(hex)!;
      return `oklch(${Math.min(1, oklch.l + 0.2).toFixed(4)} ${oklch.c.toFixed(4)} ${oklch.h.toFixed(2)})`;
    });
    expect(paletteSignature(lighter).entries).not.toEqual(paletteSignature(base).entries);
  });

  it('keeps colours it cannot parse in the comparison instead of dropping them', () => {
    const signature = paletteSignature(['#1d2321', 'rebeccapurple']);
    expect(signature.unparsed).toEqual(['rebeccapurple']);
    expect(signature.entries).toContain('raw:rebeccapurple');
  });

  it('refuses to count a colour axis that only changed hue', () => {
    const a = vectorFor('editorial-material');
    const hueTwin = vectorFor('editorial-material', {
      directionId: 'hue-twin',
      axes: { ...a.axes, color: { key: 'saturated-signal', descriptor: 'O mesmo sistema com outro matiz.' } },
    });
    const comparison = compareDirections(a, hueTwin);
    expect(comparison.hueOnlyColor).toBe(true);
    expect(comparison.distinctAxes).toEqual([]);
    expect(comparison.comparisons.find((entry) => entry.axis === 'color')?.reason).toMatch(/only the hue changed/i);
  });

  it('counts a colour axis whose palette differs beyond hue', () => {
    const comparison = compareDirections(vectorFor('editorial-material'), vectorFor('modular-technical'));
    expect(comparison.hueOnlyColor).toBe(false);
    expect(comparison.distinctAxes).toEqual(divergenceAxes);
  });
});

describe('DIV-030 through the linter registry', () => {
  function irWithMatrix(matrix: DirectionVector[], directionId: string) {
    const ir = createFixtureIR();
    ir.identity = { ...fakeIdentityFor('editorial-material'), direction: { ...fakeIdentityFor('editorial-material').direction, divergence: { directionId, matrix, constants: ['token paths'], incompatibilities: [], minimumDistinctAxes: 4 } } };
    return ir;
  }

  it('passes three opposed directions built from one briefing', () => {
    const matrix = identityAxisBriefs.map((seat) => vectorFor(seat.id));
    const report = lintDesign(irWithMatrix(matrix, 'editorial-material'));
    expect(report.findings.filter((finding) => finding.id === 'DIV-030')).toEqual([]);
  });

  it('blocks a matrix whose second direction only rotates the hue', () => {
    const base = vectorFor('editorial-material');
    const twin = vectorFor('editorial-material', { directionId: 'hue-twin', label: 'hue twin', axes: { ...base.axes, color: { key: 'saturated-signal', descriptor: 'Mesmo sistema, outro matiz.' } } });
    const findings = lintDesign(irWithMatrix([base, twin], 'editorial-material')).findings.filter((finding) => finding.id === 'DIV-030');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toMatch(/only the hue/i);
    expect(findings[0]?.severity).toBe('error');
  });

  it('refuses a palette signature that does not match the identity it belongs to', () => {
    const matrix = identityAxisBriefs.map((seat) => vectorFor(seat.id));
    const tampered = matrix.map((vector) => vector.directionId === 'editorial-material' ? { ...vector, paletteSignature: signatureOfColors(['#000000']) } : vector);
    const findings = lintDesign(irWithMatrix(tampered, 'editorial-material')).findings.filter((finding) => finding.id === 'DIV-030');
    expect(findings.some((finding) => /palette signature recorded/i.test(finding.message))).toBe(true);
  });

  it('stays silent for an identity that is not part of a fan-out', () => {
    expect(lintDesign(createFixtureIR()).findings.filter((finding) => finding.id === 'DIV-030')).toEqual([]);
  });
});

describe('ID-003', () => {
  function findings(mutate: (ir: ReturnType<typeof createFixtureIR>) => void) {
    const ir = createFixtureIR();
    mutate(ir);
    return lintDesign(ir).findings.filter((finding) => finding.id === 'ID-003');
  }

  it('passes an identity where every token and governed field has a grounded decision', () => {
    expect(findings(() => undefined)).toEqual([]);
  });

  it('flags a token with no decision record', () => {
    const flagged = findings((ir) => { ir.identity.decisions = ir.identity.decisions.filter((decision) => decision.choice !== 'tokens.color.accent'); });
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.message).toMatch(/unjustified default/i);
    expect(flagged[0]?.path).toBe('/identity/tokens/color/accent');
  });

  it('flags a governed contract field with no decision record', () => {
    const flagged = findings((ir) => { ir.identity.decisions = ir.identity.decisions.filter((decision) => decision.choice !== 'content.voice'); });
    expect(flagged.map((finding) => finding.path)).toEqual(['/identity/content/voice']);
  });

  it('flags a decision that carries neither evidence, rationale nor axis', () => {
    const flagged = findings((ir) => {
      const decision = ir.identity.decisions.find((entry) => entry.choice === 'tokens.color.ink')!;
      decision.evidenceIds = [];
      delete decision.rationale;
      delete decision.axis;
    });
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.message).toMatch(/no briefing evidence, no rationale and no divergence axis/i);
  });

  it('flags a decision that cites evidence the brief never declared', () => {
    const flagged = findings((ir) => { ir.identity.decisions[0]!.evidenceIds = ['ev-invented']; });
    expect(flagged.some((finding) => /strategy\.evidence does not declare/.test(finding.message))).toBe(true);
  });

  it('flags a decision that points at something the identity does not define', () => {
    const flagged = findings((ir) => { ir.identity.decisions[0]!.choice = 'tokens.color.ghost'; });
    expect(flagged.some((finding) => /not a token or a governed contract field/.test(finding.message))).toBe(true);
  });

  it('flags two decisions competing for the same choice', () => {
    const flagged = findings((ir) => { ir.identity.decisions.push({ ...ir.identity.decisions[0]!, id: 'dec-duplicate' }); });
    expect(flagged.some((finding) => /exactly one/.test(finding.message))).toBe(true);
  });
});
