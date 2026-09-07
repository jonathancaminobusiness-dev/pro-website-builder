import type { ReleaseCriticDimension, ReleaseVeto, ReleaseVetoId } from '@pwb/domain';

/**
 * The release veto catalogue.
 *
 * A veto is an objective stop condition. It is never scored, averaged against
 * anything, or traded off against a good rubric score: one veto blocks Gate 3.
 * The `detector` column says who is allowed to raise it, which is how the stage
 * keeps a model out of the decision — no critic can raise a veto the compiler or
 * the evidence runners did not already produce.
 */
export interface VetoDefinition {
  id: ReleaseVetoId;
  /** pt-BR title, shown on the Gate 3 screen. */
  title: string;
  /** Who is allowed to raise it. A critic never appears here: critics observe. */
  detectors: ReleaseVeto['detector'][];
  /** What has to be true for the veto to clear. */
  clears: string;
}

export const VETO_CATALOG: VetoDefinition[] = [
  { id: 'SECRET_IN_BUNDLE', title: 'Segredo no bundle', detectors: ['compiler'], clears: 'Nenhum arquivo do bundle contém credencial, chave ou token.' },
  { id: 'XSS_OR_JAVASCRIPT_URL', title: 'XSS ou URL javascript:', detectors: ['compiler'], clears: 'Nenhum documento traz handler inline nem URL executável.' },
  { id: 'UNSANITIZED_HTML', title: 'HTML não sanitizado', detectors: ['compiler'], clears: 'Todo elemento do release é um elemento que o renderer determinístico produz.' },
  { id: 'ASSET_WITHOUT_LICENSE', title: 'Asset sem licença', detectors: ['compiler'], clears: 'Todo asset e toda fonte embarcada têm licença registrada e utilizável.' },
  { id: 'BUILD_FAILED', title: 'Falha de build', detectors: ['compiler', 'evidence'], clears: 'O compilador produz todas as rotas, com fallback de cor e de fonte.' },
  { id: 'BROKEN_PRIMARY_LINK', title: 'Link primário quebrado', detectors: ['compiler'], clears: 'Todo link interno e toda rota aprovada resolvem dentro do bundle.' },
  { id: 'CRITICAL_AA_REGRESSION', title: 'Regressão AA crítica', detectors: ['evidence'], clears: 'axe não reporta violação crítica ou séria em nenhum estado crítico.' },
  { id: 'RELEASE_DIVERGES_FROM_APPROVED', title: 'Release diverge do aprovado', detectors: ['gate'], clears: 'O bundle vem da versão que o capitão aprovou, sem alteração posterior.' },
];

const BY_ID = new Map(VETO_CATALOG.map((definition) => [definition.id, definition]));

export function vetoDefinition(id: ReleaseVetoId): VetoDefinition {
  const definition = BY_ID.get(id);
  if (!definition) throw new Error(`Unknown release veto ${id}.`);
  return definition;
}

/**
 * Merges veto lists from every source, keeps one entry per distinct finding and
 * orders them so the report reads the same way every time.
 */
export function aggregateVetoes(...sources: ReleaseVeto[][]): ReleaseVeto[] {
  const seen = new Map<string, ReleaseVeto>();
  for (const veto of sources.flat()) {
    const definition = vetoDefinition(veto.id);
    if (!definition.detectors.includes(veto.detector)) throw new Error(`Veto ${veto.id} may only be raised by ${definition.detectors.join(' or ')}; it arrived from the ${veto.detector}.`);
    seen.set(`${veto.id}|${veto.where}|${veto.detail}`, veto);
  }
  const order = VETO_CATALOG.map((definition) => definition.id);
  return [...seen.values()].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id) || (a.where < b.where ? -1 : a.where > b.where ? 1 : 0));
}

/** The dimension each critic reads; used to route findings and to name the rubric rows. */
export const CRITIC_DIMENSION_TITLES: Record<ReleaseCriticDimension, string> = {
  accessibility: 'Acessibilidade',
  'semantics-seo': 'Semântica e SEO',
  'visual-regression': 'Regressão visual e responsividade',
  'asset-performance': 'Performance de assets',
  'provenance-security': 'Proveniência, licença e segurança',
};
