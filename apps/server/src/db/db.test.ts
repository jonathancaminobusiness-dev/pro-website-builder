import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createFixtureIR, hashJson } from '@pwb/domain';
import { openDatabase, ProjectRepository, scanSecrets, SCHEMA_VERSION } from './repository.js';

describe('sqlite persistence', () => {
  it('uses WAL, stores immutable versions, and appends events in order', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pwb-db-'));
    const db = openDatabase(join(dir, 'phase0.sqlite'));
    expect((db.sqlite.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode.toLowerCase()).toBe('wal');
    const repo = new ProjectRepository(db);
    await repo.createProject({ id: 'project-1', name: 'Fixture' });
    const ir = createFixtureIR();
    await repo.saveVersion({ id: 'v0', projectId: 'project-1', hash: 'hash-v0', ir });
    const versions = (JSON.parse(repo.dump()) as { versions: Array<{ id: string; ir: string }> }).versions;
    expect(JSON.parse(versions[0]!.ir).meta.projectId).toBe('fixture-project');
    await expect(repo.saveVersion({ id: 'v0', projectId: 'project-1', hash: 'hash-v0', ir })).rejects.toThrow();
    await repo.appendEvent({ id: 'event-1', runId: 'run-1', type: 'started', payload: { safe: true } });
    await repo.appendEvent({ id: 'event-2', runId: 'run-1', type: 'finished', payload: { safe: true } });
    expect((await repo.listEvents('run-1')).map((event) => event.id)).toEqual(['event-1', 'event-2']);
    db.sqlite.close();
  });

  it('moves the briefing and the conversation of an execution in one transaction, or neither', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pwb-conversation-tx-'));
    const db = openDatabase(join(dir, 'conversation.sqlite'));
    const repo = new ProjectRepository(db);
    await repo.createProject({ id: 'project-conversa', name: 'Fixture' });
    await repo.createRun({ id: 'run-conversa', projectId: 'project-conversa', briefing: 'Briefing inicial.' });
    await repo.saveConversation('run-conversa', '{"state":"confirmation"}');

    await repo.saveConversation('run-conversa', '{"state":"final"}', 'Briefing confirmado.');
    const moved = await repo.getRun('run-conversa');
    expect(moved?.briefing).toBe('Briefing confirmado.');
    expect(moved?.conversation).toBe('{"state":"final"}');

    // The briefing column is NOT NULL, so this write fails after the
    // conversation statement already ran inside the transaction.
    await expect(repo.saveConversation('run-conversa', '{"state":"perdido"}', null as unknown as string)).rejects.toThrow();

    const unchanged = await repo.getRun('run-conversa');
    expect(unchanged?.briefing).toBe('Briefing confirmado.');
    expect(unchanged?.conversation).toBe('{"state":"final"}');
    db.sqlite.close();
  });

  it('rebuilds the tasks table when a database written before the attempt key is opened', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pwb-legacy-'));
    const file = join(dir, 'legacy.sqlite');
    const legacy = new Database(file);
    legacy.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY NOT NULL, run_id TEXT NOT NULL, stage TEXT NOT NULL, role TEXT NOT NULL, state TEXT NOT NULL, base_version_id TEXT NOT NULL, payload TEXT NOT NULL);');
    legacy.exec('CREATE TABLE runs (id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL);');
    legacy.exec('CREATE TABLE assets (id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, provenance TEXT NOT NULL);');
    legacy.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?)').run('task-identity', 'run-old', 'identity', 'director', 'queued', 'v0', '{}');
    legacy.close();
    const db = openDatabase(file);
    const repo = new ProjectRepository(db);
    const task = { id: 'task-identity', attempt: 2, stage: 'identity' as const, role: 'director' as const, state: 'queued' as const, lane: 'claude' as const, baseVersionId: 'v1', inputDigest: 'digest', promptVersion: '1', modelAlias: 'fake', deadlineMs: 1000, allowedPaths: ['/reviewRecord'], documentSlice: { '/identity': createFixtureIR().identity }, brief: 'fixture' };
    await repo.createRun({ id: 'run-new', projectId: 'project-1' });
    await repo.saveTask(task, 'run-new');
    const tasks = (JSON.parse(repo.dump()) as { tasks: Array<{ id: string; run_id: string; attempt: number }> }).tasks;
    expect(tasks.map((row) => [row.id, row.run_id, row.attempt])).toEqual([['task-identity', 'run-new', 2]]);
    expect((db.sqlite.pragma('user_version') as Array<{ user_version: number }>)[0]?.user_version).toBe(SCHEMA_VERSION);
    expect(Object.keys(JSON.parse(repo.dump()) as Record<string, unknown>)).not.toContain('assets');
    db.sqlite.close();
  });

  it('renames the imagery sources of a database written before the vocabulary closed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pwb-imagery-'));
    const file = join(dir, 'v2.sqlite');
    const seeding = openDatabase(file);
    const ir = createFixtureIR();
    // A genuine version-2 row predates strategy.evidence, direction.rejectedAlternatives
    // and identity.decisions, which this build defaults in when it parses the row.
    const stored = (id: string, allowedSources: string[]): void => {
      const identity = structuredClone(ir.identity) as Record<string, unknown> & { strategy: Record<string, unknown>; direction: Record<string, unknown>; imagery: Record<string, unknown> };
      delete identity.decisions;
      delete identity.strategy.evidence;
      delete identity.direction.rejectedAlternatives;
      identity.imagery = { ...identity.imagery, allowedSources };
      const document = { ...ir, identity };
      seeding.sqlite.prepare('INSERT INTO versions VALUES (?, ?, ?, ?, ?, ?)').run(id, 'fixture-project', null, hashJson(document), JSON.stringify(document), new Date().toISOString());
    };
    stored('v-raster', ['manual', 'higgsfield']);
    stored('v-unknown', ['midjourney']);
    stored('v-current', ['higgsfield-mcp']);
    seeding.sqlite.pragma('user_version = 2');
    seeding.sqlite.close();

    const upgraded = openDatabase(file);
    const repo = new ProjectRepository(upgraded);
    const versions = await repo.listVersions('fixture-project');
    // Every row is still there, and every document parses again: the raster
    // source under its new name, and one this build cannot generate from as
    // `manual`.
    expect(versions.map((version) => [version.id, version.ir.identity.imagery.allowedSources])).toEqual([
      ['v-raster', ['manual', 'higgsfield-mcp']],
      ['v-unknown', ['manual']],
      ['v-current', ['higgsfield-mcp']],
    ]);
    // A rewritten row's hash describes the document a reader gets back, not the raw
    // bytes the migration happened to write, so a captain decision cannot be recorded
    // against a document that no longer exists.
    expect(versions.filter((version) => version.id !== 'v-current').map((version) => [version.id, version.hash === hashJson(version.ir)])).toEqual([
      ['v-raster', true],
      ['v-unknown', true],
    ]);
    upgraded.sqlite.close();
  });

  it('records captain decisions in order for a project', async () => {
    const db = openDatabase(':memory:');
    const repo = new ProjectRepository(db);
    await repo.createProject({ id: 'project-1', name: 'Fixture' });
    await repo.createApproval({ id: 'approval-1', runId: 'run-1', projectId: 'project-1', stage: 'identity', approverRole: 'captain', versionId: 'v0', versionHash: 'hash-v0', decision: 'rejected', rationale: 'Captain asked for a revision' });
    await repo.createApproval({ id: 'approval-2', runId: 'run-1', projectId: 'project-1', stage: 'identity', approverRole: 'captain', versionId: 'v1', versionHash: 'hash-v1', decision: 'approved', rationale: 'Captain approved' });
    const approvals = (JSON.parse(repo.dump()) as { approvals: Array<{ id: string; stage: string; decision: string }> }).approvals;
    expect(approvals.map((approval) => [approval.id, approval.stage, approval.decision])).toEqual([
      ['approval-1', 'identity', 'rejected'],
      ['approval-2', 'identity', 'approved'],
    ]);
    db.sqlite.close();
  });

  it('detects secret-like values in persisted text without inspecting native login state', () => {
    expect(scanSecrets('{"password":"x"}')).toContain('password');
    expect(scanSecrets('{"token":"sk-ant-example"}')).toContain('token');
    expect(scanSecrets('{"brief":"Toda escolha tem motivo."}')).toEqual([]);
  });
});
