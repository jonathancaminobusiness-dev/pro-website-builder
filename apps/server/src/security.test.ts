import { describe, expect, it } from 'vitest';
import { previewHeaders, isTrustedStudioMessage } from './security.js';

describe('preview security boundary', () => {
  it('sets a strict CSP and allows only the exact studio origin for messages', () => {
    expect(previewHeaders()['Content-Security-Policy']).toContain("default-src 'none'");
    expect(previewHeaders()['Content-Security-Policy']).not.toContain('unsafe-eval');
    expect(isTrustedStudioMessage('http://127.0.0.1:5173', 'http://127.0.0.1:5173')).toBe(true);
    expect(isTrustedStudioMessage('http://evil.test', 'http://127.0.0.1:5173')).toBe(false);
  });
});
