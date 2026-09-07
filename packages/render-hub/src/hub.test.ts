import { describe, expect, it } from 'vitest';
import { createFixtureIR } from '@pwb/domain';
import { renderDesign } from '@pwb/renderer';
import { cacheKey, createRenderCases, evaluateQa } from './index.js';

describe('render hub', () => {
  it('enumerates the phase 0 responsive and state matrix', () => {
    const ir = createFixtureIR();
    const cases = createRenderCases(ir);
    expect(cases).toHaveLength(ir.pages.routes.length * 3 * Object.keys(ir.stateFixtures).length);
    expect(cases).toEqual(expect.arrayContaining([
      { route: '/', width: 360, state: 'default', reducedMotion: false },
      { route: '/', width: 360, state: 'reduced', reducedMotion: true },
    ]));
  });

  it('uses a content-addressed render cache key and deterministic QA checks', () => {
    const ir = createFixtureIR();
    const rendered = renderDesign(ir);
    const renderCase = createRenderCases(ir)[0]!;
    expect(cacheKey(rendered, renderCase)).toHaveLength(64);
    expect(cacheKey({ ...rendered, css: `${rendered.css}\nbody { container-type: inline-size; }` }, renderCase)).not.toBe(cacheKey(rendered, renderCase));
    expect(cacheKey({ ...rendered }, renderCase)).toBe(cacheKey(rendered, renderCase));
    expect(evaluateQa({ scrollWidth: 100, clientWidth: 100, status: 200, consoleErrors: [], networkErrors: [] }).passed).toBe(true);
    expect(evaluateQa({ scrollWidth: 120, clientWidth: 100, status: 200, consoleErrors: ['boom'], networkErrors: [] }).passed).toBe(false);
    expect(evaluateQa({ scrollWidth: 100, clientWidth: 100, status: 404, consoleErrors: [], networkErrors: [] }).passed).toBe(false);
    expect(evaluateQa({ scrollWidth: 100, clientWidth: 100, status: null, consoleErrors: [], networkErrors: [] }).passed).toBe(false);
  });

  it('refuses a state fixture whose values the hub cannot apply instead of reporting duplicate coverage', () => {
    const ir = createFixtureIR();
    ir.stateFixtures.dense = { description: 'Dense spacing', values: { gap: '{space.sm}' } };
    expect(() => createRenderCases(ir)).toThrow(/cannot apply/i);
  });
});
