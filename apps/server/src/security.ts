export const STUDIO_ORIGIN = 'http://127.0.0.1:5173';
export const STUDIO_PREVIEW_BUILD_ORIGIN = 'http://127.0.0.1:4173';
export const PREVIEW_ORIGIN = 'http://127.0.0.1:4311';
export const STUDIO_ORIGINS = [STUDIO_ORIGIN, STUDIO_PREVIEW_BUILD_ORIGIN] as const;

export function previewHeaders(): Record<string, string> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors ${STUDIO_ORIGINS.join(' ')}; script-src 'none'`,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
}
