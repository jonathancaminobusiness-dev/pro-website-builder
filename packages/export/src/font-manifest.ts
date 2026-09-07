import { readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fontManifestSchema } from '@pwb/domain';
import type { FontSource } from './fonts.js';

/** The file the owner writes beside the faces, naming each one and its terms. */
export const FONT_MANIFEST_FILE = 'manifest.json';

/**
 * Reads the faces a project offers its releases.
 *
 * No manifest means no self-hosted face, which is what every release shipped
 * before the owner put one there. A manifest that does not parse is a hard
 * error, never a silent skip: a release that quietly dropped a face would ship
 * different bytes than the one the owner asked for, and every runner compiles
 * from this same directory so their measurements name the same bundle.
 */
export async function loadFontSources(fontsDir: string | undefined): Promise<FontSource[]> {
  if (fontsDir === undefined) return [];
  let raw: string;
  try { raw = await readFile(join(fontsDir, FONT_MANIFEST_FILE), 'utf8'); }
  catch { return []; }
  const manifest = fontManifestSchema.parse(JSON.parse(raw));
  const root = resolve(fontsDir);
  const sources: FontSource[] = [];
  for (const face of manifest.faces) {
    const target = resolve(fontsDir, face.file);
    if (!target.startsWith(root + sep)) throw new Error(`Cannot read the font ${face.file}; it escapes the fonts directory.`);
    sources.push({
      family: face.family,
      weight: face.weight,
      style: face.style,
      format: face.format,
      bytes: new Uint8Array(await readFile(target)),
      license: face.license,
      source: face.source,
      author: face.author,
      date: face.date,
      ...(face.licenseUrl ? { licenseUrl: face.licenseUrl } : {}),
      ...(face.unicodeRange ? { unicodeRange: face.unicodeRange } : {}),
    });
  }
  return sources;
}
