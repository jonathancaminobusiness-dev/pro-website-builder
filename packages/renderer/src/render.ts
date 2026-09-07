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

export interface RenderOptions {
  /**
   * Where this document is served from. The exported site sits at the root, so the default is empty;
   * the review surfaces serve it under `/preview/<versionId>`, and a link has to stay inside the
   * document being reviewed rather than walk out of the prefix that owns it.
   */
  routePrefix?: string;
}

function hrefFor(routePrefix: string, route: string): string {
  if (routePrefix === '') return route;
  return route === '/' ? `${routePrefix}/` : `${routePrefix}${route}`;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function roleVar(identity: IdentitySpec, role: keyof IdentitySpec['tokenRoles'], values: Record<string, string | number | boolean>): string {
  const path = identity.tokenRoles[role];
  if (!(path in values)) throw new Error(`Token role ${role} points at ${path}, which the document does not define.`);
  return `var(${cssCustomPropertyName(path)})`;
}

function cssValue(value: string | number | boolean, values: Record<string, string | number | boolean>, node: PageNode, key: string): string {
  if (typeof value === 'string' && /^\{[^}]+\}$/.test(value)) {
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

function renderNode(node: PageNode, byId: Map<string, PageNode>, values: Record<string, string | number | boolean>, assets: Map<string, Asset>, routePrefix: string): string {
  const common = ` data-node-id="${escapeHtml(node.id)}" data-node-kind="${escapeHtml(node.kind)}"`;
  const text = node.props.text ? escapeHtml(node.props.text) : '';
  const children = slotChildIds(node).map((childId) => {
    const child = byId.get(childId);
    if (!child) throw new Error(`Node ${node.id} references unknown node ${childId}.`);
    return renderNode(child, byId, values, assets, routePrefix);
  }).join('');
  if (node.kind === 'media') {
    const asset = node.assetId === undefined ? undefined : assets.get(node.assetId);
    if (node.assetId !== undefined && !asset) throw new Error(`Node ${node.id} references unknown asset ${node.assetId}.`);
    const image = asset && asset.status === 'ready' ? `<img src="${escapeHtml(asset.uri)}" alt="${escapeHtml(asset.alt)}">` : '';
    return `<figure${common}>${image}<figcaption>${text}</figcaption>${children}</figure>`;
  }
  if (node.semantic === 'link') return `<a href="${escapeHtml(hrefFor(routePrefix, String(node.props.href)))}"${common}>${text}</a>`;
  if (node.semantic === 'button') return `<button type="button"${common}>${text}</button>`;
  return `<${node.semantic}${common}>${text}${children}</${node.semantic}>`;
}

function renderPage(page: Page, values: Record<string, string | number | boolean>, assets: Map<string, Asset>, routePrefix: string): string {
  const byId = new Map(page.nodes.map((node) => [node.id, node]));
  const root = byId.get(page.rootNodeId);
  if (!root) throw new Error(`Page ${page.id} has no node ${page.rootNodeId} to use as its root.`);
  const body = renderNode(root, byId, values, assets, routePrefix);
  return `<main data-page-id="${escapeHtml(page.id)}" data-route="${escapeHtml(page.route)}">${body}</main>`;
}

/** The widest container width the identity declares as a breakpoint, as the literal a query can hold. */
function expandedBreakpoint(identity: IdentitySpec, values: Record<string, string | number | boolean>): string {
  const reference = identity.gridGrammar.breakpointTokens[identity.gridGrammar.breakpointTokens.length - 1]!;
  const path = /^\{([^}]+)\}$/.exec(reference);
  const literal = path ? values[path[1]!] : undefined;
  if (literal === undefined) throw new Error(`The grid grammar breakpoint ${reference} is not a token the document defines.`);
  return String(literal);
}

function breakpointPx(literal: string | number | boolean, nodeId: string): number {
  if (typeof literal === 'number') { if (Number.isFinite(literal)) return literal; throw new Error(`Responsive width is not a length: ${nodeId}.responsive ${String(literal)}`); }
  const size = typeof literal === 'string' ? /^(\d*\.?\d+)(px|rem|em)?$/.exec(literal.trim()) : null;
  if (!size) throw new Error(`Responsive width is not a length: ${nodeId}.responsive ${String(literal)}`);
  const amount = Number.parseFloat(size[1]!);
  return size[2] === 'rem' || size[2] === 'em' ? amount * 16 : amount;
}

/** The token-backed declarations of one prop bag, in a stable order so the output is byte-identical. */
function declarationsFor(props: Record<string, unknown>, values: Record<string, string | number | boolean>, node: PageNode, where: string): string[] {
  return Object.entries(props)
    .filter((entry): entry is [string, string | number | boolean] => visualPropKeys.has(entry[0]) && entry[1] !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${propertyName(key)}: ${cssValue(value, values, node, `${where}${key}`)};`);
}

/**
 * A node's own props are a stylesheet rule, not a style attribute: an attribute outranks every author
 * rule, so a container query on a property the node already declares could never apply. Emitted in the
 * same layer as, and ahead of, the queries, the two are equal specificity and source order decides.
 */
function renderNodeRules(ir: DesignIR, values: Record<string, string | number | boolean>): string {
  const blocks: string[] = [];
  for (const page of ir.pages.routes) for (const node of page.nodes) {
    const declarations = declarationsFor(node.props, values, node, '');
    if (declarations.length === 0) continue;
    blocks.push(`  [data-node-id="${escapeHtml(node.id)}"] { ${declarations.join(' ')} }`);
  }
  return blocks.length === 0 ? '' : `\n${blocks.join('\n')}`;
}

/**
 * Reads the responsive rules of every node into container queries. The width is resolved from its token
 * at build time because a container query condition cannot hold a custom property, so a breakpoint is
 * still authored as a token even though the emitted CSS carries a literal.
 */
function renderResponsive(ir: DesignIR, values: Record<string, string | number | boolean>): string {
  const blocks: string[] = [];
  for (const page of ir.pages.routes) for (const node of page.nodes) {
    const resolvedRules = node.responsive.map((rule) => {
      const reference = /^\{([^}]+)\}$/.exec(rule.minWidth);
      const literal = reference ? values[reference[1]!] : undefined;
      if (literal === undefined) throw new Error(`Responsive width is not token-backed: ${node.id}.responsive ${rule.minWidth}`);
      return { rule, literal, width: breakpointPx(literal, node.id) };
    });
    // Equal-specificity blocks are decided by source order, so the widest condition has to be emitted
    // last. Ordering by the token reference would let {space.lg} lose to the narrower {space.md}.
    for (const { rule, literal, width } of [...resolvedRules].sort((a, b) => a.width - b.width)) {
      const declarations = declarationsFor(rule.props, values, node, 'responsive.');
      if (declarations.length === 0) continue;
      blocks.push(`  @container (min-width: ${String(literal)}) {\n    [data-node-id="${escapeHtml(node.id)}"] { ${declarations.join(' ')} }\n  }`);
    }
  }
  return blocks.length === 0 ? '' : `\n${blocks.join('\n')}`;
}

function renderDarkScheme(ir: DesignIR, values: Record<string, string | number | boolean>): string {
  const overrides = Object.entries(ir.identity.schemes?.dark ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (overrides.length === 0) return '';
  // The source is emitted as its literal, not as var(--source): a pair that swaps two roles would
  // otherwise compile to a custom-property cycle, which CSS makes invalid at computed-value time.
  const declarations = overrides.map(([target, source]) => {
    for (const path of [target, source]) if (!(path in values)) throw new Error(`The dark scheme references ${path}, which the document does not define.`);
    return `      ${cssCustomPropertyName(target)}: ${String(values[source]!)};`;
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
  const expanded = expandedBreakpoint(ir.identity, values);
  return `@layer tokens, base, components;\n\n@layer tokens {\n  :root {\n${vars}\n  }\n}${renderDarkScheme(ir, values)}\n\n@layer base {\n  *, *::before, *::after { box-sizing: border-box; }\n  html { background: ${surface}; color: ${text}; }\n  body { margin: 0; font-family: ${bodyTypeface}; container-type: inline-size; }\n  :where(h1, h2, h3, p, figure, figcaption) { margin: 0; }\n  main { min-height: 100vh; padding: ${baseSpacing}; }\n  :where(a, button) { margin: 0; padding: 0; border: 0; background: none; color: inherit; font: inherit; text-align: inherit; cursor: pointer; }\n  :where(a, button):focus-visible { outline: 2px solid ${text}; outline-offset: 2px; }\n  [hidden] { display: none !important; }\n}\n\n@layer components {\n  [data-node-kind="stack"], [data-node-kind="grid"] { display: grid; }\n  [data-node-kind="cluster"] { display: flex; flex-wrap: wrap; }\n  @container (min-width: ${expanded}) { main { padding-inline: ${sectionSpacing}; } }\n  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition-duration: 0.01ms !important; scroll-behavior: auto !important; } }${renderNodeRules(ir, values)}${renderResponsive(ir, values)}\n}`;
}

export function renderDesign(ir: DesignIR, options: RenderOptions = {}): RenderedDocument {
  const routePrefix = (options.routePrefix ?? '').replace(/\/$/, '');
  const values = resolveTokens(ir.identity.tokens).values;
  const assets = new Map(ir.assets.items.map((asset) => [asset.id, asset]));
  const css = renderCss(ir, values);
  const routes = ir.pages.routes.map((page) => ({ route: page.route, title: page.title, html: `<!doctype html><html lang="${escapeHtml(ir.identity.meta.locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(page.title)}</title><style>${css}</style></head><body>${renderPage(page, values, assets, routePrefix)}</body></html>` }));
  return { html: routes[0]?.html ?? '<!doctype html><main></main>', css, routes, irHash: hashJson(ir), rendererVersion: RENDERER_VERSION };
}
