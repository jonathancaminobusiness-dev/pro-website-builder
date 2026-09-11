/**
 * The policy is derived from what the bundle actually contains, not from a
 * template: the compiler moves every inline style into a stylesheet, ships no
 * script, self-hosts every face it may redistribute, and can only carry an
 * image the document itself holds — the document schema refuses a rendered
 * asset whose URI is not `data:`. So the release states `script-src 'none'` and
 * `style-src 'self'` truthfully, and allows no origin it could never load from.
 *
 * The two directives a bundle can do without are read from the bundle rather
 * than asserted: a release that self-hosts no face states `font-src 'none'`,
 * and one that embeds no `data:` image drops `data:` from `img-src`, so the
 * policy never permits a load the bytes cannot make.
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

/** What the policy is read from: the bundle's own faces and its own bytes. */
export interface CspBundle {
  /** The faces the bundle ships. A bundle that self-hosts none never loads one. */
  fonts: ReadonlyArray<{ selfHosted: boolean }>;
  /** The text files the bundle ships, read for the URIs they actually reference. */
  documents: readonly string[];
}

/** A `data:` URI a document or a stylesheet really loads, rather than merely mentions. */
const DATA_URI = /(?:\bsrc\s*=\s*["']|\burl\(\s*["']?)data:/i;

export function planCsp(compiled: CspBundle): CspPlan {
  const directives: Array<[string, string]> = [
    ["default-src", "'none'"],
    ['style-src', "'self'"],
    ['img-src', compiled.documents.some((text) => DATA_URI.test(text)) ? "'self' data:" : "'self'"],
    ['font-src', compiled.fonts.some((decision) => decision.selfHosted) ? "'self'" : "'none'"],
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
