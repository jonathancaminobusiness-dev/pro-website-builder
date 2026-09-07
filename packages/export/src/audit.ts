import type { ReleaseVeto } from '@pwb/domain';
import { scanTags } from './html-scan.js';

export interface AuditableFile { path: string; contents: string | Uint8Array }

/**
 * High-signal credential shapes plus the assignment forms the Fase 0 database
 * scanner already refuses. A release bundle is public by definition, so a match
 * is a veto and never a warning.
 */
const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['anthropic key', /sk-ant-[A-Za-z0-9_-]{16,}/],
  ['openai key', /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/],
  ['github token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ['aws access key id', /\bAKIA[0-9A-Z]{16}\b/],
  ['google api key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/],
  ['pem private key', /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/],
  ['json web token', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ['bearer credential', /\bAuthorization\s*[:=]\s*["']?Bearer\s+\S{12,}/i],
  ['api_key assignment', /["']?api[_-]?key["']?\s*[:=]\s*["'][^"']{8,}["']/i],
  ['secret assignment', /["']?(?:client[_-])?secret["']?\s*[:=]\s*["'][^"']{8,}["']/i],
  ['password assignment', /["']?password["']?\s*[:=]\s*["'][^"']{6,}["']/i],
  ['private_key assignment', /["']?private[_-]?key["']?\s*[:=]\s*["'][^"']{8,}["']/i],
  ['oauth token assignment', /["']?oauth[_-]?token["']?\s*[:=]\s*["'][^"']{8,}["']/i],
];

/** Every element the deterministic renderer and this compiler are allowed to emit. */
const ALLOWED_TAGS = new Set(['html', 'head', 'meta', 'title', 'link', 'style', 'body', 'main', 'div', 'section', 'figure', 'figcaption', 'p', 'h1', 'h2', 'h3']);
const DANGEROUS_SCHEMES = /^\s*(?:javascript|vbscript|data:text\/html)/i;
const URL_ATTRIBUTES = new Set(['href', 'src', 'action', 'formaction', 'poster', 'srcset']);

function textOf(file: AuditableFile): string | undefined {
  if (typeof file.contents === 'string') return file.contents;
  return undefined;
}

/** The renderer escapes quotes, and a secret is still a secret after the browser decodes them. */
function decodeEntities(text: string): string {
  return text.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}

export function scanBundleSecrets(files: AuditableFile[]): ReleaseVeto[] {
  const vetoes: ReleaseVeto[] = [];
  for (const file of files) {
    const text = textOf(file);
    if (text === undefined) continue;
    const decoded = decodeEntities(text);
    for (const [name, pattern] of SECRET_PATTERNS) {
      if (pattern.test(text) || pattern.test(decoded)) vetoes.push({ id: 'SECRET_IN_BUNDLE', detector: 'compiler', where: file.path, detail: `The bundle file ${file.path} contains a ${name}.` });
    }
  }
  return vetoes;
}

export interface HtmlAuditContext {
  /** Paths present in the bundle, used to prove every internal link resolves. */
  paths: Set<string>;
  /** The site's base path, stripped before a link is matched against the bundle. */
  basePath: string;
}

function internalTarget(url: string): string | undefined {
  if (url.startsWith('//')) return undefined;
  if (!url.startsWith('/')) return undefined;
  const [withoutFragment] = url.split('#');
  const [path] = withoutFragment!.split('?');
  return path;
}

export function auditHtmlDocument(path: string, html: string, context: HtmlAuditContext): ReleaseVeto[] {
  const vetoes: ReleaseVeto[] = [];
  let tags;
  try { tags = scanTags(html); }
  catch (error) { return [{ id: 'BUILD_FAILED', detector: 'compiler', where: path, detail: error instanceof Error ? error.message : 'The compiled document could not be scanned.' }]; }

  for (const tag of tags) {
    if (!ALLOWED_TAGS.has(tag.name)) {
      vetoes.push({ id: 'UNSANITIZED_HTML', detector: 'compiler', where: path, detail: `The document emits <${tag.name}>, which is not an element the deterministic renderer produces.` });
    }
    if (tag.closing) continue;
    for (const attribute of tag.attributes) {
      if (/^on[a-z]+$/.test(attribute.name)) {
        vetoes.push({ id: 'XSS_OR_JAVASCRIPT_URL', detector: 'compiler', where: path, detail: `<${tag.name}> carries the inline event handler ${attribute.name}.` });
        continue;
      }
      if (!URL_ATTRIBUTES.has(attribute.name)) continue;
      const value = attribute.value.replaceAll('&amp;', '&');
      if (DANGEROUS_SCHEMES.test(value)) {
        vetoes.push({ id: 'XSS_OR_JAVASCRIPT_URL', detector: 'compiler', where: path, detail: `<${tag.name} ${attribute.name}> points at the executable URL ${value}.` });
        continue;
      }
      // `srcset` carries a comma-separated list; every candidate must resolve.
      const urls = attribute.name === 'srcset' ? value.split(',').map((entry) => entry.trim().split(/\s+/)[0] ?? '') : [value];
      for (const url of urls) {
        const absolute = internalTarget(url);
        if (absolute === undefined || absolute === '') continue;
        const target = context.basePath !== '' && absolute.startsWith(`${context.basePath}/`) ? absolute.slice(context.basePath.length) : absolute;
        const stripped = target.replace(/^\//, '').replace(/\/$/, '');
        if (![target.replace(/^\//, ''), `${stripped}/index.html`].some((candidate) => context.paths.has(candidate))) {
          vetoes.push({ id: 'BROKEN_PRIMARY_LINK', detector: 'compiler', where: path, detail: `<${tag.name} ${attribute.name}> points at ${url}, which the bundle does not contain.` });
        }
      }
    }
  }
  return vetoes;
}

/** Every route the approved document declares must have produced a document in the bundle. */
export function auditRouteCoverage(routes: string[], paths: Set<string>): ReleaseVeto[] {
  return routes
    .filter((route) => !paths.has(`${route.replace(/^\//, '').replace(/\/$/, '')}${route === '/' ? '' : '/'}index.html`.replace(/^\//, '')))
    .map((route) => ({ id: 'BROKEN_PRIMARY_LINK' as const, detector: 'compiler' as const, where: route, detail: `The approved document declares the route ${route}, which the bundle does not contain.` }));
}
