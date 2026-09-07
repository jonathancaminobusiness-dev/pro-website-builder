import { resolveTokens, visualPropKeys, type DesignIR } from '@pwb/domain';
import { contrastRatio, requiredContrast } from './contrast.js';
import { describeContext, type NodeGeometry, type RenderContext, type RenderEvidence } from './evidence.js';

export type QaTier = 0 | 1;
export type QaSeverity = 'veto' | 'major' | 'minor';

export interface QaFinding { message: string; nodeIds: string[]; context?: RenderContext; /** The node prop the check is about, when one is; a repair should target it rather than guess. */ prop?: string; }
export interface QaCheck extends QaFinding { id: string; tier: QaTier; severity: QaSeverity; title: string; }
export interface QaInput { ir: DesignIR; evidence: RenderEvidence[]; }
export interface QaRule { id: string; tier: QaTier; severity: QaSeverity; title: string; detect: (input: QaInput) => QaFinding[]; }

/** A browser reports fractional pixels; anything under this is rounding, not a defect. */
const SUBPIXEL = 1;

export function lengthToPx(value: string | number | boolean): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const match = /^(-?\d*\.?\d+)(px|rem|em)?$/.exec(value.trim());
  if (!match) return undefined;
  const amount = Number.parseFloat(match[1]!);
  if (!Number.isFinite(amount)) return undefined;
  return match[2] === 'rem' || match[2] === 'em' ? amount * 16 : amount;
}

function tokenValues(ir: DesignIR): Record<string, string | number | boolean> {
  try { return resolveTokens(ir.identity.tokens).values; } catch { return {}; }
}

function eachNode(evidence: RenderEvidence[]): Array<{ node: NodeGeometry; context: RenderContext }> {
  return evidence.flatMap((entry) => entry.nodes.map((node) => ({ node, context: entry.context })));
}

const stability: QaRule = {
  id: 'QA0-STABILITY', tier: 0, severity: 'veto', title: 'Captura estável',
  detect: ({ evidence }) => evidence.filter((entry) => !entry.stable)
    .map((entry) => ({ message: `A captura de ${describeContext(entry.context)} não estabilizou entre duas leituras consecutivas.`, nodeIds: [], context: entry.context })),
};

const runtimeClean: QaRule = {
  id: 'QA0-RUNTIME', tier: 0, severity: 'veto', title: 'Runtime limpo',
  detect: ({ evidence }) => evidence.flatMap((entry) => [
    ...entry.consoleErrors.map((error) => ({ message: `Erro de console em ${describeContext(entry.context)}: ${error}`, nodeIds: [], context: entry.context })),
    ...entry.networkErrors.map((error) => ({ message: `Falha de rede em ${describeContext(entry.context)}: ${error}`, nodeIds: [], context: entry.context })),
  ]),
};

const documentOverflow: QaRule = {
  id: 'QA0-OVERFLOW', tier: 0, severity: 'veto', title: 'Sem rolagem horizontal',
  detect: ({ evidence }) => evidence.filter((entry) => entry.documentMetrics.scrollWidth > entry.documentMetrics.clientWidth + SUBPIXEL)
    .map((entry) => ({ message: `O documento rola ${Math.round(entry.documentMetrics.scrollWidth - entry.documentMetrics.clientWidth)}px na horizontal em ${describeContext(entry.context)}.`, nodeIds: [], context: entry.context })),
};

const clipping: QaRule = {
  id: 'QA0-CLIPPING', tier: 0, severity: 'veto', title: 'Conteúdo não cortado',
  detect: ({ evidence }) => eachNode(evidence)
    .filter(({ node }) => node.displayed && node.overflowHidden && !node.ellipsis && node.text.trim() !== ''
      && (node.scrollWidth > node.clientWidth + SUBPIXEL || node.scrollHeight > node.clientHeight + SUBPIXEL))
    .map(({ node, context }) => ({ message: `O nó ${node.nodeId} corta conteúdo visível em ${describeContext(context)}.`, nodeIds: [node.nodeId], context })),
};

const geometry: QaRule = {
  id: 'QA0-GEOMETRY', tier: 0, severity: 'veto', title: 'Geometria finita e dentro da tela',
  detect: ({ evidence }) => eachNode(evidence).flatMap(({ node, context }) => {
    const values = [node.box.x, node.box.y, node.box.width, node.box.height];
    if (values.some((value) => !Number.isFinite(value))) return [{ message: `O nó ${node.nodeId} tem retângulo não finito em ${describeContext(context)}.`, nodeIds: [node.nodeId], context }];
    if (!node.displayed || node.box.width === 0 || node.box.height === 0) return [];
    const escapesLeft = node.box.x + node.box.width <= 0;
    const escapesRight = node.box.x >= context.viewport;
    if (escapesLeft || escapesRight) return [{ message: `O nó ${node.nodeId} é renderizado fora da área visível em ${describeContext(context)}.`, nodeIds: [node.nodeId], context }];
    return [];
  }),
};

const truncationWithoutAlternative: QaRule = {
  id: 'QA0-TRUNCATION', tier: 0, severity: 'veto', title: 'Truncamento com alternativa',
  detect: ({ evidence }) => eachNode(evidence)
    .filter(({ node }) => node.ellipsis && node.scrollWidth > node.clientWidth + SUBPIXEL && !node.accessibleName.includes(node.text.trim()))
    .map(({ node, context }) => ({ message: `O nó ${node.nodeId} trunca o texto sem oferecer o conteúdo completo a leitores de tela em ${describeContext(context)}.`, nodeIds: [node.nodeId], context })),
};

const orphanTokens: QaRule = {
  id: 'QA0-TOKEN-ORPHAN', tier: 0, severity: 'veto', title: 'Nenhum token órfão',
  detect: ({ ir }) => {
    const values = tokenValues(ir);
    const findings: QaFinding[] = [];
    for (const page of ir.pages.routes) for (const node of page.nodes) for (const [key, value] of Object.entries(node.props)) {
      if (!visualPropKeys.has(key) || typeof value !== 'string') continue;
      const match = /^\{([^}]+)\}$/.exec(value);
      if (!match) { findings.push({ message: `O nó ${node.id} declara ${key} fora do sistema de tokens.`, nodeIds: [node.id] }); continue; }
      if (!(match[1]! in values)) findings.push({ message: `O nó ${node.id} aponta ${key} para o token inexistente ${value}.`, nodeIds: [node.id] });
    }
    return findings;
  },
};

const contrast: QaRule = {
  id: 'QA0-CONTRAST', tier: 0, severity: 'veto', title: 'Contraste AA',
  detect: ({ evidence }) => evidence.flatMap((entry) => entry.contrast.flatMap((sample) => {
    const ratio = contrastRatio(sample.foreground, sample.background);
    if (ratio === undefined) return [{ message: `Não foi possível medir o contraste do nó ${sample.nodeId} em ${describeContext(entry.context)}.`, nodeIds: [sample.nodeId], context: entry.context }];
    const required = requiredContrast(sample.fontSizePx, sample.bold);
    if (ratio + 0.005 >= required) return [];
    return [{ message: `O nó ${sample.nodeId} tem contraste ${ratio.toFixed(2)}:1 contra o mínimo AA de ${required}:1 em ${describeContext(entry.context)}.`, nodeIds: [sample.nodeId], context: entry.context }];
  })),
};

const focusVisible: QaRule = {
  id: 'QA0-FOCUS', tier: 0, severity: 'veto', title: 'Foco visível',
  detect: ({ evidence }) => evidence.flatMap((entry) => entry.focus.flatMap((sample) => {
    const shadowed = sample.boxShadow !== '' && sample.boxShadow !== 'none';
    const outlined = sample.outlineWidthPx >= 1 && sample.outlineStyle !== 'none';
    if (!outlined && !shadowed) return [{ message: `O nó focalizável ${sample.nodeId} não mostra indicador de foco em ${describeContext(entry.context)}.`, nodeIds: [sample.nodeId], context: entry.context }];
    if (!outlined) return [];
    const ratio = contrastRatio(sample.outlineColor, sample.surroundingColor);
    if (ratio !== undefined && ratio + 0.005 < 3) return [{ message: `O indicador de foco do nó ${sample.nodeId} tem contraste ${ratio.toFixed(2)}:1 contra o mínimo de 3:1 em ${describeContext(entry.context)}.`, nodeIds: [sample.nodeId], context: entry.context }];
    return [];
  })),
};

function axeRule(id: string, tier: QaTier, severity: QaSeverity, impacts: ReadonlySet<string>, title: string): QaRule {
  return {
    id, tier, severity, title,
    detect: ({ evidence }) => evidence.flatMap((entry) => entry.axeViolations.filter((violation) => impacts.has(violation.impact))
      .map((violation) => ({ message: `axe ${violation.id} (${violation.impact}) em ${describeContext(entry.context)}: ${violation.help}`, nodeIds: violation.nodeIds, context: entry.context }))),
  };
}

const rhythm: QaRule = {
  id: 'QA1-RHYTHM', tier: 1, severity: 'major', title: 'Ritmo da gramática de grid',
  detect: ({ ir, evidence }) => {
    const values = tokenValues(ir);
    const reference = /^\{([^}]+)\}$/.exec(ir.identity.gridGrammar.rhythmToken);
    const raw = reference ? values[reference[1]!] : ir.identity.gridGrammar.rhythmToken;
    const step = raw === undefined ? undefined : lengthToPx(raw);
    if (step === undefined || step <= 0) return [];
    const offBeat = (length: number | null): boolean => length !== null && length > SUBPIXEL && Math.abs(length / step - Math.round(length / step)) * step > SUBPIXEL;
    return eachNode(evidence).flatMap(({ node, context }) => ([
      ['gap', 'gap', node.gapPx], ['paddingBlock', 'padding em bloco', node.paddingBlockPx],
      ['paddingInline', 'padding em linha', node.paddingInlinePx], ['margin', 'margem em bloco', node.marginBlockPx],
    ] as const).filter(([, , length]) => offBeat(length))
      .map(([prop, label, length]) => ({ message: `O nó ${node.nodeId} usa ${label} de ${length!.toFixed(1)}px, fora do ritmo de ${step}px em ${describeContext(context)}.`, nodeIds: [node.nodeId], context, prop })));
  },
};

const alignment: QaRule = {
  id: 'QA1-ALIGNMENT', tier: 1, severity: 'minor', title: 'Alinhamento entre irmãos',
  detect: ({ evidence }) => evidence.flatMap((entry) => {
    const siblings = new Map<string, NodeGeometry[]>();
    for (const node of entry.nodes) {
      if (!node.displayed || node.parentNodeId === undefined || node.box.width === 0) continue;
      siblings.set(node.parentNodeId, [...(siblings.get(node.parentNodeId) ?? []), node]);
    }
    const findings: QaFinding[] = [];
    for (const [parentNodeId, group] of siblings) {
      const edges = group.map((node) => node.box.x);
      const smallest = Math.min(...edges);
      const drifting = group.filter((node) => node.box.x - smallest > SUBPIXEL / 4 && node.box.x - smallest < 4);
      if (drifting.length > 0) findings.push({ message: `Os filhos de ${parentNodeId} desalinham em menos de 4px, o que lê como erro e não como intenção em ${describeContext(entry.context)}.`, nodeIds: drifting.map((node) => node.nodeId), context: entry.context });
    }
    return findings;
  }),
};

const truncationWithAlternative: QaRule = {
  id: 'QA1-TRUNCATION', tier: 1, severity: 'minor', title: 'Truncamento anunciado',
  detect: ({ evidence }) => eachNode(evidence)
    .filter(({ node }) => node.ellipsis && node.scrollWidth > node.clientWidth + SUBPIXEL && node.accessibleName.includes(node.text.trim()))
    .map(({ node, context }) => ({ message: `O nó ${node.nodeId} trunca visualmente o texto em ${describeContext(context)}; confirme se o corte é intencional.`, nodeIds: [node.nodeId], context })),
};

export const qaRuleRegistry: QaRule[] = [
  stability, runtimeClean, documentOverflow, clipping, geometry, truncationWithoutAlternative, orphanTokens, contrast, focusVisible,
  axeRule('QA0-AXE', 0, 'veto', new Set(['critical', 'serious']), 'axe sem violação crítica'),
  rhythm, alignment, truncationWithAlternative,
  axeRule('QA1-AXE', 1, 'minor', new Set(['moderate', 'minor']), 'axe sem violação moderada'),
];
