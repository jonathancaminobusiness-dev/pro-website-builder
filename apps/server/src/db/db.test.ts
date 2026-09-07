import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFixtureIR } from '@pwb/domain';
import { openDatabase, ProjectRepository, scanSecrets } from './repository.js';

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
