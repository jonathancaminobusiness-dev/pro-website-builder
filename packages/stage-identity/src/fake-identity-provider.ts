import { idempotencyKey, type AgentResult, type AgentTask, type DecisionRecord, type Evidence, type IdentitySpec, type TokenGroup } from '@pwb/domain';
import type { ModelProvider } from '@pwb/providers';
import { identityAxisBrief, identityAxisBriefs, type IdentityAxisBriefId } from './axes.js';
import { identityCritics } from './critics.js';
import type { BriefSpec, CritiqueReport, DirectionVectorDraft, ImagePromptPlan } from './contracts.js';

/**
 * The deterministic stand-in the whole identity journey runs on in CI. It is a
 * fixture, not a model: it answers each role with a fixed, schema-valid
 * artefact so the orchestration, the branch discipline, DIV-030, ID-003 and the
 * gate can be exercised without a paid API, a credential or a network call.
 *
 * The three directions it returns are deliberately opposed on all six axes and
 * carry palettes whose lightness and chroma differ, so a passing DIV-030 here
 * means the rule ran, not that it was bypassed.
 */
const evidence: Evidence[] = [
  { id: 'ev-audience', kind: 'brief', quote: 'Times pequenos com produto autoral precisam explicar uma proposta sem parecer agência.', source: 'briefing, parágrafo 1' },
  { id: 'ev-proof', kind: 'brief', quote: 'O processo é rastreável e cada etapa deixa registro.', source: 'briefing, parágrafo 2' },
  { id: 'ev-exclusion', kind: 'constraint', quote: 'Nada que pareça um SaaS genérico de template.', source: 'briefing, exclusões' },
  { id: 'ev-material', kind: 'artifact', quote: 'Cadernos de oficina: papel, tinta e diagramas anotados à mão.', source: 'referência material do capitão' },
];

export const fakeBriefSpec: BriefSpec = {
  audience: 'Times pequenos com produto autoral',
  job: 'Explicar uma proposta com confiança, sem depender de um vendedor',
  promise: 'Clareza com personalidade',
  proof: ['Processo rastreável', 'Cada decisão registra o motivo'],
  exclusions: ['Visual SaaS genérico', 'Promessa sem prova'],
  evidence,
  unknowns: ['Idiomas além do pt-BR', 'Volume de conteúdo real por rota'],
  assumptions: [{ id: 'as-locale', statement: 'A primeira versão é só em pt-BR.', risk: 'low' }],
  forbiddenDefaults: {
    fonts: ['Inter-only hero', 'system-ui-only display'],
    palettes: ['purple-blue gradient', 'neon SaaS'],
    motifs: ['generic sparkle', 'floating glass cards'],
  },
};

interface DirectionSeed {
  id: IdentityAxisBriefId;
  label: string;
  thesis: string;
  tension: string;
  materiality: string;
  density: IdentitySpec['direction']['density'];
  rationale: string;
  colors: { ink: string; paper: string; accent: string; muted: string };
  space: { sm: string; md: string; lg: string; xl: string };
  radius: string;
  type: { display: string; body: string };
  motion: string;
  grid: { columns: number; responsive: string };
  imagery: IdentitySpec['imagery'];
  iconography: IdentitySpec['iconography'];
  content: IdentitySpec['content'];
  descriptors: DirectionVectorDraft['descriptors'];
  constants: string[];
  reasons: Record<string, string>;
}

const seeds: DirectionSeed[] = [
  {
    id: 'editorial-material',
    label: 'Oficina editorial',
    thesis: 'Uma publicação que mostra o processo em vez de anunciá-lo',
    tension: 'Precisão de tipografia contra calor de material',
    materiality: 'Papel não branqueado, tinta offset e diagramas anotados',
    density: 'balanced',
    rationale: 'A assimetria carrega a hierarquia e o material carrega a confiança.',
    colors: { ink: '#1d2321', paper: '#f2ece1', accent: '#b4552f', muted: '#6d7f6a' },
    space: { sm: '0.75rem', md: '1.5rem', lg: '3.25rem', xl: '64rem' },
    radius: '0.25rem',
    type: { display: '"Fraunces", Georgia, serif', body: '"Source Serif 4", Georgia, serif' },
    motion: '220ms',
    grid: { columns: 12, responsive: 'a coluna larga precede a estreita até 48rem' },
    imagery: { treatment: 'Recorte documental do próprio trabalho, com grão de papel', focalPolicy: 'Assunto fora do centro, alinhado à calha', allowedSources: ['manual', 'higgsfield-mcp'] },
    iconography: { family: 'marcas de traço único de anotação', strokeToken: '{color.ink}', naming: 'nome pelo propósito, com rótulo acessível' },
    content: { voice: 'direta, humana, específica', message: 'Toda escolha tem motivo.', allowedTerms: ['processo', 'prova', 'oficina'], forbiddenTerms: ['revolucionário', 'mágico'] },
    descriptors: {
      composition: 'Duas colunas desiguais: o argumento ocupa cinco de doze e a prova ocupa sete.',
      typography: 'Serifa de contraste alto no título contra serifa de leitura no corpo.',
      materiality: 'Papel absorvente e tinta: a superfície tem cor própria, não é branco de painel.',
      color: 'Pigmentos de terra com um único acento quente reservado à prova.',
      imagery: 'Fotografia documental do trabalho real, nunca banco de imagem.',
      motion: 'Movimento com peso: o elemento assenta, não desliza.',
    },
    constants: ['Os caminhos de token permanecem os mesmos nas três direções', 'A promessa e a prova do briefing não mudam'],
    reasons: {
      'tokens.color.ink': 'Tinta sobre papel: o texto é o material mais escuro da página.',
      'tokens.color.paper': 'Superfície de papel não branqueado, para afastar a folha branca de painel.',
      'tokens.color.accent': 'Um pigmento de terra marca a prova; usado em mais de um papel, dilui a evidência.',
      'tokens.color.muted': 'Verde acinzentado para anotação secundária, no lugar de opacidade sobre tinta.',
      'tokens.space.sm': 'Passo entre linha e legenda, medido no caderno de referência.',
      'tokens.space.md': 'Passo base do ritmo vertical e da calha do grid.',
      'tokens.space.lg': 'Separação entre blocos de argumento, para leitura em uma sentada.',
      'tokens.space.xl': 'Medida máxima da coluna; limita a linha antes de a tela decidir.',
      'tokens.radius.card': 'Canto de cartão impresso aparado, não raio uniforme de kit.',
      'tokens.type.display': 'Serifa de contraste alto afasta a headline do grotesco padrão de SaaS.',
      'tokens.type.body': 'Serifa de leitura longa, subordinada à display e nunca usada em título.',
      'tokens.motion.quick': 'Duração única de mudança de estado; o movimento só confirma a ação.',
      'direction.thesis': 'A oficina editorial liga processo e evidência sem prometer nada.',
      'gridGrammar.columns': 'Doze colunas permitem a assimetria 5/7 sem exceção óptica inventada.',
      'imagery.treatment': 'Recorte documental do próprio trabalho, no lugar de fotografia de banco.',
      'iconography.family': 'Traço único, do vocabulário de anotação da oficina.',
      'content.voice': 'Voz direta e específica porque o público desconfia de superlativo.',
    },
  },
  {
    id: 'modular-technical',
    label: 'Instrumento modular',
    thesis: 'Um instrumento que declara a própria medida',
    tension: 'Rigor de módulo contra necessidade de convencer',
    materiality: 'Superfície usinada, silk-screen e cota visível',
    density: 'dense',
    rationale: 'O módulo é visível, a medida é declarada e o sinal aparece uma vez só.',
    colors: { ink: '#0b0f14', paper: '#ffffff', accent: '#0043ff', muted: '#9aa4ad' },
    space: { sm: '0.5rem', md: '1rem', lg: '2rem', xl: '72rem' },
    radius: '0rem',
    type: { display: '"Archivo", Helvetica, Arial, sans-serif', body: '"IBM Plex Mono", ui-monospace, monospace' },
    motion: '90ms',
    grid: { columns: 16, responsive: 'o módulo divide por dois abaixo de 40rem, nunca reflui livre' },
    imagery: { treatment: 'Diagrama técnico cotado, gerado a partir dos próprios dados', focalPolicy: 'Origem no canto superior esquerdo do módulo', allowedSources: ['manual', 'higgsfield-mcp'] },
    iconography: { family: 'glifos de instrumento com terminais retos', strokeToken: '{color.ink}', naming: 'nome pelo estado que representa' },
    content: { voice: 'precisa, curta, verificável', message: 'A medida está declarada.', allowedTerms: ['medida', 'estado', 'módulo'], forbiddenTerms: ['revolucionário', 'mágico'] },
    descriptors: {
      composition: 'Grade de dezesseis módulos visíveis; nada ocupa meio módulo.',
      typography: 'Grotesca condensada no título contra monoespaçada no dado.',
      materiality: 'Superfície usinada e plana: sem textura, sem grão, sem sombra difusa.',
      color: 'Duotono de altíssimo contraste com um sinal saturado usado uma vez por tela.',
      imagery: 'Diagrama cotado no lugar de fotografia; a imagem informa ou não existe.',
      motion: 'Passo mecânico: a transição salta entre estados discretos.',
    },
    constants: ['Os caminhos de token permanecem os mesmos nas três direções', 'A promessa e a prova do briefing não mudam'],
    reasons: {
      'tokens.color.ink': 'Preto de instrumento, para que o sinal saturado seja o único acento.',
      'tokens.color.paper': 'Branco puro de painel: a superfície não tem cor própria neste sistema.',
      'tokens.color.accent': 'Azul de sinal, reservado a um único estado por tela.',
      'tokens.color.muted': 'Cinza de cota, para linhas de medida que não competem com o dado.',
      'tokens.space.sm': 'Meio módulo, único subdivisor permitido.',
      'tokens.space.md': 'Um módulo: a unidade de todo o desenho.',
      'tokens.space.lg': 'Dois módulos separam blocos funcionais.',
      'tokens.space.xl': 'Largura máxima do painel, em múltiplo inteiro de módulo.',
      'tokens.radius.card': 'Raio zero porque o canto arredondado esconde a borda do módulo.',
      'tokens.type.display': 'Grotesca condensada mantém o título dentro de um módulo.',
      'tokens.type.body': 'Monoespaçada alinha dígitos em coluna sem tabela.',
      'tokens.motion.quick': 'Duração curta porque a transição representa mudança de estado, não deslocamento.',
      'direction.thesis': 'Declarar a medida é a prova que este público sabe ler.',
      'gridGrammar.columns': 'Dezesseis colunas dividem por dois quatro vezes sem sobra.',
      'imagery.treatment': 'Diagrama gerado dos próprios dados evita fotografia sem função.',
      'iconography.family': 'Terminais retos combinam com a grade e com a monoespaçada.',
      'content.voice': 'Voz curta e verificável porque cada frase acompanha um número.',
    },
  },
  {
    id: 'typographic-low-chroma',
    label: 'Documento tipográfico',
    thesis: 'Um documento em que só o tipo e a margem constroem hierarquia',
    tension: 'Sobriedade de contrato contra necessidade de personalidade',
    materiality: 'Impresso em duas tintas, sem imagem de apoio',
    density: 'airy',
    rationale: 'A cor quase não trabalha; a margem e a escala óptica fazem todo o trabalho.',
    colors: { ink: '#23211f', paper: '#efeeec', accent: '#545049', muted: '#8c877e' },
    space: { sm: '1rem', md: '2rem', lg: '5rem', xl: '52rem' },
    radius: '0.125rem',
    type: { display: '"Literata", Georgia, serif', body: '"Literata", Georgia, serif' },
    motion: '1ms',
    grid: { columns: 6, responsive: 'a margem cresce antes de a coluna encolher' },
    imagery: { treatment: 'Sem fotografia; a textura vem do próprio bloco de texto', focalPolicy: 'A mancha de texto é o foco', allowedSources: ['manual'] },
    iconography: { family: 'sinais tipográficos da própria família', strokeToken: '{color.ink}', naming: 'nome pelo papel no texto' },
    content: { voice: 'sóbria, longa, argumentativa', message: 'O argumento se sustenta sozinho.', allowedTerms: ['argumento', 'registro', 'documento'], forbiddenTerms: ['revolucionário', 'mágico'] },
    descriptors: {
      composition: 'Margem larga governa a página; a coluna de texto nunca é centralizada por padrão.',
      typography: 'Uma família só, com escala óptica separando display de corpo.',
      materiality: 'Impresso em duas tintas: nenhuma superfície simula profundidade.',
      color: 'Neutros de baixíssimo croma; o acento é apenas um cinza mais escuro.',
      imagery: 'Nenhuma fotografia; a mancha de texto é a única textura.',
      motion: 'Sem movimento: a mudança de estado é instantânea.',
    },
    constants: ['Os caminhos de token permanecem os mesmos nas três direções', 'A promessa e a prova do briefing não mudam'],
    reasons: {
      'tokens.color.ink': 'Primeira tinta do impresso; toda a hierarquia de texto sai dela.',
      'tokens.color.paper': 'Papel levemente quente, para leitura longa sem brilho.',
      'tokens.color.accent': 'Segunda tinta, um cinza mais escuro: o acento não é cor, é peso.',
      'tokens.color.muted': 'Cinza de nota de rodapé, ainda legível a 200% de zoom.',
      'tokens.space.sm': 'Entrelinha de bloco curto, na mesma escala do corpo.',
      'tokens.space.md': 'Passo base entre parágrafos e entre bloco e nota.',
      'tokens.space.lg': 'Respiro entre seções do argumento, no lugar de régua ou caixa.',
      'tokens.space.xl': 'Medida da mancha: cinquenta e dois rem mantêm a linha legível.',
      'tokens.radius.card': 'Raio quase nulo porque a caixa é um recorte, não um objeto.',
      'tokens.type.display': 'A mesma família do corpo, em tamanho óptico de título.',
      'tokens.type.body': 'Uma família só evita o par arbitrário de dois tipos.',
      'tokens.motion.quick': 'Um milissegundo declara a posição: este sistema não anima.',
      'direction.thesis': 'O documento é a forma que este público já confia para argumento longo.',
      'gridGrammar.columns': 'Seis colunas bastam quando a margem, e não a coluna, carrega a hierarquia.',
      'imagery.treatment': 'A ausência de imagem é a decisão, não a falta de orçamento.',
      'iconography.family': 'Sinais da própria família evitam um segundo desenho no sistema.',
      'content.voice': 'Voz longa e argumentativa porque o formato pede leitura, não varredura.',
    },
  },
];

function tokensOf(seed: DirectionSeed): TokenGroup {
  return {
    color: {
      ink: { $value: seed.colors.ink, $type: 'color' },
      paper: { $value: seed.colors.paper, $type: 'color' },
      accent: { $value: seed.colors.accent, $type: 'color' },
      muted: { $value: seed.colors.muted, $type: 'color' },
    },
    space: {
      sm: { $value: seed.space.sm, $type: 'dimension' },
      md: { $value: seed.space.md, $type: 'dimension' },
      lg: { $value: seed.space.lg, $type: 'dimension' },
      xl: { $value: seed.space.xl, $type: 'dimension' },
    },
    radius: { card: { $value: seed.radius, $type: 'borderRadius' } },
    type: {
      display: { $value: seed.type.display, $type: 'fontFamily' },
      body: { $value: seed.type.body, $type: 'fontFamily' },
    },
    motion: { quick: { $value: seed.motion, $type: 'duration' } },
  };
}

function decisionsOf(seed: DirectionSeed): DecisionRecord[] {
  const axisFor = (choice: string): 'composition' | 'typography' | 'materiality' | 'color' | 'imagery' | 'motion' => {
    if (choice.startsWith('tokens.color.')) return 'color';
    if (choice.startsWith('tokens.space.') || choice === 'gridGrammar.columns') return 'composition';
    if (choice.startsWith('tokens.type.') || choice === 'content.voice') return 'typography';
    if (choice.startsWith('tokens.motion.')) return 'motion';
    if (choice === 'imagery.treatment') return 'imagery';
    return 'materiality';
  };
  const evidenceFor = (choice: string): string[] => {
    if (choice.startsWith('tokens.color.') || choice === 'direction.thesis' || choice === 'iconography.family') return ['ev-material'];
    if (choice === 'imagery.treatment' || choice.startsWith('tokens.motion.')) return ['ev-proof'];
    if (choice.startsWith('tokens.type.')) return ['ev-exclusion'];
    return ['ev-audience'];
  };
  return Object.entries(seed.reasons).map(([choice, rationale]) => ({
    id: `dec-${seed.id}-${choice.replaceAll('.', '-')}`,
    choice,
    axis: axisFor(choice),
    evidenceIds: evidenceFor(choice),
    rationale,
  }));
}

export function fakeIdentityFor(seedId: IdentityAxisBriefId): IdentitySpec {
  const seed = seeds.find((entry) => entry.id === seedId);
  if (!seed) throw new Error(`Unknown fake identity seed ${seedId}.`);
  return {
    meta: { id: `identity-${seed.id}`, version: '1.0.0', locale: 'pt-BR', status: 'draft' },
    strategy: { audience: fakeBriefSpec.audience, job: fakeBriefSpec.job, promise: fakeBriefSpec.promise, proof: fakeBriefSpec.proof, exclusions: fakeBriefSpec.exclusions, evidence },
    direction: { thesis: seed.thesis, tension: seed.tension, materiality: seed.materiality, density: seed.density, divergenceVector: Object.values(identityAxisBrief(seed.id).required).slice(0, 3), rationale: seed.rationale, rejectedAlternatives: [] },
    tokens: tokensOf(seed),
    tokenRoles: { surface: 'color.paper', text: 'color.ink', bodyTypeface: 'type.body', baseSpacing: 'space.md', sectionSpacing: 'space.lg' },
    gridGrammar: { maxWidthToken: '{space.xl}', columns: seed.grid.columns, gutterToken: '{space.md}', rhythmToken: '{space.md}', responsive: [{ container: 'narrow', rule: seed.grid.responsive }] },
    imagery: seed.imagery,
    iconography: seed.iconography,
    content: seed.content,
    do: ['Citar a evidência antes de decorar', 'Manter a assimetria intencional'],
    dont: ['Usar hero centralizado com gradiente', 'Esconder o rationale'],
    forbiddenDefaults: fakeBriefSpec.forbiddenDefaults,
    governance: { approverRole: 'captain', rationaleRequired: true, changePolicy: 'Uma mudança de token reabre o Gate 1 e invalida os renders dependentes.' },
    provenance: { source: 'fake-identity-provider', author: 'pro-website-builder', license: 'internal fixture', date: '2026-09-07', hash: `fake-${seed.id}` },
    decisions: decisionsOf(seed),
  };
}

function draftFor(seedId: IdentityAxisBriefId): DirectionVectorDraft {
  const seed = seeds.find((entry) => entry.id === seedId)!;
  return {
    schemaVersion: 1,
    directionId: seed.id,
    label: seed.label,
    descriptors: seed.descriptors,
    constants: seed.constants,
    incompatibilities: [{ a: seed.descriptors.composition, b: seeds.find((entry) => entry.id !== seed.id)!.descriptors.composition, reason: 'As duas gramáticas de composição não podem coexistir na mesma página.' }],
  };
}

function critiqueFor(criticId: string, subject: CritiqueReport['subject']): CritiqueReport {
  const critic = identityCritics.find((entry) => entry.id === criticId)!;
  const target = subject.kind === 'direction' ? subject.directionId : 'a matriz completa';
  return {
    schemaVersion: 1,
    criticId,
    dimension: critic.dimension,
    subject,
    perception: [`O documento declara ${target} com os seis eixos preenchidos e uma decisão por token.`],
    comprehension: [`Para o público do briefing, ${target} sustenta o argumento sem depender de um hero.`],
    scores: [{ dimension: critic.dimension, score: 4, evidence: 'Cada escolha aponta para uma evidência do briefing e para um eixo declarado.' }],
    findings: [],
    abstain: false,
    summary: `Sem veto para ${target}; a rubrica de ${critic.dimension} passa com folga.`,
  };
}

function imagePlanFor(seedId: IdentityAxisBriefId): ImagePromptPlan {
  const seed = seeds.find((entry) => entry.id === seedId)!;
  const photographyRefused = identityAxisBrief(seedId).required.imagery === 'no-photography';
  return {
    schemaVersion: 1,
    directionId: seed.id,
    plans: [{
      id: 'texture-01',
      role: photographyRefused ? 'texture' : 'proof',
      prompt: `Registro de ${seed.materiality.toLowerCase()}, luz lateral rasante, enquadramento fora do centro, sem pessoas e sem interface de produto.`,
      negatives: ['gradiente roxo-azul', 'cartão de vidro flutuante', 'brilho decorativo', 'fotografia de banco'],
      aspect: '3:2',
      axis: photographyRefused ? 'materiality' : 'imagery',
      alt: `Textura de ${seed.materiality.toLowerCase()} usada como prova da direção ${seed.label}.`,
      licenceExpectation: 'Uso interno do proprietário, com os termos do provedor registrados por imagem.',
    }],
  };
}

export class FakeIdentityProvider implements ModelProvider {
  async propose(task: AgentTask, signal?: AbortSignal): Promise<AgentResult> {
    if (signal?.aborted) throw new DOMException('The task was cancelled.', 'AbortError');
    if (task.id === 'identity-curator') {
      return { taskId: task.id, status: 'succeeded', summary: 'BriefSpec extraído do briefing fixo.', artifact: fakeBriefSpec as unknown as Record<string, unknown> };
    }
    if (task.id.startsWith('identity-director-')) {
      const seedId = task.id.replace('identity-director-', '') as IdentityAxisBriefId;
      const identity = fakeIdentityFor(seedId);
      return {
        taskId: task.id,
        status: 'succeeded',
        summary: `Direção ${seedId} proposta como contrato completo.`,
        artifact: draftFor(seedId) as unknown as Record<string, unknown>,
        proposal: {
          operations: [{ op: 'replace', path: '/identity', value: identity }],
          baseVersionId: task.baseVersionId,
          touchedPaths: ['/identity'],
          rationale: identity.direction.rationale,
          confidence: 0.9,
          stage: 'identity',
          role: 'director',
          idempotencyKey: idempotencyKey(task),
        },
      };
    }
    if (task.id.startsWith('identity-critic-')) {
      const rest = task.id.replace('identity-critic-', '');
      const critic = identityCritics.find((entry) => rest === entry.id || rest.startsWith(`${entry.id}-`));
      if (!critic) throw new Error(`No fake critique for ${task.id}.`);
      const directionId = rest === critic.id ? undefined : rest.slice(critic.id.length + 1);
      const subject: CritiqueReport['subject'] = directionId ? { kind: 'direction', directionId } : { kind: 'matrix' };
      return { taskId: task.id, status: 'succeeded', summary: `Crítica de ${critic.dimension}.`, artifact: critiqueFor(critic.id, subject) as unknown as Record<string, unknown> };
    }
    if (task.id.startsWith('identity-art-director-')) {
      const seedId = task.id.replace('identity-art-director-', '') as IdentityAxisBriefId;
      return { taskId: task.id, status: 'succeeded', summary: `Planos de imagem para ${seedId}.`, artifact: imagePlanFor(seedId) as unknown as Record<string, unknown> };
    }
    if (task.id.startsWith('identity-refiner-')) {
      const seedId = task.id.replace('identity-refiner-', '') as IdentityAxisBriefId;
      return {
        taskId: task.id,
        status: 'succeeded',
        summary: `Refino de um ciclo para ${seedId}.`,
        proposal: {
          operations: [{ op: 'replace', path: '/identity', value: fakeIdentityFor(seedId) }],
          baseVersionId: task.baseVersionId,
          touchedPaths: ['/identity'],
          rationale: 'Reparo mínimo mantendo eixos, tokens e matriz.',
          confidence: 0.8,
          stage: 'identity',
          role: 'refiner',
          idempotencyKey: idempotencyKey(task),
        },
      };
    }
    return { taskId: task.id, status: 'failed', summary: `The fake identity provider has no answer for ${task.id}.`, errorCode: 'UNKNOWN_ROLE' };
  }
}

