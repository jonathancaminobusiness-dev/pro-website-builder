import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

interface Exit { code: number | null; stderr: string }

async function runFixture(env: Record<string, string>, timeoutMs: number): Promise<Exit | 'timeout'> {
  const child = spawn(join(process.cwd(), 'node_modules', '.bin', 'tsx'), ['scripts/run-fixture.ts'], {
    cwd: process.cwd(), env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  return new Promise<Exit | 'timeout'>((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve('timeout'); }, timeoutMs);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stderr }); });
  });
}

describe('run:fixture', () => {
  // The preview origin binds before the run is built, so a provider name the CLI
  // refuses used to leave that socket listening and the process alive forever.
  it('exits with the provider error instead of hanging on the preview it opened', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pwb-run-fixture-cli-'));
    directories.push(directory);
    const exit = await runFixture({
      PWB_MODEL_PROVIDER: 'codexx',
      PWB_DB_PATH: join(directory, 'cli.sqlite'),
      PWB_RELEASE_ROOT: join(directory, 'releases'),
      PWB_EVIDENCE_DIR: join(directory, 'evidence'),
      PWB_RENDER_CACHE: join(directory, 'cache'),
    }, 30_000);
    expect(exit).not.toBe('timeout');
    expect(exit).toMatchObject({ code: 1 });
    expect((exit as Exit).stderr).toMatch(/Unknown model provider codexx/);
  }, 45_000);
});
