import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileRelease } from '../../packages/export/src/index.js';
import { renderDesign } from '../../packages/renderer/src/index.js';
import { openDatabase, ProjectRepository, scanSecrets } from '../../apps/server/src/db/repository.js';
import { FixtureRun } from '../../apps/server/src/fixture-run.js';
import { IdentityRun } from '../../apps/server/src/identity-run.js';
import { createIdentityProvider, createModelProvider } from '../../apps/server/src/provider.js';

function releaseOptions(root: string) {
  return { releaseRoot: root, evidenceDir: join(root, '..', 'evidence') };
}

describe('phase 0 secret boundary', () => {
  it('keeps database dump, rendered bundle, and captured log data free of secret-like values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pwb-secrets-'));
    const database = openDatabase(join(root, 'secrets.sqlite'));
    const run = new FixtureRun({ repository: new ProjectRepository(database), release: releaseOptions(join(root, 'exports')), provider: createModelProvider() });
    const snapshot = await run.initialize('secret-scan').then(() => run.runAll());
    // The release the run stopped at: the exact bytes Gate 3 would publish.
    const compiled = compileRelease(renderDesign(snapshot.currentVersion.ir), snapshot.currentVersion.ir, { siteUrl: 'https://site.invalid', siteName: 'pro-website-builder' });
    const bundle = compiled.files.map((file) => (typeof file.contents === 'string' ? file.contents : Buffer.from(file.contents).toString('utf8'))).join('\n');
    const dump = new ProjectRepository(database).dump();
    expect(dump).toContain(snapshot.currentVersion.id);
    expect(dump).toContain(snapshot.currentVersion.ir.identity.content.message);
    const logs = JSON.stringify({ runId: snapshot.runId, status: snapshot.status, versionId: snapshot.currentVersion.id });
    expect(scanSecrets(dump + bundle + logs)).toEqual([]);
    database.sqlite.close();
  });

  it('keeps the identity stage database, events and prompts free of secret-like values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pwb-identity-secrets-'));
    const database = openDatabase(join(root, 'identity-secrets.sqlite'));
    const repository = new ProjectRepository(database);
    const run = new IdentityRun({ runId: 'identity-secret-scan', repository, provider: createIdentityProvider() });
    await run.initialize();
    const snapshot = await run.start();
    await run.approve({ directionId: snapshot.directions[0]!.directionId, approverRole: 'captain', rationale: 'Aprovada para o scan.' });
    const dump = repository.dump();
    expect(dump).toContain(snapshot.directions[0]!.versionId);
    const events = JSON.stringify(await repository.listEvents('identity-secret-scan'));
    const prompts = snapshot.directions.map((direction) => JSON.stringify(direction)).join('\n');
    expect(scanSecrets(dump + events + prompts)).toEqual([]);
    database.sqlite.close();
  });
});
