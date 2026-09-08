import { access, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createFixtureIR, type AgentTask } from '@pwb/domain';
import { CODEX_MODEL, CODEX_REASONING_EFFORT, CodexJsonRunner, CodexRunner } from './index.js';

const task: AgentTask = {
  id: 'task-codex', attempt: 1, stage: 'identity', role: 'director', state: 'queued', lane: 'claude',
  baseVersionId: 'v0', inputDigest: 'brief', promptVersion: '1', modelAlias: 'codex', deadlineMs: 5_000,
  allowedPaths: ['/reviewRecord'], documentSlice: { '/identity': createFixtureIR().identity }, brief: 'fixture',
};

const result = {
  taskId: task.id, status: 'succeeded' as const, summary: 'Codex fixture completed.',
  proposal: {
    operations: [{ op: 'replace' as const, path: '/reviewRecord/findings', value: ['ok'] }],
    baseVersionId: 'v0', touchedPaths: ['/reviewRecord/findings'], rationale: 'fixture', confidence: 1,
    stage: 'identity' as const, role: 'director' as const,
  },
};

describe('Codex provider', () => {
  it('pins the requested model and normal service and parses the final JSONL message', async () => {
    const calls: { executable: string; args: string[]; cwd: string }[] = [];
    let schemaPath = '';
    const provider = new CodexRunner({
      execute: async (executable, args, options) => {
        calls.push({ executable, args, cwd: options.cwd });
        schemaPath = args[args.indexOf('--output-schema') + 1]!;
        expect(JSON.parse(await readFile(schemaPath, 'utf8'))).toBeTruthy();
        return {
          stdout: `${JSON.stringify({ type: 'thread.started', thread_id: 'fixture' })}\n${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(result) } })}\n`,
          stderr: '',
        };
      },
    });

    await expect(provider.propose(task)).resolves.toMatchObject({ taskId: task.id, status: 'succeeded', proposal: { idempotencyKey: expect.any(String) } });
    const args = calls[0]!.args;
    expect(calls[0]!.executable).toBe('codex');
    expect(args).toEqual(expect.arrayContaining(['exec', '-m', CODEX_MODEL, '-c', `model_reasoning_effort=${CODEX_REASONING_EFFORT}`, '-c', 'service_tier="standard"', '-c', 'features.fast_mode=false', '--sandbox', 'read-only', '--ephemeral', '--json']));
    expect(args).toEqual(expect.arrayContaining(['-m', 'gpt-5.6-sol', '-c', 'model_reasoning_effort=high', '-c', 'service_tier="standard"', '-c', 'features.fast_mode=false']));
    expect(args).not.toContain('features.fast_mode=true');
    expect(args).toContain('--output-schema');
    expect(args).not.toContain('--api-key');
    await expect(access(schemaPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports an actionable error when the Codex CLI is unavailable', async () => {
    const runner = new CodexJsonRunner({ execute: async () => { throw Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }); } });
    await expect(runner.run({ prompt: 'fixture', schema: { type: 'object' }, deadlineMs: 1000 })).rejects.toMatchObject({ code: 'CODEX_UNAVAILABLE' });
  });

  it('reports an actionable error when Codex authentication is missing', async () => {
    const runner = new CodexJsonRunner({ execute: async () => { throw Object.assign(new Error('Codex login required'), { code: 'CODEX_AUTH', stderr: 'Please run codex login.' }); } });
    await expect(runner.run({ prompt: 'fixture', schema: { type: 'object' }, deadlineMs: 1000 })).rejects.toMatchObject({ code: 'CODEX_AUTH_REQUIRED', message: expect.stringMatching(/not authenticated/i) });
  });

  it('surfaces a sign-in failure returned on stderr', async () => {
    const runner = new CodexJsonRunner({ execute: async () => ({ stdout: '', stderr: 'Codex requires ChatGPT sign-in.' }) });
    await expect(runner.run({ prompt: 'fixture', schema: { type: 'object' }, deadlineMs: 1000 })).rejects.toMatchObject({ code: 'CODEX_AUTH_REQUIRED' });
  });

  it('reports a non-auth process failure without echoing stderr', async () => {
    const runner = new CodexJsonRunner({ execute: async () => { throw Object.assign(new Error('Codex failed'), { code: 'EIO', stderr: 'authorization=sk-secret-value' }); } });
    await expect(runner.run({ prompt: 'fixture', schema: { type: 'object' }, deadlineMs: 1000 })).rejects.toMatchObject({ code: 'CODEX_PROCESS_FAILED', message: expect.not.stringContaining('sk-secret-value') });
  });

  it('maps a process timeout and preserves an abort signal', async () => {
    let timeoutMs = 0;
    const timeout = new CodexJsonRunner({ timeoutMs: 10_000, execute: async (_executable, _args, options) => { timeoutMs = options.timeoutMs; throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }); } });
    await expect(timeout.run({ prompt: 'fixture', schema: { type: 'object' }, deadlineMs: 1000 })).rejects.toMatchObject({ code: 'CODEX_TIMEOUT' });
    expect(timeoutMs).toBe(1000);

    const aborted = Object.assign(new Error('aborted'), { code: 'ABORT_ERR', name: 'AbortError' });
    const runner = new CodexJsonRunner({ execute: async () => { throw aborted; } });
    await expect(runner.run({ prompt: 'fixture', schema: { type: 'object' }, deadlineMs: 1000 })).rejects.toBe(aborted);
  });

  it('turns an authentication failure event into a clear login error', async () => {
    const runner = new CodexJsonRunner({ execute: async () => ({ stdout: `${JSON.stringify({ type: 'turn.failed', error: { message: 'Please run codex login.' } })}\n`, stderr: '' }) });
    await expect(runner.run({ prompt: 'fixture', schema: { type: 'object' }, deadlineMs: 1000 })).rejects.toMatchObject({ code: 'CODEX_AUTH_REQUIRED', message: expect.stringMatching(/codex login/i) });
  });

  it('rejects a malformed final message instead of using an earlier answer', async () => {
    const stdout = [
      { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ answer: 'earlier' }) } },
      { type: 'item.completed', item: { type: 'agent_message', text: 'not-json' } },
    ].map((event) => JSON.stringify(event)).join('\n');
    // Exercise the parser through the runner contract without invoking a process.
    const runner = new CodexJsonRunner({ execute: async () => ({ stdout, stderr: '' }) });
    await expect(runner.run({ prompt: 'fixture', schema: { type: 'object' }, deadlineMs: 1000 })).rejects.toMatchObject({ code: 'SCHEMA_INVALID' });
  });
});
