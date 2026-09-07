import { slotChildIds, type DesignIR, type IdentitySpec, type Page } from '@pwb/domain';

export interface RouteMetadata {
  route: string;
  title: string;
  description: string;
  canonical: string;
  ogType: 'website' | 'article';
}

export interface SocialImage { url: string; alt: string }

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

/** A route always ends in a slash so the canonical URL matches the `<route>/index.html` the bundle writes. */
export function canonicalUrl(siteUrl: string, route: string): string {
  const base = new URL(siteUrl);
  const path = route === '/' ? '/' : `${route}/`;
  return new URL(path.replace(/^\//, ''), base.href.endsWith('/') ? base.href : `${base.href}/`).toString();
}

function truncate(text: string, limit = 160): string {
  const collapsed = text.replaceAll(/\s+/g, ' ').trim();
  if (collapsed.length <= limit) return collapsed;
  const cut = collapsed.slice(0, limit - 1);
  const boundary = cut.lastIndexOf(' ');
  return `${(boundary > limit / 2 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}

/**
 * The description of a route is the first body text the page shows, in reading
 * order, skipping the heading that already became the title. When a page has no
 * body text yet, the identity's promise stands in rather than a fabricated line.
 */
export function routeDescription(page: Page, identity: IdentitySpec): string {
  const byId = new Map(page.nodes.map((node) => [node.id, node]));
  const ordered: typeof page.nodes = [];
  const walk = (id: string): void => {
    const node = byId.get(id);
    if (!node || ordered.includes(node)) return;
    ordered.push(node);
    for (const childId of slotChildIds(node)) walk(childId);
  };
  walk(page.rootNodeId);
  const headings = new Set(['h1', 'h2', 'h3']);
  for (const node of ordered) {
    const text = node.props.text;
    if (typeof text !== 'string' || text.trim() === '') continue;
    // The heading already became the title; a description repeating it says nothing.
    if (headings.has(node.semantic)) continue;
    return truncate(text);
  }
  return truncate(identity.strategy.promise);
}

export function routeMetadata(ir: DesignIR, siteUrl: string): RouteMetadata[] {
  return ir.pages.routes.map((page) => ({
    route: page.route,
    title: page.title,
    description: routeDescription(page, ir.identity),
    canonical: canonicalUrl(siteUrl, page.route),
    ogType: page.route === '/' ? ('website' as const) : ('article' as const),
  }));
}

/** The `<meta>` and `<link>` tags a single route contributes to its `<head>`. */
export function headTags(metadata: RouteMetadata, options: { siteName: string; locale: string; socialImage?: SocialImage }): string {
  const tags: string[] = [
    `<meta name="description" content="${escapeHtml(metadata.description)}">`,
    `<link rel="canonical" href="${escapeHtml(metadata.canonical)}">`,
    '<meta name="robots" content="index,follow">',
    `<meta property="og:type" content="${metadata.ogType}">`,
    `<meta property="og:site_name" content="${escapeHtml(options.siteName)}">`,
    `<meta property="og:locale" content="${escapeHtml(options.locale.replace('-', '_'))}">`,
    `<meta property="og:title" content="${escapeHtml(metadata.title)}">`,
    `<meta property="og:description" content="${escapeHtml(metadata.description)}">`,
    `<meta property="og:url" content="${escapeHtml(metadata.canonical)}">`,
  ];
  if (options.socialImage) {
    tags.push(
      `<meta property="og:image" content="${escapeHtml(options.socialImage.url)}">`,
      `<meta property="og:image:alt" content="${escapeHtml(options.socialImage.alt)}">`,
      '<meta name="twitter:card" content="summary_large_image">',
    );
  } else {
    tags.push('<meta name="twitter:card" content="summary">');
  }
  tags.push(`<meta name="twitter:title" content="${escapeHtml(metadata.title)}">`, `<meta name="twitter:description" content="${escapeHtml(metadata.description)}">`);
  return tags.join('');
}

export function sitemapXml(metadata: RouteMetadata[]): string {
  const urls = [...metadata]
    .sort((a, b) => (a.canonical < b.canonical ? -1 : a.canonical > b.canonical ? 1 : 0))
    .map((entry) => `  <url>\n    <loc>${escapeHtml(entry.canonical)}</loc>\n    <changefreq>monthly</changefreq>\n    <priority>${entry.route === '/' ? '1.0' : '0.7'}</priority>\n  </url>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export function robotsTxt(siteUrl: string): string {
  const sitemap = new URL('sitemap.xml', siteUrl.endsWith('/') ? siteUrl : `${siteUrl}/`).toString();
  return `User-agent: *\nAllow: /\nSitemap: ${sitemap}\n`;
}
