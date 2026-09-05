import { hashJson } from '@pwb/domain';
import type { RenderedDocument } from '@pwb/renderer';

export interface RenderCase { route: string; width: 360 | 768 | 1440; theme: 'light' | 'dark'; reducedMotion: boolean; }
export interface QaResult { passed: boolean; overflow: boolean; consoleErrors: string[]; networkErrors: string[]; }

export function createRenderCases(routes = ['/', '/proof', '/contact']): RenderCase[] {
  return routes.flatMap((route) => ([360, 768, 1440] as const).flatMap((width) => (['light', 'dark'] as const).flatMap((theme) => [false, true].map((reducedMotion) => ({ route, width, theme, reducedMotion }))))) as RenderCase[];
}

export function cacheKey(rendered: RenderedDocument, renderCase: RenderCase): string { return hashJson({ irHash: rendered.irHash, rendererVersion: rendered.rendererVersion, renderCase }); }

export function evaluateQa(input: { scrollWidth: number; clientWidth: number; consoleErrors: string[]; networkErrors: string[] }): QaResult {
  const overflow = input.scrollWidth > input.clientWidth;
  return { passed: !overflow && input.consoleErrors.length === 0 && input.networkErrors.length === 0, overflow, consoleErrors: input.consoleErrors, networkErrors: input.networkErrors };
}
