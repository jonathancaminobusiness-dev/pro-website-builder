import { hashJson } from '@pwb/domain';
import type { RenderedDocument } from '@pwb/renderer';

export type RenderViewport = 320 | 360 | 390 | 768 | 1024 | 1440;
export type RenderColorScheme = 'light' | 'dark';
export interface RenderCase { route: string; width: RenderViewport; state: string; reducedMotion: boolean; colorScheme?: RenderColorScheme; }
export interface QaResult { passed: boolean; overflow: boolean; status: number | null; consoleErrors: string[]; networkErrors: string[]; }

export function cacheKey(rendered: RenderedDocument, renderCase: RenderCase): string { return hashJson({ rendered, renderCase }); }

export function evaluateQa(input: { scrollWidth: number; clientWidth: number; status: number | null; consoleErrors: string[]; networkErrors: string[] }): QaResult {
  const overflow = input.scrollWidth > input.clientWidth;
  const served = input.status !== null && input.status >= 200 && input.status < 300;
  return { passed: served && !overflow && input.consoleErrors.length === 0 && input.networkErrors.length === 0, overflow, status: input.status, consoleErrors: input.consoleErrors, networkErrors: input.networkErrors };
}
