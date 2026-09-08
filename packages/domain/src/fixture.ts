import type { DecisionRecord, Evidence } from './divergence.js';
import type { DesignIR } from './ir.js';
import type { IdentitySpec } from './identity.js';

const fixtureEvidence: Evidence[] = [
  { id: 'ev-audience', kind: 'brief', quote: 'Times pequenos com produto autoral precisam explicar uma proposta sem parecer agência.', source: 'briefing fixo, parágrafo 1' },
  { id: 'ev-proof', kind: 'brief', quote: 'O processo é rastreável e cada etapa deixa registro.', source: 'briefing fixo, parágrafo 2' },
  { id: 'ev-exclusion', kind: 'constraint', quote: 'Nada que pareça um SaaS genérico de template.', source: 'briefing fixo, exclusões' },
  { id: 'ev-material', kind: 'artifact', quote: 'Cadernos de oficina: papel, tinta e diagramas anotados à mão.', source: 'referência material fornecida pelo capitão' },
];

/** One record per token and per governed contract field, so ID-003 has nothing to flag. */
const fixtureDecisions: DecisionRecord[] = [
  { id: 'dec-ink', choice: 'tokens.color.ink', axis: 'color', evidenceIds: ['ev-material'], rationale: 'Tinta sobre papel: o texto é o material mais escuro da página.' },
  { id: 'dec-paper', choice: 'tokens.color.paper', axis: 'materiality', evidenceIds: ['ev-material'], rationale: 'Superfície de papel não branqueado, para afastar a folha branca de painel.' },
  { id: 'dec-accent', choice: 'tokens.color.accent', axis: 'color', evidenceIds: ['ev-proof'], rationale: 'Um único pigmento marca a prova; usá-lo em mais de um papel dilui a evidência.' },
  { id: 'dec-muted', choice: 'tokens.color.muted', axis: 'color', evidenceIds: ['ev-material'], rationale: 'Cinza esverdeado para anotação secundária, no lugar de opacidade sobre tinta.' },
  { id: 'dec-space-sm', choice: 'tokens.space.sm', axis: 'composition', evidenceIds: ['ev-material'], rationale: 'Menor passo do ritmo, do espaçamento entre linha e legenda no caderno.' },
  { id: 'dec-space-md', choice: 'tokens.space.md', axis: 'composition', evidenceIds: ['ev-material'], rationale: 'Passo base do ritmo vertical e da calha do grid.' },
  { id: 'dec-space-lg', choice: 'tokens.space.lg', axis: 'composition', evidenceIds: ['ev-audience'], rationale: 'Separação entre blocos de argumento, para leitura em uma sentada.' },
  { id: 'dec-space-xl', choice: 'tokens.space.xl', axis: 'composition', evidenceIds: ['ev-audience'], rationale: 'Medida máxima da coluna de leitura; limita a linha antes da tela.' },
  { id: 'dec-breakpoint-compact', choice: 'tokens.breakpoint.compact', axis: 'composition', evidenceIds: ['ev-audience'], rationale: 'Primeira largura em que a coluna de leitura deixa de ser única; abaixo dela nada se transforma.' },
  { id: 'dec-breakpoint-expanded', choice: 'tokens.breakpoint.expanded', axis: 'composition', evidenceIds: ['ev-material'], rationale: 'Largura em que a assimetria 5/7 do grid cabe sem apertar a calha.' },
  { id: 'dec-radius-card', choice: 'tokens.radius.card', axis: 'materiality', evidenceIds: ['ev-material'], rationale: 'Canto de cartão impresso aparado, não raio uniforme de kit.' },
  { id: 'dec-type-display', choice: 'tokens.type.display', axis: 'typography', evidenceIds: ['ev-exclusion'], rationale: 'Serifa de contraste alto para afastar a headline do padrão grotesco de SaaS.' },
  { id: 'dec-type-body', choice: 'tokens.type.body', axis: 'typography', evidenceIds: ['ev-audience'], rationale: 'Sem serifa de leitura longa, subordinada à display e nunca usada em título.' },
  { id: 'dec-motion-quick', choice: 'tokens.motion.quick', axis: 'motion', evidenceIds: ['ev-proof'], rationale: 'Duração única de mudança de estado; movimento só confirma ação.' },
  { id: 'dec-thesis', choice: 'direction.thesis', axis: 'materiality', evidenceIds: ['ev-material'], rationale: 'A oficina editorial é a metáfora que liga processo e evidência.' },
  { id: 'dec-columns', choice: 'gridGrammar.columns', axis: 'composition', evidenceIds: ['ev-material'], rationale: 'Doze colunas permitem a assimetria 5/7 sem inventar exceção óptica.' },
  { id: 'dec-imagery', choice: 'imagery.treatment', axis: 'imagery', evidenceIds: ['ev-proof'], rationale: 'Recorte documental do próprio trabalho, no lugar de fotografia de banco.' },
  { id: 'dec-iconography', choice: 'iconography.family', axis: 'materiality', evidenceIds: ['ev-material'], rationale: 'Marcas de traço único, do vocabulário de anotação da oficina.' },
  { id: 'dec-voice', choice: 'content.voice', axis: 'typography', evidenceIds: ['ev-audience', 'ev-exclusion'], rationale: 'Voz direta e específica porque o público desconfia de superlativo.' },
];

export function createFixtureIdentity(): IdentitySpec {
  const tokens = {
    color: {
      ink: { $value: '#18252d', $type: 'color' as const },
      paper: { $value: '#f4efe6', $type: 'color' as const },
      accent: { $value: '#e07a5f', $type: 'color' as const },
      muted: { $value: '#607078', $type: 'color' as const },
    },
    space: {
      sm: { $value: '0.75rem', $type: 'dimension' as const },
      md: { $value: '1.5rem', $type: 'dimension' as const },
      lg: { $value: '3rem', $type: 'dimension' as const },
      xl: { $value: '6rem', $type: 'dimension' as const },
    },
    breakpoint: {
      compact: { $value: '44rem', $type: 'dimension' as const },
      expanded: { $value: '60rem', $type: 'dimension' as const },
    },
    radius: { card: { $value: '1.25rem', $type: 'borderRadius' as const } },
    type: {
      display: { $value: '"Fraunces", Georgia, serif', $type: 'fontFamily' as const },
      body: { $value: 'Inter, Arial, sans-serif', $type: 'fontFamily' as const },
    },
    motion: { quick: { $value: '160ms', $type: 'duration' as const } },
  };
  return {
    meta: { id: 'fixture-identity', version: '1.0.0', locale: 'pt-BR', status: 'approved' },
    strategy: { audience: 'Times pequenos com produto autoral', job: 'Explicar uma proposta com confiança', promise: 'Clareza com personalidade', proof: ['Processo rastreável'], exclusions: ['Visual SaaS genérico'], evidence: structuredClone(fixtureEvidence) },
    direction: { thesis: 'Oficina editorial', tension: 'Precisão encontra calor humano', materiality: 'Papel, tinta e diagramas', density: 'balanced', divergenceVector: ['editorial', 'tactile', 'asymmetric'], rationale: 'A identidade transforma processo em evidência visual.', rejectedAlternatives: [] },
    tokens,
    tokenRoles: { surface: 'color.paper', text: 'color.ink', bodyTypeface: 'type.body', baseSpacing: 'space.md', sectionSpacing: 'space.lg' },
    gridGrammar: { maxWidthToken: '{space.xl}', columns: 12, gutterToken: '{space.md}', rhythmToken: '{space.md}', breakpointTokens: ['{breakpoint.compact}', '{breakpoint.expanded}'], responsive: [{ container: 'narrow', rule: 'stack content before proof' }] },
    imagery: { treatment: 'Documentary crops with paper texture', focalPolicy: 'Keep the subject off-center', allowedSources: ['manual', 'higgsfield-mcp'] },
    iconography: { family: 'single-line workshop marks', strokeToken: '{color.ink}', naming: 'purpose-first accessible labels' },
    content: { voice: 'direta, humana, específica', message: 'Toda escolha tem motivo.', allowedTerms: ['processo', 'prova', 'oficina'], forbiddenTerms: ['revolucionário', 'mágico'] },
    do: ['Use evidence before decoration', 'Keep asymmetry intentional'],
    dont: ['Use centered gradient hero defaults', 'Hide the rationale'],
    forbiddenDefaults: { fonts: ['Inter-only hero', 'system-ui-only display'], palettes: ['purple-blue gradient', 'neon SaaS'], motifs: ['generic sparkle', 'floating glass cards'] },
    governance: { approverRole: 'captain', rationaleRequired: true, changePolicy: 'Token changes reopen dependent gates.' },
    provenance: { source: 'fixture', author: 'pro-website-builder', license: 'internal fixture', date: '2026-09-05', hash: 'fixture' },
    decisions: structuredClone(fixtureDecisions),
  };
}

/**
 * The fixture's own mark, as the bytes a page would inline. A ready asset names
 * the image a document can carry, so it is a real `data:` URI: a licence row
 * that says the bundle ships it has to be able to point at what it ships.
 */
const FIXTURE_MARK_URI = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZD0iTTQgMjAgMTIgNCAyMCAyMFoiLz48L3N2Zz4=';

export function createFixtureIR(): DesignIR {
  const identity = createFixtureIdentity();
  const node = (id: string, kind: 'stack' | 'grid' | 'cluster' | 'media' | 'type' | 'surface' | 'ornament' | 'component', semantic: 'h1' | 'h2' | 'h3' | 'p' | 'section' | 'figure' | 'div', props: Record<string, string>, slots: Record<string, string[]> = {}) => ({ id, kind, semantic, props, slots, responsive: [] });
  return {
    meta: { id: 'fixture-ir', projectId: 'fixture-project', versionId: 'v0', rendererVersion: 'renderer-0.1', createdAt: '2026-09-05T00:00:00.000Z' },
    identity,
    pages: { routes: [
      { id: 'page-home', route: '/', title: 'Oficina — início', rootNodeId: 'home-root', nodes: [node('home-root', 'stack', 'div', { gap: '{space.lg}', color: '{color.ink}', background: '{color.paper}' }, { children: ['home-title', 'home-proof'] }), node('home-title', 'type', 'h1', { text: 'Toda escolha tem motivo.', color: '{color.ink}', font: '{type.display}' }), node('home-proof', 'surface', 'section', { text: 'Processo rastreável.', background: '{color.accent}', radius: '{radius.card}', padding: '{space.md}' })] },
      { id: 'page-proof', route: '/proof', title: 'Oficina — prova', rootNodeId: 'proof-root', nodes: [node('proof-root', 'stack', 'div', { gap: '{space.md}', color: '{color.ink}', background: '{color.paper}' }, { children: ['proof-title'] }), node('proof-title', 'type', 'h1', { text: 'Prova antes do brilho.', color: '{color.ink}', font: '{type.display}' })] },
      { id: 'page-contact', route: '/contact', title: 'Oficina — contato', rootNodeId: 'contact-root', nodes: [node('contact-root', 'stack', 'div', { gap: '{space.md}', color: '{color.ink}', background: '{color.paper}' }, { children: ['contact-title'] }), node('contact-title', 'type', 'h1', { text: 'Vamos conversar.', color: '{color.ink}', font: '{type.display}' })] },
    ] },
    assets: { items: [{ id: 'fixture-mark', kind: 'vector', uri: FIXTURE_MARK_URI, alt: 'Marca da oficina', provenance: { source: 'fixture', author: 'pro-website-builder', license: 'internal fixture', date: '2026-09-05', hash: 'fixture-mark' }, status: 'ready' }] },
    stateFixtures: { default: { description: 'Full motion', values: { motion: 'full' } }, reduced: { description: 'Reduced motion', values: { motion: 'reduced' } } },
    reviewRecord: { findings: [], approvals: [] },
  };
}
