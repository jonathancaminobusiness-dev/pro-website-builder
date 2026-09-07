import type { DesignIR } from '@pwb/domain';

/**
 * The policy is derived from what the bundle actually contains, not from a
 * template: the compiler moves every inline style into a stylesheet and ships
 * no script, so the release can state `script-src 'none'` and
 * `style-src 'self'` truthfully.
 */
export interface CspPlan {
  /** The policy safe to deliver in a `<meta http-equiv>` tag. */
  meta: string;
  /** The full policy, including the directives a `<meta>` tag is required to ignore. */
  header: string;
  headers: Record<string, string>;
}

/** Directives the HTML spec requires a document to ignore when they arrive in a `<meta>` tag. */
const META_IGNORED = new Set(['frame-ancestors', 'report-uri', 'sandbox']);

function originsOf(uris: string[]): string[] {
  const origins = new Set<string>();
  for (const uri of uris) {
    if (!/^https?:\/\//i.test(uri)) continue;
    try { origins.add(new URL(uri).origin); } catch { /* a URI the policy cannot allow stays out of it */ }
  }
  return [...origins].sort();
}

export function planCsp(ir: DesignIR, options: { imageUris?: string[] } = {}): CspPlan {
  const imageOrigins = originsOf([...ir.assets.items.map((asset) => asset.uri), ...(options.imageUris ?? [])]);
  const directives: Array<[string, string]> = [
    ["default-src", "'none'"],
    ['style-src', "'self'"],
    ['img-src', ["'self'", 'data:', ...imageOrigins].join(' ')],
    ['font-src', "'self'"],
    ['script-src', "'none'"],
    ['connect-src', "'none'"],
    ['object-src', "'none'"],
    ['base-uri', "'none'"],
    ['form-action', "'none'"],
    ['frame-ancestors', "'none'"],
  ];
  const serialize = (entries: Array<[string, string]>): string => entries.map(([name, value]) => `${name} ${value}`).join('; ');
  const header = serialize(directives);
  return {
    meta: serialize(directives.filter(([name]) => !META_IGNORED.has(name))),
    header,
    headers: {
      'Content-Security-Policy': header,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    },
  };
}
