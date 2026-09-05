import { hashJson, resolveTokens, type DesignIR, type Page, type PageNode } from '@pwb/domain';

export const RENDERER_VERSION = 'renderer-0.1.0';

export interface RenderedRoute {
  route: string;
  title: string;
  html: string;
}

export interface RenderedDocument {
  html: string;
  css: string;
  routes: RenderedRoute[];
  irHash: string;
  rendererVersion: string;
}

const visualKeys = new Set(['color', 'background', 'backgroundColor', 'padding', 'paddingBlock', 'paddingInline', 'gap', 'radius', 'font', 'fontSize', 'shadow', 'motion', 'width', 'height', 'margin', 'maxWidth']);

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function cssName(path: string): string {
  return `--${path.replaceAll('.', '-')}`;
}

function cssValue(value: string | number | boolean, values: Record<string, string | number | boolean>, node: PageNode, key: string): string {
  if (typeof value === 'string' && /^\{[^}]+\}$/.test(value)) {
    const path = value.slice(1, -1);
    if (!(path in values)) throw new Error(`Unresolved token reference ${value} on ${node.id}.${key}`);
    return `var(${cssName(path)})`;
  }
  if (node.signedException) return String(value);
  throw new Error(`Raw visual value is not token-backed: ${node.id}.${key}`);
}

function propertyName(key: string): string {
  return ({ background: 'background-color', radius: 'border-radius', font: 'font-family', motion: 'transition-duration' } as Record<string, string>)[key] ?? key;
}

function renderNode(node: PageNode, values: Record<string, string | number | boolean>): string {
  const styleEntries = Object.entries(node.props).filter(([key]) => visualKeys.has(key));
  const styles = styleEntries.map(([key, value]) => `${propertyName(key)}:${cssValue(value, values, node, key)}`).join(';');
  const styleAttribute = styles ? ` style="${escapeHtml(styles)}"` : '';
  const common = ` data-node-id="${escapeHtml(node.id)}" data-node-kind="${escapeHtml(node.kind)}"${styleAttribute}`;
  const text = typeof node.props.text === 'string' ? escapeHtml(node.props.text) : '';
  if (node.kind === 'type') {
    const tag = node.semantic === 'h1' || node.semantic === 'h2' || node.semantic === 'h3' ? node.semantic : 'p';
    return `<${tag}${common}>${text}</${tag}>`;
  }
  if (node.kind === 'media') return `<figure${common}><figcaption>${text}</figcaption></figure>`;
  if (node.kind === 'surface') return `<section${common}>${text}</section>`;
  return `<div${common}>${text}</div>`;
}

function renderPage(page: Page, values: Record<string, string | number | boolean>): string {
  const body = page.nodes.map((node) => renderNode(node, values)).join('');
  return `<main data-page-id="${escapeHtml(page.id)}" data-route="${escapeHtml(page.route)}"><h1 class="sr-only">${escapeHtml(page.title)}</h1>${body}</main>`;
}

function renderCss(ir: DesignIR, values: Record<string, string | number | boolean>): string {
  const vars = Object.entries(values).sort(([a], [b]) => a.localeCompare(b)).map(([path, value]) => `    ${cssName(path)}: ${String(value)};`).join('\n');
  return `@layer tokens, base, components;\n\n@layer tokens {\n  :root {\n${vars}\n  }\n}\n\n@layer base {\n  *, *::before, *::after { box-sizing: border-box; }\n  html { background: var(--color-paper); color: var(--color-ink); }\n  body { margin: 0; font-family: var(--type-body); }\n  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }\n  main { container-type: inline-size; min-height: 100vh; padding: var(--space-md); }\n}\n\n@layer components {\n  [data-node-kind="stack"], [data-node-kind="grid"] { display: grid; }\n  [data-node-kind="cluster"] { display: flex; flex-wrap: wrap; }\n  @container (min-width: 48rem) { main { padding-inline: var(--space-lg); } }\n  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition-duration: 0.01ms !important; scroll-behavior: auto !important; } }\n}`;
}

export function renderDesign(ir: DesignIR): RenderedDocument {
  const values = resolveTokens(ir.tokens).values;
  const css = renderCss(ir, values);
  const routes = ir.pages.routes.map((page) => ({ route: page.route, title: page.title, html: `<!doctype html><html lang="${escapeHtml(ir.identity.meta.locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body>${renderPage(page, values)}</body></html>` }));
  return { html: routes[0]?.html ?? '<!doctype html><main></main>', css, routes, irHash: hashJson(ir), rendererVersion: RENDERER_VERSION };
}
