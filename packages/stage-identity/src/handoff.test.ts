import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFixtureIR, hashJson } from '@pwb/domain';
import { Applier, PatchGate, RunPlanner, VersionStore } from '@pwb/orchestrator';
import { HiggsfieldMcpProvider } from '@pwb/providers';
import { FakeIdentityProvider } from './fake-identity-provider.js';
import { identityHash, pruneRenderCache } from './gate.js';
import { IdentityStage } from './stage.js';

function newStage() {
  const store = new VersionStore();
  const root = new Applier(store, new PatchGate()).createRoot(createFixtureIR());
  const stage = new IdentityStage({
    runId: 'run-handoff', baseVersionId: root.id, briefing: 'Uma oficina de produto autoral precisa explicar seu processo.',
    provider: new FakeIdentityProvider(), store, raster: new HiggsfieldMcpProvider({ configured: false }),
  });
  return { stage, store, root };
}

describe('handoff to the next stage', () => {
  it('is undefined until the captain decides', async () => {
    const { stage } = newStage();
    await stage.run();
    expect(stage.handoff()).toBeUndefined();
  });

  it('gives the prototype stage a version whose identity hashes to the approved one', async () => {
    const { stage, store } = newStage();
    await stage.run();
    await stage.approve({ directionId: 'editorial-material', rationale: 'Aprovada.', approverRole: 'captain' });
    const handoff = stage.handoff()!;
    expect(handoff.stale).toBe(false);
    expect(handoff.directionId).toBe('editorial-material');

    // The existing planner is what the next stage runs on: plan against the
    // handoff version and the identity it hands the worker is the approved one.
    const planned = new RunPlanner(store, 'claude-local').plan('run-handoff', handoff.versionId, 'briefing');
    const prototype = planned.tasks.find((task) => task.stage === 'prototype')!;
    expect(hashJson(prototype.documentSlice['/identity'])).toBe(handoff.identityHash);
    expect(prototype.baseVersionId).toBe(handoff.versionId);
    expect(handoff.identityHash).toBe(identityHash(store.get(handoff.versionId)!.ir));
  });

  it('marks the handoff stale and changes the next stage input once a token moves', async () => {
    const { stage, store } = newStage();
    await stage.run();
    await stage.approve({ directionId: 'editorial-material', rationale: 'Aprovada.', approverRole: 'captain' });
    const before = stage.handoff()!;
    const beforeDigest = new RunPlanner(store, 'claude-local').plan('run-handoff', before.versionId, 'briefing').tasks.find((task) => task.stage === 'prototype')!.inputDigest;

    await stage.changeToken({ tokenPath: 'color.paper', value: '#ffffff', rationale: 'Papel mais claro.' });
    const after = stage.handoff()!;
    expect(after.stale).toBe(true);
    expect(after.versionId).not.toBe(before.versionId);
    // The approved hash is unchanged; what changed is the document it no longer describes.
    expect(after.identityHash).toBe(before.identityHash);
    expect(identityHash(store.get(after.versionId)!.ir)).not.toBe(after.identityHash);
    const afterDigest = new RunPlanner(store, 'claude-local').plan('run-handoff', after.versionId, 'briefing').tasks.find((task) => task.stage === 'prototype')!.inputDigest;
    expect(afterDigest).not.toBe(beforeDigest);
  });
});

describe('render invalidation', () => {
  it('removes exactly the cache entries the approved identity produced', async () => {
    const { stage } = newStage();
    await stage.run();
    await stage.approve({ directionId: 'modular-technical', rationale: 'Aprovada.', approverRole: 'captain' });
    const cacheDir = await mkdtemp(join(tmpdir(), 'pwb-render-cache-'));
    try {
      const changed = await stage.changeToken({ tokenPath: 'color.accent', value: '#00a37a', rationale: 'Outro sinal.' });
      if (changed.gate.state !== 'reopened') throw new Error('the gate should have reopened');
      const keys = changed.gate.impact.staleRenderKeys;
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        await writeFile(join(cacheDir, `${key}.evidence.json`), '{}', 'utf8');
        await writeFile(join(cacheDir, `${key}.evidence.png`), '', 'utf8');
      }
      await writeFile(join(cacheDir, 'unrelated.json'), '{}', 'utf8');

      const removed = await pruneRenderCache(cacheDir, keys);
      expect(removed).toHaveLength(keys.length * 2);
      const left = await readdir(cacheDir);
      expect(left).toEqual(['unrelated.json']);
      // A second pass has nothing left to drop, and says so instead of counting attempts.
      expect(await pruneRenderCache(cacheDir, keys)).toEqual([]);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
});
