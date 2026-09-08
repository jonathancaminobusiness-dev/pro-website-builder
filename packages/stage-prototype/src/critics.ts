import type { IdentitySpec, PageNode } from '@pwb/domain';
import type { QaCheck, RenderContext } from '@pwb/qa-deterministic';
import { MIN_RUBRIC_SCORE, type CritiqueDimension, type ProposedPatch } from './critique.js';

export interface RubricCriterion { id: string; criterion: string; behaviour: string; }

export interface CriticDefinition {
  dimension: CritiqueDimension;
  title: string;
  focus: string;
  rubric: RubricCriterion[];
  vetoes: string[];
}

export const PROMPT_VERSION = 'prototype-critic-v1';

/** The four critics of the prototype gate. Each is a separate session and none may edit the document. */
export const criticRegistry: CriticDefinition[] = [
  {
    dimension: 'narrative',
    title: 'Narrative and hierarchy',
    focus: 'What a first-time visitor understands in five seconds, and whether the journey earns its call to action.',
    rubric: [
      { id: 'five-second', criterion: 'Five-second hierarchy', behaviour: '4 = the promise, the proof and the next step are read in that order without hunting; 2 = the order has to be searched for; 0 = nothing dominates.' },
      { id: 'progression', criterion: 'Narrative progression', behaviour: '4 = each section answers the question the previous one raised; 2 = sections are true but unordered; 0 = sections repeat each other.' },
      { id: 'call-to-action', criterion: 'Call to action', behaviour: '4 = one obvious next step, phrased as the visitor would say it; 2 = present but generic; 0 = absent or competing.' },
      { id: 'plausibility', criterion: 'Content plausibility', behaviour: '4 = copy reads as a real business writing in its own voice; 2 = plausible but interchangeable; 0 = placeholder or slogan.' },
    ],
    vetoes: ['The primary flow cannot be completed from the entry route.', 'A call to action leads nowhere.'],
  },
  {
    dimension: 'responsiveness',
    title: 'Responsive transformation',
    focus: 'How the composition transforms between 320 and 1440 CSS pixels, not whether it merely fits.',
    rubric: [
      { id: 'reflow', criterion: 'Reflow', behaviour: '4 = the layout changes structure where the content asks for it; 2 = it only shrinks; 0 = content is lost or overlaps.' },
      { id: 'measure', criterion: 'Measure and legibility', behaviour: '4 = line length and type size stay comfortable at every width; 2 = one width is uncomfortable; 0 = text is unreadable somewhere.' },
      { id: 'density', criterion: 'Density', behaviour: '4 = spacing follows the grid grammar at every width; 2 = spacing collapses inconsistently; 0 = rhythm is arbitrary.' },
      { id: 'targets', criterion: 'Touch targets', behaviour: '4 = every control is comfortably reachable on the narrowest viewport; 2 = some are tight; 0 = controls are unusable by touch.' },
    ],
    vetoes: ['Content is hidden by overflow at any declared viewport.', 'A control leaves the visible area.'],
  },
  {
    dimension: 'a11y-interaction',
    title: 'Accessibility and interaction',
    focus: 'Keyboard order, focus, and whether every declared state is understandable on its own.',
    rubric: [
      { id: 'focus-order', criterion: 'Focus order', behaviour: '4 = the keyboard path matches the reading order and never traps; 2 = the order surprises; 0 = focus is lost or trapped.' },
      { id: 'states', criterion: 'State legibility', behaviour: '4 = loading, empty and error each say what happened and what to do; 2 = they are distinguishable but silent; 0 = a state looks broken.' },
      { id: 'naming', criterion: 'Accessible naming', behaviour: '4 = every control and region is named for its purpose; 2 = names are generic; 0 = names are missing.' },
      { id: 'motion', criterion: 'Motion intent', behaviour: '4 = motion carries meaning and reduced motion keeps it understandable; 2 = motion is decorative; 0 = motion blocks comprehension.' },
    ],
    vetoes: ['Focus is invisible or trapped.', 'A declared state cannot be reached or understood.'],
  },
  {
    dimension: 'coherence',
    title: 'Coherence and genericity',
    focus: 'Whether the pages read as one identity, and whether any choice is a default nobody justified.',
    rubric: [
      { id: 'token-fidelity', criterion: 'Token fidelity', behaviour: '4 = every visual decision traces to the approved contract; 2 = some choices only happen to match; 0 = the contract is decoration.' },
      { id: 'cross-route', criterion: 'Cross-route consistency', behaviour: '4 = the routes share a grammar and still differ in purpose; 2 = one route drifts; 0 = the routes look unrelated.' },
      { id: 'divergence', criterion: 'Distance from defaults', behaviour: '4 = the composition would be recognisable without the logo; 2 = it follows a common template with local colour; 0 = it is the default arrangement of the stack.' },
      { id: 'materiality', criterion: 'Materiality', behaviour: '4 = surfaces, imagery and type express the declared materiality; 2 = materiality is asserted but not visible; 0 = the direction is contradicted.' },
    ],
    vetoes: ['A forbidden default from the identity contract is present.', 'A route contradicts an approved token role.'],
  },
];

export interface CritiqueCapture { context: RenderContext; screenshotPath: string; }

export interface CritiqueTask {
  id: string;
  dimension: CritiqueDimension;
  stage: 'prototype';
  promptVersion: string;
  /** The critic runs in its own session and never sees how the composition was produced. */
  criticSessionId: string;
  deadlineMs: number;
  brief: string;
  identity: IdentitySpec;
  routeSlices: Array<{ route: string; title: string; nodes: PageNode[] }>;
  qaChecks: QaCheck[];
  captures: CritiqueCapture[];
  allowedOperations: readonly ProposedPatch['operation'][];
}

export const ALLOWED_PATCH_OPERATIONS = ['set_token', 'set_constraint', 'set_crop', 'replace_copy', 'reorder_node'] as const;

export function definitionFor(dimension: CritiqueDimension): CriticDefinition {
  const definition = criticRegistry.find((candidate) => candidate.dimension === dimension);
  if (!definition) throw new Error(`No critic is registered for the ${dimension} dimension.`);
  return definition;
}

/**
 * Assembles the critic prompt. The order is deliberate: role, contract and rubric come first so the
 * judgement is anchored to the approved identity, the deterministic evidence next, and the images last.
 */
export function renderCritiquePrompt(task: CritiqueTask): string {
  const definition = definitionFor(task.dimension);
  const identity = task.identity;
  const sections = [
    `You are the ${definition.title} critic of the prototype gate for task ${task.id}. You judge; you never edit the document, never write HTML or CSS, and never propose anything outside the allowed repairs. ${definition.focus}`,
    `Brief under review:\n${task.brief}`,
    `Approved identity contract (read-only; it is not yours to change):\n${JSON.stringify({
      direction: identity.direction, tokenRoles: identity.tokenRoles, gridGrammar: identity.gridGrammar,
      imagery: identity.imagery, iconography: identity.iconography, content: identity.content,
      do: identity.do, dont: identity.dont, forbiddenDefaults: identity.forbiddenDefaults,
    })}`,
    `Rubric. Score every criterion from 0 to 4 with the behaviour anchors below and quote the evidence you used. A gate accepts a criterion only from ${MIN_RUBRIC_SCORE}.\n${definition.rubric.map((entry) => `- ${entry.id} · ${entry.criterion}: ${entry.behaviour}`).join('\n')}`,
    `Immediate vetoes for this dimension:\n${definition.vetoes.map((veto) => `- ${veto}`).join('\n')}`,
    `Answer as a CritiqueReport in three passes. Perception: what is actually on the screen, region by region, located by nodeId. Comprehension: what the composition is trying to do and how it stands against the contract. Projection: the findings. Every finding names its nodeIds, says what you observed, why it matters against the contract, and carries at most one minimal repair chosen from ${task.allowedOperations.join(', ')}. Never answer "rewrite the page". If you cannot tell, set abstain and let the verdict be uncertain rather than inventing precision. Write observation, why, perception and comprehension in ${identity.meta.locale}; keep ids and node ids verbatim.`,
    `Deterministic checks already ran and cannot be re-litigated; they are context, not your findings:\n${task.qaChecks.length === 0 ? '- none' : task.qaChecks.map((check) => `- ${check.id} (${check.severity}) ${check.nodeIds.join(', ') || '—'}: ${check.message}`).join('\n')}`,
    `The typed page graph of the routes under review:\n${JSON.stringify(task.routeSlices)}`,
    `Screenshots to read last, after the contract and the rubric:\n${task.captures.map((capture) => `- ${capture.screenshotPath} — ${capture.context.route} at ${capture.context.viewport}px, state ${capture.context.state}, ${capture.context.colorScheme}${capture.context.reducedMotion ? ', reduced motion' : ''}`).join('\n')}`,
  ];
  return sections.join('\n\n');
}
