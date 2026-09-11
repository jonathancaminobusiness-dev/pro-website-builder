import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { releasePublicationsSchema, type ReleasePublication } from '@pwb/domain';

/**
 * One publication of one bundle: which document produced these bytes, who
 * accepted what, and why. The shape is `releasePublicationSchema` in
 * `@pwb/domain`, which is what reads it back.
 *
 * It lives beside the bundle directory, never inside it. The bundle is
 * content-addressed and its manifest is a pure function of the compiled bytes,
 * so two documents that compile to the same site publish into the same
 * directory; what told them apart — the approved version, the released version,
 * the document hash, the captain's written acceptance — belongs here instead.
 * Publishing the same bytes again appends a second entry rather than colliding
 * with the first.
 */
export type { ReleasePublication };

export const RELEASE_RECORD_SUFFIX = '.publications.json';

function recordPath(rootDir: string, digest: string): string {
  return join(rootDir, `${digest}${RELEASE_RECORD_SUFFIX}`);
}

/**
 * The publications recorded for one bundle, or none when the bundle has never
 * been published. A record that exists but cannot be read — unparseable, or
 * parseable into something that is not a list of publications — is an error: it
 * is the only durable home for the captain's written acceptance, so a damaged
 * file refuses the next append rather than being silently replaced by it or
 * carried forward with its garbage preserved.
 */
export async function readReleasePublications(rootDir: string, digest: string): Promise<ReleasePublication[]> {
  const path = recordPath(rootDir, digest);
  let raw: string;
  try { raw = await readFile(path, 'utf8'); }
  catch (error) {
    if (error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT') return [];
    throw error;
  }
  // Parsed, never cast: a record that is valid JSON but not a list of
  // publications — an object, a list of numbers, an entry missing the captain's
  // acceptance — would otherwise be appended to and rewritten with the garbage
  // preserved, or would die later on a field that was never there.
  try { return releasePublicationsSchema.parse(JSON.parse(raw)); }
  catch (error) { throw new Error(`The release record ${path} is unreadable, so the publications of this bundle cannot be preserved: ${error instanceof Error ? error.message : 'invalid JSON or shape'}`); }
}

export async function appendReleasePublication(rootDir: string, entry: ReleasePublication): Promise<ReleasePublication[]> {
  await mkdir(rootDir, { recursive: true });
  const publications = [...await readReleasePublications(rootDir, entry.digest), entry];
  await writeFile(recordPath(rootDir, entry.digest), `${JSON.stringify(publications, null, 2)}\n`, 'utf8');
  return publications;
}
