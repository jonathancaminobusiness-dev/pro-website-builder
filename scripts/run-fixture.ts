import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { openDatabase, ProjectRepository } from '../apps/server/src/db/repository.js';
import { FixtureRun } from '../apps/server/src/fixture-run.js';

const root = process.cwd();
const databasePath = process.env.PWB_DB_PATH ?? join(root, '.treehouse', 'cli-fixture.sqlite');
const exportRoot = process.env.PWB_EXPORT_ROOT ?? join(root, 'exports');

async function main(): Promise<void> {
  await mkdir(join(databasePath, '..'), { recursive: true });
  await mkdir(exportRoot, { recursive: true });
  const database = openDatabase(databasePath);
  try {
    const run = new FixtureRun({ repository: new ProjectRepository(database), exportRoot });
    await run.initialize('cli-fixture');
    const snapshot = await run.runAll();
    console.log(JSON.stringify({ runId: snapshot.runId, status: snapshot.status, versionId: snapshot.currentVersion.id, exportDirectory: snapshot.exportManifest?.directory, routes: snapshot.exportManifest?.routes }, null, 2));
    if (snapshot.status !== 'succeeded') process.exitCode = 1;
  } finally { database.sqlite.close(); }
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Fixture run failed.'); process.exitCode = 1; });
