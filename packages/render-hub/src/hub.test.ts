import { describe, expect, it } from 'vitest';
import { createFixtureIR } from '@pwb/domain';
import { renderDesign } from '@pwb/renderer';
import { cacheKey, createRenderCases, evaluateQa } from './index.js';

describe('render hub', () => {
  it('enumerates the phase 0 responsive and state matrix', () => {
    expect(createRenderCases()).toHaveLength(36);
    expect(createRenderCases()).toEqual(expect.arrayContaining([{ route: '/', width: 360, theme: 'light', reducedMotion: false }]));
  });

  it('uses a content-addressed render cache key and deterministic QA checks', () => {
    const ir = createFixtureIR();
    const rendered = renderDesign(ir);
    expect(cacheKey(rendered, createRenderCases()[0]!)).toHaveLength(64);
    expect(evaluateQa({ scrollWidth: 100, clientWidth: 100, consoleErrors: [], networkErrors: [] }).passed).toBe(true);
    expect(evaluateQa({ scrollWidth: 120, clientWidth: 100, consoleErrors: ['boom'], networkErrors: [] }).passed).toBe(false);
  });
});
