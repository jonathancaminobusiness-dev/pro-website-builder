import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startServer } from './index.js';

afterEach(() => { vi.unstubAllEnvs(); });

describe('Claude model configuration at startup', () => {
  it('fails startup with a clear message when the configured effort is not a level the binary accepts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pwb-claude-effort-'));
    vi.stubEnv('PWB_CLAUDE_EFFORT', 'highest');
    await expect(startServer({ dbPath: join(directory, 'api.sqlite'), releaseRoot: join(directory, 'releases'), apiPort: 0, previewPort: 0 }))
      .rejects.toThrow(/PWB_CLAUDE_EFFORT must be one of low, medium, high, xhigh, max/);
  });

  it('fails startup when the configured model is not a single model name', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pwb-claude-model-'));
    vi.stubEnv('PWB_CLAUDE_MODEL', '   ');
    await expect(startServer({ dbPath: join(directory, 'api.sqlite'), releaseRoot: join(directory, 'releases'), apiPort: 0, previewPort: 0 }))
      .rejects.toThrow(/PWB_CLAUDE_MODEL must name a single model/);
  });
});
