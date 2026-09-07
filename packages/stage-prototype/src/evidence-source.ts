import type { DesignIR } from '@pwb/domain';
import { createCleanEvidence, type RenderEvidence } from '@pwb/qa-deterministic';
import { createRenderMatrix, readStateConditions, renderColorSchemes, REPRESENTATIVE_VIEWPORTS, type RenderHub, type RenderViewport } from '@pwb/render-hub';
import { renderDesign } from '@pwb/renderer';
import type { CritiqueCapture } from './critics.js';

export interface EvidenceRequest {
  ir: DesignIR;
  versionId: string;
  routes?: string[];
  signal?: AbortSignal;
}

export interface EvidenceBundle { evidence: RenderEvidence[]; captures: CritiqueCapture[]; }

export interface EvidenceSource {
  collect(request: EvidenceRequest): Promise<EvidenceBundle>;
}

function matrixOptions(request: EvidenceRequest, viewports: readonly RenderViewport[]): { routes?: string[]; viewports: readonly RenderViewport[] } {
  return { ...(request.routes ? { routes: request.routes } : {}), viewports };
}

/**
 * The real source: it drives the RenderHub over every declared route, state and colour scheme at the
 * widths the request asks for, reusing the content-addressed cache.
 */
export class RenderHubEvidenceSource implements EvidenceSource {
  constructor(private readonly options: { hub: RenderHub; baseUrl: string; previewPrefix: (versionId: string) => string; viewports?: readonly RenderViewport[] }) {}

  async collect(request: EvidenceRequest): Promise<EvidenceBundle> {
    const cases = createRenderMatrix(request.ir, matrixOptions(request, this.options.viewports ?? REPRESENTATIVE_VIEWPORTS));
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
    const cases = createRenderMatrix(request.ir, matrixOptions(request, REPRESENTATIVE_VIEWPORTS));
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
