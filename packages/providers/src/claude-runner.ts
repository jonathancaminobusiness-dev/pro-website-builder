import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { ZodError } from 'zod';
import { agentResultSchema, documentPathSchemas, documentRules, idempotencyKey, stageResultJsonSchemas, visualPropKeys, type AgentResult, type AgentTask } from '@pwb/domain';
import type { ClaudeExecutor, ClaudeRunnerOptions, ModelProvider } from './model.js';

const execFileAsync = promisify(execFile);
const deniedTools = 'Bash Read Write Edit Glob Grep WebFetch WebSearch Task TodoWrite NotebookEdit';
export const CLAUDE_RUNNER_TIMEOUT_MS = 7 * 60_000;

const executeClaude: ClaudeExecutor = async (executable, args, options) => {
  const { stdout, stderr } = await execFileAsync(executable, args, {
    shell: false,
    timeout: options.timeoutMs,
    ...(options.signal ? { signal: options.signal } : {}),
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  return { stdout, stderr };
};

export class ClaudeRunner implements ModelProvider {
  private readonly options: Required<ClaudeRunnerOptions>;

  constructor(options: ClaudeRunnerOptions = {}) {
    this.options = { executable: 'claude', timeoutMs: CLAUDE_RUNNER_TIMEOUT_MS, maxTurns: 4, execute: executeClaude, ...options };
  }

  async propose(task: AgentTask, signal?: AbortSignal): Promise<AgentResult> {
    let correction = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const prompt = [
          task.brief,
          `Answer as the ${task.role} of the ${task.stage} stage for taskId ${task.id}.`,
          `A proposal must set baseVersionId to ${task.baseVersionId} and may only touch these paths: ${task.allowedPaths.join(', ')}.`,
          `A page node may only declare these props: ${[...visualPropKeys].join(', ')} and text.`,
          `The gate also enforces rules the JSON Schema cannot state, and rejects a proposal that breaks any of them: ${Object.values(documentRules).join(' ')}`,
          `Every operation value must match the JSON Schema of the document subtree it writes: ${JSON.stringify(Object.fromEntries(task.allowedPaths.filter((path) => path in documentPathSchemas).map((path) => [path, documentPathSchemas[path]])))}`,
          `This is the immutable slice of the current document you may read; the identity contract is read-only: ${JSON.stringify(task.documentSlice)}`,
          correction ? 'Correct the previous schema violation and return only JSON matching the supplied schema.' : '',
        ].filter(Boolean).join('\n');
        const { stdout } = await this.options.execute(this.options.executable, [
          '-p', prompt, '--output-format', 'json', '--json-schema', JSON.stringify(stageResultJsonSchemas[task.stage]),
          '--session-id', randomUUID(), '--no-session-persistence', '--max-turns', String(this.options.maxTurns),
          '--disallowed-tools', deniedTools,
        ], { timeoutMs: this.options.timeoutMs, ...(signal ? { signal } : {}) });
        const raw: unknown = JSON.parse(stdout);
        const structured = raw && typeof raw === 'object' && 'structured_output' in raw ? (raw as { structured_output: unknown }).structured_output : raw;
        const result = agentResultSchema.parse(structured);
        return result.proposal ? { ...result, proposal: { ...result.proposal, idempotencyKey: idempotencyKey(task) } } : result;
      } catch (error) {
        const details = error as { code?: unknown; signal?: unknown; killed?: unknown; name?: unknown };
        const code = details.code === undefined ? '' : String(details.code);
        if (code === 'ABORT_ERR' || details.name === 'AbortError') throw error;
        const signal = details.signal === undefined || details.signal === null ? '' : String(details.signal);
        if (signal || details.killed === true) return { taskId: task.id, status: 'failed', summary: `The Claude Code process was terminated by ${signal || 'a timeout'}.`, errorCode: signal || 'TIMEOUT' };
        if (error instanceof SyntaxError || error instanceof ZodError) {
          if (!correction) { correction = true; continue; }
          return { taskId: task.id, status: 'needs_review', summary: 'Claude returned an invalid structured proposal.', errorCode: 'SCHEMA_INVALID' };
        }
        return { taskId: task.id, status: 'failed', summary: `The Claude Code process failed with ${code || 'an unknown error'}.`, errorCode: code || 'PROCESS_FAILED' };
      }
    }
    return { taskId: task.id, status: 'failed', summary: 'Claude process did not complete.', errorCode: 'RUNNER_EXHAUSTED' };
  }
}
