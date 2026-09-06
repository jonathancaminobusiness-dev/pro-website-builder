import { hashJson, type AgentTask } from '@pwb/domain';

export interface RunPlan { runId: string; tasks: AgentTask[]; edges: [string, string][]; }

export class RunPlanner {
  plan(runId: string, baseVersionId: string, brief: string): RunPlan {
    const stages: Array<{ stage: AgentTask['stage']; role: AgentTask['role']; deadlineMs: number }> = [
      { stage: 'identity', role: 'director', deadlineMs: 5 * 60_000 },
      { stage: 'prototype', role: 'composer', deadlineMs: 5 * 60_000 },
      { stage: 'finalization', role: 'compiler', deadlineMs: 8 * 60_000 },
    ];
    const tasks = stages.map((item, index) => ({ id: `task-${item.stage}`, ...item, state: 'queued' as const, lane: 'claude' as const, baseVersionId, inputDigest: hashJson({ runId, brief }), promptVersion: 'phase0-v1', modelAlias: 'claude-local', allowedPaths: ['/identity', '/tokens', '/pages', '/assets', '/reviewRecord'], brief }));
    return { runId, tasks, edges: [['task-identity', 'task-prototype'], ['task-prototype', 'task-finalization']] };
  }
}
