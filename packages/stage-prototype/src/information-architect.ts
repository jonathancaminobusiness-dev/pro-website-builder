import { hashJson, type AgentTask, type DesignIR, type IdentitySpec, type Page, type PageNode, type Patch } from '@pwb/domain';
import { ClaudeSession, type ClaudeSessionOptions } from './claude-session.js';
import { ROUTE_SHELL_SLOT, routeManifestSchema, stagePrototypeContractSchemaJson, type RouteManifest, type RoutePlan } from './contracts.js';

export const ARCHITECT_PROMPT_VERSION = 'prototype-architect-v1';
/** The architect owns the page graph and the state fixtures; it never touches the approved identity. */
export const ARCHITECT_ALLOWED_PATHS = ['/pages', '/stateFixtures'];

export interface ArchitectProvider {
  plan(task: AgentTask, signal?: AbortSignal): Promise<RouteManifest>;
}

export function renderArchitectPrompt(task: AgentTask, identity: IdentitySpec): string {
  return [
    `You are the information architect of the prototype stage for task ${task.id}. You run alone, before any composer, and your answer is the contract they build against.`,
    `Brief:\n${task.brief}`,
    `Approved identity contract, which is frozen and read-only:\n${JSON.stringify({ strategy: identity.strategy, direction: identity.direction, gridGrammar: identity.gridGrammar, content: identity.content, do: identity.do, dont: identity.dont })}`,
    'Answer as a RouteManifest. Name the routes and the order a visitor walks them, give each route a purpose, and break each route into sections with a role, an intent, and plausible copy written in the identity voice — never a placeholder or a slogan.',
    `Every route reserves slot ${ROUTE_SHELL_SLOT} for its shell, which you own; sections start at slot ${ROUTE_SHELL_SLOT + 1} and their windows must be contiguous and never overlap, because the composers write them in parallel and each one may only touch its own window. Reserve exactly as many node ids as the section needs; the composer must fill every one of them.`,
    'Declare the states the prototype must survive: a default state, and the loading, empty, error and focus states the journey implies. A state lists the node ids that are absent in it and, when relevant, the node id the keyboard should reach.',
    `Write titles, purposes and copy in ${identity.meta.locale}; keep ids, routes and node ids as lowercase kebab-case identifiers.`,
  ].join('\n\n');
}

/**
 * The deterministic architect used by CI and the fixture journey: a three-route journey with a shell,
 * sections with disjoint windows, plausible copy from the identity, and the five capture states.
 */
export class FakeInformationArchitect implements ArchitectProvider {
  async plan(task: AgentTask, signal?: AbortSignal): Promise<RouteManifest> {
    if (signal?.aborted) throw new DOMException('The task was cancelled.', 'AbortError');
    const identity = task.documentSlice['/identity'] as IdentitySpec;
    const routes: RoutePlan[] = [
      {
        id: 'route-home', route: '/', title: `${identity.direction.thesis} — início`, journeyStep: 1, purpose: 'Apresentar a promessa e levar à prova.', rootNodeId: 'home-shell',
        sections: [
          { id: 'home-hero', route: '/', role: 'hero', intent: 'Entregar a promessa em cinco segundos.', headline: identity.content.message, body: identity.strategy.promise, callToAction: { label: 'Ver a prova', href: '/proof' }, nodeIds: ['home-hero-root', 'home-hero-title', 'home-hero-body', 'home-hero-cta'], nodeRange: { start: 1, count: 4 } },
          { id: 'home-proof', route: '/', role: 'proof', intent: 'Mostrar a evidência que sustenta a promessa.', headline: 'Processo rastreável', body: identity.strategy.proof[0] ?? 'Cada decisão aponta para o contrato.', nodeIds: ['home-proof-root', 'home-proof-title', 'home-proof-body'], nodeRange: { start: 5, count: 3 } },
          { id: 'home-states', route: '/', role: 'support', intent: 'Cobrir carregamento, vazio e erro sem sair da identidade.', headline: 'Estados', body: 'Cada estado explica o que aconteceu.', nodeIds: ['home-states-root', 'home-loading', 'home-empty', 'home-error'], nodeRange: { start: 8, count: 4 } },
        ],
      },
      {
        id: 'route-proof', route: '/proof', title: `${identity.direction.thesis} — prova`, journeyStep: 2, purpose: 'Detalhar a evidência antes do contato.', rootNodeId: 'proof-shell',
        sections: [
          { id: 'proof-narrative', route: '/proof', role: 'narrative', intent: 'Explicar como a evidência é construída.', headline: 'Prova antes do brilho', body: identity.direction.rationale, callToAction: { label: 'Falar com a oficina', href: '/contact' }, nodeIds: ['proof-root', 'proof-title', 'proof-body', 'proof-cta'], nodeRange: { start: 1, count: 4 } },
          { id: 'proof-states', route: '/proof', role: 'support', intent: 'Cobrir carregamento, vazio e erro.', headline: 'Estados', body: 'Cada estado explica o que aconteceu.', nodeIds: ['proof-states-root', 'proof-loading', 'proof-empty', 'proof-error'], nodeRange: { start: 5, count: 4 } },
        ],
      },
      {
        id: 'route-contact', route: '/contact', title: `${identity.direction.thesis} — contato`, journeyStep: 3, purpose: 'Fechar a jornada com um próximo passo claro.', rootNodeId: 'contact-shell',
        sections: [
          { id: 'contact-action', route: '/contact', role: 'action', intent: 'Oferecer um único próximo passo.', headline: 'Vamos conversar', body: identity.strategy.job, callToAction: { label: 'Voltar ao início', href: '/' }, nodeIds: ['contact-root', 'contact-title', 'contact-body', 'contact-cta'], nodeRange: { start: 1, count: 4 } },
          { id: 'contact-states', route: '/contact', role: 'support', intent: 'Cobrir carregamento, vazio e erro.', headline: 'Estados', body: 'Cada estado explica o que aconteceu.', nodeIds: ['contact-states-root', 'contact-loading', 'contact-empty', 'contact-error'], nodeRange: { start: 5, count: 4 } },
        ],
      },
    ];
    const transient = routes.flatMap((route) => route.sections.filter((section) => section.role === 'support').flatMap((section) => section.nodeIds.slice(1)));
    const hideAllBut = (suffix: string): string[] => transient.filter((nodeId) => !nodeId.endsWith(suffix));
    const content = routes.flatMap((route) => route.sections.filter((section) => section.role !== 'support').flatMap((section) => section.nodeIds));
    return routeManifestSchema.parse({
      schemaVersion: '1',
      journey: 'Promessa na entrada, evidência no meio, um único próximo passo no fim.',
      routes,
      states: [
        { id: 'default', description: 'Conteúdo carregado', motion: 'full', hidden: transient, focus: null },
        { id: 'loading', description: 'Carregando a rota', motion: 'full', hidden: [...content, ...hideAllBut('-loading')], focus: null },
        { id: 'empty', description: 'Sem conteúdo para mostrar', motion: 'full', hidden: [...content, ...hideAllBut('-empty')], focus: null },
        { id: 'error', description: 'Falha ao carregar a rota', motion: 'full', hidden: [...content, ...hideAllBut('-error')], focus: null },
        { id: 'focus', description: 'Primeiro alvo do teclado', motion: 'full', hidden: transient, focus: 'home-hero-cta' },
        { id: 'reduced', description: 'Movimento reduzido', motion: 'reduced', hidden: transient, focus: null },
      ],
    });
  }
}

/** The real architect: one local Claude Code session answering a closed JSON schema. */
export class ClaudeInformationArchitect implements ArchitectProvider {
  private readonly session: ClaudeSession;
  constructor(options: ClaudeSessionOptions = {}) { this.session = new ClaudeSession({ maxTurns: 5, ...options }); }

  async plan(task: AgentTask, signal?: AbortSignal): Promise<RouteManifest> {
    const identity = task.documentSlice['/identity'] as IdentitySpec;
    return this.session.ask({
      sessionId: `${task.id}-attempt-${task.attempt}`,
      prompt: renderArchitectPrompt(task, identity),
      schema: stagePrototypeContractSchemaJson.RouteManifest,
      parse: (value) => routeManifestSchema.parse(value),
      deadlineMs: task.deadlineMs,
      ...(signal ? { signal } : {}),
    });
  }
}

function placeholderNode(id: string, semantic: string, identity: IdentitySpec): PageNode {
  return { id, kind: 'surface', semantic, props: { background: `{${identity.tokenRoles.surface}}`, color: `{${identity.tokenRoles.text}}`, padding: identity.gridGrammar.rhythmToken, text: 'Aguardando composição.' }, slots: {}, responsive: [] };
}

/** Builds the shell and the empty windows the composers will fill, in the exact order the manifest declares. */
export function compileManifestPages(manifest: RouteManifest, identity: IdentitySpec): Page[] {
  return manifest.routes.map((route) => {
    const shell: PageNode = {
      id: route.rootNodeId, kind: 'stack', semantic: 'main',
      props: { background: `{${identity.tokenRoles.surface}}`, color: `{${identity.tokenRoles.text}}`, gap: `{${identity.tokenRoles.sectionSpacing}}`, padding: `{${identity.tokenRoles.baseSpacing}}` },
      slots: { sections: route.sections.map((section) => section.nodeIds[0]!) },
      responsive: identity.gridGrammar.responsive,
    };
    const windows = route.sections.flatMap((section) => section.nodeIds.map((nodeId, offset) => {
      const node = placeholderNode(nodeId, offset === 0 ? 'section' : 'p', identity);
      return offset === 0 ? { ...node, kind: 'stack' as const, slots: { children: section.nodeIds.slice(1) } } : node;
    }));
    return { id: route.id, route: route.route, title: route.title, rootNodeId: route.rootNodeId, nodes: [shell, ...windows] };
  });
}

export function compileManifestStates(manifest: RouteManifest): DesignIR['stateFixtures'] {
  return Object.fromEntries(manifest.states.map((state) => [state.id, {
    description: state.description,
    values: { motion: state.motion, hidden: state.hidden.join(', '), ...(state.focus === null ? {} : { focus: state.focus }) },
  }]));
}

/** Turns the architect's typed manifest into the patch the applier will validate and version. */
export function manifestPatch(manifest: RouteManifest, identity: IdentitySpec, task: AgentTask): Patch {
  const routes = compileManifestPages(manifest, identity);
  const stateFixtures = compileManifestStates(manifest);
  return {
    operations: [
      { op: 'replace', path: '/pages/routes', value: routes },
      { op: 'replace', path: '/stateFixtures', value: stateFixtures },
    ],
    baseVersionId: task.baseVersionId,
    touchedPaths: ['/pages/routes', '/stateFixtures'],
    rationale: `Arquitetura de informação: ${manifest.journey}`,
    confidence: 1,
    stage: 'prototype',
    role: 'composer',
    idempotencyKey: hashJson(['architect', task.baseVersionId, task.inputDigest, ARCHITECT_PROMPT_VERSION, manifest]),
  };
}
