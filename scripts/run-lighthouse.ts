/**
 * Lighthouse evidence for the finalization stage, on mobile and on desktop.
 *
 * It compiles the release, serves it on an ephemeral port, drives Playwright's
 * Chromium over the DevTools protocol and writes one typed artifact per form
 * factor. Lighthouse is a laboratory measurement: it does not observe a real
 * visitor, and the artifact says so rather than implying field data.
 *
 * Run it manually, or through `pnpm run:evidence`, before Gate 3.
 */
import { createServer } from 'node:net';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { compileRelease, loadFontSources } from '../packages/export/src/index.js';
import { renderDesign } from '../packages/renderer/src/index.js';
import { artifactHash, createReleaseHarness, loadReleaseDocument, writeEvidenceArtifact } from '../packages/stage-finalization/src/index.js';

interface LighthouseResult { lhr: { categories: Record<string, { score: number | null }>; audits: Record<string, { numericValue?: number; score: number | null }>; runtimeError?: { message: string } } }
type LighthouseFn = (url: string, flags: Record<string, unknown>) => Promise<LighthouseResult | undefined>;

const evidenceDir = process.env.PWB_EVIDENCE_DIR ?? join(process.cwd(), 'artifacts', 'release');
const fontsDir = process.env.PWB_FONTS_DIR ?? join(process.cwd(), 'fonts');

/** Asks the operating system for a free port instead of claiming a developer port. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') { probe.close(); reject(new Error('Could not reserve a port.')); return; }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

const FORM_FACTORS = [
  { name: 'mobile', formFactor: 'mobile' as const, screenEmulation: { mobile: true, width: 412, height: 823, deviceScaleFactor: 1.75, disabled: false } },
  { name: 'desktop', formFactor: 'desktop' as const, screenEmulation: { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false } },
];

async function main(): Promise<void> {
  const ir = await loadReleaseDocument(evidenceDir);
  const rendered = renderDesign(ir);
  const fonts = await loadFontSources(fontsDir);
  const compiled = compileRelease(rendered, ir, { siteUrl: process.env.PWB_SITE_URL ?? 'https://site.invalid', siteName: process.env.PWB_SITE_NAME ?? 'pro-website-builder', ...(fonts.length > 0 ? { fonts } : {}) });
  const harness = createReleaseHarness(compiled, rendered, 0);
  const origin = await harness.start();
  const debuggingPort = await freePort();
  const browser = await chromium.launch({ headless: true, args: [`--remote-debugging-port=${debuggingPort}`] });

  // The specifier is a variable so the type checker does not need declarations
  // for a package that ships none; the shape it is used through is declared above.
  const specifier = 'lighthouse';
  const lighthouse = ((await import(specifier)) as { default: LighthouseFn }).default;

  const written: string[] = [];
  try {
    for (const route of compiled.routes) {
      for (const factor of FORM_FACTORS) {
        const result = await lighthouse(`${origin}${route.path.replace(/index\.html$/, '').replace(/^/, '/')}`, {
          port: debuggingPort,
          output: 'json',
          logLevel: 'error',
          formFactor: factor.formFactor,
          screenEmulation: factor.screenEmulation,
          onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
        });
        if (!result) throw new Error(`Lighthouse returned nothing for ${route.route} on ${factor.name}.`);
        const { lhr } = result;
        const score = (name: string): number => Math.round(((lhr.categories[name]?.score ?? 0) * 100));
        const audit = (name: string): number => Math.round(lhr.audits[name]?.numericValue ?? 0);
        const metrics = {
          performance: score('performance'), accessibility: score('accessibility'),
          bestPractices: score('best-practices'), seo: score('seo'),
          largestContentfulPaintMs: audit('largest-contentful-paint'),
          cumulativeLayoutShift: lhr.audits['cumulative-layout-shift']?.numericValue ?? 0,
          totalBlockingTimeMs: audit('total-blocking-time'),
        };
        written.push(await writeEvidenceArtifact(evidenceDir, {
          id: `lighthouse-${factor.name}-${route.route === '/' ? 'home' : route.route.slice(1)}`,
          runner: 'lighthouse', engine: 'chromium', releaseDigest: compiled.digest, irHash: compiled.irHash, route: route.route, state: factor.name,
          status: lhr.runtimeError ? 'failed' : 'passed',
          path: route.path,
          hash: artifactHash(metrics),
          metrics,
          notes: [
            'Lighthouse is a laboratory run: it measures this machine and this network, not a real visitor.',
            'INP is not measured without interaction; total blocking time stands in for it.',
            ...(lhr.runtimeError ? [lhr.runtimeError.message] : []),
          ],
        }));
      }
    }
  } finally {
    await browser.close();
    await harness.close();
  }
  console.log(JSON.stringify({ origin, artifacts: written.length, evidenceDir }, null, 2));
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Lighthouse run failed.'); process.exitCode = 1; });
