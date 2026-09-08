import { idempotencyKey, type AgentResult, type AgentTask, type IdentitySpec } from '@pwb/domain';
import type { ModelProvider } from './model.js';

export class FakeModelProvider implements ModelProvider {
  async propose(task: AgentTask, signal?: AbortSignal): Promise<AgentResult> {
    if (signal?.aborted) throw new DOMException('The task was cancelled.', 'AbortError');
    const identity = task.documentSlice['/identity'] as IdentitySpec;
    return {
      taskId: task.id,
      status: 'succeeded',
      summary: `Deterministic ${task.stage} proposal`,
      proposal: {
        operations: [{ op: 'replace', path: '/reviewRecord/findings', value: [`${task.stage} proposal accepted for ${identity.meta.id}`] }],
        baseVersionId: task.baseVersionId,
        touchedPaths: ['/reviewRecord/findings'],
        rationale: `Fixture ${task.role} produces a typed proposal for ${task.stage}.`,
        confidence: 1,
        stage: task.stage,
        role: task.role,
        idempotencyKey: idempotencyKey(task),
      },
    };
  }
}
