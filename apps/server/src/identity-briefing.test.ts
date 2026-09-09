import Database from 'better-sqlite3';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IDENTITY_BRIEFING } from './identity-briefing.js';
import { openDatabase, ProjectRepository } from './db/repository.js';

describe('briefing migration', () => {
  it('adds the briefing column to a v3 database and supplies the legacy default', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pwb-briefing-migration-'));
    const file = join(directory, 'legacy.sqlite');
    const legacy = new Database(file);
    legacy.exec("CREATE TABLE runs (id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, created_at TEXT NOT NULL);");
    legacy.prepare('INSERT INTO runs VALUES (?, ?, ?)').run('old-run', 'fixture-project', new Date().toISOString());
    legacy.pragma('user_version = 3');
    legacy.close();

    const database = openDatabase(file);
    const repository = new ProjectRepository(database);
    const columns = database.sqlite.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>;

    expect(columns.map((column) => column.name)).toContain('briefing');
    expect((await repository.getRun('old-run'))?.briefing).toBe(IDENTITY_BRIEFING);
    expect((database.sqlite.pragma('user_version') as Array<{ user_version: number }>)[0]?.user_version).toBe(4);
    database.sqlite.close();
  });
});
