/**
 * Drives the finalization stage from the command line.
 *
 * Without arguments it prepares the release through the same `ReleaseRun` the
 * studio uses — compile, five critics, Gate 3 — and publishes only a report that
 * left nothing for a human to accept, under the `fixture` role, so a script
 * never signs for the captain. A veto or an open escalation is printed and the
 * command exits non-zero without writing a bundle. With `--serve` it keeps the
 * release and the preview of the same document online so the independent
 * evidence runners — Playwright on three engines, axe and Lighthouse — can take
 * their own measurements.
 *
 * Environment:
 *   PWB_SITE_URL       origin the release will be served from (default https://site.invalid)
 *   PWB_SITE_NAME      site name used in Open Graph (default "pro-website-builder")
 *   PWB_RELEASE_ROOT   where the content-addressed bundle is written (default releases/)
 *   PWB_EVIDENCE_DIR   where the evidence runners write their artifacts and the
 *                      release document lives (default artifacts/release/)
 *   PWB_FONTS_DIR      faces the release may self-host (default fonts/)
 *   PWB_RELEASE_PORT   harness port for --serve (default: a port the OS chooses)
 *   PWB_MODEL_PROVIDER "fake" (default) or "claude-code" for the real critic sessions
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ReleaseRun } from '../apps/server/src/release-run.js';
import { compileRelease, loadFontSources } from '../packages/export/src/index.js';
import { Applier, PatchGate, VersionStore } from '../packages/orchestrator/src/index.js';
import { renderDesign } from '../packages/renderer/src/index.js';
import { createReleaseHarness, loadReleaseDocument, writeReleaseDocument } from '../packages/stage-finalization/src/index.js';

const root = process.cwd();
const siteUrl = process.env.PWB_SITE_URL ?? 'https://site.invalid';
const siteName = process.env.PWB_SITE_NAME ?? 'pro-website-builder';
const releaseRoot = process.env.PWB_RELEASE_ROOT ?? join(root, 'releases');
const evidenceDir = process.env.PWB_EVIDENCE_DIR ?? join(root, 'artifacts', 'release');
const fontsDir = process.env.PWB_FONTS_DIR ?? join(root, 'fonts');
// Default to an ephemeral port so a manual harness never contends with the
// studio, the preview, or another worktree's test run.
const port = Number(process.env.PWB_RELEASE_PORT ?? 0);

const RATIONALE = 'Publicado por scripts/run-release.ts, sem decisão humana: o Gate 3 não deixou nada a aceitar.';

/**
 * Serves the release the evidence runners measure. The document goes through the
 * Applier first, exactly as Gate 3 compiles it, so the digest the artifacts name
 * is the digest the gate credits.
 */
async function serve(): Promise<void> {
  const version = new Applier(new VersionStore(), new PatchGate()).createRoot(await loadReleaseDocument(evidenceDir));
  await writeReleaseDocument(evidenceDir, version.ir);
  const rendered = renderDesign(version.ir);
  const fonts = await loadFontSources(fontsDir);
  const compiled = compileRelease(rendered, version.ir, { siteUrl, siteName, ...(fonts.length > 0 ? { fonts } : {}) });
  const harness = createReleaseHarness(compiled, rendered, port);
  const origin = await harness.start();
  console.log(JSON.stringify({ mode: 'serve', origin, digest: compiled.digest, routes: compiled.routes.map((route) => route.route) }, null, 2));
  const stop = (): void => { void harness.close().then(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function main(): Promise<void> {
  if (process.argv.includes('--serve')) { await serve(); return; }
  await mkdir(releaseRoot, { recursive: true });
  const applier = new Applier(new VersionStore(), new PatchGate());
  const approved = applier.createRoot(await loadReleaseDocument(evidenceDir));
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];

  const release = new ReleaseRun('cli-release', {
    releaseRoot,
    evidenceDir,
    fontsDir,
    siteUrl,
    siteName,
    ...(process.env.PWB_MODEL_PROVIDER ? { modelProvider: process.env.PWB_MODEL_PROVIDER } : {}),
  });
  // A command line run has no durable log of its own, so its events are printed
  // beside the report instead of being dropped.
  const prepared = await release.prepare({
    approved,
    current: approved,
    applier,
    adopt: async () => { /* a refinement is already in this run's own version store */ },
    record: async (type, payload) => { events.push({ type, payload }); },
    approveFinalization: async () => { /* the CLI has no run to advance; the release record is the durable trace */ },
  });

  const report = prepared.report;
  const publishable = !report.blocked && report.escalations.length === 0;
  if (publishable) await release.publish('fixture', prepared.digest, RATIONALE);
  const published = release.snapshot()?.published;

  console.log(JSON.stringify({
    digest: report.bundleDigest,
    versionId: prepared.versionId,
    blocked: report.blocked,
    vetoes: report.vetoes,
    rubric: report.rubric,
    parity: report.parity.matched,
    refinementCycles: report.refinementCycles,
    escalations: report.escalations,
    evidenceCount: report.evidence.length,
    summary: report.summary,
    events: events.map((entry) => entry.type),
    ...(published ? { bundle: published.directory } : {}),
  }, null, 2));
  if (!publishable) process.exitCode = 1;
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Release run failed.'); process.exitCode = 1; });
