import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, ProjectRepository, scanSecrets } from '../../apps/server/src/db/repository.js';
import { FixtureRun } from '../../apps/server/src/fixture-run.js';

describe('phase 0 secret boundary', () => {
  it('keeps database dump, rendered bundle, and captured log data free of secret-like values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pwb-secrets-'));
    const database = openDatabase(join(root, 'secrets.sqlite'));
    const run = new FixtureRun({ repository: new ProjectRepository(database), exportRoot: join(root, 'exports') });
    const snapshot = await run.initialize('secret-scan').then(() => run.runAll());
    const files: string[] = [];
    async function collect(directory: string): Promise<void> { for (const entry of await readdir(directory, { withFileTypes: true })) { const path = join(directory, entry.name); if (entry.isDirectory()) await collect(path); else files.push(path); } }
    await collect(snapshot.exportManifest!.directory);
    const bundle = (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n');
    const dump = new ProjectRepository(database).dump();
    expect(dump).toContain(snapshot.currentVersion.id);
    expect(dump).toContain(snapshot.currentVersion.ir.identity.content.message);
    const logs = JSON.stringify({ runId: snapshot.runId, status: snapshot.status, versionId: snapshot.currentVersion.id });
    expect(scanSecrets(dump + bundle + logs)).toEqual([]);
    database.sqlite.close();
  });
});
