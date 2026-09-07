import { hashJson, type DesignIR } from '@pwb/domain';
import type { RenderedDocument } from '@pwb/renderer';

export interface RenderCase { route: string; width: 360 | 768 | 1440; state: string; reducedMotion: boolean; }
export interface QaResult { passed: boolean; overflow: boolean; status: number | null; consoleErrors: string[]; networkErrors: string[]; }

/**
 * The hub can only apply the `motion` fixture value, which it maps to Chromium's reduced-motion
 * emulation. Enumerating a state it cannot apply would report duplicate output as state coverage,
 * so an unsupported value is refused here rather than silently ignored.
 */
export function createRenderCases(ir: DesignIR): RenderCase[] {
  for (const [state, fixture] of Object.entries(ir.stateFixtures)) {
    const unsupported = Object.keys(fixture.values).filter((key) => key !== 'motion');
    if (unsupported.length > 0) throw new Error(`State fixture ${state} sets ${unsupported.join(', ')}, which the render hub cannot apply; it only applies motion.`);
  }
  return ir.pages.routes.flatMap((page) => ([360, 768, 1440] as const).flatMap((width) =>
    Object.entries(ir.stateFixtures).map(([state, fixture]) => ({ route: page.route, width, state, reducedMotion: fixture.values.motion === 'reduced' }))));
}

export function cacheKey(rendered: RenderedDocument, renderCase: RenderCase): string { return hashJson({ rendered, renderCase }); }

export function evaluateQa(input: { scrollWidth: number; clientWidth: number; status: number | null; consoleErrors: string[]; networkErrors: string[] }): QaResult {
  const overflow = input.scrollWidth > input.clientWidth;
  const served = input.status !== null && input.status >= 200 && input.status < 300;
  return { passed: served && !overflow && input.consoleErrors.length === 0 && input.networkErrors.length === 0, overflow, status: input.status, consoleErrors: input.consoleErrors, networkErrors: input.networkErrors };
}
