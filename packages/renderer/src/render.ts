import { cssCustomPropertyName, cssTokenIssues, documentRules, hashJson, resolveTokens, slotChildIds, visualPropKeys, type Asset, type DesignIR, type IdentitySpec, type Page, type PageNode } from '@pwb/domain';

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

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function roleVar(identity: IdentitySpec, role: keyof IdentitySpec['tokenRoles'], values: Record<string, string | number | boolean>): string {
  const path = identity.tokenRoles[role];
  if (!(path in values)) throw new Error(`Token role ${role} points at ${path}, which the document does not define.`);
  return `var(${cssCustomPropertyName(path)})`;
}

function cssValue(value: string, values: Record<string, string | number | boolean>, node: PageNode, key: string): string {
  if (/^\{[^}]+\}$/.test(value)) {
    const path = value.slice(1, -1);
    if (!(path in values)) throw new Error(`${documentRules.tokenReferences} Unresolved token reference ${value} on ${node.id}.${key}`);
    return `var(${cssCustomPropertyName(path)})`;
  }
  throw new Error(`${documentRules.visualPropTokens} Node ${node.id} sets ${key} to ${JSON.stringify(value)}.`);
}

const propertyAliases: Record<string, string> = { background: 'background-color', radius: 'border-radius', font: 'font-family', motion: 'transition-duration', shadow: 'box-shadow' };

function propertyName(key: string): string {
  return propertyAliases[key] ?? key.replaceAll(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function renderNode(node: PageNode, byId: Map<string, PageNode>, values: Record<string, string | number | boolean>, assets: Map<string, Asset>): string {
  const styleEntries = Object.entries(node.props).filter((entry): entry is [string, string] => visualPropKeys.has(entry[0]) && typeof entry[1] === 'string');
  const styles = styleEntries.map(([key, value]) => `${propertyName(key)}:${cssValue(value, values, node, key)}`).join(';');
  const styleAttribute = styles ? ` style="${escapeHtml(styles)}"` : '';
  const common = ` data-node-id="${escapeHtml(node.id)}" data-node-kind="${escapeHtml(node.kind)}"${styleAttribute}`;
  const text = node.props.text ? escapeHtml(node.props.text) : '';
  const children = slotChildIds(node).map((childId) => {
    const child = byId.get(childId);
    if (!child) throw new Error(`Node ${node.id} references unknown node ${childId}.`);
    return renderNode(child, byId, values, assets);
  }).join('');
  if (node.kind === 'media') {
    const asset = node.assetId === undefined ? undefined : assets.get(node.assetId);
    if (node.assetId !== undefined && !asset) throw new Error(`Node ${node.id} references unknown asset ${node.assetId}.`);
    const image = asset && asset.status === 'ready' ? `<img src="${escapeHtml(asset.uri)}" alt="${escapeHtml(asset.alt)}">` : '';
    return `<figure${common}>${image}<figcaption>${text}</figcaption>${children}</figure>`;
  }
  return `<${node.semantic}${common}>${text}${children}</${node.semantic}>`;
}

function renderPage(page: Page, values: Record<string, string | number | boolean>, assets: Map<string, Asset>): string {
  const byId = new Map(page.nodes.map((node) => [node.id, node]));
  const root = byId.get(page.rootNodeId);
  if (!root) throw new Error(`Page ${page.id} has no node ${page.rootNodeId} to use as its root.`);
  const body = renderNode(root, byId, values, assets);
  return `<main data-page-id="${escapeHtml(page.id)}" data-route="${escapeHtml(page.route)}">${body}</main>`;
}

function renderDarkScheme(ir: DesignIR, values: Record<string, string | number | boolean>): string {
  const overrides = Object.entries(ir.identity.schemes?.dark ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (overrides.length === 0) return '';
  const declarations = overrides.map(([target, source]) => {
    for (const path of [target, source]) if (!(path in values)) throw new Error(`The dark scheme references ${path}, which the document does not define.`);
    return `      ${cssCustomPropertyName(target)}: var(${cssCustomPropertyName(source)});`;
  }).join('\n');
  return `\n\n@layer tokens {\n  @media (prefers-color-scheme: dark) {\n    :root {\n${declarations}\n    }\n  }\n}`;
}

function renderCss(ir: DesignIR, values: Record<string, string | number | boolean>): string {
  const issues = cssTokenIssues(values);
  if (issues[0]) throw new Error(issues[0].message);
  const vars = Object.entries(values).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([path, value]) => `    ${cssCustomPropertyName(path)}: ${String(value)};`).join('\n');
  const surface = roleVar(ir.identity, 'surface', values);
  const text = roleVar(ir.identity, 'text', values);
  const bodyTypeface = roleVar(ir.identity, 'bodyTypeface', values);
  const baseSpacing = roleVar(ir.identity, 'baseSpacing', values);
  const sectionSpacing = roleVar(ir.identity, 'sectionSpacing', values);
  return `@layer tokens, base, components;\n\n@layer tokens {\n  :root {\n${vars}\n  }\n}${renderDarkScheme(ir, values)}\n\n@layer base {\n  *, *::before, *::after { box-sizing: border-box; }\n  html { background: ${surface}; color: ${text}; }\n  body { margin: 0; font-family: ${bodyTypeface}; container-type: inline-size; }\n  :where(h1, h2, h3, p, figure, figcaption) { margin: 0; }\n  main { min-height: 100vh; padding: ${baseSpacing}; }\n}\n\n@layer components {\n  [data-node-kind="stack"], [data-node-kind="grid"] { display: grid; }\n  [data-node-kind="cluster"] { display: flex; flex-wrap: wrap; }\n  @container (min-width: 48rem) { main { padding-inline: ${sectionSpacing}; } }\n  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition-duration: 0.01ms !important; scroll-behavior: auto !important; } }\n}`;
}

export function renderDesign(ir: DesignIR): RenderedDocument {
  const values = resolveTokens(ir.identity.tokens).values;
  const assets = new Map(ir.assets.items.map((asset) => [asset.id, asset]));
  const css = renderCss(ir, values);
  const routes = ir.pages.routes.map((page) => ({ route: page.route, title: page.title, html: `<!doctype html><html lang="${escapeHtml(ir.identity.meta.locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(page.title)}</title><style>${css}</style></head><body>${renderPage(page, values, assets)}</body></html>` }));
  return { html: routes[0]?.html ?? '<!doctype html><main></main>', css, routes, irHash: hashJson(ir), rendererVersion: RENDERER_VERSION };
}
