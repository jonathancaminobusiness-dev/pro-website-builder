import { resolveTokens, visualPropKeys, type DesignIR } from '@pwb/domain';

export type FindingSeverity = 'error' | 'warning' | 'info';
export interface LintFinding { id: string; stage: 'identity' | 'prototype' | 'finalization'; severity: FindingSeverity; path: string; message: string; suggestedPatch?: unknown; }
export interface LintRule { id: string; stage: LintFinding['stage']; severity: FindingSeverity; detect: (ir: DesignIR) => LintFinding[]; }
export interface LintReport { findings: LintFinding[]; errorCount: number; warningCount: number; }

function finding(id: string, severity: FindingSeverity, path: string, message: string): LintFinding {
  return { id, stage: id.startsWith('TOK') ? 'identity' : 'prototype', severity, path, message };
}

function* visualProps(ir: DesignIR): Generator<{ path: string; value: string | number | boolean; signedException: boolean }> {
  for (const page of ir.pages.routes) for (const node of page.nodes) for (const [key, value] of Object.entries(node.props)) {
    if (!visualPropKeys.has(key)) continue;
    yield { path: `/pages/routes/${page.id}/nodes/${node.id}/props/${key}`, value, signedException: Boolean(node.signedException) };
  }
}

function tokenOnly(ir: DesignIR): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const { path, value, signedException } of visualProps(ir)) {
    const isRef = typeof value === 'string' && /^\{[^}]+\}$/.test(value);
    if (!isRef && !signedException) findings.push(finding('TOK-001', 'error', path, 'Visual values must resolve from a token or carry a captain-signed exception.'));
  }
  return findings;
}

function aliasesAndRefs(ir: DesignIR): LintFinding[] {
  const findings: LintFinding[] = [];
  let resolved: ReturnType<typeof resolveTokens> | undefined;
  try { resolved = resolveTokens(ir.tokens); } catch (error) { findings.push(finding('TOK-002', 'error', '/tokens', error instanceof Error ? error.message : 'Token aliases are invalid.')); }
  for (const { path, value } of visualProps(ir)) {
    if (typeof value !== 'string') continue;
    const match = /^\{([^}]+)\}$/.exec(value);
    if (match && (!resolved || !(match[1]! in resolved.values))) findings.push(finding('TOK-002', 'error', path, `Token reference ${value} is orphaned.`));
  }
  return findings;
}

function forbiddenDefaults(ir: DesignIR): LintFinding[] {
  const defaults = [...ir.identity.forbiddenDefaults.fonts, ...ir.identity.forbiddenDefaults.palettes, ...ir.identity.forbiddenDefaults.motifs];
  const findings: LintFinding[] = [];
  for (const { path, value } of visualProps(ir)) {
    if (typeof value !== 'string') continue;
    const match = defaults.find((candidate) => value.toLowerCase().includes(candidate.toLowerCase()));
    if (match) findings.push(finding('DEF-010', 'error', path, `Forbidden default detected: ${match}.`));
  }
  return findings;
}

export const ruleRegistry: LintRule[] = [
  { id: 'TOK-001', stage: 'identity', severity: 'error', detect: tokenOnly },
  { id: 'TOK-002', stage: 'identity', severity: 'error', detect: aliasesAndRefs },
  { id: 'DEF-010', stage: 'prototype', severity: 'error', detect: forbiddenDefaults },
];

export function lintDesign(ir: DesignIR): LintReport {
  const findings = ruleRegistry.flatMap((rule) => rule.detect(ir));
  return { findings, errorCount: findings.filter((item) => item.severity === 'error').length, warningCount: findings.filter((item) => item.severity === 'warning').length };
}
