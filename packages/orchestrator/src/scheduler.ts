import type { AgentTask } from '@pwb/domain';

export interface SchedulerOptions { maxActiveClaude?: number; maxActiveRaster?: number; }
export interface ScheduleResult<T> { results: Array<{ task: AgentTask; value?: T; error?: unknown; state: AgentTask['state'] }>; cancelled: boolean; }

export class Scheduler {
  readonly maxActiveClaude: number;
  readonly maxActiveRaster: number;
  constructor(options: SchedulerOptions = {}) { this.maxActiveClaude = options.maxActiveClaude ?? 3; this.maxActiveRaster = options.maxActiveRaster ?? 1; }

  async run<T>(tasks: AgentTask[], worker: (task: AgentTask, signal: AbortSignal) => Promise<T>, options: { signal?: AbortSignal } = {}): Promise<ScheduleResult<T>> {
    const controller = new AbortController();
    const relay = () => controller.abort();
    options.signal?.addEventListener('abort', relay, { once: true });
    const queue = [...tasks];
    const results: ScheduleResult<T>['results'] = [];
    const take = () => queue.shift();
    const loop = async () => {
      for (;;) {
        const task = take();
        if (!task) return;
        if (controller.signal.aborted) { results.push({ task: { ...task, state: 'cancelled' }, state: 'cancelled' }); continue; }
        try {
          const value = await worker({ ...task, state: 'running' }, controller.signal);
          results.push({ task: { ...task, state: 'succeeded' }, value, state: 'succeeded' });
        } catch (error) {
          const cancelled = controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
          results.push({ task: { ...task, state: cancelled ? 'cancelled' : 'failed' }, error, state: cancelled ? 'cancelled' : 'failed' });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.maxActiveClaude, Math.max(tasks.length, 1)) }, loop));
    options.signal?.removeEventListener('abort', relay);
    return { results, cancelled: controller.signal.aborted };
  }
}
