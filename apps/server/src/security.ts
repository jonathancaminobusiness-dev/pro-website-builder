export const STUDIO_ORIGIN = 'http://127.0.0.1:5173';
export const PREVIEW_ORIGIN = 'http://127.0.0.1:4311';

export function previewHeaders(): Record<string, string> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; script-src 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
}

export function isTrustedStudioMessage(origin: string, expectedOrigin = STUDIO_ORIGIN): boolean { return origin === expectedOrigin; }
