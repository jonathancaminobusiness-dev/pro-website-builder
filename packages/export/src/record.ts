import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * One publication of one bundle: which document produced these bytes, who
 * accepted what, and why.
 *
 * It lives beside the bundle directory, never inside it. The bundle is
 * content-addressed and its manifest is a pure function of the compiled bytes,
 * so two documents that compile to the same site publish into the same
 * directory; what told them apart — the approved version, the released version,
 * the document hash, the captain's written acceptance — belongs here instead.
 * Publishing the same bytes again appends a second entry rather than colliding
 * with the first.
 */
export interface ReleasePublication {
  digest: string;
  approvedVersionId: string;
  releasedVersionId: string;
  irHash: string;
  approverRole: string;
  rationale: string;
  acceptedEscalations: string[];
}

export const RELEASE_RECORD_SUFFIX = '.publications.json';

function recordPath(rootDir: string, digest: string): string {
  return join(rootDir, `${digest}${RELEASE_RECORD_SUFFIX}`);
}

export async function readReleasePublications(rootDir: string, digest: string): Promise<ReleasePublication[]> {
  try { return JSON.parse(await readFile(recordPath(rootDir, digest), 'utf8')) as ReleasePublication[]; }
  catch { return []; }
}

export async function appendReleasePublication(rootDir: string, entry: ReleasePublication): Promise<ReleasePublication[]> {
  await mkdir(rootDir, { recursive: true });
  const publications = [...await readReleasePublications(rootDir, entry.digest), entry];
  await writeFile(recordPath(rootDir, entry.digest), `${JSON.stringify(publications, null, 2)}\n`, 'utf8');
  return publications;
}
