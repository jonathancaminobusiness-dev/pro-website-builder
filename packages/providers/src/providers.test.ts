import { describe, expect, it } from 'vitest';
import { createFixtureIR } from '@pwb/domain';
import { FakeModelProvider, FakeRasterProvider, HiggsfieldMcpProvider, idempotencyKey } from './index.js';

describe('providers', () => {
  it('returns typed deterministic proposals from the fake model', async () => {
    const provider = new FakeModelProvider();
    const result = await provider.propose({ id: 'task-1', stage: 'identity', role: 'director', state: 'queued', baseVersionId: 'v0', inputDigest: 'brief', promptVersion: '1', modelAlias: 'fake', deadlineMs: 5000, allowedPaths: ['/reviewRecord'], brief: 'fixture' });
    expect(result.status).toBe('succeeded');
    expect(result.proposal?.baseVersionId).toBe('v0');
    expect(result.proposal?.operations[0]?.path).toBe('/reviewRecord/findings');
  });

  it('deduplicates raster jobs and marks missing Higgsfield setup', async () => {
    const job = { id: 'asset-job', digest: 'digest', prompt: 'paper texture', model: 'higgsfield', aspect: '1:1', identityVersionId: 'v0' };
    const fake = new FakeRasterProvider();
    expect((await fake.submit(job)).status).toBe('succeeded');
    expect((await fake.submit(job)).id).toBe((await fake.submit(job)).id);
    expect((await new HiggsfieldMcpProvider({ configured: false }).submit(job)).status).toBe('not_configured');
  });

  it('derives an idempotency key without including credentials', () => {
    const key = idempotencyKey({ stage: 'identity', role: 'director', baseVersionId: 'v0', inputDigest: 'brief', promptVersion: '1', modelAlias: 'fake' });
    expect(key).toHaveLength(64);
    expect(key).not.toMatch(/token|secret|key/i);
    expect(createFixtureIR().meta.projectId).toBe('fixture-project');
  });
});
