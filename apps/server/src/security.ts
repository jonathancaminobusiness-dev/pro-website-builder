const DEFAULT_STUDIO_ORIGIN = 'http://127.0.0.1:5173';

function parseExactOrigin(value: string, variable: string): string {
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new Error(`${variable} must contain exact http or https origins.`); }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.origin !== value) {
    throw new Error(`${variable} must contain exact http or https origins.`);
  }
  return value;
}

function parseStudioOrigins(value: string | undefined): string[] {
  return value?.split(',').map((origin) => origin.trim()).filter(Boolean).map((origin) => parseExactOrigin(origin, 'PWB_STUDIO_ORIGINS')) ?? [];
}

const configuredStudioOrigins = parseStudioOrigins(process.env.PWB_STUDIO_ORIGINS);
const configuredStudioOrigin = process.env.PWB_STUDIO_ORIGIN?.trim();

/** The primary Studio origin is retained for CSP fallbacks and backwards compatibility. */
export const STUDIO_ORIGIN = configuredStudioOrigin ? parseExactOrigin(configuredStudioOrigin, 'PWB_STUDIO_ORIGIN') : DEFAULT_STUDIO_ORIGIN;
/** Only these exact, operator-configured origins may call the local API. */
export const STUDIO_ORIGINS = Object.freeze([...new Set([STUDIO_ORIGIN, ...configuredStudioOrigins])]);
export const PREVIEW_ORIGIN = 'http://127.0.0.1:4311';

export function previewHeaders(): Record<string, string> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors ${STUDIO_ORIGINS.join(' ')}; script-src 'none'`,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
}
