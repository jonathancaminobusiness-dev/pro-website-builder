import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { ZodError } from 'zod';
import { AgentResultSchema, idempotencyKey, schemaJson, type AgentResult, type AgentTask } from '@pwb/domain';
import type { ClaudeRunnerOptions, ModelProvider } from './model.js';

const execFileAsync = promisify(execFile);
const transientCodes = new Set(['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', '429', 'OVERLOADED', 'RATE_LIMIT']);

export class ClaudeRunner implements ModelProvider {
  private readonly options: Required<ClaudeRunnerOptions>;

  constructor(options: ClaudeRunnerOptions = {}) {
    this.options = { executable: 'claude', timeoutMs: 8 * 60_000, maxTurns: 1, ...options };
  }

  async checkAvailable(): Promise<boolean> {
    try {
      await execFileAsync(this.options.executable, ['--version'], { shell: false, timeout: 10_000, windowsHide: true });
      return true;
    } catch { return false; }
  }

  async propose(task: AgentTask, signal?: AbortSignal): Promise<AgentResult> {
    let correction = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const prompt = correction ? `${task.brief}\nReturn only JSON matching the supplied schema. Correct the previous schema violation.` : task.brief;
        const { stdout } = await execFileAsync(this.options.executable, [
          '-p', prompt, '--output-format', 'json', '--json-schema', JSON.stringify(schemaJson.AgentResult),
          '--session-id', randomUUID(), '--no-session-persistence', '--max-turns', String(this.options.maxTurns),
        ], { shell: false, timeout: this.options.timeoutMs, signal, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
        const raw: unknown = JSON.parse(stdout);
        const structured = raw && typeof raw === 'object' && 'structured_output' in raw ? (raw as { structured_output: unknown }).structured_output : raw;
        const result = AgentResultSchema.parse(structured);
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
        if (transientCodes.has(code) && attempt < 2) { await new Promise((resolve) => setTimeout(resolve, 30 * (attempt + 1))); continue; }
        return { taskId: task.id, status: 'failed', summary: `The Claude Code process failed with ${code || 'an unknown error'}.`, errorCode: code || 'PROCESS_FAILED' };
      }
    }
    return { taskId: task.id, status: 'failed', summary: 'Claude process did not complete.', errorCode: 'RUNNER_EXHAUSTED' };
  }
}
