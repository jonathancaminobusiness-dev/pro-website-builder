import { RELEASE_RUBRIC_MINIMUM, releaseGateReportSchema, type EvidenceArtifact, type ParityReport, type ReleaseCritique, type ReleaseGateReport, type ReleaseSummary, type ReleaseVeto } from '@pwb/domain';
import type { CompiledSite } from '@pwb/export';
import { evidenceCoverage, evidenceVetoes } from './evidence.js';
import { RELEASE_CRITICS } from './critics.js';
import { aggregateVetoes } from './veto-catalog.js';

export interface ReleaseGateInput {
  compiled: CompiledSite;
  evidence: EvidenceArtifact[];
  critiques: ReleaseCritique[];
  parity: ParityReport;
  approved: { versionId: string; irHash: string };
  refinementCycles: number;
  escalations: string[];
  /** Read for display only; it can never change a verdict. */
  summary?: ReleaseSummary;
}

/** The gate's own veto: the bundle must come from the version the captain approved. */
function divergenceVetoes(input: ReleaseGateInput): ReleaseVeto[] {
  const vetoes: ReleaseVeto[] = [];
  if (input.compiled.irHash !== input.approved.irHash) {
    vetoes.push({ id: 'RELEASE_DIVERGES_FROM_APPROVED', detector: 'gate', where: input.approved.versionId, detail: `O bundle foi compilado do documento ${input.compiled.irHash.slice(0, 12)}, e o capitão aprovou ${input.approved.irHash.slice(0, 12)}.` });
  }
  for (const route of input.parity.routes) {
    if (route.matched) continue;
    vetoes.push({ id: 'RELEASE_DIVERGES_FROM_APPROVED', detector: 'gate', where: route.route, detail: `Preview e release divergem em ${route.route}: ${route.differences.join(' ')}` });
  }
  return vetoes;
}

/**
 * Builds the Gate 3 report.
 *
 * Every veto is recomputed here from the compiled bundle, the raw evidence
 * artifacts and the approved version. Critiques contribute rubric scores and
 * escalations and nothing else — a critic cannot introduce a veto and cannot
 * clear one — and the summary is carried along without ever being read for a
 * verdict. Only the captain approves; `blocked` says whether they may.
 */
export function evaluateReleaseGate(input: ReleaseGateInput): ReleaseGateReport {
  const vetoes = aggregateVetoes(input.compiled.vetoes, evidenceVetoes(input.evidence), divergenceVetoes(input));
  const rubric = input.critiques
    .map((critique) => ({ dimension: critique.dimension, score: critique.rubricScore, verdict: critique.verdict }))
    .sort((a, b) => (a.dimension < b.dimension ? -1 : a.dimension > b.dimension ? 1 : 0));

  const reported = new Set(input.critiques.map((critique) => critique.dimension));
  const escalations = [
    ...input.escalations,
    ...RELEASE_CRITICS.filter((critic) => !reported.has(critic.dimension)).map((critic) => `O crítico de ${critic.dimension} não entregou parecer; a evidência dessa dimensão está ausente.`),
    ...rubric.filter((row) => row.score < RELEASE_RUBRIC_MINIMUM).map((row) => `A dimensão ${row.dimension} pontuou ${row.score}/4, abaixo do mínimo ${RELEASE_RUBRIC_MINIMUM}.`),
    ...rubric.filter((row) => row.verdict === 'uncertain').map((row) => `O crítico de ${row.dimension} respondeu incerto; a decisão sobe para o capitão.`),
    ...evidenceCoverage(input.evidence).missing,
  ];

  return releaseGateReportSchema.parse({
    stage: 'finalization',
    bundleDigest: input.compiled.digest,
    irHash: input.compiled.irHash,
    approvedVersionId: input.approved.versionId,
    rendererVersion: input.compiled.rendererVersion,
    compilerVersion: input.compiled.compilerVersion,
    blocked: vetoes.length > 0,
    vetoes,
    rubric,
    parity: input.parity,
    evidence: input.evidence,
    refinementCycles: input.refinementCycles,
    escalations: [...new Set(escalations)],
    ...(input.summary ? { summary: input.summary } : {}),
    approverRole: 'captain',
  });
}
