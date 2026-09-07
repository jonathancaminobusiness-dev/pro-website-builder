import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createFixtureIR } from '@pwb/domain';
import { renderDesign } from '@pwb/renderer';
import { assertBrowserInstalled, cacheKey, createRenderCases, evaluateQa } from './index.js';

describe('render hub', () => {
  it('enumerates the phase 0 responsive and state matrix', () => {
    const ir = createFixtureIR();
    const cases = createRenderCases(ir, `/preview/${ir.meta.versionId}`);
    expect(cases).toHaveLength(ir.pages.routes.length * 3 * Object.keys(ir.stateFixtures).length);
    expect(cases).toEqual(expect.arrayContaining([
      { route: `/preview/${ir.meta.versionId}/`, width: 360, state: 'default', reducedMotion: false },
      { route: `/preview/${ir.meta.versionId}/`, width: 360, state: 'reduced', reducedMotion: true },
      { route: `/preview/${ir.meta.versionId}/proof`, width: 1440, state: 'default', reducedMotion: false },
    ]));
  });

  it('names the install command when Playwright has no browser to measure with', () => {
    expect(() => assertBrowserInstalled(join(tmpdir(), 'pwb-chromium-that-is-not-installed'))).toThrow(/playwright install chromium/);
  });

  it('uses a content-addressed render cache key and deterministic QA checks', () => {
    const ir = createFixtureIR();
    const rendered = renderDesign(ir);
    const renderCase = createRenderCases(ir, `/preview/${ir.meta.versionId}`)[0]!;
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
    expect(() => createRenderCases(ir, '/preview/v0')).toThrow(/cannot apply/i);
  });
});
