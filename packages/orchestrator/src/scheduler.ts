import type { AgentTask } from '@pwb/domain';

export interface SchedulerOptions { maxActiveClaude?: number; maxActiveRaster?: number; }
export interface ScheduleResult<T> { results: Array<{ task: AgentTask; value?: T; error?: unknown; state: AgentTask['state'] }>; cancelled: boolean; }
export type GateVerdict = 'approved' | 'rejected' | 'cancelled';
export interface RunOptions<T> {
  signal?: AbortSignal;
  edges?: [string, string][];
  completed?: string[];
  settle?: (task: AgentTask, value: T, signal: AbortSignal) => Promise<GateVerdict>;
}

export class DeadlineExceededError extends Error {
  constructor(public readonly taskId: string, public readonly deadlineMs: number) { super(`Task ${taskId} exceeded its ${deadlineMs}ms deadline.`); this.name = 'DeadlineExceededError'; }
}

/** The plan's concurrency: three simultaneous Claude sessions, one browser at a time. */
export const DEFAULT_MAX_ACTIVE_CLAUDE = 3;
export const DEFAULT_MAX_ACTIVE_RASTER = 1;

/**
 * Rejects as soon as the run is cancelled. Used to bound the settle callback, which is otherwise
 * unbounded: a gate that never resolves would hold scheduler ownership forever and block restart.
 * The worker itself is deliberately not raced against abort - cutting it off mid-flight would
 * abandon an in-progress persist and break the cancel-then-restart integrity guarantee - because
 * its own deadline already bounds it.
 */
function aborted(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_, reject) => {
    const fail = (): void => reject(new DOMException('The run was cancelled.', 'AbortError'));
    if (signal.aborted) { fail(); return; }
    signal.addEventListener('abort', fail, { once: true });
  });
}

export class Scheduler {
  readonly maxActiveClaude: number;
  readonly maxActiveRaster: number;
  constructor(options: SchedulerOptions = {}) { this.maxActiveClaude = options.maxActiveClaude ?? DEFAULT_MAX_ACTIVE_CLAUDE; this.maxActiveRaster = options.maxActiveRaster ?? DEFAULT_MAX_ACTIVE_RASTER; }

  async run<T>(tasks: AgentTask[], worker: (task: AgentTask, signal: AbortSignal) => Promise<T>, options: RunOptions<T> = {}): Promise<ScheduleResult<T>> {
    const controller = new AbortController();
    const relay = () => controller.abort();
    options.signal?.addEventListener('abort', relay, { once: true });
    const results: ScheduleResult<T>['results'] = [];
    const succeeded = new Set<string>();
    const completed = new Set(options.completed ?? []);
    const ids = new Set(tasks.map((task) => task.id));
    const dependencies = new Map<string, string[]>();
    for (const [from, to] of options.edges ?? []) dependencies.set(to, [...(dependencies.get(to) ?? []), from]);
    const satisfied = (dep: string): boolean => succeeded.has(dep) || completed.has(dep);

    const runOne = async (task: AgentTask): Promise<void> => {
      for (let attempt = task.attempt; ; attempt += 1) {
        const current: AgentTask = { ...task, attempt };
        if (controller.signal.aborted) { results.push({ task: { ...current, state: 'cancelled' }, state: 'cancelled' }); return; }
        const taskController = new AbortController();
        const cascade = () => taskController.abort();
        controller.signal.addEventListener('abort', cascade, { once: true });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => { taskController.abort(); reject(new DeadlineExceededError(current.id, current.deadlineMs)); }, current.deadlineMs);
        });
        let value: T;
        try {
          value = await Promise.race([worker({ ...current, state: 'running' }, taskController.signal), deadline]);
        } catch (error) {
          const expired = error instanceof DeadlineExceededError;
          const cancelled = !expired && (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError'));
          results.push({ task: { ...current, state: cancelled ? 'cancelled' : 'failed' }, error, state: cancelled ? 'cancelled' : 'failed' });
          return;
        } finally {
          if (timer) clearTimeout(timer);
          controller.signal.removeEventListener('abort', cascade);
        }
        const verdict = options.settle ? await Promise.race([options.settle(current, value, controller.signal), aborted(controller.signal).catch(() => 'cancelled' as GateVerdict)]) : 'approved';
        if (verdict === 'rejected') continue;
        if (verdict === 'approved') { succeeded.add(current.id); results.push({ task: { ...current, state: 'succeeded' }, value, state: 'succeeded' }); return; }
        results.push({ task: { ...current, state: 'cancelled' }, value, state: 'cancelled' });
        return;
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
        const deps = dependencies.get(task.id) ?? [];
        const lane = laneOf(task);
        if (deps.every(satisfied) && active[lane] < limits[lane]) {
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
        for (const task of pending.splice(0)) {
          const absent = (dependencies.get(task.id) ?? []).filter((dep) => !satisfied(dep) && !ids.has(dep));
          if (absent.length === 0) { results.push({ task: { ...task, state: 'cancelled' }, state: 'cancelled' }); continue; }
          results.push({ task: { ...task, state: 'failed' }, error: new Error(`Task ${task.id} depends on ${absent.join(', ')}, which has not succeeded in this run.`), state: 'failed' });
        }
        break;
      }
      if (running.size > 0) await Promise.race([...running]);
    }
    options.signal?.removeEventListener('abort', relay);
    return { results, cancelled: controller.signal.aborted };
  }
}
