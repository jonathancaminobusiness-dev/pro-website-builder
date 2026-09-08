/**
 * Puts one real face in the project's fonts directory, the way an owner would.
 *
 * The compiler never downloads a font, so without a file on disk every runner
 * measures a release whose typography is a fallback stack: `document.fonts` is
 * empty on both sides of `tests/release/parity.spec.ts`, and the browser
 * evidence proves nothing about the faces the release ships. The face comes
 * from a dev dependency that redistributes it under the OFL — `@fontsource/fraunces`
 * — rather than from a binary committed to this repository or a download at
 * compile time.
 *
 * It runs once, at install, because every compile site reads this same
 * directory: seeding it later would change the digest between the gate and the
 * runners that are meant to measure the gate's bundle. An existing
 * `manifest.json` is left exactly as it is — the faces a real owner put there
 * are theirs, not a fixture's.
 *
 * `Fraunces` is the family the fixture identity already names in its display
 * stack, so the face is loaded by text on every route instead of being declared
 * and never used.
 */
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FontManifest } from '../packages/domain/src/index.js';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const fontsDir = process.env.PWB_FONTS_DIR ?? join(root, 'fonts');

/** What the package declares about the face it ships; the manifest states no more than this. */
interface FontsourceMetadata { family: string; license: { type: string; url: string }; source: string; lastModified: string }

/** The weight and style the fixture renders, and the one file that carries them. */
const WEIGHT = '400';
const STYLE = 'normal';
const FILE = 'fraunces-400-normal.woff2';
/** The copyright line of the package's own LICENSE file. */
const AUTHOR = 'The Fraunces Project Authors (github.com/undercasetype/Fraunces)';

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

async function main(): Promise<void> {
  const manifestPath = join(fontsDir, 'manifest.json');
  if (await exists(manifestPath)) {
    console.log(JSON.stringify({ fontsDir, seeded: false, reason: 'The project already declares its own faces.' }));
    return;
  }
  const metadata = JSON.parse(await readFile(require.resolve('@fontsource/fraunces/metadata.json'), 'utf8')) as FontsourceMetadata;
  const manifest: FontManifest = {
    faces: [{
      family: metadata.family, weight: WEIGHT, style: STYLE, format: 'woff2', file: FILE,
      license: metadata.license.type, licenseUrl: metadata.license.url,
      source: metadata.source, author: AUTHOR, date: metadata.lastModified,
    }],
  };
  await mkdir(fontsDir, { recursive: true });
  await copyFile(require.resolve(`@fontsource/fraunces/files/fraunces-latin-${WEIGHT}-${STYLE}.woff2`), join(fontsDir, FILE));
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ fontsDir, seeded: true, family: metadata.family, license: metadata.license.type }));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'The fixture face could not be seeded.');
  process.exitCode = 1;
});
