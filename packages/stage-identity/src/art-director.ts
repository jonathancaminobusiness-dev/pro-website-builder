import { hashJson, RASTER_IMAGERY_SOURCE, type DesignIR, type IdentitySpec } from '@pwb/domain';
import type { RasterJob, RasterProvider } from '@pwb/providers';
import type { ImagePromptPlan } from './contracts.js';

export type IdentityAsset = DesignIR['assets']['items'][number];

/** Generation is admitted by the closed source vocabulary, never by how a model spelled it. */
export function admitsGeneratedImagery(identity: IdentitySpec): boolean {
  return identity.imagery.allowedSources.includes(RASTER_IMAGERY_SOURCE);
}

export interface RasterGenerationOptions {
  provider: RasterProvider;
  identityVersionId: string;
  /** The approved contract, whose `imagery.allowedSources` decides whether anything may be generated at all. */
  identity: IdentitySpec;
  /** Assets already generated for this direction; a finished one whose digest still matches is reused, never shot again. */
  existing?: IdentityAsset[];
  model?: string;
  signal?: AbortSignal;
  date?: string;
}

export const DEFAULT_RASTER_MODEL = 'higgsfield';

/**
 * The digest covers the plan alone, so re-approving a gate a token change
 * reopened reuses the finished image it already has instead of shooting an
 * identical prompt again, while an asset that never became one is asked for
 * again under that same digest, which the provider's idempotency key makes
 * free.
 */
export function imageryDigest(directionId: string, item: ImagePromptPlan['plans'][number], model = DEFAULT_RASTER_MODEL): string {
  return hashJson({ directionId, id: item.id, prompt: item.prompt, negatives: item.negatives, aspect: item.aspect, model });
}

export function imageryAssetId(directionId: string, item: ImagePromptPlan['plans'][number]): string {
  return `asset-${directionId}-${item.id}`;
}

function termsOf(item: ImagePromptPlan['plans'][number], note: string): string {
  return `${note} Negatives: ${item.negatives.join('; ')}. Axis: ${item.axis}. Expected licence: ${item.licenceExpectation}.`;
}

/**
 * What the captain sees the moment Gate 1 closes: the image this direction is
 * about to be shot, already carrying its prompt and its digest. An image the
 * run already finished is kept as it is and never shot again; everything else
 * is `generating` until the raster task settles it, so an image in flight is
 * never mistaken for a provider that was never configured.
 */
export function plannedImagery(plan: ImagePromptPlan, options: { identity: IdentitySpec; existing?: IdentityAsset[]; model?: string; date?: string }): IdentityAsset[] {
  const model = options.model ?? DEFAULT_RASTER_MODEL;
  const date = options.date ?? new Date().toISOString().slice(0, 10);
  if (!admitsGeneratedImagery(options.identity)) return [];
  return plan.plans.map((item) => {
    const digest = imageryDigest(plan.directionId, item, model);
    const reused = options.existing?.find((asset) => asset.status === 'ready' && asset.provenance.hash === digest);
    if (reused) return reused;
    return {
      id: imageryAssetId(plan.directionId, item),
      kind: 'raster',
      uri: `placeholder:${digest.slice(0, 12)}`,
      alt: item.alt,
      provenance: {
        source: 'higgsfield-mcp',
        author: 'higgsfield',
        license: 'pending provider terms',
        date,
        hash: digest,
        prompt: item.prompt,
        model,
        termsNote: termsOf(item, 'Higgsfield MCP was asked for this image.'),
      },
      status: 'generating',
    };
  });
}

/**
 * Only the approved direction is generated, and only when its own contract
 * admits the raster source. Every asset carries the prompt, the model and the
 * licence the provider returned, so nothing enters the ledger whose origin
 * cannot be stated. A provider that is not configured still yields a
 * provenance-marked placeholder rather than a silent gap, and no credential is
 * read, logged or stored anywhere here.
 */
export async function generateImageAsset(plan: ImagePromptPlan, item: ImagePromptPlan['plans'][number], options: RasterGenerationOptions): Promise<{ asset: IdentityAsset; job?: RasterJob }> {
  const model = options.model ?? DEFAULT_RASTER_MODEL;
  const date = options.date ?? new Date().toISOString().slice(0, 10);
  const digest = imageryDigest(plan.directionId, item, model);
  const reused = options.existing?.find((asset) => asset.status === 'ready' && asset.provenance.hash === digest);
  if (reused) return { asset: reused };
  const job = await options.provider.submit({ id: `${plan.directionId}-${item.id}`, digest, prompt: item.prompt, model, aspect: item.aspect, identityVersionId: options.identityVersionId }, options.signal);
  return {
    job,
    asset: {
      id: imageryAssetId(plan.directionId, item),
      kind: 'raster',
      uri: job.uri ?? `placeholder:${digest.slice(0, 12)}`,
      alt: item.alt,
      provenance: {
        source: job.status === 'not_configured' ? 'higgsfield-mcp (not configured)' : 'higgsfield-mcp',
        author: 'higgsfield',
        license: job.provenance.license,
        date,
        hash: digest,
        prompt: item.prompt,
        model: job.provenance.model,
        termsNote: termsOf(item, job.provenance.termsNote),
      },
      status: job.status === 'succeeded' ? 'ready' : job.status === 'failed' ? 'failed' : 'placeholder',
    },
  };
}

/** A plan is only usable when it respects the direction's own imagery policy. */
export function imageryPolicyViolations(plan: ImagePromptPlan, ir: DesignIR): string[] {
  const violations: string[] = [];
  const photographyRefused = ir.identity.direction.divergence?.matrix.find((vector) => vector.directionId === plan.directionId)?.axes.imagery.key === 'no-photography';
  const generationAllowed = admitsGeneratedImagery(ir.identity);
  for (const item of plan.plans) {
    if (!generationAllowed) {
      violations.push(`Plan ${item.id} would be generated by ${RASTER_IMAGERY_SOURCE}, which this direction's allowed sources (${ir.identity.imagery.allowedSources.join(', ')}) do not admit.`);
    }
    if (photographyRefused && (item.role === 'hero' || item.role === 'portrait')) {
      violations.push(`Plan ${item.id} asks for a ${item.role} image, but this direction declares the imagery axis no-photography.`);
    }
    if (!item.licenceExpectation.trim()) violations.push(`Plan ${item.id} states no licence expectation.`);
    const forbidden = [...ir.identity.forbiddenDefaults.motifs, ...ir.identity.forbiddenDefaults.palettes]
      .find((entry) => item.prompt.toLowerCase().includes(entry.toLowerCase()));
    if (forbidden) violations.push(`Plan ${item.id} asks for a forbidden default: ${forbidden}.`);
  }
  return violations;
}
