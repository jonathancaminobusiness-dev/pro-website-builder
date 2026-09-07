import { z } from 'zod';
import { identitySpecSchema } from './identity.js';

export const nodeKindSchema = z.enum(['stack', 'grid', 'cluster', 'media', 'type', 'surface', 'ornament', 'component']);
export const visualValueSchema = z.union([z.string(), z.number(), z.boolean()]);
export const visualPropsSchema = z.object({
  color: visualValueSchema, background: visualValueSchema, padding: visualValueSchema, paddingBlock: visualValueSchema,
  paddingInline: visualValueSchema, gap: visualValueSchema, radius: visualValueSchema, font: visualValueSchema,
  fontSize: visualValueSchema, fontWeight: visualValueSchema, shadow: visualValueSchema, motion: visualValueSchema,
  width: visualValueSchema, height: visualValueSchema, margin: visualValueSchema, maxWidth: visualValueSchema,
}).partial();
export const visualPropKeys = new Set<string>(Object.keys(visualPropsSchema.shape));
export const nodePropsSchema = visualPropsSchema.extend({ text: z.string().optional() }).strict();

export const routeSchema = z.string()
  .regex(/^\/$|^(?:\/[A-Za-z0-9\-._~]+)+$/, 'Route must start with / and use non-empty unreserved path segments without a trailing slash.')
  .refine((route) => route.split('/').every((segment) => segment !== '.' && segment !== '..'), 'Route segments must not traverse directories.');

export const pageNodeSchema = z.object({
  id: z.string(),
  kind: nodeKindSchema,
  semantic: z.string(),
  props: nodePropsSchema,
  slots: z.record(z.array(z.string())).default({}),
  responsive: z.array(z.object({ container: z.string(), rule: z.string() })).default([]),
});

export function slotChildIds(node: { slots: Record<string, string[]> }): string[] {
  return Object.keys(node.slots).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).flatMap((slot) => node.slots[slot]!);
}

export const pageSchema = z.object({
  id: z.string(), route: routeSchema, title: z.string(), rootNodeId: z.string(), nodes: z.array(pageNodeSchema),
}).superRefine((page, ctx) => {
  const byId = new Map(page.nodes.map((node) => [node.id, node]));
  if (byId.size !== page.nodes.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['nodes'], message: `Page ${page.id} declares duplicate node ids.` });
  const root = byId.get(page.rootNodeId);
  if (!root) { ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rootNodeId'], message: `Page ${page.id} has no node ${page.rootNodeId} to use as its root.` }); return; }
  const visited = new Set([root.id]);
  const walk = (node: typeof root): void => {
    for (const childId of slotChildIds(node)) {
      const child = byId.get(childId);
      if (!child) { ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['nodes'], message: `Node ${node.id} references unknown node ${childId}.` }); continue; }
      if (visited.has(childId)) { ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['nodes'], message: `Node ${childId} appears more than once in the page graph.` }); continue; }
      visited.add(childId);
      walk(child);
    }
  };
  walk(root);
  for (const node of page.nodes) {
    if (!visited.has(node.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['nodes'], message: `Node ${node.id} is not reachable from the page root ${page.rootNodeId}.` });
  }
});

export const assetSchema = z.object({
  id: z.string(), kind: z.enum(['raster', 'vector', 'font', 'manual']), uri: z.string(), alt: z.string(),
  provenance: z.object({ source: z.string(), author: z.string(), license: z.string(), date: z.string(), hash: z.string(), prompt: z.string().optional(), model: z.string().optional(), termsNote: z.string().optional() }),
  status: z.enum(['placeholder', 'ready', 'failed']),
});

export const pagesSchema = z.object({ routes: z.array(pageSchema) }).superRefine((pages, ctx) => {
  for (const key of ['id', 'route'] as const) {
    const seen = new Set<string>();
    for (const page of pages.routes) {
      const value = key === 'route' ? page.route.toLowerCase() : page.id;
      if (seen.has(value)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['routes'], message: `Pages must not share the ${key} ${page[key]}.` });
      seen.add(value);
    }
  }
});
export const assetsSchema = z.object({ items: z.array(assetSchema) });
export const reviewRecordSchema = z.object({ findings: z.array(z.string()), approvals: z.array(z.string()) });

export const designIRSchema = z.object({
  meta: z.object({ id: z.string(), projectId: z.string(), versionId: z.string(), rendererVersion: z.string(), createdAt: z.string() }),
  identity: identitySpecSchema,
  pages: pagesSchema,
  assets: assetsSchema,
  stateFixtures: z.record(z.object({ description: z.string(), values: z.record(visualValueSchema) })),
  reviewRecord: reviewRecordSchema,
});

export type PageNode = z.infer<typeof pageNodeSchema>;
export type Page = z.infer<typeof pageSchema>;
export type DesignIR = z.infer<typeof designIRSchema>;
