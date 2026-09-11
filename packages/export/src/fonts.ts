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
  format: 'woff2';
  bytes: Uint8Array;
  license: string;
  licenseUrl?: string;
  source: string;
  author: string;
  date: string;
}

/**
 * What the release decided about one face, and the provenance the owner
 * declared for it. The licence inventory is written from these rows, so
 * everything a reader needs to trace the face to its origin travels here.
 */
export interface FontDecision {
  family: string;
  weight: string;
  style: FontSource['style'];
  format: FontSource['format'];
  selfHosted: boolean;
  reason: string;
  license: string;
  licenseUrl?: string;
  source: string;
  author: string;
  date: string;
  /** Path inside the bundle, and the hash of the bytes, when the face is self-hosted. */
  path?: string;
  hash?: string;
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
 * The `@font-face` rules for the faces a view serves, with each file addressed
 * by the caller. The release links its faces relative to the stylesheet they sit
 * beside, so it works at any base path; a preview serves them from its own
 * origin. One emission for both, so the two views cannot describe a face
 * differently.
 */
export function fontFaceCss(decisions: FontDecision[], href: (decision: FontDecision & { path: string }) => string): string {
  return decisions
    .filter((decision): decision is FontDecision & { path: string } => decision.path !== undefined)
    .map((decision) => [
      '@font-face{',
      `font-family:"${decision.family.replaceAll('"', '')}";`,
      `font-style:${decision.style};`,
      `font-weight:${decision.weight};`,
      'font-display:swap;',
      `src:url("${href(decision)}") format("${decision.format}");`,
      '}',
    ].join(''))
    .join('\n');
}

/**
 * Decides which faces may be redistributed with the site and names the file each
 * one becomes. The decision carries the provenance the owner declared, so the
 * licence inventory states it rather than inventing a substitute.
 */
export function selfHostFaces(fonts: FontSource[], hashOf: (bytes: Uint8Array) => string): { decisions: FontDecision[]; files: FontPlan['files'] } {
  const decisions: FontDecision[] = [];
  const files: FontPlan['files'] = [];
  const ordered = [...fonts].sort((a, b) => (fileStem(a) < fileStem(b) ? -1 : fileStem(a) > fileStem(b) ? 1 : 0));
  for (const font of ordered) {
    const base: Omit<FontDecision, 'selfHosted' | 'reason' | 'path' | 'hash'> = {
      family: font.family, weight: font.weight, style: font.style, format: font.format,
      license: font.license, source: font.source, author: font.author, date: font.date,
      ...(font.licenseUrl ? { licenseUrl: font.licenseUrl } : {}),
    };
    if (!font.license.trim()) { decisions.push({ ...base, selfHosted: false, reason: 'The face arrived without a licence record.' }); continue; }
    if (!isSelfHostableLicense(font.license)) { decisions.push({ ...base, selfHosted: false, reason: `Licence ${font.license} does not clearly permit redistributing the file with the site.` }); continue; }
    const hash = hashOf(font.bytes);
    const path = `assets/fonts/${fileStem(font)}.${hash.slice(0, 12)}.${font.format}`;
    files.push({ path, contents: font.bytes });
    decisions.push({ ...base, selfHosted: true, reason: `Licence ${font.license} permits self-hosting.`, path, hash });
  }
  return { decisions, files };
}

/**
 * Decides which faces the release self-hosts, emits their `@font-face` rules,
 * and reports every fontFamily token that would leave a visitor with no
 * readable fallback.
 */
export function planFonts(identity: IdentitySpec, fonts: FontSource[], hashOf: (bytes: Uint8Array) => string): FontPlan {
  const { decisions, files } = selfHostFaces(fonts, hashOf);
  const css = fontFaceCss(decisions, (decision) => decision.path.replace('assets/', ''));

  const missingFallbacks: FontPlan['missingFallbacks'] = [];
  for (const [tokenPath, token] of flattenTokens(identity.tokens)) {
    if (token.$type !== 'fontFamily' || typeof token.$value !== 'string') continue;
    if (/^\{[^}]+\}$/.test(token.$value)) continue;
    if (!hasGenericFallback(token.$value)) missingFallbacks.push({ tokenPath, value: token.$value });
  }

  return { decisions, files, css, missingFallbacks };
}

/**
 * One `@font-face` a view really declared, read back out of the bytes it served.
 *
 * The faces a preview served are the ones its document named, never the ones a
 * fonts directory would have produced: reading the plan back would compare the
 * directory against itself. `path` is the file the rule points at, addressed the
 * way the bundle addresses it, so a re-exported face reads as a different file.
 */
export interface ServedFace {
  family: string;
  weight: string;
  style: string;
  path: string;
}

const FONT_FACE_RULE = /@font-face\s*\{([^}]*)\}/gi;

function declaration(body: string, property: string): string | undefined {
  return new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'i').exec(body)?.[1]?.trim();
}

/**
 * The faces a stylesheet declares, parsed by a reader that shares no code with
 * `fontFaceCss`, so the two sides of a parity comparison cannot agree by
 * construction. A rule without a family or a file is not a face a view served.
 */
export function parseFontFaceCss(css: string, href: (url: string) => string = (url) => url): ServedFace[] {
  const faces: ServedFace[] = [];
  for (const rule of css.matchAll(FONT_FACE_RULE)) {
    const body = rule[1]!;
    const family = declaration(body, 'font-family')?.replaceAll(/^["']|["']$/g, '');
    const url = /url\(\s*["']?([^"')]+)["']?\s*\)/i.exec(declaration(body, 'src') ?? '')?.[1];
    if (family === undefined || family === '' || url === undefined) continue;
    faces.push({ family, weight: declaration(body, 'font-weight') ?? '400', style: declaration(body, 'font-style') ?? 'normal', path: href(url) });
  }
  return faces;
}
