export const STUDIO_ORIGIN = process.env.PWB_STUDIO_ORIGIN ?? 'http://127.0.0.1:5173';
export const PREVIEW_ORIGIN = 'http://127.0.0.1:4311';

export function previewHeaders(): Record<string, string> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors ${STUDIO_ORIGIN}; script-src 'none'`,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
}
