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
    expect(cacheKey(rendered, createRenderCases(ir)[0]!)).toHaveLength(64);
    expect(evaluateQa({ scrollWidth: 100, clientWidth: 100, status: 200, consoleErrors: [], networkErrors: [] }).passed).toBe(true);
    expect(evaluateQa({ scrollWidth: 120, clientWidth: 100, status: 200, consoleErrors: ['boom'], networkErrors: [] }).passed).toBe(false);
    expect(evaluateQa({ scrollWidth: 100, clientWidth: 100, status: 404, consoleErrors: [], networkErrors: [] }).passed).toBe(false);
    expect(evaluateQa({ scrollWidth: 100, clientWidth: 100, status: null, consoleErrors: [], networkErrors: [] }).passed).toBe(false);
  });
});
