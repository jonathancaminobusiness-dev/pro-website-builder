import { ZodError } from 'zod';
import { CodexCliError, CodexJsonRunner, type CodexJsonRunnerOptions, type JsonModelRunner } from '@pwb/providers';
import type { ClaudeAsk, StructuredSession } from './claude-session.js';

export class CodexSessionError extends Error {
  constructor(public readonly errorCode: string, message: string) {
    super(message);
    this.name = 'CodexSessionError';
  }
}

/** One read-only, ephemeral Codex CLI session for a prototype worker. */
export class CodexSession implements StructuredSession {
  private readonly runner: JsonModelRunner;

  constructor(options: CodexJsonRunnerOptions & { runner?: JsonModelRunner } = {}) {
    const { runner, ...runnerOptions } = options;
    this.runner = runner ?? new CodexJsonRunner(runnerOptions);
  }

  async ask<T>(input: ClaudeAsk<T>): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const prompt = attempt === 0 ? input.prompt : `${input.prompt}\n\nYour previous answer did not match the supplied schema. Return only JSON matching it.`;
      const request = { prompt, schema: input.schema, deadlineMs: input.deadlineMs, ...(input.allowlist ? { allowlist: input.allowlist } : {}) };
      try {
        if (this.runner.runValidated) return await this.runner.runValidated(request, input.parse, input.signal);
        return input.parse(await this.runner.run(request, input.signal));
      } catch (error) {
        const details = error as { name?: unknown; code?: unknown };
        if (details.name === 'AbortError' || details.code === 'ABORT_ERR') throw error;
        const schemaProblem = error instanceof ZodError || (error instanceof CodexCliError && error.code === 'SCHEMA_INVALID');
        if (schemaProblem && attempt === 0) continue;
        if (error instanceof CodexCliError) throw new CodexSessionError(error.code, error.message);
        throw new CodexSessionError(schemaProblem ? 'SCHEMA_INVALID' : String(details.code ?? 'PROCESS_FAILED'), schemaProblem ? 'Codex returned an answer that does not match the supplied schema.' : `The Codex process failed with ${String(details.code ?? 'an unknown error')}.`);
      }
    }
    throw new CodexSessionError('RUNNER_EXHAUSTED', 'The Codex session did not produce an answer.');
  }
}
