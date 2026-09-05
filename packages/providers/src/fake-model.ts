import { hashJson, type AgentResult, type AgentTask } from '@pwb/domain';
import type { ModelProvider } from './model.js';

export class FakeModelProvider implements ModelProvider {
  async propose(task: AgentTask, signal?: AbortSignal): Promise<AgentResult> {
    if (signal?.aborted) throw new DOMException('The task was cancelled.', 'AbortError');
    return {
      taskId: task.id,
      status: 'succeeded',
      summary: `Deterministic ${task.stage} proposal`,
      proposal: {
        op: 'proposal',
        operations: [{ op: 'replace', path: '/reviewRecord/findings', value: [`${task.stage} proposal accepted`] }],
        baseVersionId: task.baseVersionId,
        touchedPaths: ['/reviewRecord/findings'],
        rationale: `Fixture ${task.role} produces a typed proposal for ${task.stage}.`,
        confidence: 1,
        stage: task.stage,
        role: task.role,
        idempotencyKey: hashJson([task.stage, task.role, task.baseVersionId, task.inputDigest, task.promptVersion, task.modelAlias]),
      },
    };
  }
}
