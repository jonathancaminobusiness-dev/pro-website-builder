import { type AgentResult, type AgentTask } from '@pwb/domain';

export interface ModelProvider {
  propose(task: AgentTask, signal?: AbortSignal): Promise<AgentResult>;
}

export interface ClaudeRunnerOptions {
  executable?: string;
  timeoutMs?: number;
  maxTurns?: number;
  maxOutputTokens?: number;
}
