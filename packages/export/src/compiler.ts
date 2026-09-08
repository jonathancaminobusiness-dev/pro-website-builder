import { createHash } from 'node:crypto';
import { hashJson, resolveTokens, type DesignIR, type ReleaseVeto } from '@pwb/domain';
import type { RenderedDocument } from '@pwb/renderer';
import { auditHtmlDocument, auditRouteCoverage, scanBundleSecrets } from './audit.js';
import { isFallbackFailure, needsColorFallback, srgbFallbackValue, supportsConditionFor } from './css-color.js';
import { planCsp } from './csp.js';
import { planFonts, type FontDecision, type FontSource } from './fonts.js';
import { extractInlineStyles, replaceOnce, scanTags, styleRules, unescapeHtml, type ExtractedStyle } from './html-scan.js';
import { buildLicenseInventory, isUsableLicense, type LicenseInventory } from './licenses.js';
import { headTags, robotsTxt, routeMetadata, sitemapXml, type RouteMetadata } from './metadata.js';

export const COMPILER_VERSION = 'compiler-0.1.0';

export interface ReleaseCompilerOptions {
  /** Absolute origin the release will be served from; canonical URLs and the sitemap need it. */
  siteUrl: string;
  siteName: string;
  fonts?: FontSource[];
}

export interface CompiledFile { path: string; contents: string | Uint8Array; hash: string; bytes: number }
export interface CompiledRoute extends RouteMetadata { path: string }

export interface CompiledSite {
  digest: string;
  irHash: string;
  rendererVersion: string;
  compilerVersion: string;
  siteUrl: string;
  siteName: string;
  csp: string;
  headers: Record<string, string>;
  stylesheetPath: string;
  files: CompiledFile[];
  routes: CompiledRoute[];
  fonts: FontDecision[];
  licenses: LicenseInventory;
  /** Every deterministic veto the compiler can see from the bundle alone. */
  vetoes: ReleaseVeto[];
}

function sha256(contents: string | Uint8Array): string {
  return createHash('sha256').update(typeof contents === 'string' ? Buffer.from(contents, 'utf8') : contents).digest('hex');
}

function byteLength(contents: string | Uint8Array): number {
  return typeof contents === 'string' ? Buffer.byteLength(contents, 'utf8') : contents.byteLength;
}

function routeFilePath(route: string): string {
  const segments = route.split('/').filter((segment) => segment !== '');
  if (segments.some((segment) => segment === '.' || segment === '..')) throw new Error(`Cannot compile a route that escapes the export root: ${route}`);
  return [...segments, 'index.html'].join('/');
}

const ROOT_SELECTOR = ':root {';
const CUSTOM_PROPERTY = /^(\s*)(--[A-Za-z0-9_-]+):\s*(.+);\s*$/;

interface RootRule { start: number; end: number; indent: string; body: string }

/** Every `:root` rule of the rendered sheet: the token block and the dark scheme's override block. */
function rootRules(css: string): RootRule[] {
  const rules: RootRule[] = [];
  for (let index = css.indexOf(ROOT_SELECTOR); index !== -1; index = css.indexOf(ROOT_SELECTOR, index + 1)) {
    const open = index + ROOT_SELECTOR.length - 1;
    const close = css.indexOf('}', open);
    if (close === -1) continue;
    const lineStart = css.lastIndexOf('\n', index) + 1;
    const indent = css.slice(lineStart, index);
    rules.push({ start: index, end: close + 1, indent: /^\s*$/.test(indent) ? indent : '', body: css.slice(open + 1, close) });
  }
  return rules;
}

/**
 * One `:root` rule with an sRGB value in place of every modern colour, followed
 * by an `@supports` sibling that re-declares the authored values.
 *
 * The companion has to sit where the declaration it replaces sits: an unlayered
 * block would outrank every layered one, so re-declaring the base tokens
 * outside `@layer tokens` would silently drop the dark scheme in exactly the
 * browsers that can render the authored colour.
 */
function rewriteRootRule(rule: RootRule): string {
  const modern = new Map<string, string[]>();
  const body = rule.body.split('\n').map((line) => {
    const declaration = CUSTOM_PROPERTY.exec(line);
    if (!declaration) return line;
    const lead = declaration[1]!;
    const property = declaration[2]!;
    const value = declaration[3]!;
    if (!needsColorFallback(value)) return line;
    const fallback = srgbFallbackValue(value);
    if (fallback === undefined || isFallbackFailure(fallback)) return line;
    const condition = supportsConditionFor(value);
    modern.set(condition, [...(modern.get(condition) ?? []), `${property}: ${value};`]);
    return `${lead}${property}: ${fallback.text};`;
  }).join('\n');
  const blocks = [...modern.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([condition, declarations]) => `\n${rule.indent}@supports (${condition}) {\n${rule.indent}  :root {\n${declarations.map((line) => `${rule.indent}    ${line}`).join('\n')}\n${rule.indent}  }\n${rule.indent}}`);
  return `${ROOT_SELECTOR}${body}}${blocks.join('')}`;
}

/**
 * Rewrites every `:root` rule so browsers without wide-gamut colour still
 * resolve each custom property, and re-declares the authored value in an
 * `@supports` block beside the rule it came from. A colour the compiler cannot
 * express in sRGB is a veto, reported against the token that declares it.
 */
function applyColorFallbacks(css: string, ir: DesignIR): { css: string; vetoes: ReleaseVeto[] } {
  const { values } = resolveTokens(ir.identity.tokens);
  const vetoes: ReleaseVeto[] = [];
  for (const path of Object.keys(values).sort()) {
    const value = values[path];
    if (typeof value !== 'string' || !needsColorFallback(value)) continue;
    const fallback = srgbFallbackValue(value);
    if (fallback !== undefined && isFallbackFailure(fallback)) vetoes.push({ id: 'BUILD_FAILED', detector: 'compiler', where: `/identity/tokens/${path.replaceAll('.', '/')}`, detail: fallback.reason });
  }
  let rewritten = '';
  let cursor = 0;
  for (const rule of rootRules(css)) {
    rewritten += css.slice(cursor, rule.start) + rewriteRootRule(rule);
    cursor = rule.end;
  }
  return { css: rewritten + css.slice(cursor), vetoes };
}

/**
 * The assets whose bytes the bundle ships, read back out of the documents the
 * compiler wrote. Only a `data:` asset a document references travels inside the
 * bundle: a document that points at a remote URI ships nothing, and an asset no
 * page references is never written at all.
 */
function bundledAssetIds(documents: string[], ir: DesignIR): Set<string> {
  const referenced = new Set<string>();
  for (const document of documents) {
    let tags;
    try { tags = scanTags(document); }
    catch { continue; }
    for (const tag of tags) {
      if (tag.closing) continue;
      const source = tag.attributes.find((attribute) => attribute.name === 'src');
      if (source) referenced.add(unescapeHtml(source.value));
    }
  }
  return new Set(ir.assets.items.filter((asset) => asset.uri.startsWith('data:') && referenced.has(asset.uri)).map((asset) => asset.id));
}

const STYLESHEET_PLACEHOLDER = '__PWB_STYLESHEET_HREF__';

/**
 * Compiles an approved document and its rendered output into the exact file set
 * of a release. The compiler never writes to disk and never throws for a
 * content problem: it returns the bundle together with every veto it found, so
 * the release critics can read the same evidence the gate reads.
 */
export function compileRelease(rendered: RenderedDocument, ir: DesignIR, options: ReleaseCompilerOptions): CompiledSite {
  const vetoes: ReleaseVeto[] = [];
  let siteUrl: string;
  try {
    const parsed = new URL(options.siteUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('unsupported scheme');
    siteUrl = parsed.origin + parsed.pathname.replace(/\/$/, '');
  } catch {
    throw new Error(`The release compiler needs an absolute http(s) site URL; it received ${JSON.stringify(options.siteUrl)}.`);
  }
  // Assets are linked from the site's own base path, so a release served under a
  // sub-path still resolves its stylesheet and its faces.
  const basePath = new URL(siteUrl).pathname.replace(/\/$/, '');
  const fontPlan = planFonts(ir.identity, options.fonts ?? [], (bytes) => sha256(bytes));
  for (const missing of fontPlan.missingFallbacks) {
    vetoes.push({ id: 'BUILD_FAILED', detector: 'compiler', where: `/identity/tokens/${missing.tokenPath.replaceAll('.', '/')}`, detail: `The font stack ${JSON.stringify(missing.value)} ends without a generic family, so a visitor whose browser cannot load the first face has no readable fallback.` });
  }

  const colors = applyColorFallbacks(rendered.css, ir);
  vetoes.push(...colors.vetoes);

  const metadata = routeMetadata(ir, siteUrl);
  const csp = planCsp(ir);

  // First pass: strip inline styles so the release can ship `style-src 'self'`.
  const extractions = new Map<string, { html: string; styles: ExtractedStyle[] }>();
  for (const page of ir.pages.routes) {
    const route = rendered.routes.find((candidate) => candidate.route === page.route);
    if (!route) { vetoes.push({ id: 'BUILD_FAILED', detector: 'compiler', where: page.route, detail: `The renderer produced no document for the route ${page.route}.` }); continue; }
    try { extractions.set(page.route, extractInlineStyles(route.html, page.id)); }
    catch (error) { vetoes.push({ id: 'BUILD_FAILED', detector: 'compiler', where: page.route, detail: error instanceof Error ? error.message : 'The compiler could not read the rendered document.' }); }
  }

  const allRules = ir.pages.routes.flatMap((page) => styleRules(extractions.get(page.route)?.styles ?? [])).filter((rule) => rule !== '');
  const stylesheet = [colors.css, fontPlan.css, allRules.join('\n')].filter((part) => part.trim() !== '').join('\n\n').concat('\n');
  const stylesheetPath = `assets/site.${sha256(stylesheet).slice(0, 12)}.css`;

  // Second pass: write the head each route needs and point it at the stylesheet.
  const files: Array<{ path: string; contents: string | Uint8Array }> = [];
  const routes: CompiledRoute[] = [];
  for (const entry of metadata) {
    const extraction = extractions.get(entry.route);
    if (!extraction) continue;
    const filePath = routeFilePath(entry.route);
    try {
      const withPolicy = replaceOnce(extraction.html, '<meta charset="utf-8">', `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp.meta.replaceAll('"', '&quot;')}">`);
      const head = headTags(entry, { siteName: options.siteName, locale: ir.identity.meta.locale });
      const document = replaceOnce(withPolicy, `<style>${rendered.css}</style></head>`, `${head}<link rel="stylesheet" href="${basePath}/${STYLESHEET_PLACEHOLDER}"></head>`);
      files.push({ path: filePath, contents: document.replaceAll(STYLESHEET_PLACEHOLDER, stylesheetPath) });
      routes.push({ ...entry, path: filePath });
    } catch (error) {
      vetoes.push({ id: 'BUILD_FAILED', detector: 'compiler', where: entry.route, detail: error instanceof Error ? error.message : 'The compiler could not assemble the document head.' });
    }
  }

  files.push({ path: stylesheetPath, contents: stylesheet });
  files.push(...fontPlan.files);

  const documents = files.flatMap((file) => (file.path.endsWith('.html') && typeof file.contents === 'string' ? [file.contents] : []));
  const licenses = buildLicenseInventory(ir, fontPlan.decisions, { rendererVersion: rendered.rendererVersion, compilerVersion: COMPILER_VERSION }, bundledAssetIds(documents, ir));
  for (const missing of licenses.missing) vetoes.push({ id: 'ASSET_WITHOUT_LICENSE', detector: 'compiler', where: missing.id, detail: missing.detail });

  files.push({ path: 'sitemap.xml', contents: sitemapXml(metadata) });
  files.push({ path: 'robots.txt', contents: robotsTxt(siteUrl) });
  files.push({ path: 'licenses.json', contents: `${JSON.stringify(licenses.entries, null, 2)}\n` });
  files.push({ path: 'headers.json', contents: `${JSON.stringify({ '/*': csp.headers }, null, 2)}\n` });

  const compiled: CompiledFile[] = files
    .map((file) => ({ ...file, hash: sha256(file.contents), bytes: byteLength(file.contents) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const paths = new Set(compiled.map((file) => file.path));
  for (const file of compiled) {
    if (!file.path.endsWith('.html') || typeof file.contents !== 'string') continue;
    vetoes.push(...auditHtmlDocument(file.path, file.contents, { paths, basePath }));
  }
  vetoes.push(...auditRouteCoverage(ir.pages.routes.map((page) => page.route), paths));
  vetoes.push(...scanBundleSecrets(compiled));

  const digest = hashJson({ files: compiled.map((file) => [file.path, file.hash]), compilerVersion: COMPILER_VERSION, rendererVersion: rendered.rendererVersion });

  return {
    digest,
    irHash: rendered.irHash,
    rendererVersion: rendered.rendererVersion,
    compilerVersion: COMPILER_VERSION,
    siteUrl,
    siteName: options.siteName,
    csp: csp.header,
    headers: csp.headers,
    stylesheetPath,
    files: compiled,
    routes,
    fonts: fontPlan.decisions,
    licenses,
    vetoes: dedupeVetoes(vetoes),
  };
}

function dedupeVetoes(vetoes: ReleaseVeto[]): ReleaseVeto[] {
  const seen = new Set<string>();
  const unique: ReleaseVeto[] = [];
  for (const veto of vetoes) {
    const key = `${veto.id}|${veto.where}|${veto.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(veto);
  }
  return unique.sort((a, b) => (`${a.id}${a.where}` < `${b.id}${b.where}` ? -1 : `${a.id}${a.where}` > `${b.id}${b.where}` ? 1 : 0));
}

export { isUsableLicense };
