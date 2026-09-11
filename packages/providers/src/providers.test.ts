import { describe, expect, it } from 'vitest';
import { createFixtureIR, idempotencyKey } from '@pwb/domain';
import { CLAUDE_RUNNER_TIMEOUT_MS, ClaudeJsonRunner, FakeModelProvider, HiggsfieldMcpProvider } from './index.js';

describe('providers', () => {
  it('returns typed deterministic proposals from the fake model', async () => {
    const provider = new FakeModelProvider();
    const result = await provider.propose({ id: 'task-1', attempt: 1, stage: 'identity', role: 'director', state: 'queued', lane: 'claude', baseVersionId: 'v0', inputDigest: 'brief', promptVersion: '1', modelAlias: 'fake', deadlineMs: 5000, allowedPaths: ['/reviewRecord'], documentSlice: { '/identity': createFixtureIR().identity }, brief: 'fixture' });
    expect(result.status).toBe('succeeded');
    expect(result.proposal?.baseVersionId).toBe('v0');
    expect(result.proposal?.operations[0]?.path).toBe('/reviewRecord/findings');
    expect(result.proposal?.operations[0]?.value).toEqual(['identity proposal accepted for fixture-identity']);
  });

  it('marks missing Higgsfield setup and forwards the idempotency digest when configured', async () => {
    const job = { id: 'asset-job', digest: 'digest', prompt: 'paper texture', model: 'higgsfield', aspect: '1:1', identityVersionId: 'v0' };
    const unconfigured = await new HiggsfieldMcpProvider({ configured: false }).submit(job);
    expect(unconfigured.status).toBe('not_configured');
    expect(unconfigured.provenance.status).toBe('not_configured');
    const calls: Array<Record<string, unknown>> = [];
    const configured = new HiggsfieldMcpProvider({ configured: true, transport: { callTool: async (_name, arguments_) => { calls.push(arguments_); return { uri: 'higgsfield://asset', license: 'provider terms' }; } } });
    const generated = await configured.submit(job);
    expect(generated.status).toBe('succeeded');
    expect(generated.provenance).toMatchObject({ prompt: 'paper texture', model: 'higgsfield', license: 'provider terms', identityVersionId: 'v0' });
    expect(calls).toEqual([{ prompt: 'paper texture', model: 'higgsfield', aspect: '1:1', idempotency_key: 'digest' }]);
  });

  it('derives an idempotency key without including credentials', async () => {
    const key = idempotencyKey({ stage: 'identity', role: 'director', baseVersionId: 'v0', inputDigest: 'brief', promptVersion: '1', modelAlias: 'fake' });
    const proposed = await new FakeModelProvider().propose({ id: 'task-1', attempt: 1, stage: 'identity', role: 'director', state: 'queued', lane: 'claude', baseVersionId: 'v0', inputDigest: 'brief', promptVersion: '1', modelAlias: 'fake', deadlineMs: 5000, allowedPaths: ['/reviewRecord'], documentSlice: { '/identity': createFixtureIR().identity }, brief: 'fixture' });
    expect(proposed.proposal?.idempotencyKey).toBe(key);
    expect(key).toHaveLength(64);
    expect(key).not.toMatch(/token|secret|key/i);
    expect(createFixtureIR().meta.projectId).toBe('fixture-project');
  });
});

describe('ClaudeJsonRunner invocation cap', () => {
  function recordingRunner(options: { timeoutMs?: number } = {}): { runner: ClaudeJsonRunner; calls: number[] } {
    const calls: number[] = [];
    const runner = new ClaudeJsonRunner({
      ...options,
      execute: async (_executable, _args, execution) => { calls.push(execution.timeoutMs); return { stdout: '{"answer":"ok"}', stderr: '' }; },
    });
    return { runner, calls };
  }

  it('caps one invocation at the claude timeout even when the remaining deadline is longer', async () => {
    const { runner, calls } = recordingRunner();
    await runner.run({ prompt: 'fixture', schema: { type: 'object' }, deadlineMs: 30 * 60_000 });
    // The README promises 7 minutes per claude invocation, not the whole stage budget.
    expect(calls).toEqual([CLAUDE_RUNNER_TIMEOUT_MS]);
  });

  it('spends no more than the deadline the caller has left', async () => {
    const { runner, calls } = recordingRunner({ timeoutMs: 7 * 60_000 });
    await runner.run({ prompt: 'fixture', schema: { type: 'object' }, deadlineMs: 30_000 });
    expect(calls).toEqual([30_000]);
  });

  it('honours a configured cap below the default', async () => {
    const { runner, calls } = recordingRunner({ timeoutMs: 90_000 });
    await runner.run({ prompt: 'fixture', schema: { type: 'object' }, deadlineMs: 30 * 60_000 });
    expect(calls).toEqual([90_000]);
  });
});
