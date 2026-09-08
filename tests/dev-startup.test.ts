import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('builds recursive workspace dependencies before starting the server', async () => {
  const packageJson = JSON.parse(await readFile(join(process.cwd(), 'apps/server/package.json'), 'utf8')) as { scripts?: { dev?: string } };
  const dev = packageJson.scripts?.dev ?? '';
  const build = dev.indexOf('@pwb/server^... build');
  const start = dev.indexOf('tsx src/index.ts');

  expect(build).toBeGreaterThanOrEqual(0);
  expect(start).toBeGreaterThan(build);
});
