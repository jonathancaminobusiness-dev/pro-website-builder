import type { CritiqueDimension } from './contracts.js';

export interface IdentityCriticDefinition {
  id: string;
  dimension: CritiqueDimension;
  /** Whether the critic judges one candidate or the whole fan-out at once. */
  scope: 'direction' | 'matrix';
  /** Behavioural descriptions for scores 0 to 4, read before the document. */
  rubric: string[];
  /** Objective failures that are not a score at all. */
  vetoes: string[];
}

/**
 * Three read-only critics, each a session of its own, none of them able to edit
 * the document. Brand fit and system accessibility judge one candidate at a
 * time; divergence is inherently a judgment about the set, so it reads the
 * matrix once instead of three times.
 */
export const identityCritics: readonly IdentityCriticDefinition[] = [
  {
    id: 'brand-fit-critic',
    dimension: 'brand-fit',
    scope: 'direction',
    rubric: [
      'The direction contradicts the audience, the job or the promise in the brief.',
      'The direction is plausible for any brief; nothing in it comes from this one.',
      'Some choices trace to the brief, but concept, colour, type, form, imagery and motion do not agree with each other.',
      'The direction answers this brief and its parts agree; the system would still hold up on a page with no hero.',
      'The direction answers this brief, its parts reinforce one another, and the exclusions are visibly respected rather than merely listed.',
    ],
    vetoes: [
      'A reference to a named company, product interface or brand instead of a material, craft, editorial or architectural reference.',
      'A rationale that cites no evidence from the brief.',
      'A direction that only works as a full-viewport hero.',
      'A choice that the brief explicitly excluded.',
    ],
  },
  {
    id: 'divergence-critic',
    dimension: 'divergence',
    scope: 'matrix',
    rubric: [
      'Two or more directions are the same proposal with different values.',
      'The directions differ, but on fewer axes than the matrix requires.',
      'The directions differ on enough axes, yet at least one difference is cosmetic rather than structural.',
      'Each direction differs from the others on at least the required axes and each difference changes how a page would be built.',
      'The differences are structural, the constants are deliberate, and each direction states what it refuses to combine.',
    ],
    vetoes: [
      'Two directions that a reader could not tell apart from a description alone.',
      'A colour difference that is only a hue rotation of the same palette.',
      'A direction whose declared axis key is contradicted by its own tokens.',
    ],
  },
  {
    id: 'system-a11y-critic',
    dimension: 'system-accessibility',
    scope: 'direction',
    rubric: [
      'The token system cannot produce a readable page: text and surface do not separate.',
      'Only the primary text pair is usable; secondary and accent roles fail.',
      'The main pairs are usable, but the system offers no answer for focus, state or reduced motion.',
      'The system supports text, secondary text, focus and state, and declares a reduced-motion position.',
      'The system supports all of that and its typographic scale and spacing rhythm still work at 200% zoom and in a long-content fixture.',
    ],
    vetoes: [
      'A text and surface pair that cannot reach WCAG 2.2 AA contrast.',
      'A motion grammar with no reduced-motion position.',
      'A typographic role with no declared fallback family.',
      'An asset with no stated origin or licence.',
    ],
  },
];

export type IdentityCriticId = (typeof identityCritics)[number]['id'];
