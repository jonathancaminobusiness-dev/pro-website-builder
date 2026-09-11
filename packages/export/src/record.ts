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

function samePublication(one: ReleasePublication, other: ReleasePublication): boolean {
  return one.digest === other.digest && one.approvedVersionId === other.approvedVersionId && one.releasedVersionId === other.releasedVersionId
    && one.irHash === other.irHash && one.approverRole === other.approverRole && one.rationale === other.rationale
    && one.acceptedEscalations.length === other.acceptedEscalations.length && one.acceptedEscalations.every((escalation, index) => escalation === other.acceptedEscalations[index]);
}

export async function appendReleasePublication(rootDir: string, entry: ReleasePublication): Promise<ReleasePublication[]> {
  await mkdir(rootDir, { recursive: true });
  const publications = [...await readReleasePublications(rootDir, entry.digest), entry];
  await writeFile(recordPath(rootDir, entry.digest), `${JSON.stringify(publications, null, 2)}\n`, 'utf8');
  return publications;
}

/**
 * Takes one publication back out of the record: the acceptance it belongs to
 * did not commit, so it describes a publication that never happened. Only the
 * entry this publish appended is dropped — the last one that matches it — so
 * the record is left exactly as the publish found it, and a retry appends once
 * instead of doubling what an auditor counts.
 */
export async function removeReleasePublication(rootDir: string, entry: ReleasePublication): Promise<ReleasePublication[]> {
  const recorded = await readReleasePublications(rootDir, entry.digest);
  const last = recorded.map((publication) => samePublication(publication, entry)).lastIndexOf(true);
  if (last < 0) return recorded;
  const publications = recorded.filter((_, index) => index !== last);
  await writeFile(recordPath(rootDir, entry.digest), `${JSON.stringify(publications, null, 2)}\n`, 'utf8');
  return publications;
}
