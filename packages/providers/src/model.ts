import { type AgentResult, type AgentTask } from '@pwb/domain';

export interface ModelProvider {
  propose(task: AgentTask, signal?: AbortSignal): Promise<AgentResult>;
}

export interface ClaudeRunnerOptions {
  executable?: string;
  timeoutMs?: number;
  maxTurns?: number;
  execute?: ClaudeExecutor;
}

export interface ClaudeExecutorOptions {
  signal?: AbortSignal;
  timeoutMs: number;
}

export type ClaudeExecutor = (executable: string, args: string[], options: ClaudeExecutorOptions) => Promise<{ stdout: string; stderr: string }>;
