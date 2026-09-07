import { hashJson, type DesignIR } from '@pwb/domain';
import type { RasterJob, RasterProvider } from '@pwb/providers';
import type { ImagePromptPlan } from './contracts.js';

export type IdentityAsset = DesignIR['assets']['items'][number];

export interface RasterGenerationOptions {
  provider: RasterProvider;
  identityVersionId: string;
  model?: string;
  signal?: AbortSignal;
  date?: string;
}

/**
 * Only the approved direction is generated. Every asset carries the prompt, the
 * model, the licence the provider returned and the identity version it belongs
 * to, so nothing enters the ledger whose origin cannot be stated. A provider
 * that is not configured still yields a provenance-marked placeholder rather
 * than a silent gap, and no credential is read, logged or stored anywhere here.
 */
export async function generateApprovedImagery(plan: ImagePromptPlan, options: RasterGenerationOptions): Promise<{ assets: IdentityAsset[]; jobs: RasterJob[] }> {
  const model = options.model ?? 'higgsfield';
  const date = options.date ?? new Date().toISOString().slice(0, 10);
  const assets: IdentityAsset[] = [];
  const jobs: RasterJob[] = [];
  for (const item of plan.plans) {
    const digest = hashJson({ identityVersionId: options.identityVersionId, directionId: plan.directionId, id: item.id, prompt: item.prompt, negatives: item.negatives, aspect: item.aspect, model });
    const job = await options.provider.submit({ id: `${plan.directionId}-${item.id}`, digest, prompt: item.prompt, model, aspect: item.aspect, identityVersionId: options.identityVersionId }, options.signal);
    jobs.push(job);
    assets.push({
      id: `asset-${plan.directionId}-${item.id}`,
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
        termsNote: `${job.provenance.termsNote} Negatives: ${item.negatives.join('; ')}. Axis: ${item.axis}. Expected licence: ${item.licenceExpectation}.`,
      },
      status: job.status === 'succeeded' ? 'ready' : job.status === 'failed' ? 'failed' : 'placeholder',
    });
  }
  return { assets, jobs };
}

/** A plan is only usable when it respects the direction's own imagery policy. */
export function imageryPolicyViolations(plan: ImagePromptPlan, ir: DesignIR): string[] {
  const violations: string[] = [];
  const photographyRefused = ir.identity.direction.divergence?.matrix.find((vector) => vector.directionId === plan.directionId)?.axes.imagery.key === 'no-photography';
  for (const item of plan.plans) {
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
