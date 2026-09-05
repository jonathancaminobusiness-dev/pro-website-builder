import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, ProjectRepository } from './db/repository.js';
import { FixtureRun } from './fixture-run.js';

describe('phase 0 fixture run', () => {
  it('crosses all three captain gates and exports three routes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pwb-run-'));
    const db = openDatabase(join(dir, 'run.sqlite'));
    const run = new FixtureRun({ repository: new ProjectRepository(db), exportRoot: join(dir, 'exports') });
    await run.initialize('run-1');
    const snapshot = await run.runAll();
    expect(snapshot.status).toBe('succeeded');
    expect(snapshot.approvals).toHaveLength(3);
    expect(snapshot.exportManifest?.routes).toEqual(['/', '/proof', '/contact']);
    expect(await readdir(snapshot.exportManifest!.directory)).toEqual(expect.arrayContaining(['index.html', 'manifest.json', 'assets', 'proof', 'contact']));
    db.sqlite.close();
  });

  it('cancels before apply and restarts from the same immutable revision', async () => {
    const db = openDatabase(':memory:');
    const run = new FixtureRun({ repository: new ProjectRepository(db), exportRoot: '/tmp/pwb-fixture-test' });
    await run.initialize('run-2');
    const rootId = run.snapshot().currentVersion.id;
    run.cancel();
    expect(run.snapshot().status).toBe('cancelled');
    expect(run.snapshot().currentVersion.id).toBe(rootId);
    run.restart();
    expect((await run.runAll()).status).toBe('succeeded');
    db.sqlite.close();
  });
});
