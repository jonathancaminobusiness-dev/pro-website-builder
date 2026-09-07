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
    `Return a SectionComposition holding exactly ${section.nodeIds.length} nodes, with these ids in this order: ${section.nodeIds.join(', ')}. The first id is the section root; every other id must be reachable from it through the slots you declare. A node may only carry these visual props: ${[...visualPropKeys].join(', ')}, plus text. Every visual prop must be a token reference such as {color.ink}; a raw value is refused. A node whose semantic is h1, h2, h3 or p carries its own text and declares no children. The journey runs ${manifest.routes.map((route) => route.route).join(' then ')}; name the next route in the copy, because this renderer emits no anchors.`,
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
      // One real breakpoint: past the declared max width the section takes the section gutter inline.
      responsive: [{ minWidth: identity.gridGrammar.maxWidthToken, props: { paddingInline: identity.gridGrammar.gutterToken } }],
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
      // This renderer emits no anchors, so the journey is carried by the copy rather than by a link.
      const closesJourney = section.callToAction !== undefined && index === childIds.length - 1 && section.role !== 'support';
      const text: string = closesJourney && section.callToAction
        ? `${section.callToAction.label}: ${section.callToAction.href}`
        : copy[index] ?? section.body;
      return {
        id, kind: 'type' as const, semantic: heading ? level : ('p' as const),
        props: { color: ink, font: `{${identity.tokenRoles.bodyTypeface}}`, text },
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
  for (const node of composition.nodes) {
    for (const [key, value] of Object.entries(node.props)) {
      if (!visualPropKeys.has(key) || value === undefined) continue;
      const reference = typeof value === 'string' ? /^\{([^}]+)\}$/.exec(value) : null;
      if (!reference) { problems.push(`Node ${node.id} sets ${key} outside the token system.`); continue; }
      if (!tokens.has(reference[1]!)) problems.push(`Node ${node.id} points ${key} at the undefined token ${String(value)}.`);
    }
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
