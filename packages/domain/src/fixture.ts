import type { DesignIR } from './ir.js';
import type { IdentitySpec } from './identity.js';

export function createFixtureIdentity(): IdentitySpec {
  const tokens = {
    color: {
      ink: { $value: '#18252d', $type: 'color' as const },
      paper: { $value: '#f4efe6', $type: 'color' as const },
      accent: { $value: '#d86445', $type: 'color' as const },
      muted: { $value: '#607078', $type: 'color' as const },
    },
    space: {
      sm: { $value: '0.75rem', $type: 'dimension' as const },
      md: { $value: '1.5rem', $type: 'dimension' as const },
      lg: { $value: '3rem', $type: 'dimension' as const },
      xl: { $value: '6rem', $type: 'dimension' as const },
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
    strategy: { audience: 'Times pequenos com produto autoral', job: 'Explicar uma proposta com confiança', promise: 'Clareza com personalidade', proof: ['Processo rastreável'], exclusions: ['Visual SaaS genérico'] },
    direction: { thesis: 'Oficina editorial', tension: 'Precisão encontra calor humano', materiality: 'Papel, tinta e diagramas', density: 'balanced', divergenceVector: ['editorial', 'tactile', 'asymmetric'], rationale: 'A identidade transforma processo em evidência visual.' },
    tokens,
    tokenRoles: { surface: 'color.paper', text: 'color.ink', bodyTypeface: 'type.body', baseSpacing: 'space.md', sectionSpacing: 'space.lg' },
    gridGrammar: { maxWidthToken: '{space.xl}', columns: 12, gutterToken: '{space.md}', rhythmToken: '{space.md}', responsive: [{ container: 'narrow', rule: 'stack content before proof' }] },
    imagery: { treatment: 'Documentary crops with paper texture', focalPolicy: 'Keep the subject off-center', allowedSources: ['manual', 'higgsfield'] },
    iconography: { family: 'single-line workshop marks', strokeToken: '{color.ink}', naming: 'purpose-first accessible labels' },
    content: { voice: 'direta, humana, específica', message: 'Toda escolha tem motivo.', allowedTerms: ['processo', 'prova', 'oficina'], forbiddenTerms: ['revolucionário', 'mágico'] },
    do: ['Use evidence before decoration', 'Keep asymmetry intentional'],
    dont: ['Use centered gradient hero defaults', 'Hide the rationale'],
    forbiddenDefaults: { fonts: ['Inter-only hero', 'system-ui-only display'], palettes: ['purple-blue gradient', 'neon SaaS'], motifs: ['generic sparkle', 'floating glass cards'] },
    governance: { approverRole: 'captain', rationaleRequired: true, changePolicy: 'Token changes reopen dependent gates.' },
    provenance: { source: 'fixture', author: 'pro-website-builder', license: 'internal fixture', date: '2026-09-05', hash: 'fixture' },
  };
}

export function createFixtureIR(): DesignIR {
  const identity = createFixtureIdentity();
  const node = (id: string, kind: 'stack' | 'grid' | 'cluster' | 'media' | 'type' | 'surface' | 'ornament' | 'component', semantic: 'h1' | 'h2' | 'h3' | 'p' | 'section' | 'figure' | 'div', props: Record<string, string | number | boolean>, slots: Record<string, string[]> = {}) => ({ id, kind, semantic, props, slots });
  return {
    meta: { id: 'fixture-ir', projectId: 'fixture-project', versionId: 'v0', rendererVersion: 'renderer-0.1', createdAt: '2026-09-05T00:00:00.000Z' },
    identity,
    pages: { routes: [
      { id: 'page-home', route: '/', title: 'Oficina — início', rootNodeId: 'home-root', nodes: [node('home-root', 'stack', 'div', { gap: '{space.lg}', color: '{color.ink}', background: '{color.paper}' }, { children: ['home-title', 'home-proof'] }), node('home-title', 'type', 'h1', { text: 'Toda escolha tem motivo.', color: '{color.ink}', font: '{type.display}' }), node('home-proof', 'surface', 'section', { text: 'Processo rastreável.', background: '{color.accent}', radius: '{radius.card}', padding: '{space.md}' })] },
      { id: 'page-proof', route: '/proof', title: 'Oficina — prova', rootNodeId: 'proof-root', nodes: [node('proof-root', 'stack', 'div', { gap: '{space.md}', color: '{color.ink}', background: '{color.paper}' }, { children: ['proof-title'] }), node('proof-title', 'type', 'h1', { text: 'Prova antes do brilho.', color: '{color.ink}', font: '{type.display}' })] },
      { id: 'page-contact', route: '/contact', title: 'Oficina — contato', rootNodeId: 'contact-root', nodes: [node('contact-root', 'stack', 'div', { gap: '{space.md}', color: '{color.ink}', background: '{color.paper}' }, { children: ['contact-title'] }), node('contact-title', 'type', 'h1', { text: 'Vamos conversar.', color: '{color.ink}', font: '{type.display}' })] },
    ] },
    assets: { items: [{ id: 'fixture-mark', kind: 'vector', uri: 'inline:mark', alt: 'Marca da oficina', provenance: { source: 'fixture', author: 'pro-website-builder', license: 'internal fixture', date: '2026-09-05', hash: 'fixture-mark' }, status: 'ready' }] },
    stateFixtures: { default: { description: 'Full motion', values: { motion: 'full' } }, reduced: { description: 'Reduced motion', values: { motion: 'reduced' } } },
    reviewRecord: { findings: [], approvals: [] },
  };
}
