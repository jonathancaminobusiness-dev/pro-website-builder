import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixtureIR } from '../../packages/domain/src/index.js';
import { compileRelease } from '../../packages/export/src/index.js';
import { renderDesign } from '../../packages/renderer/src/index.js';
import { createReleaseHarness } from '../../packages/stage-finalization/src/index.js';

/**
 * Compiles the release once and serves it, together with the preview of the same
 * document, on a port the operating system chooses. Nothing here binds a fixed
 * developer port, so an evidence run never contends with a running studio or
 * with another worktree.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const ir = createFixtureIR();
  const rendered = renderDesign(ir);
  const compiled = compileRelease(rendered, ir, {
    siteUrl: process.env.PWB_SITE_URL ?? 'https://site.invalid',
    siteName: process.env.PWB_SITE_NAME ?? 'pro-website-builder',
  });
  const harness = createReleaseHarness(compiled, rendered, Number(process.env.PWB_RELEASE_PORT ?? 0));
  const origin = await harness.start();
  process.env.PWB_RELEASE_ORIGIN = origin;
  await mkdir(process.env.PWB_EVIDENCE_DIR ?? join(process.cwd(), 'artifacts', 'release'), { recursive: true });
  return async () => { await harness.close(); };
}
