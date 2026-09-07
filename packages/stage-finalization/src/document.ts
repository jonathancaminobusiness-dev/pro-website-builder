import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createFixtureIR, designIRSchema, type DesignIR } from '@pwb/domain';

/**
 * The document the evidence runners measure.
 *
 * Evidence only counts when it was taken against the release being evaluated, so
 * a runner must compile the same document the gate compiles. Gate 3 writes that
 * document beside the evidence directory when it prepares a release, and every
 * runner reads it back from there. With no run to read — a clean checkout, CI —
 * the fixture stands in, and the artifacts then carry the fixture's digest, so a
 * later run does not silently inherit them.
 */
export const RELEASE_DOCUMENT_FILE = 'release-document.json';

export function releaseDocumentPath(evidenceDir: string): string {
  return process.env.PWB_RELEASE_DOCUMENT ?? join(evidenceDir, RELEASE_DOCUMENT_FILE);
}

export async function writeReleaseDocument(evidenceDir: string, ir: DesignIR): Promise<string> {
  const path = releaseDocumentPath(evidenceDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(designIRSchema.parse(ir), null, 2)}\n`, 'utf8');
  return path;
}

export async function loadReleaseDocument(evidenceDir: string): Promise<DesignIR> {
  const path = releaseDocumentPath(evidenceDir);
  let raw: string;
  try { raw = await readFile(path, 'utf8'); }
  catch { return createFixtureIR(); }
  return designIRSchema.parse(JSON.parse(raw));
}
