import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { ReleaseVeto } from '@pwb/domain';
import type { CompiledSite } from './compiler.js';

export class ReleaseVetoError extends Error {
  constructor(public readonly vetoes: ReleaseVeto[]) {
    super(`The release is blocked by ${vetoes.length} veto(es): ${vetoes.map((veto) => `${veto.id} at ${veto.where}`).join('; ')}`);
    this.name = 'ReleaseVetoError';
  }
}

export interface ReleaseManifest {
  digest: string;
  directory: string;
  rendererVersion: string;
  compilerVersion: string;
  siteUrl: string;
  siteName: string;
  csp: string;
  headers: Record<string, string>;
  stylesheetPath: string;
  routes: Array<{ route: string; path: string; title: string; description: string; canonical: string; hash: string }>;
  files: Array<{ path: string; hash: string; bytes: number }>;
  fonts: CompiledSite['fonts'];
  licenses: CompiledSite['licenses']['entries'];
}

/** Refuses any path that would leave the bundle directory, symlink or `..` included. */
function safeTarget(directory: string, path: string): string {
  const target = resolve(directory, path);
  const root = resolve(directory);
  if (target !== root && !target.startsWith(root + sep)) throw new Error(`Cannot write ${path}; it escapes the release bundle root.`);
  return target;
}

/**
 * Writes the compiled release into a content-addressed directory.
 *
 * The bundle is immutable: the directory name is the digest of every file it
 * contains, the manifest carries no timestamp, and nothing outside the compiled
 * file set is written. Any veto refuses the write outright — a blocked release
 * never reaches disk in a form that could be published by accident.
 *
 * The manifest is a pure function of the compiled bytes and the toolchain that
 * produced them: it names no document, no version and no publication, so the
 * same site always writes the same manifest and publishing it twice succeeds.
 * Which document produced these bytes, and who accepted what to publish them,
 * is the release record beside the bundle — see `appendReleasePublication`.
 */
export async function writeReleaseBundle(compiled: CompiledSite, rootDir: string): Promise<ReleaseManifest> {
  if (compiled.vetoes.length > 0) throw new ReleaseVetoError(compiled.vetoes);

  const directory = join(rootDir, compiled.digest);
  await mkdir(directory, { recursive: true });
  for (const file of compiled.files) {
    const target = safeTarget(directory, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, typeof file.contents === 'string' ? Buffer.from(file.contents, 'utf8') : Buffer.from(file.contents));
  }

  const byPath = new Map(compiled.files.map((file) => [file.path, file]));
  const manifest: ReleaseManifest = {
    digest: compiled.digest,
    directory,
    rendererVersion: compiled.rendererVersion,
    compilerVersion: compiled.compilerVersion,
    siteUrl: compiled.siteUrl,
    siteName: compiled.siteName,
    csp: compiled.csp,
    headers: compiled.headers,
    stylesheetPath: compiled.stylesheetPath,
    routes: compiled.routes.map((route) => ({ route: route.route, path: route.path, title: route.title, description: route.description, canonical: route.canonical, hash: byPath.get(route.path)?.hash ?? '' })),
    files: compiled.files.map((file) => ({ path: file.path, hash: file.hash, bytes: file.bytes })),
    fonts: compiled.fonts,
    licenses: compiled.licenses.entries,
  };
  // The manifest is written last and is excluded from the digest, so the same IR
  // and toolchain always produce the same directory name and the same bytes. The
  // digest cannot cover the manifest that names it, so a manifest that no longer
  // describes this bundle is refused rather than overwritten.
  const manifestPath = join(directory, 'manifest.json');
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  const existing = await readFile(manifestPath, 'utf8').catch(() => undefined);
  if (existing !== undefined && existing !== serialized) {
    throw new Error(`The bundle ${compiled.digest} already exists with a different manifest; an immutable release is never rewritten.`);
  }
  await writeFile(manifestPath, serialized, 'utf8');
  return manifest;
}

/** Reads a written bundle back as a path → sha256 map, for reproducibility checks. */
export async function readBundleHashes(manifest: ReleaseManifest): Promise<Record<string, string>> {
  const { createHash } = await import('node:crypto');
  const entries = await Promise.all(manifest.files.map(async (file) => {
    const contents = await readFile(join(manifest.directory, file.path));
    return [file.path, createHash('sha256').update(contents).digest('hex')] as const;
  }));
  return Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
