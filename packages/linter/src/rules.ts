import { resolveTokens, type DesignIR } from '@pwb/domain';

export type FindingSeverity = 'error' | 'warning' | 'info';
export interface LintFinding { id: string; stage: 'identity' | 'prototype' | 'finalization'; severity: FindingSeverity; path: string; message: string; suggestedPatch?: unknown; }
export interface LintRule { id: string; stage: LintFinding['stage']; severity: FindingSeverity; detect: (ir: DesignIR) => LintFinding[]; }
export interface LintReport { findings: LintFinding[]; errorCount: number; warningCount: number; }

const visualKeys = new Set(['color', 'background', 'backgroundColor', 'padding', 'paddingBlock', 'paddingInline', 'gap', 'radius', 'font', 'fontSize', 'shadow', 'motion', 'width', 'height', 'margin', 'maxWidth']);
const fixedDefaults = ['system-ui', 'Inter-only hero', 'system-ui-only display', 'purple-blue gradient', 'neon SaaS', 'generic sparkle', 'floating glass cards'];

function finding(id: string, severity: FindingSeverity, path: string, message: string): LintFinding {
  return { id, stage: id.startsWith('TOK') ? 'identity' : 'prototype', severity, path, message };
}

function tokenOnly(ir: DesignIR): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const page of ir.pages.routes) for (const node of page.nodes) for (const [key, value] of Object.entries(node.props)) {
    if (!visualKeys.has(key)) continue;
    const isRef = typeof value === 'string' && /^\{[^}]+\}$/.test(value);
    if (!isRef && !node.signedException) findings.push(finding('TOK-001', 'error', `/pages/routes/${page.id}/nodes/${node.id}/props/${key}`, 'Visual values must resolve from a token or carry a captain-signed exception.'));
  }
  return findings;
}

function aliasesAndRefs(ir: DesignIR): LintFinding[] {
  const findings: LintFinding[] = [];
  let resolved: ReturnType<typeof resolveTokens> | undefined;
  try { resolved = resolveTokens(ir.tokens); } catch (error) { findings.push(finding('TOK-002', 'error', '/tokens', error instanceof Error ? error.message : 'Token aliases are invalid.')); }
  for (const page of ir.pages.routes) for (const node of page.nodes) for (const [key, value] of Object.entries(node.props)) {
    if (typeof value !== 'string') continue;
    const match = /^\{([^}]+)\}$/.exec(value);
    if (match && (!resolved || !(match[1]! in resolved.values))) findings.push(finding('TOK-002', 'error', `/pages/routes/${page.id}/nodes/${node.id}/props/${key}`, `Token reference ${value} is orphaned.`));
  }
  return findings;
}

function forbiddenDefaults(ir: DesignIR): LintFinding[] {
  const defaults = [...fixedDefaults, ...ir.identity.forbiddenDefaults.fonts, ...ir.identity.forbiddenDefaults.palettes, ...ir.identity.forbiddenDefaults.motifs];
  const findings: LintFinding[] = [];
  for (const page of ir.pages.routes) for (const node of page.nodes) for (const [key, value] of Object.entries(node.props)) {
    if (typeof value !== 'string') continue;
    const match = defaults.find((candidate) => value.toLowerCase().includes(candidate.toLowerCase()));
    if (match) findings.push(finding('DEF-010', 'error', `/pages/routes/${page.id}/nodes/${node.id}/props/${key}`, `Forbidden default detected: ${match}.`));
  }
  return findings;
}

const stubIds = ['STR', 'DIV', 'GRID', 'TYPE', 'MEDIA', 'COH', 'MOTION', 'A11Y', 'SIM', 'COPY'] as const;
export const ruleRegistry: LintRule[] = [
  { id: 'TOK-001', stage: 'identity', severity: 'error', detect: tokenOnly },
  { id: 'TOK-002', stage: 'identity', severity: 'error', detect: aliasesAndRefs },
  { id: 'DEF-010', stage: 'prototype', severity: 'error', detect: forbiddenDefaults },
  ...stubIds.map((id) => ({ id, stage: 'prototype' as const, severity: 'info' as const, detect: () => [] })),
];

export function lintDesign(ir: DesignIR): LintReport {
  const findings = ruleRegistry.flatMap((rule) => rule.detect(ir));
  return { findings, errorCount: findings.filter((item) => item.severity === 'error').length, warningCount: findings.filter((item) => item.severity === 'warning').length };
}
