import { flattenTokens, type IdentitySpec } from '@pwb/domain';

/**
 * A font file the owner supplied together with the terms that came with it.
 * The compiler never downloads a font: a face reaches the release only when the
 * owner handed over the bytes and the licence at the same time.
 */
export interface FontSource {
  family: string;
  weight: string;
  style: 'normal' | 'italic';
  format: 'woff2' | 'woff';
  bytes: Uint8Array;
  license: string;
  licenseUrl?: string;
  source: string;
  author: string;
  date: string;
  unicodeRange?: string;
}

export interface FontDecision {
  family: string;
  weight: string;
  style: FontSource['style'];
  selfHosted: boolean;
  reason: string;
  license: string;
  path?: string;
}

export interface FontPlan {
  decisions: FontDecision[];
  files: Array<{ path: string; contents: Uint8Array }>;
  css: string;
  /** Font families the identity declares without a generic fallback at the end of the stack. */
  missingFallbacks: Array<{ tokenPath: string; value: string }>;
}

/**
 * Licences under which redistributing the font file with the site is the point
 * of the licence. Anything else stays unhosted and falls back to the stack, so
 * an ambiguous licence degrades the typography instead of shipping a file the
 * owner may not redistribute.
 */
const SELF_HOSTABLE_LICENSES = new Set([
  'ofl-1.1', 'sil-ofl-1.1', 'sil open font license 1.1', 'apache-2.0', 'apache license 2.0',
  'mit', 'cc0-1.0', 'ufl-1.0', 'ubuntu font licence 1.0', 'cc-by-4.0',
]);

const GENERIC_FAMILIES = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji', 'fangsong',
]);

export function isSelfHostableLicense(license: string): boolean {
  return SELF_HOSTABLE_LICENSES.has(license.trim().toLowerCase());
}

/** The last entry of a font stack must be a generic family the browser always has. */
export function hasGenericFallback(stack: string): boolean {
  const families = stack.split(',').map((family) => family.trim().replaceAll(/^["']|["']$/g, '').toLowerCase());
  const last = families.at(-1);
  return last !== undefined && GENERIC_FAMILIES.has(last);
}

function fileStem(font: FontSource): string {
  return `${font.family}-${font.weight}-${font.style}`.toLowerCase().replaceAll(/[^a-z0-9-]+/g, '-').replaceAll(/-+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Decides which faces the release self-hosts, emits their `@font-face` rules,
 * and reports every fontFamily token that would leave a visitor with no
 * readable fallback.
 */
export function planFonts(identity: IdentitySpec, fonts: FontSource[], hashOf: (bytes: Uint8Array) => string): FontPlan {
  const decisions: FontDecision[] = [];
  const files: FontPlan['files'] = [];
  const faces: string[] = [];
  const ordered = [...fonts].sort((a, b) => (fileStem(a) < fileStem(b) ? -1 : fileStem(a) > fileStem(b) ? 1 : 0));
  for (const font of ordered) {
    const base: Omit<FontDecision, 'selfHosted' | 'reason' | 'path'> = { family: font.family, weight: font.weight, style: font.style, license: font.license };
    if (!font.license.trim()) { decisions.push({ ...base, selfHosted: false, reason: 'The face arrived without a licence record.' }); continue; }
    if (!isSelfHostableLicense(font.license)) { decisions.push({ ...base, selfHosted: false, reason: `Licence ${font.license} does not clearly permit redistributing the file with the site.` }); continue; }
    const path = `assets/fonts/${fileStem(font)}.${hashOf(font.bytes).slice(0, 12)}.${font.format}`;
    files.push({ path, contents: font.bytes });
    decisions.push({ ...base, selfHosted: true, reason: `Licence ${font.license} permits self-hosting.`, path });
    faces.push([
      '@font-face{',
      `font-family:"${font.family.replaceAll('"', '')}";`,
      `font-style:${font.style};`,
      `font-weight:${font.weight};`,
      'font-display:swap;',
      `src:url("/${path}") format("${font.format}");`,
      ...(font.unicodeRange ? [`unicode-range:${font.unicodeRange};`] : []),
      '}',
    ].join(''));
  }

  const missingFallbacks: FontPlan['missingFallbacks'] = [];
  for (const [tokenPath, token] of flattenTokens(identity.tokens)) {
    if (token.$type !== 'fontFamily' || typeof token.$value !== 'string') continue;
    if (/^\{[^}]+\}$/.test(token.$value)) continue;
    if (!hasGenericFallback(token.$value)) missingFallbacks.push({ tokenPath, value: token.$value });
  }

  return { decisions, files, css: faces.join('\n'), missingFallbacks };
}
