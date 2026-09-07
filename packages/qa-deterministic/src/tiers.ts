import { hashJson } from '@pwb/domain';
import { qaRuleRegistry, type QaCheck, type QaInput, type QaRule, type QaTier } from './checks.js';

export interface QaReport {
  /** Every check that fired, ordered by tier and then by rule id. */
  checks: QaCheck[];
  /** The subset that vetoes the revision; a non-empty list must stop the stage before any model runs. */
  vetoes: QaCheck[];
  tiersRun: QaTier[];
  passed: boolean;
  /** Stable identity of the set of problems, so the loop controller can detect a repeated cycle. */
  issueHash: string;
}

export interface QaOptions { tiers?: QaTier[]; rules?: QaRule[]; }

/**
 * Runs the deterministic gate. Tier 0 answers what the DOM and the IR can decide on their own and
 * vetoes the revision; Tier 1 adds the per-candidate observations that inform a critic without blocking.
 */
export function runQa(input: QaInput, options: QaOptions = {}): QaReport {
  const tiers = options.tiers ?? [0, 1];
  const rules = (options.rules ?? qaRuleRegistry).filter((rule) => tiers.includes(rule.tier));
  const checks = rules.flatMap((rule) => rule.detect(input).map((finding) => ({ ...finding, id: rule.id, tier: rule.tier, severity: rule.severity, title: rule.title })))
    .sort((a, b) => a.tier - b.tier || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) || (a.message < b.message ? -1 : a.message > b.message ? 1 : 0));
  const vetoes = checks.filter((check) => check.severity === 'veto');
  return { checks, vetoes, tiersRun: [...tiers].sort(), passed: vetoes.length === 0, issueHash: hashJson(checks.map((check) => [check.id, check.nodeIds, check.message])) };
}

/** Tier 0 alone: the veto that must pass before a single model call is spent. */
export function runTier0(input: QaInput, options: Omit<QaOptions, 'tiers'> = {}): QaReport {
  return runQa(input, { ...options, tiers: [0] });
}

export function runTier1(input: QaInput, options: Omit<QaOptions, 'tiers'> = {}): QaReport {
  return runQa(input, { ...options, tiers: [1] });
}
