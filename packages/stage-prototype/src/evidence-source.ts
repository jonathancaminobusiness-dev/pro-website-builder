import type { DesignIR } from '@pwb/domain';
import { createCleanEvidence, type QaTier, type RenderEvidence } from '@pwb/qa-deterministic';
import { createRenderMatrix, createTier1Matrix, readStateConditions, renderColorSchemes, type RenderHub } from '@pwb/render-hub';
import { renderDesign } from '@pwb/renderer';
import type { CritiqueCapture } from './critics.js';

export interface EvidenceRequest {
  ir: DesignIR;
  versionId: string;
  tier: QaTier;
  routes?: string[];
  signal?: AbortSignal;
}

export interface EvidenceBundle { evidence: RenderEvidence[]; captures: CritiqueCapture[]; }

export interface EvidenceSource {
  collect(request: EvidenceRequest): Promise<EvidenceBundle>;
}

/**
 * The real source: it drives the RenderHub over the full matrix for Tier 0 and over the three
 * representative widths for the per-candidate Tier 1 loop, reusing the content-addressed cache.
 */
export class RenderHubEvidenceSource implements EvidenceSource {
  constructor(private readonly options: { hub: RenderHub; baseUrl: string; previewPrefix: (versionId: string) => string }) {}

  async collect(request: EvidenceRequest): Promise<EvidenceBundle> {
    const cases = request.tier === 0
      ? createRenderMatrix(request.ir, request.routes ? { routes: request.routes } : {})
      : createTier1Matrix(request.ir, request.routes ? { routes: request.routes } : {});
    const captures = await this.options.hub.capture({
      ir: request.ir,
      rendered: renderDesign(request.ir),
      baseUrl: this.options.baseUrl,
      previewPrefix: this.options.previewPrefix(request.versionId),
      cases,
      ...(request.signal ? { signal: request.signal } : {}),
    });
    return {
      evidence: captures.map((capture) => capture.evidence),
      captures: captures.map((capture) => ({ context: capture.evidence.context, screenshotPath: capture.evidence.screenshotPath })),
    };
  }
}

/**
 * The deterministic source used by CI and the fixture journey. It derives the same evidence shape from
 * the resolved tokens, so a spacing outside the grid rhythm still surfaces as a Tier 1 observation and
 * the loop, the critics and the patch gate are exercised without a browser.
 */
export class DerivedEvidenceSource implements EvidenceSource {
  async collect(request: EvidenceRequest): Promise<EvidenceBundle> {
    const options = request.routes ? { routes: request.routes } : {};
    const cases = request.tier === 0 ? createRenderMatrix(request.ir, options) : createTier1Matrix(request.ir, options);
    const conditions = new Map(readStateConditions(request.ir).map((condition) => [condition.state, condition]));
    const schemes = renderColorSchemes(request.ir);
    const evidence = cases.map((renderCase) => createCleanEvidence(request.ir, {
      route: renderCase.route,
      viewport: renderCase.width,
      state: renderCase.state,
      colorScheme: renderCase.colorScheme ?? schemes[0] ?? 'light',
      reducedMotion: conditions.get(renderCase.state)?.reducedMotion ?? renderCase.reducedMotion,
    }, `derived://${request.versionId}${renderCase.route}#${renderCase.width}-${renderCase.state}`));
    return { evidence, captures: evidence.map((entry) => ({ context: entry.context, screenshotPath: entry.screenshotPath })) };
  }
}
