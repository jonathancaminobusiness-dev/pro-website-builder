/**
 * Drives the finalization stage from the command line.
 *
 * Without arguments it compiles the release document, runs the five critics with
 * the deterministic providers, evaluates Gate 3 and writes the immutable bundle
 * when nothing vetoes it. With `--serve` it keeps the release and the preview of
 * the same document online so the independent evidence runners — Playwright on
 * three engines, axe and Lighthouse — can take their own measurements.
 *
 * Environment:
 *   PWB_SITE_URL       origin the release will be served from (default https://site.invalid)
 *   PWB_SITE_NAME      site name used in Open Graph (default "pro-website-builder")
 *   PWB_RELEASE_ROOT   where the content-addressed bundle is written (default releases/)
 *   PWB_EVIDENCE_DIR   where the evidence runners write their artifacts and the
 *                      release document lives (default artifacts/release/)
 *   PWB_RELEASE_PORT   harness port for --serve (default: a port the OS chooses)
 *   PWB_MODEL_PROVIDER "fake" (default) or "claude-code" for the real critic sessions
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ReleaseVetoError, writeReleaseBundle } from '../packages/export/src/index.js';
import { Applier, PatchGate, VersionStore } from '../packages/orchestrator/src/index.js';
import { ClaudeJsonRunner } from '../packages/providers/src/index.js';
import { renderDesign } from '../packages/renderer/src/index.js';
import {
  ClaudeReleaseCriticProvider, ClaudeReleaseRefiner, ClaudeReleaseSummarizer, createReleaseHarness,
  DeterministicReleaseSummarizer, FakeReleaseCriticProvider, FakeReleaseRefiner, FinalizationStage,
  loadReleaseDocument, PatchRefiner, readEvidence, writeReleaseDocument,
  type ReleaseCriticProvider, type ReleaseRefinerProvider, type ReleaseSummarizerProvider,
} from '../packages/stage-finalization/src/index.js';

const root = process.cwd();
const siteUrl = process.env.PWB_SITE_URL ?? 'https://site.invalid';
const siteName = process.env.PWB_SITE_NAME ?? 'pro-website-builder';
const releaseRoot = process.env.PWB_RELEASE_ROOT ?? join(root, 'releases');
const evidenceDir = process.env.PWB_EVIDENCE_DIR ?? join(root, 'artifacts', 'release');
// Default to an ephemeral port so a manual harness never contends with the
// studio, the preview, or another worktree's test run.
const port = Number(process.env.PWB_RELEASE_PORT ?? 0);

function providers(): { critic: ReleaseCriticProvider; refiner: ReleaseRefinerProvider; summarizer: ReleaseSummarizerProvider } {
  const name = process.env.PWB_MODEL_PROVIDER ?? 'fake';
  if (name === 'fake') return { critic: new FakeReleaseCriticProvider(), refiner: new FakeReleaseRefiner(), summarizer: new DeterministicReleaseSummarizer() };
  if (name !== 'claude-code') throw new Error(`Unknown model provider ${name}; use fake or claude-code.`);
  const runner = new ClaudeJsonRunner();
  return { critic: new ClaudeReleaseCriticProvider(runner), refiner: new ClaudeReleaseRefiner(runner), summarizer: new ClaudeReleaseSummarizer(runner) };
}

async function main(): Promise<void> {
  await mkdir(releaseRoot, { recursive: true });
  const store = new VersionStore();
  const applier = new Applier(store, new PatchGate());
  const approved = applier.createRoot(await loadReleaseDocument(evidenceDir));
  // The evidence runners compile this same document, so their artifacts name the
  // release this run is about to evaluate.
  await writeReleaseDocument(evidenceDir, approved.ir);
  const chosen = providers();
  const stage = new FinalizationStage({
    criticProvider: chosen.critic,
    refiner: new PatchRefiner(chosen.refiner),
    summarizer: chosen.summarizer,
    compilerOptions: { siteUrl, siteName },
  });

  const evidence = await readEvidence(evidenceDir);
  const result = await stage.run({ runId: 'cli-release', version: approved, evidence, applier });

  if (process.argv.includes('--serve')) {
    const harness = createReleaseHarness(result.compiled, renderDesign(result.version.ir), port);
    const origin = await harness.start();
    console.log(JSON.stringify({ mode: 'serve', origin, digest: result.compiled.digest, routes: result.compiled.routes.map((route) => route.route) }, null, 2));
    const stop = (): void => { void harness.close().then(() => process.exit(0)); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return;
  }

  let bundle: string | undefined;
  let refused: string | undefined;
  try {
    bundle = (await writeReleaseBundle(result.compiled, releaseRoot)).directory;
  } catch (error) {
    if (!(error instanceof ReleaseVetoError)) throw error;
    refused = error.message;
  }

  console.log(JSON.stringify({
    digest: result.compiled.digest,
    versionId: result.version.id,
    blocked: result.report.blocked,
    vetoes: result.report.vetoes,
    rubric: result.report.rubric,
    parity: result.report.parity.matched,
    refinementCycles: result.cycles,
    escalations: result.report.escalations,
    evidenceCount: evidence.length,
    summary: result.report.summary,
    ...(bundle ? { bundle } : {}),
    ...(refused ? { refused } : {}),
  }, null, 2));
  if (result.report.blocked) process.exitCode = 1;
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Release run failed.'); process.exitCode = 1; });
