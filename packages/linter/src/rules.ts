import { cssTokenIssues, flattenTokens, resolveTokens, visualPropKeys, type DesignIR } from '@pwb/domain';

export type FindingSeverity = 'error' | 'warning' | 'info';
export interface LintIssue { path: string; message: string; suggestedPatch?: unknown; }
export interface LintFinding extends LintIssue { id: string; stage: 'identity' | 'prototype' | 'finalization'; severity: FindingSeverity; }
export interface LintRule { id: string; stage: LintFinding['stage']; severity: FindingSeverity; detect: (ir: DesignIR) => LintIssue[]; }
export interface LintReport { findings: LintFinding[]; errorCount: number; warningCount: number; }

function* visualProps(ir: DesignIR): Generator<{ path: string; value: string | number | boolean; signedException: boolean }> {
  for (const page of ir.pages.routes) for (const node of page.nodes) for (const [key, value] of Object.entries(node.props)) {
    if (!visualPropKeys.has(key)) continue;
    yield { path: `/pages/routes/${page.id}/nodes/${node.id}/props/${key}`, value, signedException: Boolean(node.signedException) };
  }
}

function tokenOnly(ir: DesignIR): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const { path, value, signedException } of visualProps(ir)) {
    const isRef = typeof value === 'string' && /^\{[^}]+\}$/.test(value);
    if (!isRef && !signedException) issues.push({ path, message: 'Visual values must resolve from a token or carry a captain-signed exception.' });
  }
  return issues;
}

function aliasesAndRefs(ir: DesignIR): LintIssue[] {
  const issues: LintIssue[] = [];
  let resolved: ReturnType<typeof resolveTokens> | undefined;
  try { resolved = resolveTokens(ir.identity.tokens); } catch (error) { issues.push({ path: '/identity/tokens', message: error instanceof Error ? error.message : 'Token aliases are invalid.' }); }
  for (const { path, value } of visualProps(ir)) {
    if (typeof value !== 'string') continue;
    const match = /^\{([^}]+)\}$/.exec(value);
    if (match && (!resolved || !(match[1]! in resolved.values))) issues.push({ path, message: `Token reference ${value} is orphaned.` });
  }
  return issues;
}

function forbiddenDefaults(ir: DesignIR): LintIssue[] {
  const defaults = [...ir.identity.forbiddenDefaults.fonts, ...ir.identity.forbiddenDefaults.palettes, ...ir.identity.forbiddenDefaults.motifs];
  let resolved: ReturnType<typeof resolveTokens>;
  try { resolved = resolveTokens(ir.identity.tokens); } catch { return []; }
  const issues: LintIssue[] = [];
  for (const [path, value] of Object.entries(resolved.values)) {
    if (typeof value !== 'string') continue;
    const match = defaults.find((candidate) => value.toLowerCase().includes(candidate.toLowerCase()));
    if (match) issues.push({ path: `/identity/tokens/${path.replaceAll('.', '/')}`, message: `Forbidden default detected: ${match}.` });
  }
  return issues;
}

function identityTokenRoles(ir: DesignIR): LintIssue[] {
  const paths = flattenTokens(ir.identity.tokens);
  return Object.entries(ir.identity.tokenRoles)
    .filter(([, path]) => !paths.has(path))
    .map(([role, path]) => ({ path: `/identity/tokenRoles/${role}`, message: `Token role ${role} points at ${path}, which the document does not define.` }));
}

function emittableTokens(ir: DesignIR): LintIssue[] {
  let resolved: ReturnType<typeof resolveTokens>;
  try { resolved = resolveTokens(ir.identity.tokens); } catch { return []; }
  return cssTokenIssues(resolved.values).map((issue) => ({ path: `/identity/tokens/${issue.path.replaceAll('.', '/')}`, message: issue.message }));
}

export const ruleRegistry: LintRule[] = [
  { id: 'TOK-001', stage: 'identity', severity: 'error', detect: tokenOnly },
  { id: 'TOK-002', stage: 'identity', severity: 'error', detect: aliasesAndRefs },
  { id: 'TOK-003', stage: 'identity', severity: 'error', detect: identityTokenRoles },
  { id: 'TOK-004', stage: 'identity', severity: 'error', detect: emittableTokens },
  { id: 'DEF-010', stage: 'prototype', severity: 'error', detect: forbiddenDefaults },
];

export function lintDesign(ir: DesignIR): LintReport {
  const findings = ruleRegistry.flatMap((rule) => rule.detect(ir).map((issue) => ({ ...issue, id: rule.id, stage: rule.stage, severity: rule.severity })));
  return { findings, errorCount: findings.filter((item) => item.severity === 'error').length, warningCount: findings.filter((item) => item.severity === 'warning').length };
}
