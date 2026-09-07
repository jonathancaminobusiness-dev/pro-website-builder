import {
  compareDivergenceMatrix,
  divergenceAxes,
  flattenTokens,
  governedContractFields,
  identityColorValues,
  isGroundedDecision,
  measuredAxisSignals,
  MINIMUM_DISTINCT_AXES,
  paletteSignature,
  paletteSignaturesMatch,
  type DesignIR,
} from '@pwb/domain';
import type { LintIssue } from './rules.js';

/** Every choice an identity has to account for: one per token, one per governed contract field. */
export function governedChoices(ir: DesignIR): string[] {
  const tokens = [...flattenTokens(ir.identity.tokens).keys()].map((path) => `tokens.${path}`);
  return [...tokens, ...governedContractFields];
}

/**
 * ID-003 — every choice points at briefing evidence, a rationale or a divergence axis.
 *
 * The rule is deliberately unconditional. An identity that declares no decision
 * record has justified nothing, which is exactly the state the plan wants Gate 1
 * to block, so silence is a finding rather than a pass.
 */
export function identityEvidence(ir: DesignIR): LintIssue[] {
  const issues: LintIssue[] = [];
  const { decisions, strategy } = ir.identity;
  const evidenceIds = new Set(strategy.evidence.map((entry) => entry.id));
  const choices = new Set(governedChoices(ir));
  const covered = new Map<string, number>();
  const seenIds = new Set<string>();

  decisions.forEach((decision, index) => {
    const at = `/identity/decisions/${index}`;
    if (seenIds.has(decision.id)) issues.push({ path: `${at}/id`, message: `Decision id ${decision.id} is declared more than once.` });
    seenIds.add(decision.id);
    if (!choices.has(decision.choice)) {
      issues.push({ path: `${at}/choice`, message: `Decision ${decision.id} points at ${decision.choice}, which is not a token or a governed contract field of this identity.` });
    } else {
      covered.set(decision.choice, (covered.get(decision.choice) ?? 0) + 1);
    }
    for (const [position, id] of decision.evidenceIds.entries()) {
      if (!evidenceIds.has(id)) issues.push({ path: `${at}/evidenceIds/${position}`, message: `Decision ${decision.id} cites evidence ${id}, which strategy.evidence does not declare.` });
    }
    if (!isGroundedDecision(decision, evidenceIds)) {
      issues.push({ path: at, message: `Decision ${decision.id} for ${decision.choice} carries no briefing evidence, no rationale and no divergence axis.` });
    }
  });

  for (const choice of choices) {
    if (!covered.has(choice)) {
      const path = choice.startsWith('tokens.') ? `/identity/tokens/${choice.slice('tokens.'.length).replaceAll('.', '/')}` : `/identity/${choice.replaceAll('.', '/')}`;
      issues.push({ path, message: `${choice} has no decision record, so the choice is an unjustified default.` });
    }
  }
  for (const [choice, count] of covered) {
    if (count > 1) issues.push({ path: '/identity/decisions', message: `${choice} carries ${count} decision records; a choice must have exactly one.` });
  }
  return issues;
}

/**
 * DIV-030 — the three directions of one fan-out must stand apart on at least
 * four axes, and neither a hue swap nor a strategy the document does not show
 * is one of them.
 *
 * Each candidate carries the whole matrix, so linting any one document checks
 * the set it was produced with. A document with no divergence spec is not part
 * of a fan-out and is left alone; the identity stage is what refuses to promote
 * a candidate that carries none.
 */
export function divergenceDistance(ir: DesignIR): LintIssue[] {
  const spec = ir.identity.direction.divergence;
  if (!spec) return [];
  const issues: LintIssue[] = [];
  const own = spec.matrix.find((vector) => vector.directionId === spec.directionId);
  if (!own) return [{ path: '/identity/direction/divergence/matrix', message: `The matrix does not contain the direction ${spec.directionId} it belongs to.` }];

  let measurable = true;
  try {
    const measured = paletteSignature(identityColorValues(ir.identity));
    if (!paletteSignaturesMatch(measured, own.paletteSignature)) {
      issues.push({ path: '/identity/direction/divergence/matrix', message: `The palette signature recorded for ${spec.directionId} does not match the identity's colour tokens, so its divergence claim cannot be verified.` });
    }
    const signals = measuredAxisSignals(ir.identity);
    for (const axis of divergenceAxes) {
      // The palette fingerprint above is the colour measurement; the signal recorded for that axis is the same fact.
      if (axis === 'color' || own.axes[axis].signal === signals[axis]) continue;
      issues.push({ path: '/identity/direction/divergence/matrix', message: `The ${axis} signal recorded for ${spec.directionId} says "${own.axes[axis].signal}" but the document shows "${signals[axis]}", so its divergence claim cannot be verified.` });
    }
  } catch { measurable = false; }
  if (!measurable) return issues;

  for (const pair of compareDivergenceMatrix(spec.matrix)) {
    if (pair.distinctAxes.length >= MINIMUM_DISTINCT_AXES) continue;
    const shared = pair.comparisons.filter((entry) => !entry.distinct).map((entry) => `${entry.axis}: ${entry.reason}`);
    const hue = pair.hueOnlyColor ? ' Changing only the hue does not count as a colour direction.' : '';
    issues.push({
      path: '/identity/direction/divergence/matrix',
      message: `Directions ${pair.a} and ${pair.b} differ on ${pair.distinctAxes.length} of the required ${MINIMUM_DISTINCT_AXES} axes (${pair.distinctAxes.join(', ') || 'none'}). Shared axes — ${shared.join(' ')}${hue}`,
    });
  }
  return issues;
}
