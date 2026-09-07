/**
 * Collects the independent evidence Gate 3 reads.
 *
 * Four runners, none of which knows what the gate wants to hear: Vitest for the
 * pure logic, Playwright on Chromium, Firefox and WebKit for the rendered
 * release, axe on every critical state, and Lighthouse on mobile and desktop.
 * Each writes typed artifacts to the evidence directory; the gate reads those
 * files, so no summary sits between a measurement and the decision.
 *
 * A runner that cannot run leaves no artifact, and the gate reports the gap as
 * an escalation rather than treating silence as a pass.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { compileRelease } from '../packages/export/src/index.js';
import { renderDesign } from '../packages/renderer/src/index.js';
import { artifactHash, loadReleaseDocument, writeEvidenceArtifact } from '../packages/stage-finalization/src/index.js';

const execFileAsync = promisify(execFile);
const evidenceDir = process.env.PWB_EVIDENCE_DIR ?? join(process.cwd(), 'artifacts', 'release');

interface RunnerOutcome { name: string; ok: boolean; detail: string }

async function run(name: string, args: string[]): Promise<RunnerOutcome> {
  try {
    await execFileAsync('corepack', ['pnpm', ...args], { shell: false, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, PWB_EVIDENCE_DIR: evidenceDir } });
    return { name, ok: true, detail: 'completed' };
  } catch (error) {
    const details = error as { stdout?: string; stderr?: string; message?: string };
    return { name, ok: false, detail: (details.stdout ?? '').split('\n').slice(-8).join(' ').trim() || details.message || 'failed' };
  }
}

interface VitestReport { numTotalTests?: number; numPassedTests?: number; numFailedTests?: number; success?: boolean }

/** Vitest has no artifact of its own, so its JSON report becomes one. */
async function vitestEvidence(release: { digest: string; irHash: string }): Promise<RunnerOutcome> {
  const directory = await mkdtemp(join(tmpdir(), 'pwb-vitest-'));
  const outputFile = join(directory, 'report.json');
  let ok = true;
  try {
    try { await execFileAsync('corepack', ['pnpm', 'exec', 'vitest', 'run', '--reporter=json', `--outputFile=${outputFile}`], { shell: false, maxBuffer: 64 * 1024 * 1024 }); }
    catch { ok = false; }
    const report = JSON.parse(await readFile(outputFile, 'utf8')) as VitestReport;
    const metrics = { total: report.numTotalTests ?? 0, passed: report.numPassedTests ?? 0, failed: report.numFailedTests ?? 0 };
    await writeEvidenceArtifact(evidenceDir, {
      id: 'vitest-node', runner: 'vitest', engine: 'node', releaseDigest: release.digest, irHash: release.irHash, route: '/', state: 'unit',
      status: metrics.failed === 0 && (report.success ?? ok) ? 'passed' : 'failed',
      path: 'vitest', hash: artifactHash(metrics), vetoes: [], metrics,
      notes: metrics.failed === 0 ? ['A suíte determinística passou; ela não prova layout, fonte nem acessibilidade de interação.'] : [`${metrics.failed} teste(s) falharam.`],
    });
    return { name: 'vitest', ok: metrics.failed === 0, detail: `${metrics.passed}/${metrics.total} passed` };
  } catch (error) {
    return { name: 'vitest', ok: false, detail: error instanceof Error ? error.message : 'failed' };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

async function main(): Promise<void> {
  // Every runner measures the same release, so every artifact names it and the
  // gate can tell this run's evidence from what an earlier run left behind.
  const ir = await loadReleaseDocument(evidenceDir);
  const compiled = compileRelease(renderDesign(ir), ir, {
    siteUrl: process.env.PWB_SITE_URL ?? 'https://site.invalid',
    siteName: process.env.PWB_SITE_NAME ?? 'pro-website-builder',
  });
  const outcomes: RunnerOutcome[] = [
    await vitestEvidence({ digest: compiled.digest, irHash: compiled.irHash }),
    await run('playwright+axe', ['test:e2e:release']),
    await run('lighthouse', ['run:lighthouse']),
  ];
  console.log(JSON.stringify({ evidenceDir, releaseDigest: compiled.digest, outcomes }, null, 2));
  if (outcomes.some((outcome) => !outcome.ok)) process.exitCode = 1;
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Evidence run failed.'); process.exitCode = 1; });
