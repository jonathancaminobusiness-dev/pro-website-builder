import type { AgentTask } from '@pwb/domain';

export interface SchedulerOptions { maxActiveClaude?: number; maxActiveRaster?: number; }
export interface ScheduleResult<T> { results: Array<{ task: AgentTask; value?: T; error?: unknown; state: AgentTask['state'] }>; cancelled: boolean; }

export class DeadlineExceededError extends Error {
  constructor(public readonly taskId: string, public readonly deadlineMs: number) { super(`Task ${taskId} exceeded its ${deadlineMs}ms deadline.`); this.name = 'DeadlineExceededError'; }
}

export class Scheduler {
  readonly maxActiveClaude: number;
  readonly maxActiveRaster: number;
  constructor(options: SchedulerOptions = {}) { this.maxActiveClaude = options.maxActiveClaude ?? 3; this.maxActiveRaster = options.maxActiveRaster ?? 1; }

  async run<T>(tasks: AgentTask[], worker: (task: AgentTask, signal: AbortSignal) => Promise<T>, options: { signal?: AbortSignal } = {}): Promise<ScheduleResult<T>> {
    const controller = new AbortController();
    const relay = () => controller.abort();
    options.signal?.addEventListener('abort', relay, { once: true });
    const results: ScheduleResult<T>['results'] = [];

    const runOne = async (task: AgentTask): Promise<void> => {
      if (controller.signal.aborted) { results.push({ task: { ...task, state: 'cancelled' }, state: 'cancelled' }); return; }
      const taskController = new AbortController();
      const cascade = () => taskController.abort();
      controller.signal.addEventListener('abort', cascade, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { taskController.abort(); reject(new DeadlineExceededError(task.id, task.deadlineMs)); }, task.deadlineMs);
      });
      try {
        const value = await Promise.race([worker({ ...task, state: 'running' }, taskController.signal), deadline]);
        results.push({ task: { ...task, state: 'succeeded' }, value, state: 'succeeded' });
      } catch (error) {
        const expired = error instanceof DeadlineExceededError;
        const cancelled = !expired && (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError'));
        results.push({ task: { ...task, state: cancelled ? 'cancelled' : 'failed' }, error, state: cancelled ? 'cancelled' : 'failed' });
      } finally {
        if (timer) clearTimeout(timer);
        controller.signal.removeEventListener('abort', cascade);
      }
    };

    const lane = (laneTasks: AgentTask[], limit: number): Promise<void>[] => {
      const queue = [...laneTasks];
      const loop = async () => { for (;;) { const task = queue.shift(); if (!task) return; await runOne(task); } };
      return Array.from({ length: Math.min(limit, Math.max(laneTasks.length, 1)) }, loop);
    };

    await Promise.all([
      ...lane(tasks.filter((task) => task.lane !== 'raster'), this.maxActiveClaude),
      ...lane(tasks.filter((task) => task.lane === 'raster'), this.maxActiveRaster),
    ]);
    options.signal?.removeEventListener('abort', relay);
    return { results, cancelled: controller.signal.aborted };
  }
}
