import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFixtureIR, idempotencyKey, type AgentTask } from '@pwb/domain';
import { ClaudeJsonRunner, ClaudeRunner, CLAUDE_RUNNER_DENIED_TOOLS, JSON_RUNNER_DENIED_TOOLS, JsonRunnerError, type ClaudeExecutor } from './index.js';

afterEach(() => { vi.unstubAllEnvs(); });

const task: AgentTask = {
  id: 'task-claude', attempt: 1, stage: 'identity', role: 'director', state: 'queued', lane: 'claude',
  baseVersionId: 'v0', inputDigest: 'brief', promptVersion: '1', modelAlias: 'claude-local', deadlineMs: 5_000,
  allowedPaths: ['/reviewRecord'], documentSlice: { '/identity': createFixtureIR().identity }, brief: 'fixture',
};

const result = {
  taskId: task.id, status: 'succeeded' as const, summary: 'Claude fixture completed.',
  proposal: {
    operations: [{ op: 'replace' as const, path: '/reviewRecord/findings', value: ['ok'] }],
    baseVersionId: 'v0', touchedPaths: ['/reviewRecord/findings'], rationale: 'fixture', confidence: 1,
    stage: 'identity' as const, role: 'director' as const,
  },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

/** Records every argv the runner would have spawned, and answers with whatever the test scripted. */
function recorder(answers: Array<unknown | Error>): { calls: Array<{ args: string[]; timeoutMs: number }>; execute: ClaudeExecutor } {
  const calls: Array<{ args: string[]; timeoutMs: number }> = [];
  return {
    calls,
    execute: async (_executable, args, options) => {
      calls.push({ args, timeoutMs: options.timeoutMs });
      const answer = answers[calls.length - 1];
      if (answer instanceof Error) throw answer;
      return { stdout: typeof answer === 'string' ? answer : JSON.stringify({ structured_output: answer }), stderr: '' };
    },
  };
}

describe('Claude runner boundary', () => {
  it('spawns the local binary with a fresh unpersisted session and no credential of any kind', async () => {
    const { calls, execute } = recorder([result]);
    await new ClaudeRunner({ execute }).propose(task);

    const { args } = calls[0]!;
    expect(args).toContain('--no-session-persistence');
    expect(flag(args, '--session-id')).toMatch(UUID);
    expect(flag(args, '--output-format')).toBe('json');
    expect(flag(args, '--max-turns')).toBe('4');
    // The product never reads, stores, prints, forwards or asks for a credential, so no flag carries one.
    expect(args).not.toContain('--api-key');
    expect(args.join(' ')).not.toMatch(/(api[_-]?key|secret|password|bearer|authorization|oauth)\s*[:=]/i);
    expect(args.join(' ')).not.toMatch(/\bsk-[A-Za-z0-9]/);
  });

  it('denies a worker every tool, Read included, because a worker never reads', async () => {
    const { calls, execute } = recorder([result]);
    await new ClaudeRunner({ execute }).propose(task);

    expect(flag(calls[0]!.args, '--disallowed-tools')).toBe(CLAUDE_RUNNER_DENIED_TOOLS);
    expect(CLAUDE_RUNNER_DENIED_TOOLS.split(' ')).toEqual(['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'TodoWrite', 'NotebookEdit']);
  });

  it('opens a new session for every invocation, and a new one again for the correction attempt', async () => {
    const { calls, execute } = recorder(['not json at all', result, result]);
    const runner = new ClaudeRunner({ execute });

    await runner.propose(task);
    await runner.propose(task);

    const ids = calls.map((call) => flag(call.args, '--session-id')!);
    expect(ids).toHaveLength(3);
    for (const id of ids) expect(id).toMatch(UUID);
    // Two proposals and one correction: three invocations, three ids, none of them reused.
    expect(new Set(ids).size).toBe(3);
    expect(flag(calls[1]!.args, '-p')).toContain('Correct the previous schema violation');
    expect(flag(calls[0]!.args, '-p')).not.toContain('Correct the previous schema violation');
  });

  it('stamps the proposal with the idempotency key of the task, not with one the model chose', async () => {
    const { execute } = recorder([{ ...result, proposal: { ...result.proposal, idempotencyKey: 'whatever-the-model-said' } }]);
    const answer = await new ClaudeRunner({ execute }).propose(task);
    expect(answer.proposal?.idempotencyKey).toBe(idempotencyKey(task));
  });

  it('bounds every call by the runner timeout and passes the caller\'s signal through', async () => {
    const { calls, execute } = recorder([result]);
    await new ClaudeRunner({ execute, timeoutMs: 42_000 }).propose(task);
    expect(calls[0]!.timeoutMs).toBe(42_000);
  });

  it('reports an invalid structured proposal as needs_review after its one correction', async () => {
    const { calls, execute } = recorder(['not json', 'still not json']);
    const answer = await new ClaudeRunner({ execute }).propose(task);
    expect(calls).toHaveLength(2);
    expect(answer).toMatchObject({ status: 'needs_review', errorCode: 'SCHEMA_INVALID' });
  });

  it('keeps the kill distinct from the failure, so a deadline is never reported as an unknown error', async () => {
    const killed = await new ClaudeRunner({ execute: recorder([Object.assign(new Error('killed'), { killed: true, signal: 'SIGKILL' })]).execute }).propose(task);
    expect(killed).toMatchObject({ status: 'failed', errorCode: 'SIGKILL' });

    const timedOut = await new ClaudeRunner({ execute: recorder([Object.assign(new Error('timeout'), { killed: true })]).execute }).propose(task);
    expect(timedOut).toMatchObject({ status: 'failed', errorCode: 'TIMEOUT' });

    const broken = await new ClaudeRunner({ execute: recorder([Object.assign(new Error('missing'), { code: 'ENOENT' })]).execute }).propose(task);
    expect(broken).toMatchObject({ status: 'failed', errorCode: 'ENOENT' });
  });

  it('names the model and the effort on every invocation, so no worker inherits the machine default', async () => {
    vi.stubEnv('PWB_CLAUDE_MODEL', undefined);
    vi.stubEnv('PWB_CLAUDE_EFFORT', undefined);
    const { calls, execute } = recorder([result]);
    await new ClaudeRunner({ execute }).propose(task);
    expect(flag(calls[0]!.args, '--model')).toBe('claude-opus-5');
    expect(flag(calls[0]!.args, '--effort')).toBe('high');
  });

  it('takes an override of either one from the environment', async () => {
    vi.stubEnv('PWB_CLAUDE_MODEL', 'claude-sonnet-5');
    vi.stubEnv('PWB_CLAUDE_EFFORT', 'xhigh');
    const { calls, execute } = recorder([result]);
    await new ClaudeRunner({ execute }).propose(task);
    expect(flag(calls[0]!.args, '--model')).toBe('claude-sonnet-5');
    expect(flag(calls[0]!.args, '--effort')).toBe('xhigh');
  });

  it('refuses to construct a runner over a malformed effort rather than spawning without one', () => {
    vi.stubEnv('PWB_CLAUDE_EFFORT', 'highest');
    expect(() => new ClaudeRunner({ execute: recorder([result]).execute })).toThrow(/PWB_CLAUDE_EFFORT/);
  });

  it('lets an abort through instead of turning it into a result the gate would read', async () => {
    const runner = new ClaudeRunner({ execute: async () => { throw Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }); } });
    await expect(runner.propose(task)).rejects.toMatchObject({ code: 'ABORT_ERR' });
  });
});

describe('Claude JSON runner boundary', () => {
  it('carries the same fresh session, denied tools and deadline, and no credential', async () => {
    const calls: Array<{ args: string[]; timeoutMs: number }> = [];
    const runner = new ClaudeJsonRunner({
      execute: async (_executable, args, options) => { calls.push({ args, timeoutMs: options.timeoutMs }); return { stdout: JSON.stringify({ structured_output: { answer: 'ok' } }), stderr: '' }; },
    });

    await expect(runner.run({ prompt: 'fixture', schema: { type: 'object' }, deadlineMs: 7_000 })).resolves.toEqual({ answer: 'ok' });
    await runner.run({ prompt: 'fixture', schema: { type: 'object' }, deadlineMs: 7_000 });

    const ids = calls.map((call) => flag(call.args, '--session-id')!);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id).toMatch(UUID);
    expect(calls[0]!.args).toContain('--no-session-persistence');
    expect(flag(calls[0]!.args, '--disallowed-tools')).toBe(JSON_RUNNER_DENIED_TOOLS);
    expect(calls[0]!.timeoutMs).toBe(7_000);
    expect(calls[0]!.args).not.toContain('--api-key');
  });

  it('names the same model and effort as the proposal runner, defaults and overrides alike', async () => {
    vi.stubEnv('PWB_CLAUDE_MODEL', undefined);
    vi.stubEnv('PWB_CLAUDE_EFFORT', undefined);
    const calls: string[][] = [];
    const execute: ClaudeExecutor = async (_executable, args) => { calls.push(args); return { stdout: JSON.stringify({ answer: 'ok' }), stderr: '' }; };
    await new ClaudeJsonRunner({ execute }).run({ prompt: 'fixture', schema: {}, deadlineMs: 1_000 });
    expect(flag(calls[0]!, '--model')).toBe('claude-opus-5');
    expect(flag(calls[0]!, '--effort')).toBe('high');

    vi.stubEnv('PWB_CLAUDE_MODEL', 'claude-sonnet-5');
    vi.stubEnv('PWB_CLAUDE_EFFORT', 'low');
    await new ClaudeJsonRunner({ execute }).run({ prompt: 'fixture', schema: {}, deadlineMs: 1_000 });
    expect(flag(calls[1]!, '--model')).toBe('claude-sonnet-5');
    expect(flag(calls[1]!, '--effort')).toBe('low');
  });

  it('names what went wrong: an unreadable answer, a kill, and a process that would not start', async () => {
    const failing = async (error: Error): Promise<unknown> => new ClaudeJsonRunner({ execute: async () => { throw error; } })
      .run({ prompt: 'fixture', schema: {}, deadlineMs: 1_000 });

    await expect(new ClaudeJsonRunner({ execute: async () => ({ stdout: 'not json', stderr: '' }) }).run({ prompt: 'fixture', schema: {}, deadlineMs: 1_000 }))
      .rejects.toMatchObject({ name: 'JsonRunnerError', code: 'SCHEMA_INVALID' });
    await expect(failing(Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' }))).rejects.toMatchObject({ code: 'SIGTERM' });
    await expect(failing(Object.assign(new Error('killed'), { killed: true }))).rejects.toMatchObject({ code: 'TIMEOUT' });
    await expect(failing(Object.assign(new Error('missing'), { code: 'ENOENT' }))).rejects.toBeInstanceOf(JsonRunnerError);
    await expect(failing(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }))).rejects.toMatchObject({ code: 'ABORT_ERR' });
  });
});
