import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadFontSources } from './font-manifest.js';

const FACE = Buffer.from([119, 79, 70, 50, 1, 2, 3, 4]);
const ENTRY = {
  family: 'Fixture Sans', weight: '400', style: 'normal', format: 'woff2',
  file: 'fixture-sans-400.woff2', license: 'ofl-1.1',
  source: 'https://fonts.example/fixture-sans', author: 'Fixture Foundry', date: '2026-09-07',
};

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function fontsDirectory(manifest?: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pwb-fonts-'));
  directories.push(directory);
  await writeFile(join(directory, ENTRY.file), FACE);
  if (manifest !== undefined) await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return directory;
}

describe('the fonts the owner hands over', () => {
  it('reads each face named in the manifest together with its bytes and its terms', async () => {
    const [face, ...rest] = await loadFontSources(await fontsDirectory({
      faces: [{ ...ENTRY, licenseUrl: 'https://openfontlicense.org' }],
    }));
    expect(rest).toEqual([]);
    expect(face).toMatchObject({
      family: 'Fixture Sans', weight: '400', style: 'normal', format: 'woff2',
      license: 'ofl-1.1', licenseUrl: 'https://openfontlicense.org',
      source: 'https://fonts.example/fixture-sans', author: 'Fixture Foundry', date: '2026-09-07',
    });
    expect(Buffer.from(face!.bytes)).toEqual(FACE);
  });

  it('self-hosts nothing when the project has no fonts directory and no manifest in it', async () => {
    expect(await loadFontSources(undefined)).toEqual([]);
    expect(await loadFontSources(join(tmpdir(), 'pwb-fonts-absent'))).toEqual([]);
    expect(await loadFontSources(await fontsDirectory())).toEqual([]);
  });

  it('refuses a manifest that reaches outside the fonts directory', async () => {
    const directory = await fontsDirectory({ faces: [{ ...ENTRY, file: '../fixture-sans-400.woff2' }] });
    await expect(loadFontSources(directory)).rejects.toThrow(/escapes the fonts directory/);
  });

  it('refuses a manifest it cannot read rather than compiling with no face at all', async () => {
    const directory = await fontsDirectory({ faces: [ENTRY] });
    // The owner pointed the variable at the manifest instead of its directory.
    await expect(loadFontSources(join(directory, 'manifest.json'))).rejects.toThrow(/could not be read/);
  });

  it('refuses a face declared in a format the release does not ship', async () => {
    const directory = await fontsDirectory({ faces: [{ ...ENTRY, format: 'woff' }] });
    await expect(loadFontSources(directory)).rejects.toThrow();
  });

  it('refuses a face that arrives without the terms it came under', async () => {
    const directory = await fontsDirectory({ faces: [{ ...ENTRY, license: '' }] });
    await expect(loadFontSources(directory)).rejects.toThrow();
  });
});
