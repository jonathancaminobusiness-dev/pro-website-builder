import { describe, expect, it } from 'vitest';
import { createFixtureIR } from '@pwb/domain';
import { compileRelease } from '@pwb/export';
import { renderDesign } from '@pwb/renderer';
import { siteFromEnvironment } from './site-environment.js';

describe('the origin a release is compiled for', () => {
  it('falls back to the same defaults every compile site uses', () => {
    expect(siteFromEnvironment({})).toEqual({ siteUrl: 'https://site.invalid', siteName: 'pro-website-builder' });
  });

  it('reads both variables', () => {
    expect(siteFromEnvironment({ PWB_SITE_URL: 'https://oficina.example', PWB_SITE_NAME: 'Oficina' }))
      .toEqual({ siteUrl: 'https://oficina.example', siteName: 'Oficina' });
  });

  /** Why a compile site may not ignore them: the origin is part of the digest. */
  it('changes the bundle digest, so a run that ignores it compiles bytes nobody measured', () => {
    const ir = createFixtureIR();
    const rendered = renderDesign(ir);
    const fallback = compileRelease(rendered, ir, siteFromEnvironment({}));
    const configured = compileRelease(rendered, ir, siteFromEnvironment({ PWB_SITE_URL: 'https://oficina.example', PWB_SITE_NAME: 'Oficina' }));
    expect(configured.digest).not.toBe(fallback.digest);
    expect(configured.files.find((file) => file.path === 'robots.txt')!.contents).toContain('https://oficina.example');
  });
});
