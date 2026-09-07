import { z } from 'zod';
import { identitySpecSchema } from './identity.js';
import { cssTokenIssues, resolveTokens } from './tokens.js';
import { documentRules } from './rules.js';

export const nodeKindSchema = z.enum(['stack', 'grid', 'cluster', 'media', 'type', 'surface', 'ornament', 'component']);
export const visualValueSchema = z.union([z.string(), z.number(), z.boolean()]);
export const tokenReferenceSchema = z.string({ invalid_type_error: documentRules.visualPropTokens }).regex(/^\{[^}]+\}$/, documentRules.visualPropTokens);
export const visualPropsSchema = z.object({
  color: tokenReferenceSchema, background: tokenReferenceSchema, padding: tokenReferenceSchema, paddingBlock: tokenReferenceSchema,
  paddingInline: tokenReferenceSchema, gap: tokenReferenceSchema, radius: tokenReferenceSchema, font: tokenReferenceSchema,
  fontSize: tokenReferenceSchema, fontWeight: tokenReferenceSchema, shadow: tokenReferenceSchema, motion: tokenReferenceSchema,
  width: tokenReferenceSchema, height: tokenReferenceSchema, margin: tokenReferenceSchema, maxWidth: tokenReferenceSchema,
}).partial();
export const visualPropKeys = new Set<string>(Object.keys(visualPropsSchema.shape));
export const nodePropsSchema = visualPropsSchema.extend({ text: z.string().optional(), href: z.string().optional() }).strict();

export const routeSchema = z.string()
  .regex(/^\/$|^(?:\/[A-Za-z0-9\-._~]+)+$/, 'Route must start with / and use non-empty unreserved path segments without a trailing slash.')
  .refine((route) => route.split('/').every((segment) => segment !== '.' && segment !== '..'), 'Route segments must not traverse directories.');

export const semanticSchema = z.enum(['h1', 'h2', 'h3', 'p', 'link', 'button', 'section', 'figure', 'div']);
export const phrasingSemantics = new Set<string>(['h1', 'h2', 'h3', 'p', 'link', 'button']);
/** The two semantics a keyboard can reach: a link, which carries the route it opens, and a button. */
export const interactiveSemantics = new Set<string>(['link', 'button']);

/**
 * A responsive rule the renderer actually reads: at a container width of `minWidth` or more, the node
 * takes these props. Both sides stay inside the token system, so a breakpoint is as auditable as a colour.
 */
export const responsiveRuleSchema = z.object({
  minWidth: z.string(),
  props: visualPropsSchema,
}).strict();

export const pageNodeSchema = z.object({
  id: z.string(),
  kind: nodeKindSchema,
  semantic: semanticSchema,
  props: nodePropsSchema,
  slots: z.record(z.array(z.string())).default({}),
  assetId: z.string().optional(),
  responsive: z.array(responsiveRuleSchema).default([]),
}).superRefine((node, ctx) => {
  const widths = node.responsive.map((rule) => rule.minWidth);
  if (new Set(widths).size !== widths.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['responsive'], message: `${documentRules.responsiveWidths} Node ${node.id} declares one width twice.` });
  if ((node.kind === 'media') !== (node.semantic === 'figure')) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['semantic'], message: `${documentRules.mediaFigure} Node ${node.id} is a ${node.kind} declaring ${node.semantic}.` });
  if (node.assetId !== undefined && node.kind !== 'media') ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['assetId'], message: `${documentRules.mediaAsset} Node ${node.id} is a ${node.kind}.` });
  if (phrasingSemantics.has(node.semantic) && slotChildIds(node).length > 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['slots'], message: `${documentRules.phrasingLeaf} Node ${node.id} renders as ${node.semantic}.` });
  const interactive = interactiveSemantics.has(node.semantic);
  if (interactive && node.kind !== 'component') ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['kind'], message: `${documentRules.interactiveControl} Node ${node.id} is a ${node.kind} declaring ${node.semantic}.` });
  if (interactive && (node.props.text ?? '').trim() === '') ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['props', 'text'], message: `${documentRules.interactiveControl} Node ${node.id} carries no label.` });
  if (node.semantic === 'link') {
    const href = routeSchema.safeParse(node.props.href);
    if (!href.success) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['props', 'href'], message: `${documentRules.interactiveControl} Node ${node.id} points at ${String(node.props.href)}, which is not a route of this site.` });
  } else if (node.props.href !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['props', 'href'], message: `${documentRules.interactiveControl} Node ${node.id} declares href while rendering as ${node.semantic}.` });
  }
});

export function slotChildIds(node: { slots: Record<string, string[]> }): string[] {
  return Object.keys(node.slots).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).flatMap((slot) => node.slots[slot]!);
}

export const pageSchema = z.object({
  id: z.string(), route: routeSchema, title: z.string(), rootNodeId: z.string(), nodes: z.array(pageNodeSchema),
}).superRefine((page, ctx) => {
  const byId = new Map(page.nodes.map((node) => [node.id, node]));
  if (byId.size !== page.nodes.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['nodes'], message: `${documentRules.pageGraph} Page ${page.id} declares duplicate node ids.` });
  const root = byId.get(page.rootNodeId);
  if (!root) { ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rootNodeId'], message: `${documentRules.pageGraph} Page ${page.id} has no node ${page.rootNodeId} to use as its root.` }); return; }
  const visited = new Set([root.id]);
  const walk = (node: typeof root): void => {
    for (const childId of slotChildIds(node)) {
      const child = byId.get(childId);
      if (!child) { ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['nodes'], message: `${documentRules.pageGraph} Node ${node.id} references unknown node ${childId}.` }); continue; }
      if (visited.has(childId)) { ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['nodes'], message: `${documentRules.pageGraph} Node ${childId} appears more than once in the page graph.` }); continue; }
      visited.add(childId);
      walk(child);
    }
  };
  walk(root);
  for (const node of page.nodes) {
    if (!visited.has(node.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['nodes'], message: `${documentRules.pageGraph} Node ${node.id} is not reachable from the page root ${page.rootNodeId}.` });
  }
});

export const assetCropSchema = z.object({
  focalX: z.number().min(0).max(1), focalY: z.number().min(0).max(1), aspect: z.string().regex(/^\d+:\d+$/, 'A crop aspect must read as width:height.'),
}).strict();

export const assetSchema = z.object({
  id: z.string(), kind: z.enum(['raster', 'vector', 'font', 'manual']), uri: z.string(), alt: z.string(),
  provenance: z.object({ source: z.string(), author: z.string(), license: z.string().min(1, 'An asset must record the license its provenance grants before the site can be exported.'), date: z.string(), hash: z.string(), prompt: z.string().optional(), model: z.string().optional(), termsNote: z.string().optional() }),
  status: z.enum(['placeholder', 'ready', 'failed']),
  crop: assetCropSchema.optional(),
});

export const pagesSchema = z.object({ routes: z.array(pageSchema) }).superRefine((pages, ctx) => {
  for (const key of ['id', 'route'] as const) {
    const seen = new Set<string>();
    for (const page of pages.routes) {
      const value = key === 'route' ? page.route.toLowerCase() : page.id;
      if (seen.has(value)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['routes'], message: `${documentRules.uniquePages} Pages must not share the ${key} ${page[key]}.` });
      seen.add(value);
    }
  }
  const routes = new Set(pages.routes.map((page) => page.route.toLowerCase()));
  for (const page of pages.routes) for (const node of page.nodes) {
    if (node.semantic !== 'link' || routes.has(String(node.props.href).toLowerCase())) continue;
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['routes'], message: `${documentRules.interactiveControl} Node ${node.id} links to ${String(node.props.href)}, which is not a route this document declares.` });
  }
});
export const assetsSchema = z.object({ items: z.array(assetSchema) });
export const stateFixturesSchema = z.record(z.object({ description: z.string(), values: z.record(visualValueSchema) }));
export const reviewRecordSchema = z.object({ findings: z.array(z.string()), approvals: z.array(z.string()) });

export const designIRSchema = z.object({
  meta: z.object({ id: z.string(), projectId: z.string(), versionId: z.string(), rendererVersion: z.string(), createdAt: z.string() }),
  identity: identitySpecSchema,
  pages: pagesSchema,
  assets: assetsSchema,
  stateFixtures: stateFixturesSchema,
  reviewRecord: reviewRecordSchema,
}).superRefine((ir, ctx) => {
  let defined: Record<string, string | number | boolean>;
  try { defined = resolveTokens(ir.identity.tokens).values; }
  catch (error) { ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['identity', 'tokens'], message: error instanceof Error ? error.message : `${documentRules.tokenReferences} Token aliases do not resolve.` }); return; }
  for (const issue of cssTokenIssues(defined)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['identity', 'tokens'], message: issue.message });
  for (const page of ir.pages.routes) for (const node of page.nodes) for (const [key, value] of Object.entries(node.props)) {
    if (!visualPropKeys.has(key) || typeof value !== 'string') continue;
    const path = value.slice(1, -1);
    if (!(path in defined)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pages', 'routes'], message: `${documentRules.tokenReferences} Node ${node.id} sets ${key} to ${value}, which the identity does not define.` });
  }
  const assetsById = new Map(ir.assets.items.map((asset) => [asset.id, asset]));
  for (const page of ir.pages.routes) for (const node of page.nodes) {
    if (node.assetId === undefined) continue;
    const asset = assetsById.get(node.assetId);
    if (!asset) { ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pages', 'routes'], message: `${documentRules.mediaAsset} Node ${node.id} references the unknown asset ${node.assetId}.` }); continue; }
    if (asset.status !== 'ready') continue;
    if (asset.alt.trim() === '') ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['assets', 'items'], message: `${documentRules.mediaAsset} Asset ${asset.id} is ready but records no alt text.` });
    if (!asset.uri.startsWith('data:')) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['assets', 'items'], message: `${documentRules.mediaAsset} Asset ${asset.id} is ready but its URI ${asset.uri} is not a data: URI.` });
  }
});

export type Asset = z.infer<typeof assetSchema>;
export type AssetCrop = z.infer<typeof assetCropSchema>;
export type ResponsiveRule = z.infer<typeof responsiveRuleSchema>;
export type PageNode = z.infer<typeof pageNodeSchema>;
export type Page = z.infer<typeof pageSchema>;
export type DesignIR = z.infer<typeof designIRSchema>;
