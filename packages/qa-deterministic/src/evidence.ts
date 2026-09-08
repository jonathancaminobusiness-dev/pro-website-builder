import { z } from 'zod';

/** One reproducible rendering condition: a route seen at one width, state, scheme and motion setting. */
export const renderContextSchema = z.object({
  route: z.string(),
  viewport: z.number().int().positive(),
  state: z.string(),
  colorScheme: z.enum(['light', 'dark']),
  reducedMotion: z.boolean(),
}).strict();

export const boxSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).strict();

/** What the browser reports about a single rendered `data-node-id`. */
export const nodeGeometrySchema = z.object({
  nodeId: z.string(),
  tag: z.string(),
  parentNodeId: z.string().optional(),
  box: boxSchema,
  clientWidth: z.number(),
  clientHeight: z.number(),
  scrollWidth: z.number(),
  scrollHeight: z.number(),
  overflowHidden: z.boolean(),
  displayed: z.boolean(),
  focusable: z.boolean(),
  ellipsis: z.boolean(),
  accessibleName: z.string(),
  text: z.string(),
  gapPx: z.number().nullable(),
  paddingBlockPx: z.number().nullable(),
  paddingInlinePx: z.number().nullable(),
  marginBlockPx: z.number().nullable(),
}).strict();

export const contrastSampleSchema = z.object({
  nodeId: z.string(), foreground: z.string(), background: z.string(), fontSizePx: z.number(), bold: z.boolean(),
}).strict();

export const focusSampleSchema = z.object({
  nodeId: z.string(), outlineWidthPx: z.number(), outlineStyle: z.string(), outlineColor: z.string(), surroundingColor: z.string(), boxShadow: z.string(),
}).strict();

export const axeViolationSchema = z.object({
  id: z.string(), impact: z.enum(['critical', 'serious', 'moderate', 'minor']), help: z.string(), nodeIds: z.array(z.string()),
}).strict();

/** The complete, model-free evidence bundle a RenderHub capture produces for one context. */
export const renderEvidenceSchema = z.object({
  context: renderContextSchema,
  documentMetrics: z.object({ scrollWidth: z.number(), clientWidth: z.number(), scrollHeight: z.number(), clientHeight: z.number() }).strict(),
  nodes: z.array(nodeGeometrySchema),
  contrast: z.array(contrastSampleSchema),
  focus: z.array(focusSampleSchema),
  axeViolations: z.array(axeViolationSchema),
  consoleErrors: z.array(z.string()),
  networkErrors: z.array(z.string()),
  stable: z.boolean(),
  status: z.number().int().nullable(),
  screenshotPath: z.string(),
  domHash: z.string(),
}).strict();

export type RenderContext = z.infer<typeof renderContextSchema>;
export type NodeGeometry = z.infer<typeof nodeGeometrySchema>;
export type ContrastSample = z.infer<typeof contrastSampleSchema>;
export type FocusSample = z.infer<typeof focusSampleSchema>;
export type AxeViolation = z.infer<typeof axeViolationSchema>;
export type RenderEvidence = z.infer<typeof renderEvidenceSchema>;

export function describeContext(context: RenderContext): string {
  return `${context.route} @ ${context.viewport}px · ${context.state} · ${context.colorScheme}${context.reducedMotion ? ' · reduced motion' : ''}`;
}
