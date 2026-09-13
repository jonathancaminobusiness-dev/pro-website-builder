import { afterEach, describe, expect, it } from 'vitest';
import { forgetRun, rememberedRun, rememberRun } from './rememberedRun.js';

const KEY = 'pwb.test.runId';

function withStorage(storage: unknown): void {
  (globalThis as { window?: unknown }).window = { localStorage: storage };
}

afterEach(() => { delete (globalThis as { window?: unknown }).window; });

/**
 * The pointer a screen keeps back to an execution the server still holds. A
 * browser that refuses storage decides in this session instead of failing.
 */
describe('remembered run', () => {
  it('reads back the run it was told to remember', () => {
    const values = new Map<string, string>();
    withStorage({
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    });
    expect(rememberedRun(KEY)).toBe('');
    rememberRun(KEY, 'studio-1');
    expect(rememberedRun(KEY)).toBe('studio-1');
    forgetRun(KEY);
    expect(rememberedRun(KEY)).toBe('');
  });

  it('answers with no run when the browser refuses storage', () => {
    withStorage({
      getItem: () => { throw new Error('storage disabled'); },
      setItem: () => { throw new Error('storage disabled'); },
      removeItem: () => { throw new Error('storage disabled'); },
    });
    expect(() => rememberRun(KEY, 'studio-1')).not.toThrow();
    expect(rememberedRun(KEY)).toBe('');
    expect(() => forgetRun(KEY)).not.toThrow();
  });
});
