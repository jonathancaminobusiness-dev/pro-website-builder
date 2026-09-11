/**
 * Drives the finalization stage from the command line.
 *
 * Without arguments it prepares the release through the same `ReleaseRun` the
 * studio uses — compile, five critics, Gate 3 — and publishes only a report that
 * left nothing for a human to accept, under the `fixture` role, so a script
 * never signs for the captain. A veto or an open escalation is printed and the
 * command exits non-zero without writing a bundle. `run:evidence` is what serves
 * the release, so the independent runners — Playwright on three engines, axe and
 * Lighthouse — take their measurements against one harness.
 *
 * Environment:
 *   PWB_SITE_URL       origin the release will be served from (default https://site.invalid)
 *   PWB_SITE_NAME      site name used in Open Graph (default "pro-website-builder")
 *   PWB_RELEASE_ROOT   where the content-addressed bundle is written (default releases/)
 *   PWB_EVIDENCE_DIR   where the evidence runners write their artifacts and the
 *                      release document lives (default artifacts/release/)
 *   PWB_FONTS_DIR      faces the release may self-host (default fonts/)
 *   PWB_MODEL_PROVIDER "fake" (default), "claude-code" or "codex" for the real critic sessions
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { startServedPreview } from '../apps/server/src/preview.js';
import { ReleaseRun, type ReleaseSnapshot } from '../apps/server/src/release-run.js';
import { siteFromEnvironment } from '../apps/server/src/site-environment.js';
import { Applier, PatchGate, VersionStore } from '../packages/orchestrator/src/index.js';
import { renderDesign } from '../packages/renderer/src/index.js';
import { loadReleaseDocument } from '../packages/stage-finalization/src/index.js';

const root = process.cwd();
const { siteUrl, siteName } = siteFromEnvironment();
const releaseRoot = process.env.PWB_RELEASE_ROOT ?? join(root, 'releases');
const evidenceDir = process.env.PWB_EVIDENCE_DIR ?? join(root, 'artifacts', 'release');
const fontsDir = process.env.PWB_FONTS_DIR ?? join(root, 'fonts');

const RATIONALE = 'Publicado por scripts/run-release.ts, sem decisão humana: o Gate 3 não deixou nada a aceitar.';

async function main(): Promise<void> {
  await mkdir(releaseRoot, { recursive: true });
  const applier = new Applier(new VersionStore(), new PatchGate());
  const approved = applier.createRoot(await loadReleaseDocument(evidenceDir));
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];

  // Gate 3 can only speak for faces a preview served, so this run serves the
  // version the stage hands the gate — asked for by `previewFaces` while the
  // release is prepared, before any refinement cycle — and hands the gate the
  // faces that origin delivered; the faces come from the fonts directory, so a
  // refinement does not change them. Port 0 keeps the CLI off the developer ports.
  const preview = await startServedPreview(fontsDir);
  const release = new ReleaseRun('cli-release', {
    releaseRoot,
    evidenceDir,
    fontsDir,
    siteUrl,
    siteName,
    previewFaces: (version) => preview.serve(version.id, renderDesign(version.ir)),
    ...(process.env.PWB_MODEL_PROVIDER ? { modelProvider: process.env.PWB_MODEL_PROVIDER } : {}),
  });
  // A command line run has no durable log of its own, so its events are printed
  // beside the report instead of being dropped.
  let prepared: ReleaseSnapshot;
  try {
    prepared = await release.prepare({
      approved,
      current: approved,
      applier,
      adopt: async () => { /* a refinement is already in this run's own version store */ },
      record: async (type, payload) => { events.push({ type, payload }); },
      approveFinalization: async () => { /* the CLI has no run to advance; the release record is the durable trace */ },
    });
  } finally { await preview.close(); }

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
