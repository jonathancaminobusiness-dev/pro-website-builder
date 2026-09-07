import { hashJson, resolveTokens, slotChildIds, visualPropKeys, type AgentTask, type IdentitySpec, type PageNode, type Patch } from '@pwb/domain';
import { ClaudeSession, type ClaudeSessionOptions } from './claude-session.js';
import { locateSection, ROUTE_SHELL_SLOT, sectionAllowedPaths, sectionCompositionSchema, stagePrototypeContractSchemaJson, type RouteManifest, type SectionComposition, type SectionPlan } from './contracts.js';

export const COMPOSER_PROMPT_VERSION = 'prototype-composer-v1';

export interface ComposerProvider {
  compose(task: AgentTask, section: SectionPlan, manifest: RouteManifest, signal?: AbortSignal): Promise<SectionComposition>;
}

export function renderComposerPrompt(task: AgentTask, section: SectionPlan, manifest: RouteManifest, identity: IdentitySpec): string {
  return [
    `You are the composer of section ${section.id} on route ${section.route}, task ${task.id}. Other composers are working on other sections at the same time, so you may only describe the nodes listed below and nothing else.`,
    `Section contract:\n${JSON.stringify(section)}`,
    `Approved identity contract, frozen and read-only:\n${JSON.stringify({ direction: identity.direction, tokenRoles: identity.tokenRoles, gridGrammar: identity.gridGrammar, iconography: identity.iconography, content: identity.content, do: identity.do, dont: identity.dont, forbiddenDefaults: identity.forbiddenDefaults })}`,
    `Available token references: ${Object.keys(resolveTokens(identity.tokens).values).map((path) => `{${path}}`).join(', ')}`,
    `A responsive rule may only open at one of the identity's breakpoints — ${identity.gridGrammar.breakpointTokens.join(' or ')} — never at the content max width, which is narrower than the smallest viewport this prototype has to survive.`,
    `Return a SectionComposition holding exactly ${section.nodeIds.length} nodes, with these ids in this order: ${section.nodeIds.join(', ')}. The first id is the section root; every other id must be reachable from it through the slots you declare. A node may only carry these visual props: ${[...visualPropKeys].join(', ')}, plus text. Every visual prop must be a token reference such as {color.ink}, on the node and inside every responsive rule alike; a raw value is refused in both. A node whose semantic is h1, h2, h3, p, link or button carries its own text and declares no children. A link and a button are always kind component. A link is a component node whose text is its label and whose href is one of the routes of this journey — ${manifest.routes.map((route) => route.route).join(', ')}; a button is a component node with a label and no href. The journey runs ${manifest.routes.map((route) => route.route).join(' then ')}; carry the visitor to the next route with a link, never with a raw URL in the copy.`,
    `Write the copy in ${identity.meta.locale}, in the identity voice, and never use ${identity.content.forbiddenTerms.join(', ')}.`,
  ].join('\n\n');
}

/** The deterministic composer used by CI and the fixture journey. */
export class FakeSectionComposer implements ComposerProvider {
  async compose(task: AgentTask, section: SectionPlan, _manifest: RouteManifest, signal?: AbortSignal): Promise<SectionComposition> {
    if (signal?.aborted) throw new DOMException('The task was cancelled.', 'AbortError');
    const identity = task.documentSlice['/identity'] as IdentitySpec;
    const surface = `{${identity.tokenRoles.surface}}`;
    const ink = `{${identity.tokenRoles.text}}`;
    const rhythm = identity.gridGrammar.rhythmToken;
    const [rootId, ...childIds] = section.nodeIds as [string, ...string[]];
    const root: PageNode = {
      id: rootId, kind: 'stack', semantic: 'section',
      props: { background: surface, color: ink, gap: rhythm, paddingBlock: `{${identity.tokenRoles.sectionSpacing}}` },
      slots: { children: childIds },
      // The identity's own breakpoints, which are the only widths the layout may transform at.
      responsive: [
        { minWidth: identity.gridGrammar.breakpointTokens[0]!, props: { paddingInline: identity.gridGrammar.gutterToken } },
        { minWidth: identity.gridGrammar.breakpointTokens[1]!, props: { paddingInline: `{${identity.tokenRoles.sectionSpacing}}` } },
      ],
    };
    const copy = section.role === 'support'
      ? ['Carregando o conteúdo desta rota.', 'Ainda não há conteúdo para mostrar.', 'Não foi possível carregar esta rota. Tente novamente.']
      : [section.headline, section.body, section.callToAction?.label ?? section.intent];
    // Every route needs exactly one h1, and it belongs to the section that opens the route. A state
    // that replaces the whole route needs its own, because the route's h1 is hidden while it shows.
    const opensRoute = section.nodeRange.start === ROUTE_SHELL_SLOT + 1;
    const children: PageNode[] = childIds.map((id, index) => {
      const heading = section.role === 'support' || index === 0;
      const level: 'h1' | 'h2' = section.role === 'support' || opensRoute ? 'h1' : 'h2';
      const font = `{${identity.tokenRoles.bodyTypeface}}`;
      // The section's call to action is the navigation: a real anchor the keyboard can reach, which is
      // what makes the focus state and the focus veto measure something.
      const closesJourney = section.callToAction !== undefined && index === childIds.length - 1 && section.role !== 'support';
      if (closesJourney && section.callToAction) {
        return {
          id, kind: 'component' as const, semantic: 'link' as const,
          props: { color: ink, font, text: section.callToAction.label, href: section.callToAction.href },
          slots: {}, responsive: [],
        };
      }
      return {
        id, kind: 'type' as const, semantic: heading ? level : ('p' as const),
        props: { color: ink, font, text: copy[index] ?? section.body },
        slots: {}, responsive: [],
      };
    });
    return sectionCompositionSchema.parse({
      sectionId: section.id,
      nodes: [root, ...children],
      rationale: `Composição determinística de ${section.id}: ${section.intent}`,
      confidence: 1,
    });
  }
}

/** The real composer: one local Claude Code session per section, all of them under the scheduler's lane limit. */
export class ClaudeSectionComposer implements ComposerProvider {
  private readonly session: ClaudeSession;
  constructor(options: ClaudeSessionOptions = {}) { this.session = new ClaudeSession({ maxTurns: 5, ...options }); }

  async compose(task: AgentTask, section: SectionPlan, manifest: RouteManifest, signal?: AbortSignal): Promise<SectionComposition> {
    const identity = task.documentSlice['/identity'] as IdentitySpec;
    return this.session.ask({
      sessionId: `${task.id}-attempt-${task.attempt}`,
      prompt: renderComposerPrompt(task, section, manifest, identity),
      schema: stagePrototypeContractSchemaJson.SectionComposition,
      parse: (value) => sectionCompositionSchema.parse(value),
      deadlineMs: task.deadlineMs,
      ...(signal ? { signal } : {}),
    });
  }
}

/**
 * The deterministic contract check a composition must survive before the patch gate ever sees it:
 * the composer filled exactly its own window, wired a connected subtree, stayed inside the token
 * system, linked only inside the site, and honoured the identity's forbidden vocabulary.
 */
export function validateComposition(composition: SectionComposition, section: SectionPlan, manifest: RouteManifest, identity: IdentitySpec): string[] {
  const problems: string[] = [];
  if (composition.sectionId !== section.id) problems.push(`This composition answers section ${section.id}; it declared ${composition.sectionId}.`);
  const declared = composition.nodes.map((node) => node.id);
  if (declared.length !== section.nodeIds.length || declared.some((id, index) => id !== section.nodeIds[index])) {
    problems.push(`Section ${section.id} must return exactly ${section.nodeIds.join(', ')} in that order; it returned ${declared.join(', ') || 'nothing'}.`);
    return problems;
  }
  const owned = new Set(section.nodeIds);
  const byId = new Map(composition.nodes.map((node) => [node.id, node]));
  const reached = new Set([section.nodeIds[0]!]);
  const walk = (node: PageNode): void => {
    for (const childId of slotChildIds(node)) {
      if (!owned.has(childId)) { problems.push(`Node ${node.id} references ${childId}, which belongs to another section.`); continue; }
      if (reached.has(childId)) { problems.push(`Node ${childId} appears more than once in section ${section.id}.`); continue; }
      reached.add(childId);
      walk(byId.get(childId)!);
    }
  };
  walk(byId.get(section.nodeIds[0]!)!);
  for (const nodeId of section.nodeIds) if (!reached.has(nodeId)) problems.push(`Node ${nodeId} is not reachable from the root of section ${section.id}.`);

  let tokens: Set<string>;
  try { tokens = new Set(Object.keys(resolveTokens(identity.tokens).values)); } catch { tokens = new Set(); }
  const breakpoints = new Set(identity.gridGrammar.breakpointTokens);
  const journeyRoutes = new Set(manifest.routes.map((route) => route.route));
  for (const node of composition.nodes) {
    if (node.semantic === 'link' && !journeyRoutes.has(String(node.props.href))) {
      problems.push(`Node ${node.id} links to ${String(node.props.href)}, which is not one of the routes this journey declares.`);
    }
    const checkProps = (where: string, props: Record<string, unknown>): void => {
      for (const [key, value] of Object.entries(props)) {
        if (!visualPropKeys.has(key) || value === undefined) continue;
        const reference = typeof value === 'string' ? /^\{([^}]+)\}$/.exec(value) : null;
        if (!reference) { problems.push(`Node ${node.id} sets ${where}${key} outside the token system.`); continue; }
        if (!tokens.has(reference[1]!)) problems.push(`Node ${node.id} points ${where}${key} at the undefined token ${String(value)}.`);
      }
    };
    for (const rule of node.responsive) {
      if (!breakpoints.has(rule.minWidth)) problems.push(`Node ${node.id} opens a breakpoint at ${rule.minWidth}, which the grid grammar does not declare as one of ${identity.gridGrammar.breakpointTokens.join(', ')}.`);
      checkProps(`responsive ${rule.minWidth} `, rule.props);
    }
    checkProps('', node.props);
    const text = node.props.text;
    if (typeof text === 'string') {
      const forbidden = identity.content.forbiddenTerms.find((term) => text.toLowerCase().includes(term.toLowerCase()));
      if (forbidden) problems.push(`Node ${node.id} uses ${forbidden}, which the identity forbids.`);
    }
  }
  return problems;
}

/** Compiles a validated composition into a patch that writes only that section's own window. */
export function compositionPatch(composition: SectionComposition, manifest: RouteManifest, task: AgentTask): Patch {
  const { section } = locateSection(manifest, composition.sectionId);
  const paths = sectionAllowedPaths(manifest, composition.sectionId);
  return {
    operations: paths.map((path, offset) => ({ op: 'replace' as const, path, value: composition.nodes[offset]! })),
    baseVersionId: task.baseVersionId,
    touchedPaths: paths,
    rationale: composition.rationale,
    confidence: composition.confidence,
    stage: 'prototype',
    role: 'composer',
    idempotencyKey: hashJson(['composer', section.id, task.baseVersionId, task.inputDigest, COMPOSER_PROMPT_VERSION, composition]),
  };
}
