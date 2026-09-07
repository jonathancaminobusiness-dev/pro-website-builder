import { declaresDarkScheme, type DesignIR } from '@pwb/domain';
import type { RenderCase, RenderColorScheme, RenderViewport } from './cases.js';

/** The CSS pixel widths every prototype must survive, from the smallest phone to a wide desktop. */
export const RENDER_VIEWPORTS = [320, 360, 390, 768, 1024, 1440] as const;
/** The three representative widths of the fast per-candidate loop. */
export const TIER1_VIEWPORTS = [390, 768, 1440] as const;

/**
 * A state fixture describes a capture condition through a closed vocabulary:
 * `motion` selects reduced motion, `hidden` lists the node ids absent in that state,
 * and `focus` names the node the keyboard reaches first.
 */
export interface StateCondition {
  state: string;
  description: string;
  reducedMotion: boolean;
  hiddenNodeIds: string[];
  focusNodeId: string | null;
}

function nodeIdList(value: string | number | boolean | undefined): string[] {
  return typeof value === 'string' ? value.split(',').map((entry) => entry.trim()).filter(Boolean) : [];
}

export function readStateConditions(ir: DesignIR): StateCondition[] {
  return Object.entries(ir.stateFixtures)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([state, fixture]) => ({
      state,
      description: fixture.description,
      reducedMotion: fixture.values.motion === 'reduced',
      hiddenNodeIds: nodeIdList(fixture.values.hidden),
      focusNodeId: typeof fixture.values.focus === 'string' && fixture.values.focus !== '' ? fixture.values.focus : null,
    }));
}

export function renderColorSchemes(ir: DesignIR): RenderColorScheme[] {
  return declaresDarkScheme(ir.identity) ? ['light', 'dark'] : ['light'];
}

export interface RenderMatrixOptions {
  viewports?: readonly RenderViewport[];
  routes?: readonly string[];
  states?: readonly string[];
}

/** Enumerates every capture the deterministic gate expects: route × viewport × state × colour scheme. */
export function createRenderMatrix(ir: DesignIR, options: RenderMatrixOptions = {}): RenderCase[] {
  const viewports = options.viewports ?? RENDER_VIEWPORTS;
  const routes = options.routes ?? ir.pages.routes.map((page) => page.route);
  const schemes = renderColorSchemes(ir);
  const conditions = readStateConditions(ir).filter((condition) => !options.states || options.states.includes(condition.state));
  return routes.flatMap((route) => viewports.flatMap((width) => conditions.flatMap((condition) => schemes.map((colorScheme) => ({
    route, width, state: condition.state, reducedMotion: condition.reducedMotion, colorScheme,
  })))));
}

/** The Tier 1 subset: the same states and schemes on three representative widths. */
export function createTier1Matrix(ir: DesignIR, options: Omit<RenderMatrixOptions, 'viewports'> = {}): RenderCase[] {
  return createRenderMatrix(ir, { ...options, viewports: TIER1_VIEWPORTS });
}

export function conditionFor(ir: DesignIR, state: string): StateCondition {
  const condition = readStateConditions(ir).find((candidate) => candidate.state === state);
  if (!condition) throw new Error(`The document declares no state fixture named ${state}.`);
  return condition;
}
