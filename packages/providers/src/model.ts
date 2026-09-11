import { type AgentResult, type AgentTask } from '@pwb/domain';
import type { ClaudeEffort } from './claude-model.js';

export interface ModelProvider {
  propose(task: AgentTask, signal?: AbortSignal): Promise<AgentResult>;
}

export interface ClaudeRunnerOptions {
  executable?: string;
  /** Overrides `PWB_CLAUDE_MODEL`; left unset the environment, then `DEFAULT_CLAUDE_MODEL`, decides. */
  model?: string;
  /** Overrides `PWB_CLAUDE_EFFORT`; left unset the environment, then `DEFAULT_CLAUDE_EFFORT`, decides. */
  effort?: ClaudeEffort;
  timeoutMs?: number;
  maxTurns?: number;
  execute?: ClaudeExecutor;
}

export interface ClaudeExecutorOptions {
  signal?: AbortSignal;
  timeoutMs: number;
}

export type ClaudeExecutor = (executable: string, args: string[], options: ClaudeExecutorOptions) => Promise<{ stdout: string; stderr: string }>;
