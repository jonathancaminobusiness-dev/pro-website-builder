import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

it('builds workspace dependencies before the server dev command resolves exports', async () => {
  const root = process.cwd();
  await execFileAsync('corepack', ['pnpm', '--filter', '@pwb/server', 'predev'], {
    cwd: root,
    env: { ...process.env, CI: '1' },
    maxBuffer: 2 * 1024 * 1024,
  });

  await expect(access(join(root, 'packages/stage-identity/dist/index.js'))).resolves.toBeUndefined();
});
