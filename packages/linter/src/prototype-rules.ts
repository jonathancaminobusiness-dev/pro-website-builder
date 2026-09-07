import { flattenTokens, resolveTokens, slotChildIds, type DesignIR, type Page, type PageNode } from '@pwb/domain';
import { lengthToPx } from '@pwb/qa-deterministic';
import type { LintIssue, LintRule } from './rules.js';

/**
 * The prototype half of the genericity catalogue. These rules read the typed document, not a rendered
 * page: the browser-measured half lives in the deterministic QA gate. Each explains the deviation in
 * the identity's own terms rather than scoring the design.
 */

const headingLevels: Record<string, number> = { h1: 1, h2: 2, h3: 3 };
const placeholderPatterns = [/lorem ipsum/i, /\bplaceholder\b/i, /\bTODO\b/, /aguardando composi[çc][ãa]o/i, /texto aqui/i, /sample text/i];
const STRUCTURAL_SIGNAL_NODES = 4;
const genericLabels = new Set(['clique aqui', 'saiba mais', 'leia mais', 'veja mais', 'aqui', 'click here', 'read more', 'learn more']);

function* eachNode(ir: DesignIR): Generator<{ page: Page; node: PageNode; path: string }> {
  for (const page of ir.pages.routes) for (const node of page.nodes) yield { page, node, path: `/pages/routes/${page.id}/nodes/${node.id}` };
}

function tokenPx(ir: DesignIR, reference: string | number | boolean | undefined): number | undefined {
  if (typeof reference !== 'string') return undefined;
  const match = /^\{([^}]+)\}$/.exec(reference);
  if (!match) return undefined;
  let values: Record<string, string | number | boolean>;
  try { values = resolveTokens(ir.identity.tokens).values; } catch { return undefined; }
  const resolved = values[match[1]!];
  return resolved === undefined ? undefined : lengthToPx(resolved);
}

function treeSignature(page: Page): string {
  const byId = new Map(page.nodes.map((node) => [node.id, node]));
  const walk = (node: PageNode): string => `${node.kind}:${node.semantic}(${slotChildIds(node).map((childId) => { const child = byId.get(childId); return child ? walk(child) : '?'; }).join(',')})`;
  const root = byId.get(page.rootNodeId);
  return root ? walk(root) : '';
}

/** STR-020 — the default arrangement: a hero over three interchangeable cards, or two routes with the same tree. */
function structuralDefaults(ir: DesignIR): LintIssue[] {
  const issues: LintIssue[] = [];
  const signatures = new Map<string, string>();
  for (const page of ir.pages.routes) {
    // Two pages of two or three nodes are identical by arithmetic, not by habit; only a tree with
    // real structure says anything about a repeated arrangement.
    if (page.nodes.length >= STRUCTURAL_SIGNAL_NODES) {
      const signature = treeSignature(page);
      const owner = signatures.get(signature);
      if (owner) issues.push({ path: `/pages/routes/${page.id}`, message: `As rotas ${owner} e ${page.route} repetem a mesma árvore de composição; justifique a repetição ou reestruture uma delas.` });
      else signatures.set(signature, page.route);
    }

    const byId = new Map(page.nodes.map((node) => [node.id, node]));
    for (const node of page.nodes) {
      const children = slotChildIds(node).flatMap((childId) => byId.get(childId) ?? []);
      const heading = children.findIndex((child) => child.kind === 'type' && child.semantic in headingLevels);
      const rest = children.slice(heading + 1);
      if (heading < 0 || rest.length !== 3) continue;
      const shape = (child: PageNode): string => `${child.kind}|${Object.keys(child.props).filter((key) => key !== 'text').sort().join(',')}`;
      if (new Set(rest.map(shape)).size === 1) {
        issues.push({ path: `/pages/routes/${page.id}/nodes/${node.id}`, message: `${node.id} repete o arranjo padrão de título sobre três blocos idênticos; exija um motivo no contrato ou reestruture a seção.` });
      }
    }
  }
  return issues;
}

/** GRID-040 — spacing that leaves the declared grid rhythm. */
function gridGrammar(ir: DesignIR): LintIssue[] {
  const rhythm = tokenPx(ir, ir.identity.gridGrammar.rhythmToken);
  if (rhythm === undefined || rhythm <= 0) return [{ path: '/identity/gridGrammar/rhythmToken', message: `A gramática de grid aponta o ritmo para ${ir.identity.gridGrammar.rhythmToken}, que não resolve para uma medida.` }];
  const issues: LintIssue[] = [];
  for (const { node, path } of eachNode(ir)) {
    for (const key of ['gap', 'padding', 'paddingBlock', 'paddingInline', 'margin'] as const) {
      const px = tokenPx(ir, node.props[key]);
      if (px === undefined || px === 0) continue;
      if (Math.abs(px / rhythm - Math.round(px / rhythm)) * rhythm > 0.5) {
        issues.push({ path: `${path}/props/${key}`, message: `${node.id} usa ${key} de ${px}px, fora do ritmo de ${rhythm}px declarado pela gramática de grid.`, suggestedPatch: { operation: 'set_token', nodeId: node.id, prop: key, token: ir.identity.gridGrammar.rhythmToken } });
      }
    }
  }
  return issues;
}

/** TYPE-050 — a typographic role that was never assigned, or a family with no usable fallback. */
function typographicRoles(ir: DesignIR): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const { node, path } of eachNode(ir)) {
    if (node.kind === 'type' && node.props.font === undefined) {
      issues.push({ path: `${path}/props/font`, message: `${node.id} carrega texto sem papel tipográfico; aponte font para um token da identidade.`, suggestedPatch: { operation: 'set_token', nodeId: node.id, prop: 'font', token: `{${ir.identity.tokenRoles.bodyTypeface}}` } });
    }
  }
  for (const [tokenPath, token] of flattenTokens(ir.identity.tokens)) {
    if (token.$type !== 'fontFamily' || typeof token.$value !== 'string') continue;
    if (!token.$value.includes(',')) issues.push({ path: `/identity/tokens/${tokenPath.replaceAll('.', '/')}`, message: `A família ${tokenPath} declara ${token.$value} sem fallback; um navegador sem essa fonte perde a intenção tipográfica.` });
  }
  return issues;
}

/** COH-070 — a route or a state that stops agreeing with the approved contract. */
function coherence(ir: DesignIR): LintIssue[] {
  const issues: LintIssue[] = [];
  const declared = new Set(ir.pages.routes.flatMap((page) => page.nodes.map((node) => node.id)));
  for (const [state, fixture] of Object.entries(ir.stateFixtures)) {
    for (const key of ['hidden', 'focus'] as const) {
      const value = fixture.values[key];
      if (typeof value !== 'string') continue;
      for (const nodeId of value.split(',').map((entry) => entry.trim()).filter(Boolean)) {
        if (!declared.has(nodeId)) issues.push({ path: `/stateFixtures/${state}/values/${key}`, message: `O estado ${state} aponta ${key} para ${nodeId}, que o grafo de páginas não declara.` });
      }
    }
  }
  const surface = `{${ir.identity.tokenRoles.surface}}`;
  const text = `{${ir.identity.tokenRoles.text}}`;
  for (const page of ir.pages.routes) {
    const root = page.nodes.find((node) => node.id === page.rootNodeId);
    if (!root) continue;
    if (root.props.background !== undefined && root.props.background !== surface) issues.push({ path: `/pages/routes/${page.id}/nodes/${root.id}/props/background`, message: `A raiz de ${page.route} usa ${String(root.props.background)} em vez do papel de superfície ${surface}; as rotas deixam de ler como uma identidade só.` });
    if (root.props.color !== undefined && root.props.color !== text) issues.push({ path: `/pages/routes/${page.id}/nodes/${root.id}/props/color`, message: `A raiz de ${page.route} usa ${String(root.props.color)} em vez do papel de texto ${text}.` });
  }
  return issues;
}

/** MOTION-080 — movement without intent, or without a reduced-motion state to answer for it. */
function motionIntent(ir: DesignIR): LintIssue[] {
  const issues: LintIssue[] = [];
  let types: Record<string, string | undefined> = {};
  try { types = resolveTokens(ir.identity.tokens).types; } catch { types = {}; }
  const reduced = Object.values(ir.stateFixtures).some((fixture) => fixture.values.motion === 'reduced');
  for (const { node, path } of eachNode(ir)) {
    const motion = node.props.motion;
    if (motion === undefined) continue;
    if (!reduced) issues.push({ path: `${path}/props/motion`, message: `${node.id} declara movimento, mas nenhum estado declara movimento reduzido; o protótipo não responde por quem pede menos animação.` });
    const reference = typeof motion === 'string' ? /^\{([^}]+)\}$/.exec(motion) : null;
    const type = reference ? types[reference[1]!] : undefined;
    if (reference && type !== 'duration' && type !== 'cubicBezier') {
      issues.push({ path: `${path}/props/motion`, message: `${node.id} aponta o movimento para ${String(motion)}, que não é um token de duração nem de curva; o movimento fica sem intenção declarada.` });
    }
  }
  return issues;
}

/** A11Y-090 — the accessibility failures the typed document can decide on its own. */
function accessibilityContract(ir: DesignIR): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const page of ir.pages.routes) {
    const byId = new Map(page.nodes.map((node) => [node.id, node]));
    const ordered: PageNode[] = [];
    const walk = (node: PageNode): void => { ordered.push(node); for (const childId of slotChildIds(node)) { const child = byId.get(childId); if (child) walk(child); } };
    const root = byId.get(page.rootNodeId);
    if (root) walk(root);
    const headings = ordered.filter((node) => node.kind === 'type' && node.semantic in headingLevels);
    if (!headings.some((node) => node.semantic === 'h1')) issues.push({ path: `/pages/routes/${page.id}`, message: `A rota ${page.route} não declara um h1; leitores de tela perdem o título da página.` });
    let previous = 0;
    for (const heading of headings) {
      const level = headingLevels[heading.semantic]!;
      if (previous > 0 && level > previous + 1) issues.push({ path: `/pages/routes/${page.id}/nodes/${heading.id}`, message: `A rota ${page.route} salta de h${previous} para h${level} em ${heading.id}; a hierarquia de cabeçalhos precisa ser contínua.` });
      previous = level;
    }
    for (const node of page.nodes) {
      if (node.kind !== 'component') continue;
      const label = typeof node.props.text === 'string' ? node.props.text.trim() : '';
      if (label === '') { issues.push({ path: `/pages/routes/${page.id}/nodes/${node.id}/props/text`, message: `O controle ${node.id} não tem nome acessível.` }); continue; }
      if (genericLabels.has(label.toLowerCase())) issues.push({ path: `/pages/routes/${page.id}/nodes/${node.id}/props/text`, message: `O controle ${node.id} usa o rótulo genérico "${label}"; diga para onde ele leva.` });
    }
  }
  return issues;
}

/** COPY-110 — placeholder copy, empty text and the vocabulary the identity forbids. */
function copyContract(ir: DesignIR): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const { node, path } of eachNode(ir)) {
    const text = node.props.text;
    if (typeof text !== 'string') continue;
    if (text.trim() === '') { issues.push({ path: `${path}/props/text`, message: `${node.id} declara texto vazio.` }); continue; }
    const placeholder = placeholderPatterns.find((pattern) => pattern.test(text));
    if (placeholder) issues.push({ path: `${path}/props/text`, message: `${node.id} ainda carrega texto de espera; o protótipo precisa de conteúdo plausível na voz da identidade.` });
    const forbidden = ir.identity.content.forbiddenTerms.find((term) => term !== '' && text.toLowerCase().includes(term.toLowerCase()));
    if (forbidden) issues.push({ path: `${path}/props/text`, message: `${node.id} usa "${forbidden}", que o contrato de conteúdo proíbe.` });
  }
  return issues;
}

export const prototypeRuleRegistry: LintRule[] = [
  { id: 'STR-020', stage: 'prototype', severity: 'warning', detect: structuralDefaults },
  { id: 'GRID-040', stage: 'prototype', severity: 'warning', detect: gridGrammar },
  { id: 'TYPE-050', stage: 'prototype', severity: 'warning', detect: typographicRoles },
  { id: 'COH-070', stage: 'prototype', severity: 'warning', detect: coherence },
  { id: 'MOTION-080', stage: 'prototype', severity: 'warning', detect: motionIntent },
  { id: 'A11Y-090', stage: 'prototype', severity: 'error', detect: accessibilityContract },
  { id: 'COPY-110', stage: 'prototype', severity: 'error', detect: copyContract },
];
