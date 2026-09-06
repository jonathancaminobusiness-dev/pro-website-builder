import { z } from 'zod';
import { identitySpecSchema } from './identity.js';
import { tokenGroupSchema } from './tokens.js';

export const nodeKindSchema = z.enum(['stack', 'grid', 'cluster', 'media', 'type', 'surface', 'ornament', 'component']);
export const visualValueSchema = z.union([z.string(), z.number(), z.boolean()]);
export const visualPropKeys = new Set(['color', 'background', 'backgroundColor', 'padding', 'paddingBlock', 'paddingInline', 'gap', 'radius', 'font', 'fontSize', 'shadow', 'motion', 'width', 'height', 'margin', 'maxWidth']);

export const routeSchema = z.string()
  .regex(/^\/[A-Za-z0-9\-._~/]*$/, 'Route must start with / and use unreserved path characters.')
  .refine((route) => route.split('/').every((segment) => segment !== '.' && segment !== '..'), 'Route segments must not traverse directories.');

export const pageNodeSchema = z.object({
  id: z.string(),
  kind: nodeKindSchema,
  semantic: z.string(),
  props: z.record(visualValueSchema),
  slots: z.record(z.array(z.string())).default({}),
  responsive: z.array(z.object({ container: z.string(), rule: z.string() })).default([]),
  signedException: z.object({ reason: z.string(), approver: z.literal('captain'), signature: z.string() }).optional(),
});

export const pageSchema = z.object({
  id: z.string(), route: routeSchema, title: z.string(), rootNodeId: z.string(), nodes: z.array(pageNodeSchema),
});

export const assetSchema = z.object({
  id: z.string(), kind: z.enum(['raster', 'vector', 'font', 'manual']), uri: z.string(), alt: z.string(),
  provenance: z.object({ source: z.string(), author: z.string(), license: z.string(), date: z.string(), hash: z.string(), prompt: z.string().optional(), model: z.string().optional(), termsNote: z.string().optional() }),
  status: z.enum(['placeholder', 'ready', 'failed']),
});

export const designIRSchema = z.object({
  meta: z.object({ id: z.string(), projectId: z.string(), versionId: z.string(), rendererVersion: z.string(), createdAt: z.string() }),
  identity: identitySpecSchema,
  tokens: tokenGroupSchema,
  pages: z.object({ routes: z.array(pageSchema) }),
  assets: z.object({ items: z.array(assetSchema) }),
  stateFixtures: z.record(z.object({ description: z.string(), values: z.record(visualValueSchema) })),
  reviewRecord: z.object({ findings: z.array(z.string()), approvals: z.array(z.string()) }),
});

export type PageNode = z.infer<typeof pageNodeSchema>;
export type Page = z.infer<typeof pageSchema>;
export type DesignIR = z.infer<typeof designIRSchema>;
export const DesignIRSchema = designIRSchema;
