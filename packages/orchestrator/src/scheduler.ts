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

    const limits = { claude: this.maxActiveClaude, raster: this.maxActiveRaster };
    const active = { claude: 0, raster: 0 };
    const laneOf = (task: AgentTask): 'claude' | 'raster' => task.lane === 'raster' ? 'raster' : 'claude';
    const running = new Set<Promise<void>>();
    const pending = [...tasks];

    while (pending.length > 0 || running.size > 0) {
      let started = false;
      for (let index = 0; index < pending.length;) {
        const task = pending[index]!;
        const lane = laneOf(task);
        if (active[lane] < limits[lane]) {
          pending.splice(index, 1);
          active[lane] += 1;
          const promise = runOne(task).then(() => { active[lane] -= 1; running.delete(promise); });
          running.add(promise);
          started = true;
          continue;
        }
        index += 1;
      }
      if (!started && running.size === 0) {
        for (const task of pending.splice(0)) results.push({ task: { ...task, state: 'cancelled' }, state: 'cancelled' });
        break;
      }
      if (running.size > 0) await Promise.race([...running]);
    }
    options.signal?.removeEventListener('abort', relay);
    return { results, cancelled: controller.signal.aborted };
  }
}
