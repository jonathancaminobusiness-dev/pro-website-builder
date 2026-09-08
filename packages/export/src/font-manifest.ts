import type { Stats } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
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
  const path = join(fontsDir, FONT_MANIFEST_FILE);
  let raw: string;
  try { raw = await readFile(path, 'utf8'); }
  catch (error) {
    if (error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT') return [];
    throw new Error(`The fonts manifest ${path} could not be read, so the release cannot know which faces it may ship: ${error instanceof Error ? error.message : 'unreadable'}`);
  }
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
    });
  }
  return sources;
}

/**
 * An identity for the faces a directory offers, cheap enough to compute on every
 * request that serves them: the manifest and every face file it declares, by
 * modification time and size.
 *
 * A face re-exported in place leaves the manifest untouched, so an identity
 * taken from the manifest alone would keep a reader on bytes the release no
 * longer ships. `absent` means the project declares no face; `unreadable` means
 * the faces could not be identified, and the caller has to load the sources to
 * learn why rather than trust anything it kept.
 */
export async function fontManifestKey(fontsDir: string | undefined): Promise<string> {
  if (fontsDir === undefined) return 'absent';
  const path = join(fontsDir, FONT_MANIFEST_FILE);
  let manifestFile: Stats;
  try { manifestFile = await stat(path); }
  catch (error) { return error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT' ? 'absent' : 'unreadable'; }
  try {
    const manifest = fontManifestSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    const parts = [`${FONT_MANIFEST_FILE}:${manifestFile.mtimeMs}:${manifestFile.size}`];
    for (const face of manifest.faces) {
      const info = await stat(resolve(fontsDir, face.file));
      parts.push(`${face.file}:${info.mtimeMs}:${info.size}`);
    }
    return parts.join('|');
  } catch { return 'unreadable'; }
}
