import { describe, expect, it } from 'vitest';
import { previewHeaders, STUDIO_ORIGIN, STUDIO_PREVIEW_BUILD_ORIGIN } from './security.js';

describe('preview security boundary', () => {
  it('keeps a strict CSP that still lets the studio origins frame the preview', () => {
    const policy = previewHeaders()['Content-Security-Policy']!;
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("script-src 'none'");
    expect(policy).not.toContain('unsafe-eval');
    const frameAncestors = policy.split(';').map((directive) => directive.trim()).find((directive) => directive.startsWith('frame-ancestors'))!;
    expect(frameAncestors).toBe(`frame-ancestors ${STUDIO_ORIGIN} ${STUDIO_PREVIEW_BUILD_ORIGIN}`);
    expect(frameAncestors).not.toContain("'none'");
  });
});
