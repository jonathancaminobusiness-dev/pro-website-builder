import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { evidenceArtifactSchema, type EvidenceArtifact, type ReleaseVeto } from '@pwb/domain';

/**
 * Evidence is produced by runners that do not know what the gate wants to hear:
 * Vitest, Playwright on three engines, axe per critical state and Lighthouse on
 * mobile and desktop. Each run writes a typed artifact to disk, and the gate
 * reads those files rather than a report someone wrote about them.
 */
export const EVIDENCE_FILE_SUFFIX = '.evidence.json';

export function artifactHash(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export async function writeEvidenceArtifact(directory: string, artifact: EvidenceArtifact): Promise<string> {
  const parsed = evidenceArtifactSchema.parse(artifact);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${parsed.id.replaceAll(/[^A-Za-z0-9._-]+/g, '-')}${EVIDENCE_FILE_SUFFIX}`);
  await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  return path;
}

/** Reads every artifact in the directory. A file that does not parse is a hard error, never a skip. */
export async function readEvidence(directory: string): Promise<EvidenceArtifact[]> {
  let names: string[];
  try { names = await readdir(directory); }
  catch { return []; }
  const artifacts: EvidenceArtifact[] = [];
  for (const name of names.filter((entry) => entry.endsWith(EVIDENCE_FILE_SUFFIX)).sort()) {
    const raw: unknown = JSON.parse(await readFile(join(directory, name), 'utf8'));
    artifacts.push(evidenceArtifactSchema.parse(raw));
  }
  return artifacts;
}

/** Counts axe reports as an accessibility regression from the raw violation counts. */
function accessibilityRegression(artifact: EvidenceArtifact): ReleaseVeto[] {
  if (artifact.runner !== 'axe') return [];
  const critical = artifact.metrics.critical ?? 0;
  const serious = artifact.metrics.serious ?? 0;
  if (critical + serious <= 0) return [];
  return [{
    id: 'CRITICAL_AA_REGRESSION',
    detector: 'evidence',
    where: `${artifact.engine} ${artifact.route} (${artifact.state})`,
    detail: `axe reported ${critical} critical and ${serious} serious violations in ${artifact.id}.`,
  }];
}

function runnerFailure(artifact: EvidenceArtifact): ReleaseVeto[] {
  if (artifact.status !== 'failed') return [];
  if (artifact.runner !== 'vitest' && artifact.runner !== 'playwright') return [];
  return [{
    id: 'BUILD_FAILED',
    detector: 'evidence',
    where: `${artifact.runner}:${artifact.engine}:${artifact.route}`,
    detail: artifact.notes[0] ?? `The ${artifact.runner} run ${artifact.id} failed on ${artifact.engine}.`,
  }];
}

/**
 * Derives the release vetoes the evidence carries.
 *
 * The derivation reads the raw counts on every artifact, not a field a runner
 * chose to set, so a runner that forgets to declare a veto still cannot hide
 * one, and no later summary can subtract from this list.
 */
export function evidenceVetoes(artifacts: EvidenceArtifact[]): ReleaseVeto[] {
  return artifacts.flatMap((artifact) => [...artifact.vetoes, ...accessibilityRegression(artifact), ...runnerFailure(artifact)]);
}

export interface EvidenceCoverage {
  engines: EvidenceArtifact['engine'][];
  runners: EvidenceArtifact['runner'][];
  missing: string[];
}

const REQUIRED_ENGINES: EvidenceArtifact['engine'][] = ['chromium', 'firefox', 'webkit'];
const REQUIRED_RUNNERS: EvidenceArtifact['runner'][] = ['vitest', 'playwright', 'axe', 'lighthouse'];

/**
 * Says plainly which independent runners are absent. A gap is never silent: it
 * becomes an escalation on the gate screen so the captain decides with the
 * missing evidence named rather than assumed.
 */
export function evidenceCoverage(artifacts: EvidenceArtifact[]): EvidenceCoverage {
  const engines = [...new Set(artifacts.filter((artifact) => artifact.engine !== 'node').map((artifact) => artifact.engine))].sort();
  const runners = [...new Set(artifacts.map((artifact) => artifact.runner))].sort();
  const missing = [
    ...REQUIRED_RUNNERS.filter((runner) => !runners.includes(runner)).map((runner) => `Nenhuma evidência do runner ${runner}.`),
    ...REQUIRED_ENGINES.filter((engine) => !engines.includes(engine)).map((engine) => `Nenhuma execução Playwright em ${engine}.`),
  ];
  return { engines, runners, missing };
}
