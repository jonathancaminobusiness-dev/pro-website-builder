import { describe, expect, it } from 'vitest';
import { createFixtureIR } from '@pwb/domain';
import { conditionFor, createRenderMatrix, createRepresentativeMatrix, readStateConditions, renderColorSchemes, RENDER_VIEWPORTS, REPRESENTATIVE_VIEWPORTS } from './index.js';

describe('render matrix', () => {
  it('covers every route at the six agreed widths for every declared state', () => {
    const ir = createFixtureIR();
    const cases = createRenderMatrix(ir);
    expect(RENDER_VIEWPORTS).toEqual([320, 360, 390, 768, 1024, 1440]);
    expect(cases).toHaveLength(ir.pages.routes.length * RENDER_VIEWPORTS.length * Object.keys(ir.stateFixtures).length);
    expect(new Set(cases.map((entry) => entry.width))).toEqual(new Set(RENDER_VIEWPORTS));
    expect(cases.every((entry) => entry.colorScheme === 'light')).toBe(true);
    expect(cases.filter((entry) => entry.state === 'reduced').every((entry) => entry.reducedMotion)).toBe(true);
  });

  it('narrows the Tier 1 loop to three representative widths', () => {
    const cases = createRepresentativeMatrix(createFixtureIR(), { routes: ['/'] });
    expect(new Set(cases.map((entry) => entry.width))).toEqual(new Set(REPRESENTATIVE_VIEWPORTS));
    expect(cases.every((entry) => entry.route === '/')).toBe(true);
  });

  it('adds the dark scheme only when the identity declares one', () => {
    const light = createFixtureIR();
    expect(renderColorSchemes(light)).toEqual(['light']);
    const dark = createFixtureIR();
    dark.identity.schemes = { dark: { 'color.paper': 'color.ink', 'color.ink': 'color.paper' } };
    expect(renderColorSchemes(dark)).toEqual(['light', 'dark']);
    expect(createRenderMatrix(dark, { routes: ['/'], viewports: [390] })).toHaveLength(Object.keys(dark.stateFixtures).length * 2);
  });

  it('reads the closed state vocabulary of motion, hidden nodes and focus', () => {
    const ir = createFixtureIR();
    ir.stateFixtures.error = { description: 'Falha ao carregar', values: { motion: 'full', hidden: 'home-proof, home-title', focus: 'home-root' } };
    const conditions = readStateConditions(ir);
    expect(conditions.map((condition) => condition.state)).toEqual(['default', 'error', 'reduced']);
    const error = conditionFor(ir, 'error');
    expect(error).toMatchObject({ reducedMotion: false, hiddenNodeIds: ['home-proof', 'home-title'], focusNodeId: 'home-root' });
    expect(conditionFor(ir, 'default')).toMatchObject({ hiddenNodeIds: [], focusNodeId: null });
    expect(() => conditionFor(ir, 'missing')).toThrow('no state fixture named missing');
  });
});
