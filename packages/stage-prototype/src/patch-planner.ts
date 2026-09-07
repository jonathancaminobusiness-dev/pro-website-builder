import { resolveTokens, type DesignIR, type Page, type PageNode, type Patch } from '@pwb/domain';
import type { Finding, ProposedPatch } from './critique.js';

type PatchOperation = Patch['operations'][number];

export interface PlannedRepair { finding: Finding; operations: PatchOperation[]; paths: string[]; }
export interface RejectedRepair { finding: Finding; reason: string; }
export interface PatchPlan { patch?: Patch; accepted: PlannedRepair[]; rejected: RejectedRepair[]; }

export interface PlanInput {
  ir: DesignIR;
  findings: Finding[];
  allowedPaths: string[];
  baseVersionId: string;
  idempotencyKey: string;
  /** The loop never spends more than a few causal repairs on one cycle. */
  maxPatches?: number;
  minConfidence?: number;
}

const severityRank: Record<Finding['severity'], number> = { blocker: 0, major: 1, minor: 2, info: 3 };

function withinAllowed(path: string, allowedPaths: string[]): boolean {
  return allowedPaths.some((allowed) => path === allowed || path.startsWith(`${allowed}/`));
}

function locateNode(ir: DesignIR, nodeId: string): { routeIndex: number; nodeIndex: number; page: Page; node: PageNode } | undefined {
  for (const [routeIndex, page] of ir.pages.routes.entries()) {
    const nodeIndex = page.nodes.findIndex((node) => node.id === nodeId);
    if (nodeIndex >= 0) return { routeIndex, nodeIndex, page, node: page.nodes[nodeIndex]! };
  }
  return undefined;
}

function tokenPaths(ir: DesignIR): Set<string> {
  try { return new Set(Object.keys(resolveTokens(ir.identity.tokens).values)); } catch { return new Set(); }
}

/** Turns one allowlisted repair into JSON Pointer operations, or explains why it cannot be applied. */
function compile(ir: DesignIR, patch: ProposedPatch, tokens: Set<string>): { operations: PatchOperation[] } | { reason: string } {
  if (patch.operation === 'set_crop') {
    const index = ir.assets.items.findIndex((asset) => asset.id === patch.assetId);
    const asset = ir.assets.items[index];
    if (!asset) return { reason: `A revisão não tem o asset ${patch.assetId}.` };
    if (asset.kind !== 'raster') return { reason: `Só um asset raster pode ser recortado; ${patch.assetId} é do tipo ${asset.kind}.` };
    const path = `/assets/items/${index}/crop`;
    const crop = { focalX: patch.focalX, focalY: patch.focalY, aspect: patch.aspect };
    return { operations: [{ op: 'test', path, ...(asset.crop === undefined ? {} : { value: asset.crop }) }, { op: asset.crop === undefined ? 'add' : 'replace', path, value: crop }] };
  }

  const located = locateNode(ir, patch.nodeId);
  if (!located) return { reason: `A revisão não tem o nó ${patch.nodeId}.` };
  const { routeIndex, nodeIndex, node } = located;
  const nodePath = `/pages/routes/${routeIndex}/nodes/${nodeIndex}`;

  if (patch.operation === 'set_token') {
    const reference = patch.token.slice(1, -1);
    if (!tokens.has(reference)) return { reason: `A identidade não define o token ${patch.token}.` };
    const path = `${nodePath}/props/${patch.prop}`;
    const current = node.props[patch.prop];
    if (current === patch.token) return { reason: `O nó ${patch.nodeId} já define ${patch.prop} como ${patch.token}.` };
    return { operations: [{ op: 'test', path, ...(current === undefined ? {} : { value: current }) }, { op: current === undefined ? 'add' : 'replace', path, value: patch.token }] };
  }

  if (patch.operation === 'replace_copy') {
    if (typeof node.props.text !== 'string') return { reason: `O nó ${patch.nodeId} não carrega texto a substituir.` };
    const forbidden = ir.identity.content.forbiddenTerms.find((term) => patch.text.toLowerCase().includes(term.toLowerCase()));
    if (forbidden) return { reason: `O texto proposto usa "${forbidden}", que a identidade proíbe.` };
    const path = `${nodePath}/props/text`;
    if (node.props.text === patch.text) return { reason: `O nó ${patch.nodeId} já carrega esse texto.` };
    return { operations: [{ op: 'test', path, value: node.props.text }, { op: 'replace', path, value: patch.text }] };
  }

  if (patch.operation === 'set_constraint') {
    const containers = new Set(ir.identity.gridGrammar.responsive.map((entry) => entry.container));
    if (!containers.has(patch.container)) return { reason: `A gramática de grid não declara o container ${patch.container}.` };
    const responsive = node.responsive.filter((entry) => entry.container !== patch.container);
    const next = [...responsive, { container: patch.container, rule: patch.rule }].sort((a, b) => (a.container < b.container ? -1 : a.container > b.container ? 1 : 0));
    const path = `${nodePath}/responsive`;
    if (JSON.stringify(next) === JSON.stringify(node.responsive)) return { reason: `O nó ${patch.nodeId} já carrega essa restrição.` };
    return { operations: [{ op: 'test', path, value: node.responsive }, { op: 'replace', path, value: next }] };
  }

  const current = node.slots[patch.slot];
  if (!current) return { reason: `O nó ${patch.nodeId} não tem o slot ${patch.slot}.` };
  const sorted = (list: string[]): string => [...list].sort().join('|');
  if (sorted(current) !== sorted(patch.order)) return { reason: `Uma reordenação precisa manter exatamente os filhos de ${patch.nodeId}.${patch.slot}.` };
  if (current.join('|') === patch.order.join('|')) return { reason: `O nó ${patch.nodeId}.${patch.slot} já está nessa ordem.` };
  const path = `${nodePath}/slots/${patch.slot}`;
  return { operations: [{ op: 'test', path, value: current }, { op: 'replace', path, value: patch.order }] };
}

/**
 * Compiles the critics' findings into at most one minimal, causal patch.
 * Nothing outside the allowlist reaches the document, every write is guarded by a `test` against the
 * value the critic actually saw, and a repair that cannot be justified is rejected with a reason.
 */
export function planPatch(input: PlanInput): PatchPlan {
  const maxPatches = input.maxPatches ?? 3;
  const minConfidence = input.minConfidence ?? 0.5;
  const tokens = tokenPaths(input.ir);
  const accepted: PlannedRepair[] = [];
  const rejected: RejectedRepair[] = [];
  const claimed = new Set<string>();

  const ranked = [...input.findings].sort((a, b) =>
    severityRank[a.severity] - severityRank[b.severity] || b.confidence - a.confidence || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  for (const finding of ranked) {
    if (finding.abstain) { rejected.push({ finding, reason: 'O crítico se absteve e escalou a decisão para o humano.' }); continue; }
    if (!finding.patch) { rejected.push({ finding, reason: 'O achado não traz um reparo mínimo a aplicar.' }); continue; }
    if (finding.confidence < minConfidence) { rejected.push({ finding, reason: `A confiança ${finding.confidence} está abaixo do mínimo de ${minConfidence} exigido pelo planejador.` }); continue; }
    if (accepted.length >= maxPatches) { rejected.push({ finding, reason: `Este ciclo já carrega ${maxPatches} reparos causais.` }); continue; }

    const compiled = compile(input.ir, finding.patch, tokens);
    if ('reason' in compiled) { rejected.push({ finding, reason: compiled.reason }); continue; }

    const paths = [...new Set(compiled.operations.map((operation) => operation.path))];
    const outside = paths.find((path) => !withinAllowed(path, input.allowedPaths));
    if (outside) { rejected.push({ finding, reason: `O reparo escreveria em ${outside}, fora dos caminhos que esta tarefa pode tocar.` }); continue; }
    const conflict = paths.find((path) => claimed.has(path));
    if (conflict) { rejected.push({ finding, reason: `Outro reparo deste ciclo já escreve em ${conflict}.` }); continue; }

    for (const path of paths) claimed.add(path);
    accepted.push({ finding, operations: compiled.operations, paths });
  }

  if (accepted.length === 0) return { accepted, rejected };
  const operations = accepted.flatMap((repair) => repair.operations);
  const touchedPaths = [...new Set(accepted.flatMap((repair) => repair.paths))];
  return {
    accepted,
    rejected,
    patch: {
      operations,
      baseVersionId: input.baseVersionId,
      touchedPaths,
      rationale: accepted.map((repair) => `${repair.finding.id}: ${repair.finding.why}`).join(' | '),
      confidence: Math.min(...accepted.map((repair) => repair.finding.confidence)),
      stage: 'prototype',
      role: 'composer',
      idempotencyKey: input.idempotencyKey,
    },
  };
}
