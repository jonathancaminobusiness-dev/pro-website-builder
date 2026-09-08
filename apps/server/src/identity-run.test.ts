import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFixtureIR } from '@pwb/domain';
import { lintDesign } from '@pwb/linter';
import { CodexRunner, type ModelProvider } from '@pwb/providers';
import { HiggsfieldMcpProvider } from '@pwb/providers';
import { fakeIdentityFor, FakeIdentityProvider } from '@pwb/stage-identity';
import { startServer } from './index.js';
import { openDatabase, ProjectRepository, type LocalDatabase } from './db/repository.js';
import { IdentityRun } from './identity-run.js';
import { STUDIO_ORIGIN } from './security.js';

let directory: string;
let database: LocalDatabase;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pwb-identity-'));
  database = openDatabase(join(directory, 'identity.sqlite'));
});

afterEach(async () => {
  database.sqlite.close();
  await rm(directory, { recursive: true, force: true });
});

function newRun(runId = 'identity-test'): IdentityRun {
  return new IdentityRun({ runId, repository: new ProjectRepository(database), provider: new FakeIdentityProvider() });
}

describe('identity run', () => {
  it('spends no model turn until the captain starts it', async () => {
    const run = newRun();
    await run.initialize();
    expect(run.snapshot().status).toBe('queued');
    expect(run.snapshot().directions).toEqual([]);
    const started = await run.start();
    expect(started.status).toBe('needs_review');
    expect(started.directions).toHaveLength(3);
  });

  it('exposes actionable Codex startup failures in the identity snapshot', async () => {
    const provider = new CodexRunner({ execute: async () => { throw Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }); } });
    const run = new IdentityRun({ runId: 'identity-codex-failure', repository: new ProjectRepository(database), provider });
    await run.initialize();

    const snapshot = await run.start();

    expect(snapshot.status).toBe('failed');
    expect(snapshot.error).toMatch(/Install Codex CLI/);
    expect(snapshot.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: 'identity-curator', reason: expect.stringMatching(/Install Codex CLI/) }),
    ]));
  });

  it('persists every candidate version and the events behind the fan-out', async () => {
    const repository = new ProjectRepository(database);
    const run = new IdentityRun({ runId: 'identity-events', repository, provider: new FakeIdentityProvider() });
    await run.initialize();
    const snapshot = await run.start();
    const stored = database.sqlite.prepare('SELECT id, parent_id FROM versions').all() as Array<{ id: string; parent_id: string | null }>;
    for (const direction of snapshot.directions) expect(stored.some((row) => row.id === direction.versionId)).toBe(true);
    expect(stored.filter((row) => row.parent_id === snapshot.baseVersionId)).toHaveLength(3);
    const events = await repository.listEvents('identity-events');
    expect(events.map((event) => event.type)).toContain('identity.stage.started');
    expect(events.filter((event) => event.type === 'identity.candidate.opened')).toHaveLength(3);
    expect(events.some((event) => event.type === 'identity.stage.gate_opened')).toBe(true);
  });

  it('gives the Gate 1 screen three directions with rationale, exclusions and axes', async () => {
    const run = newRun();
    await run.initialize();
    const snapshot = await run.start();
    expect(snapshot.divergence?.passed).toBe(true);
    for (const direction of snapshot.directions) {
      expect(direction.axes).toHaveLength(6);
      expect(direction.rationale.length).toBeGreaterThan(10);
      expect(direction.exclusions.length).toBeGreaterThan(0);
      expect(direction.forbiddenDefaults.palettes.length).toBeGreaterThan(0);
      expect(direction.decisions.length).toBeGreaterThan(10);
      expect(direction.lintErrors).toEqual([]);
      expect(direction.swatches.length).toBeGreaterThan(0);
    }
  });

  it('shows a failing DIV-030 pair once on the gate, not inside every card', async () => {
    const inner = new FakeIdentityProvider();
    const provider: ModelProvider = {
      async propose(task, signal) {
        const result = await inner.propose(task, signal);
        if (task.id !== 'identity-director-modular-technical' || !result.proposal) return result;
        const converged = { ...fakeIdentityFor('editorial-material'), meta: fakeIdentityFor('modular-technical').meta, direction: fakeIdentityFor('modular-technical').direction };
        return { ...result, proposal: { ...result.proposal, operations: [{ op: 'replace', path: '/identity', value: converged }] } };
      },
    };
    const run = new IdentityRun({ runId: 'identity-div030', repository: new ProjectRepository(database), provider });
    await run.initialize();
    const snapshot = await run.start();
    expect(snapshot.divergence?.passed).toBe(false);
    expect(snapshot.divergence?.blockedPairs.join(' ')).toMatch(/editorial-material and modular-technical/);
    // The pair belongs to the set, so no card repeats the lint finding every document carries.
    for (const direction of snapshot.directions) expect(direction.lintErrors.map((finding) => finding.id)).not.toContain('DIV-030');
    // The card and the approve call agree: the two directions in the pair carry it, the third does not.
    for (const directionId of ['editorial-material', 'modular-technical']) {
      const card = snapshot.directions.find((direction) => direction.directionId === directionId)!;
      expect(card.blockedPairs.join(' ')).toMatch(/editorial-material and modular-technical/);
      await expect(run.approve({ directionId, approverRole: 'captain', rationale: 'Gosto dessa.' })).rejects.toThrow(/editorial-material and modular-technical differ/);
    }
    expect(snapshot.directions.find((direction) => direction.directionId === 'typographic-low-chroma')!.blockedPairs).toEqual([]);
  });

  it('keeps a page-graph finding off the Gate 1 card the decision cannot clear', async () => {
    const inner = new FakeIdentityProvider();
    const provider: ModelProvider = {
      async propose(task, signal) {
        const result = await inner.propose(task, signal);
        if (task.id !== 'identity-director-editorial-material' || !result.proposal) return result;
        const base = fakeIdentityFor('editorial-material');
        const identity = { ...base, content: { ...base.content, forbiddenTerms: [...base.content.forbiddenTerms, 'brilho'] } };
        return { ...result, proposal: { ...result.proposal, operations: [{ op: 'replace', path: '/identity', value: identity }] } };
      },
    };
    const repository = new ProjectRepository(database);
    const run = new IdentityRun({ runId: 'identity-copy110', repository, provider });
    await run.initialize();
    const opened = await run.start();
    const candidate = opened.directions.find((direction) => direction.directionId === 'editorial-material')!;
    expect(candidate.lintErrors.map((finding) => finding.id)).not.toContain('COPY-110');

    // The document really does carry the finding; it names /pages, which this stage cannot write.
    const approved = await run.approve({ directionId: 'editorial-material', approverRole: 'captain', rationale: 'A voz proibida é do protótipo, não da identidade.' });
    const stored = (await repository.listVersions('fixture-project')).find((version) => version.id === approved.previewVersionId)!;
    expect(lintDesign(stored.ir).findings.some((finding) => finding.id === 'COPY-110')).toBe(true);
    const chosen = approved.directions.find((direction) => direction.directionId === 'editorial-material')!;
    expect(chosen.lintErrors.map((finding) => finding.id)).not.toContain('COPY-110');
  });

  it('records the captain decision and serves the approved version to the preview', async () => {
    const run = newRun();
    await run.initialize();
    await run.start();
    const approved = await run.approve({ directionId: 'editorial-material', approverRole: 'captain', rationale: 'A oficina editorial responde ao briefing.' });
    expect(approved.status).toBe('approved');
    expect(approved.approvals[0]).toMatchObject({ stage: 'identity', approverRole: 'captain', decision: 'approved' });
    expect(approved.gate.state).toBe('closed');
    expect(run.renderedFor(approved.previewVersionId!)).toBeDefined();
    expect(approved.assets[0]?.provenance.license).toBeTruthy();
  });

  it('reopens the gate when a token changes after approval', async () => {
    const run = newRun();
    await run.initialize();
    await run.start();
    await run.approve({ directionId: 'modular-technical', approverRole: 'captain', rationale: 'Aprovada.' });
    const reopened = await run.changeToken({ tokenPath: 'color.accent', value: '#ff7a00', rationale: 'Sinal mais quente.' });
    expect(reopened.status).toBe('reopened');
    expect(reopened.gate.state).toBe('reopened');
    if (reopened.gate.state !== 'reopened') throw new Error('unreachable');
    expect(reopened.gate.impact.changedTokenPaths).toEqual(['color.accent']);
    expect(reopened.gate.impact.staleRenderKeys.length).toBeGreaterThan(0);
  });

  it('follows the gate back to approved when a token change is undone', async () => {
    const repository = new ProjectRepository(database);
    const run = new IdentityRun({ runId: 'identity-undo', repository, provider: new FakeIdentityProvider() });
    await run.initialize();
    const started = await run.start();
    const before = started.directions.find((direction) => direction.directionId === 'modular-technical')!.swatches.find((swatch) => swatch.path === 'color.accent')!.value;
    await run.approve({ directionId: 'modular-technical', approverRole: 'captain', rationale: 'Aprovada.' });

    const reopened = await run.changeToken({ tokenPath: 'color.accent', value: '#ff7a00', rationale: 'Sinal mais quente.' });
    expect(reopened.status).toBe('reopened');

    // Restoring the approved value leaves the identity byte-identical, so the gate
    // closes again and the label the captain reads cannot disagree with it.
    const undone = await run.changeToken({ tokenPath: 'color.accent', value: before, rationale: 'Volta ao sinal aprovado.' });
    expect(undone.gate.state).toBe('closed');
    expect(undone.status).toBe('approved');
    expect(undone.handoff?.stale).toBe(false);
  });

  it('persists every captain decision as its own row across a reopen and an undo', async () => {
    const repository = new ProjectRepository(database);
    const run = new IdentityRun({ runId: 'identity-recur', repository, provider: new FakeIdentityProvider() });
    await run.initialize();
    const started = await run.start();
    const before = started.directions.find((direction) => direction.directionId === 'editorial-material')!.swatches.find((swatch) => swatch.path === 'color.accent')!.value;
    const first = await run.approve({ directionId: 'editorial-material', approverRole: 'captain', rationale: 'Primeira decisão.' });
    if (first.gate.state !== 'closed') throw new Error('unreachable');

    await run.changeToken({ tokenPath: 'color.accent', value: '#ff7a00', rationale: 'Sinal mais quente.' });
    await run.approve({ directionId: 'editorial-material', approverRole: 'captain', rationale: 'Segunda decisão.' });
    // Restoring the accent carries the identity the first decision closed on, so the gate reopens against the second.
    const undone = await run.changeToken({ tokenPath: 'color.accent', value: before, rationale: 'Volta ao sinal aprovado.' });
    if (undone.gate.state !== 'reopened') throw new Error('the gate should have reopened');
    const third = await run.approve({ directionId: 'editorial-material', approverRole: 'captain', rationale: 'Terceira decisão.' });
    if (third.gate.state !== 'closed') throw new Error('unreachable');

    // The ledger keeps one row per decision, whatever version each decision landed on.
    const persisted = database.sqlite.prepare('SELECT id, rationale FROM approvals WHERE run_id = ? ORDER BY rowid').all('identity-recur') as Array<{ id: string; rationale: string }>;
    expect(persisted.map((row) => row.rationale)).toEqual(['Primeira decisão.', 'Segunda decisão.', 'Terceira decisão.']);
    expect(new Set(persisted.map((row) => row.id)).size).toBe(3);
  });

  it('records the written override with the decision it authorised', async () => {
    const repository = new ProjectRepository(database);
    const run = new IdentityRun({ runId: 'identity-override', repository, provider: new FakeIdentityProvider() });
    await run.initialize();
    await run.start();
    await run.approve({ directionId: 'editorial-material', approverRole: 'captain', rationale: 'Aprovada.' });
    await run.changeToken({ tokenPath: 'type.display', value: 'Inter-only hero, Georgia, serif', rationale: 'Testando a fonte proibida.' });
    const override = 'A fonte proibida é intencional: o Gate 2 substitui essa rota.';
    const reapproved = await run.approve({ directionId: 'editorial-material', approverRole: 'captain', rationale: 'Revisado.', overrideRationale: override });

    if (reapproved.gate.state !== 'closed') throw new Error('unreachable');
    expect(reapproved.gate.record.overrideRationale).toBe(override);
    // The ledger keeps the sentence that authorised an approval over blockers.
    const persisted = database.sqlite.prepare('SELECT rationale FROM approvals WHERE run_id = ?').all('identity-override') as Array<{ rationale: string }>;
    expect(persisted.some((row) => row.rationale.includes(override))).toBe(true);
    const events = await repository.listEvents('identity-override');
    const approvedEvents = events.filter((event) => event.type === 'identity.gate.approved');
    expect((approvedEvents.at(-1)!.payload as { overrideRationale?: string }).overrideRationale).toBe(override);
    expect((approvedEvents[0]!.payload as { overrideRationale?: string }).overrideRationale).toBeUndefined();
  });

  it('hands the next stage the approved version and marks it stale when a token moves', async () => {
    const run = newRun();
    await run.initialize();
    await run.start();
    await run.approve({ directionId: 'editorial-material', approverRole: 'captain', rationale: 'Aprovada.' });
    const handed = run.snapshot().handoff!;
    expect(handed.stale).toBe(false);
    expect(handed.directionId).toBe('editorial-material');
    const reopened = await run.changeToken({ tokenPath: 'color.paper', value: '#ffffff', rationale: 'Papel mais claro.' });
    expect(reopened.handoff?.stale).toBe(true);
  });

  it('persists the re-approval that closes a reopened gate as its own decision', async () => {
    const run = newRun();
    await run.initialize();
    await run.start();
    const first = await run.approve({ directionId: 'editorial-material', approverRole: 'captain', rationale: 'Aprovada.' });
    await run.changeToken({ tokenPath: 'color.accent', value: '#ff7a00', rationale: 'Sinal mais quente.' });
    const reapproved = await run.approve({ directionId: 'editorial-material', approverRole: 'captain', rationale: 'Token revisado e aprovado.' });
    expect(reapproved.gate.state).toBe('closed');

    const rows = database.sqlite.prepare("SELECT id, version_id, rationale FROM approvals WHERE decision = 'approved' ORDER BY rowid").all() as Array<{ id: string; version_id: string; rationale: string }>;
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
    expect(rows[1]?.version_id).not.toBe(rows[0]?.version_id);
    expect(rows[1]?.rationale).toBe('Token revisado e aprovado.');
    if (first.gate.state !== 'closed') throw new Error('unreachable');
    expect(rows[0]?.version_id).toBe(first.gate.record.versionId);
    expect(new Set(reapproved.approvals.map((approval) => approval.id)).size).toBe(2);
  });

  it('shows every colour token on the card, including one a director nested', async () => {
    const inner = new FakeIdentityProvider();
    const provider: ModelProvider = {
      async propose(task, signal) {
        const result = await inner.propose(task, signal);
        if (task.id !== 'identity-director-editorial-material' || !result.proposal) return result;
        const identity = result.proposal.operations[0]!.value as { tokens: { color: Record<string, unknown> } };
        const tokens = { ...identity.tokens, color: { ...identity.tokens.color, brand: { primary: { $value: '#b4552f', $type: 'color' } } } };
        return { ...result, proposal: { ...result.proposal, operations: [{ op: 'replace', path: '/identity', value: { ...identity, tokens } }] } };
      },
    };
    const run = new IdentityRun({ runId: 'nested-color', repository: new ProjectRepository(database), provider });
    await run.initialize();
    const started = await run.start();
    const card = started.directions.find((direction) => direction.directionId === 'editorial-material')!;
    expect(card.swatches.find((swatch) => swatch.path === 'color.brand.primary')?.value).toBe('#b4552f');
    expect(card.swatches.every((swatch) => swatch.value !== 'undefined')).toBe(true);
  });

  it('re-derives the chosen card from the version a token change produced', async () => {
    const run = newRun();
    await run.initialize();
    await run.start();
    const approved = await run.approve({ directionId: 'editorial-material', approverRole: 'captain', rationale: 'Aprovada.' });
    const before = approved.directions.find((direction) => direction.directionId === 'editorial-material')!;
    if (approved.gate.state !== 'closed') throw new Error('unreachable');
    // A closed gate already moved the chosen card onto the approved version.
    expect(before.versionId).toBe(approved.gate.record.versionId);
    expect(before.identityHash).toBe(approved.gate.record.identityHash);

    const reopened = await run.changeToken({ tokenPath: 'color.accent', value: '#ff7a00', rationale: 'Sinal mais quente.' });
    const chosen = reopened.directions.find((direction) => direction.directionId === 'editorial-material')!;
    expect(chosen.versionId).toBe(reopened.previewVersionId);
    expect(chosen.identityHash).not.toBe(before.identityHash);
    expect(chosen.swatches.find((swatch) => swatch.path === 'color.accent')?.value).toBe('#ff7a00');

    // The blocker the server will refuse the approval with is on the card first.
    const withForbiddenFont = await run.changeToken({ tokenPath: 'type.display', value: 'Inter-only hero, Georgia, serif', rationale: 'Testando a fonte proibida.' });
    const blocked = withForbiddenFont.directions.find((direction) => direction.directionId === 'editorial-material')!;
    expect(blocked.lintErrors.map((finding) => finding.id)).toContain('DEF-010');
    await expect(run.approve({ directionId: 'editorial-material', approverRole: 'captain', rationale: 'Mesmo assim.' })).rejects.toThrow(/automatic selection is not allowed/);

    // The other two cards stay the historical candidates the captain compared.
    const other = withForbiddenFont.directions.find((direction) => direction.directionId === 'modular-technical')!;
    expect(other.versionId).not.toBe(withForbiddenFont.previewVersionId);
    expect(other.lintErrors).toEqual([]);

    // Re-approving closes the gate onto that same version, and the card follows it.
    const reapproved = await run.approve({ directionId: 'editorial-material', approverRole: 'captain', rationale: 'Revisado.', overrideRationale: 'A fonte proibida é intencional neste teste.' });
    if (reapproved.gate.state !== 'closed') throw new Error('unreachable');
    const closed = reapproved.directions.find((direction) => direction.directionId === 'editorial-material')!;
    expect(closed.versionId).toBe(reapproved.gate.record.versionId);
    expect(closed.identityHash).toBe(reapproved.gate.record.identityHash);
    expect(closed.swatches.find((swatch) => swatch.path === 'color.accent')?.value).toBe('#ff7a00');
  });

  it('drops the render cache entries the approved identity produced when a token changes', async () => {
    const cacheDir = join(directory, 'render-cache');
    await mkdir(cacheDir, { recursive: true });
    const run = new IdentityRun({ runId: 'identity-prune', repository: new ProjectRepository(database), provider: new FakeIdentityProvider(), renderCacheDir: cacheDir });
    await run.initialize();
    await run.start();
    await run.approve({ directionId: 'editorial-material', approverRole: 'captain', rationale: 'Aprovada.' });

    // The stale keys belong to the approved version, so a first change names the
    // same entries a later one has to remove.
    const reopened = await run.changeToken({ tokenPath: 'color.paper', value: '#ffffff', rationale: 'Papel mais claro.' });
    if (reopened.gate.state !== 'reopened') throw new Error('the gate should have reopened');
    const keys = reopened.gate.impact.staleRenderKeys;
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) await writeFile(join(cacheDir, `${key}.evidence.json`), '{}', 'utf8');
    await writeFile(join(cacheDir, 'unrelated.json'), '{}', 'utf8');

    await run.changeToken({ tokenPath: 'color.paper', value: '#fefefe', rationale: 'Papel ainda mais claro.' });
    expect(await readdir(cacheDir)).toEqual(['unrelated.json']);
  });

  it('serves and decides an open Gate 1 after the server that opened it is gone', async () => {
    const repository = new ProjectRepository(database);
    const first = new IdentityRun({ runId: 'identity-restart', repository, provider: new FakeIdentityProvider() });
    await first.initialize();
    const started = await first.start();
    expect(started.status).toBe('needs_review');

    // A second process holds nothing in memory: the run has to come back from the ledger.
    const restored = new IdentityRun({ runId: 'identity-restart', repository, provider: new FakeIdentityProvider() });
    expect(await restored.restore()).toBe(true);
    const snapshot = restored.snapshot();
    expect(snapshot.status).toBe('needs_review');
    expect(snapshot.directions.map((direction) => direction.versionId)).toEqual(started.directions.map((direction) => direction.versionId));
    expect(snapshot.brief?.evidence.map((item) => item.id)).toEqual(started.brief?.evidence.map((item) => item.id));
    expect(snapshot.critiques.length).toBe(started.critiques.length);

    const approved = await restored.approve({ directionId: 'editorial-material', approverRole: 'captain', rationale: 'Decidida depois do reinício.' });
    expect(approved.gate.state).toBe('closed');
    expect(restored.renderedFor(approved.previewVersionId!)).toBeDefined();
    expect(approved.handoff?.stale).toBe(false);
  });

  it('carries the captain decision and the generated assets across a restart', async () => {
    const repository = new ProjectRepository(database);
    const first = new IdentityRun({ runId: 'identity-restart-approved', repository, provider: new FakeIdentityProvider() });
    await first.initialize();
    await first.start();
    const decided = await first.approve({ directionId: 'editorial-material', approverRole: 'captain', rationale: 'Aprovada antes do reinício.' });
    if (decided.gate.state !== 'closed') throw new Error('unreachable');

    const restored = new IdentityRun({ runId: 'identity-restart-approved', repository, provider: new FakeIdentityProvider() });
    expect(await restored.restore()).toBe(true);
    const snapshot = restored.snapshot();
    expect(snapshot.status).toBe('approved');
    if (snapshot.gate.state !== 'closed') throw new Error('the restored gate should still be closed');
    expect(snapshot.gate.record.versionId).toBe(decided.gate.record.versionId);
    expect(snapshot.approvals.map((approval) => approval.id)).toEqual(decided.approvals.map((approval) => approval.id));
    expect(snapshot.assets.map((asset) => asset.id)).toEqual(decided.assets.map((asset) => asset.id));

    // A token change after the restart still reopens the gate it closed.
    const reopened = await restored.changeToken({ tokenPath: 'color.accent', value: '#ff7a00', rationale: 'Sinal mais quente.' });
    expect(reopened.gate.state).toBe('reopened');
  });

  it('comes back interrupted when the process ended while the stage was running', async () => {
    const repository = new ProjectRepository(database);
    let release = (): void => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const inner = new FakeIdentityProvider();
    const provider: ModelProvider = {
      async propose(task, signal) {
        if (task.id.startsWith('identity-director-')) await held;
        return inner.propose(task, signal);
      },
    };
    const first = new IdentityRun({ runId: 'identity-midflight', repository, provider });
    await first.initialize();
    const running = first.start();
    while (!(await repository.listEvents('identity-midflight')).some((event) => event.type === 'identity.stage.started')) {
      await new Promise((resolve) => { setTimeout(resolve, 5); });
    }

    const restored = new IdentityRun({ runId: 'identity-midflight', repository, provider: new FakeIdentityProvider() });
    expect(await restored.restore()).toBe(true);
    const snapshot = restored.snapshot();
    expect(snapshot.status).toBe('interrupted');
    expect(snapshot.error).toMatch(/restart/i);
    // The gate is decidable again by running the stage, not by a 404.
    expect(snapshot.gate.state).toBe('open');
    release();
    await running;
  });

  it('reads a run back from a database written before the imagery vocabulary closed', async () => {
    // The file the owner already has: written at schema version 2, holding a
    // version whose identity names the raster source as it was named then.
    const file = join(directory, 'v2.sqlite');
    const seeding = openDatabase(file);
    const ir = createFixtureIR();
    const legacy = { ...ir, identity: { ...ir.identity, imagery: { ...ir.identity.imagery, allowedSources: ['manual', 'higgsfield'] } } };
    const now = new Date().toISOString();
    seeding.sqlite.prepare('INSERT INTO projects VALUES (?, ?, ?)').run('fixture-project', 'Fixture', now);
    seeding.sqlite.prepare('INSERT INTO versions VALUES (?, ?, ?, ?, ?, ?)').run('v-legacy', 'fixture-project', null, 'hash-legacy', JSON.stringify(legacy), now);
    seeding.sqlite.prepare('INSERT INTO runs VALUES (?, ?, ?)').run('identity-legacy', 'fixture-project', now);
    seeding.sqlite.pragma('user_version = 2');
    seeding.sqlite.close();

    const upgraded = openDatabase(file);
    const repository = new ProjectRepository(upgraded);
    const run = new IdentityRun({ runId: 'identity-legacy', repository, provider: new FakeIdentityProvider() });
    expect(await run.restore()).toBe(true);
    expect(run.snapshot().status).toBe('queued');
    // The run the owner already paid for is still theirs to run: the row was
    // rewritten, not dropped.
    expect((await repository.listVersions('fixture-project')).map((version) => version.id)).toContain('v-legacy');
    expect((await run.start()).directions).toHaveLength(3);
    upgraded.sqlite.close();
  });

  it('does not invent a run the ledger never held', async () => {
    const run = new IdentityRun({ runId: 'never-created', repository: new ProjectRepository(database), provider: new FakeIdentityProvider() });
    expect(await run.restore()).toBe(false);
  });

  it('returns the gate decision while the imagery is still being shot, and settles it after', async () => {
    const repository = new ProjectRepository(database);
    let release = (): void => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const raster = new HiggsfieldMcpProvider({
      configured: true,
      transport: { callTool: async () => { await held; return { uri: 'higgsfield://asset-1', license: 'provider terms 2026', termsNote: 'Owner review required.' }; } },
    });
    const run = new IdentityRun({ runId: 'identity-raster', repository, provider: new FakeIdentityProvider(), raster });
    await run.initialize();
    await run.start();

    const approved = await run.approve({ directionId: 'modular-technical', approverRole: 'captain', rationale: 'Aprovada.' });
    expect(approved.gate.state).toBe('closed');
    expect(approved.assets.map((asset) => asset.status)).toEqual(['generating']);

    release();
    // Cancelling waits for what is in flight, which is how the run learns the image settled.
    await run.cancel();
    const settled = run.snapshot();
    expect(settled.assets.map((asset) => asset.status)).toEqual(['ready']);
    expect(settled.handoff?.assets.map((asset) => asset.provenance.license)).toEqual(['provider terms 2026']);

    // The settled image is on the checkpoint, so a restart does not show it generating forever.
    const restored = new IdentityRun({ runId: 'identity-raster', repository, provider: new FakeIdentityProvider() });
    expect(await restored.restore()).toBe(true);
    expect(restored.snapshot().assets.map((asset) => asset.status)).toEqual(['ready']);
  });

  it('settles an image the ended process was still shooting, instead of leaving it generating', async () => {
    const repository = new ProjectRepository(database);
    let entered = (): void => {};
    const shooting = new Promise<void>((resolve) => { entered = resolve; });
    const raster = new HiggsfieldMcpProvider({
      configured: true,
      transport: {
        callTool: async (_name, _args, signal) => {
          entered();
          return new Promise<{ uri?: string }>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('the call was cancelled')), { once: true });
          });
        },
      },
    });
    const run = new IdentityRun({ runId: 'identity-restart-generating', repository, provider: new FakeIdentityProvider(), raster });
    await run.initialize();
    await run.start();
    const approved = await run.approve({ directionId: 'modular-technical', approverRole: 'captain', rationale: 'Aprovada.' });
    expect(approved.assets.map((asset) => asset.status)).toEqual(['generating']);
    await shooting;

    // A second process reads the checkpoint written while the image was in flight.
    const restored = new IdentityRun({ runId: 'identity-restart-generating', repository, provider: new FakeIdentityProvider() });
    expect(await restored.restore()).toBe(true);
    const snapshot = restored.snapshot();
    expect(snapshot.assets.map((asset) => asset.status)).toEqual(['failed']);
    expect(snapshot.assets[0]?.provenance.termsNote).toMatch(/process ended while this image was being generated/);
    // The handoff states what became of the image rather than calling it work in progress.
    expect(snapshot.handoff?.assets.map((asset) => asset.status)).toEqual(['failed']);
    expect(snapshot.gate.state).toBe('closed');

    await run.cancel();
  });

  it('marks a run the captain stopped before its gate as cancelled, and refuses to decide it', async () => {
    const repository = new ProjectRepository(database);
    let entered = (): void => {};
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    const inner = new FakeIdentityProvider();
    const provider: ModelProvider = {
      async propose(task, signal) {
        if (task.id.startsWith('identity-director-')) {
          entered();
          await new Promise<void>((_resolve, reject) => { signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); });
        }
        return inner.propose(task, signal);
      },
    };
    const run = new IdentityRun({ runId: 'identity-stopped', repository, provider });
    await run.initialize();
    const started = run.start();
    await reached;

    const cancelled = await run.cancel();
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.gate.state).toBe('open');
    await started.catch(() => undefined);

    // A run nobody decided stays undecided: it cannot be approved, and it
    // cannot be started again to spend the turns over.
    await expect(run.approve({ directionId: 'editorial-material', approverRole: 'captain', rationale: 'Mesmo assim.' })).rejects.toThrow(/cancelled/i);
    await expect(run.start()).rejects.toThrow(/cancelled/i);
    expect(run.snapshot().status).toBe('cancelled');

    const events = await repository.listEvents('identity-stopped');
    expect(events.some((event) => event.type === 'identity.run.cancelled')).toBe(true);
  });

  it('runs the stage again after a failure, on the same run', async () => {
    const repository = new ProjectRepository(database);
    let failing = true;
    const inner = new FakeIdentityProvider();
    const provider: ModelProvider = {
      async propose(task, signal) {
        const result = await inner.propose(task, signal);
        // Every director answers without its draft, so no branch opens and the
        // fan-out has nothing to build a matrix from.
        if (failing && task.id.startsWith('identity-director-')) return { ...result, artifact: undefined };
        return result;
      },
    };
    const run = new IdentityRun({ runId: 'identity-retry', repository, provider });
    await run.initialize();

    const first = await run.start();
    expect(first.status).toBe('failed');
    expect(first.directions).toEqual([]);
    expect(first.error).toMatch(/usable directions/);

    failing = false;
    const second = await run.start();
    expect(second.status).toBe('needs_review');
    expect(second.directions).toHaveLength(3);
    expect(second.error).toBeUndefined();

    // The retry produced a decidable gate, not a half-built one.
    const approved = await run.approve({ directionId: 'editorial-material', approverRole: 'captain', rationale: 'Aprovada na segunda tentativa.' });
    expect(approved.gate.state).toBe('closed');
  });

  it('reports a retry the process ended as interrupted, not as the failure before it', async () => {
    const repository = new ProjectRepository(database);
    const inner = new FakeIdentityProvider();
    let failing = true;
    let release = (): void => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const provider: ModelProvider = {
      // The first attempt loses every director draft; the second is still
      // waiting on its directors when the process ends.
      async propose(task, signal) {
        const director = task.id.startsWith('identity-director-');
        if (director && !failing) await held;
        const result = await inner.propose(task, signal);
        return director && failing ? { ...result, artifact: undefined } : result;
      },
    };
    const run = new IdentityRun({ runId: 'identity-retry-midflight', repository, provider });
    await run.initialize();
    expect((await run.start()).status).toBe('failed');

    failing = false;
    const retrying = run.start();
    const attempts = async (): Promise<number> => (await repository.listEvents('identity-retry-midflight')).filter((event) => event.type === 'identity.stage.started').length;
    while (await attempts() < 2) await new Promise((resolve) => { setTimeout(resolve, 5); });

    const restored = new IdentityRun({ runId: 'identity-retry-midflight', repository, provider: new FakeIdentityProvider() });
    expect(await restored.restore()).toBe(true);
    const snapshot = restored.snapshot();
    expect(snapshot.status).toBe('interrupted');
    expect(snapshot.error).toMatch(/restart/i);
    // The attempt that ended measured no fan-out, so it cannot be blamed on one.
    expect(snapshot.error).not.toMatch(/usable directions/);

    release();
    await retrying;
  });

  it('keeps a fan-out that had already finished when the stop arrived', async () => {
    const repository = new ProjectRepository(database);
    const run = new IdentityRun({ runId: 'identity-late-stop', repository, provider: new FakeIdentityProvider() });
    await run.initialize();
    const started = await run.start();
    expect(started.directions).toHaveLength(3);

    // The stop lands after the stage produced its candidates. They cost the
    // curator, three directors and the critics: the run keeps them.
    const stopped = await run.cancel();
    expect(stopped.status).toBe('needs_review');
    expect(stopped.directions).toHaveLength(3);

    const approved = await run.approve({ directionId: 'editorial-material', approverRole: 'captain', rationale: 'Decidida depois do pedido de parada.' });
    expect(approved.gate.state).toBe('closed');
  });

  it('decides nothing on a run stopped after its directions were already built', async () => {
    const repository = new ProjectRepository(database);
    let entered = (): void => {};
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    const inner = new FakeIdentityProvider();
    const provider: ModelProvider = {
      async propose(task, signal) {
        // The stop lands after the directors answered, so the stage still
        // resolves with candidates while the run itself was interrupted.
        if (task.id.startsWith('identity-critic-')) {
          entered();
          await new Promise<void>((_resolve, reject) => { signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); });
        }
        return inner.propose(task, signal);
      },
    };
    const run = new IdentityRun({ runId: 'identity-stopped-late', repository, provider });
    await run.initialize();
    const started = run.start();
    await reached;

    const stopped = await run.cancel();
    await started.catch(() => undefined);
    expect(stopped.status).toBe('cancelled');
    expect(stopped.gate.state).toBe('open');
    // The cards are there to read, and neither decision is available on them.
    expect(stopped.directions.length).toBeGreaterThan(0);
    const directionId = stopped.directions[0]!.directionId;
    await expect(run.approve({ directionId, approverRole: 'captain', rationale: 'Mesmo assim.' })).rejects.toThrow(/cancelled/i);
    await expect(run.reject({ directionId, approverRole: 'captain', rationale: 'Devolvida.' })).rejects.toThrow(/cancelled/i);

    // Nothing was written to the ledger by either refusal.
    const rows = database.sqlite.prepare('SELECT id FROM approvals WHERE run_id = ?').all('identity-stopped-late') as Array<{ id: string }>;
    expect(rows).toEqual([]);
  });

  it('reads a stopped run back as stopped after a restart', async () => {
    const repository = new ProjectRepository(database);
    let entered = (): void => {};
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    const inner = new FakeIdentityProvider();
    const provider: ModelProvider = {
      async propose(task, signal) {
        if (task.id.startsWith('identity-director-')) {
          entered();
          await new Promise<void>((_resolve, reject) => { signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); });
        }
        return inner.propose(task, signal);
      },
    };
    const run = new IdentityRun({ runId: 'identity-stop-restart', repository, provider });
    await run.initialize();
    const started = run.start();
    await reached;
    expect((await run.cancel()).status).toBe('cancelled');
    await started.catch(() => undefined);

    // A second process reads the ledger, not the memory of the one that stopped it.
    const restored = new IdentityRun({ runId: 'identity-stop-restart', repository, provider: new FakeIdentityProvider() });
    expect(await restored.restore()).toBe(true);
    expect(restored.snapshot().status).toBe('cancelled');
    await expect(restored.start()).rejects.toThrow(/cancelled/i);
    await expect(restored.approve({ directionId: 'editorial-material', approverRole: 'captain', rationale: 'Mesmo assim.' })).rejects.toThrow(/cancelled/i);
  });

  it('cancels imagery the raster lane never finished, keeping the decision', async () => {
    const repository = new ProjectRepository(database);
    const raster = new HiggsfieldMcpProvider({
      configured: true,
      transport: {
        callTool: async (_name, _args, signal) => new Promise<{ uri?: string }>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('the call was cancelled')), { once: true });
        }),
      },
    });
    const run = new IdentityRun({ runId: 'identity-raster-cancel', repository, provider: new FakeIdentityProvider(), raster });
    await run.initialize();
    await run.start();
    await run.approve({ directionId: 'modular-technical', approverRole: 'captain', rationale: 'Aprovada.' });

    const cancelled = await run.cancel();
    expect(cancelled.gate.state).toBe('closed');
    expect(cancelled.assets.map((asset) => asset.status)).toEqual(['failed']);
    expect(cancelled.status).toBe('approved');
  });

  it('refuses a rejection from anyone but the captain', async () => {
    const run = newRun();
    await run.initialize();
    await run.start();
    await expect(run.reject({ directionId: 'editorial-material', approverRole: 'designer', rationale: 'não' })).rejects.toThrow(/Only the captain/);
  });
});

describe('identity api', () => {
  // Ephemeral ports: several worktrees of this repo run their suites on one machine.
  async function withServer<T>(work: (origin: string) => Promise<T>): Promise<T> {
    const server = await startServer({ dbPath: join(directory, 'api.sqlite'), releaseRoot: join(directory, 'releases'), apiPort: 0, previewPort: 0 });
    const { port } = server.api.address() as AddressInfo;
    try { return await work(`http://127.0.0.1:${port}`); } finally { await server.close(); }
  }

  const post = (origin: string, path: string, payload: unknown) => fetch(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: STUDIO_ORIGIN }, body: JSON.stringify(payload) });

  it('drives one run from creation to an approved gate and back open', async () => {
    await withServer(async (origin) => {
      const created = await post(origin, '/api/identity/runs', { runId: 'api-run' });
      expect(created.status).toBe(201);
      expect((await created.json() as { status: string }).status).toBe('queued');

      const started = await post(origin, '/api/identity/runs/api-run/start', { approverRole: 'captain' });
      const startedBody = await started.json() as { status: string; directions: Array<{ directionId: string }>; divergence: { passed: boolean } };
      expect(started.status).toBe(200);
      expect(startedBody.status).toBe('needs_review');
      expect(startedBody.directions).toHaveLength(3);
      expect(startedBody.divergence.passed).toBe(true);

      const approved = await post(origin, '/api/identity/runs/api-run/approve', { approverRole: 'captain', directionId: 'typographic-low-chroma', rationale: 'Aprovada.' });
      expect((await approved.json() as { gate: { state: string } }).gate.state).toBe('closed');

      const reopened = await post(origin, '/api/identity/runs/api-run/token', { approverRole: 'captain', tokenPath: 'color.ink', value: '#111111', rationale: 'Tinta mais escura.' });
      expect((await reopened.json() as { gate: { state: string } }).gate.state).toBe('reopened');

      const fetched = await fetch(`${origin}/api/identity/runs/api-run`, { headers: { origin: STUDIO_ORIGIN } });
      expect((await fetched.json() as { status: string }).status).toBe('reopened');
    });
  });

  it('refuses a start, an approval and a token change from anyone but the captain', async () => {
    await withServer(async (origin) => {
      await post(origin, '/api/identity/runs', { runId: 'guarded' });
      for (const [path, payload] of [
        ['/api/identity/runs/guarded/start', {}],
        ['/api/identity/runs/guarded/approve', { directionId: 'editorial-material' }],
        ['/api/identity/runs/guarded/token', { tokenPath: 'color.ink', value: { $value: '#000000' } }],
      ] as const) {
        const response = await post(origin, path, { ...payload, approverRole: 'designer' });
        expect(response.status).toBe(403);
      }
    });
  });

  it('refuses a state-changing identity request from another origin', async () => {
    await withServer(async (origin) => {
      const response = await fetch(`${origin}/api/identity/runs`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: '{}' });
      expect(response.status).toBe(403);
    });
  });

  it('rejects a token change that carries anything but a value', async () => {
    await withServer(async (origin) => {
      await post(origin, '/api/identity/runs', { runId: 'bad-token' });
      await post(origin, '/api/identity/runs/bad-token/start', { approverRole: 'captain' });
      await post(origin, '/api/identity/runs/bad-token/approve', { approverRole: 'captain', directionId: 'editorial-material', rationale: 'ok' });
      // The caller does not get to declare the token's type; it sends the value the approved token takes.
      const response = await post(origin, '/api/identity/runs/bad-token/token', { approverRole: 'captain', tokenPath: 'color.ink', value: { $value: '#000000', $type: 'dimension' } });
      expect(response.status).toBe(400);
    });
  });

  it('answers 400 when the captain approves a blocked direction without an override', async () => {
    await withServer(async (origin) => {
      await post(origin, '/api/identity/runs', { runId: 'blocked-gate' });
      await post(origin, '/api/identity/runs/blocked-gate/start', { approverRole: 'captain' });
      await post(origin, '/api/identity/runs/blocked-gate/approve', { approverRole: 'captain', directionId: 'editorial-material', rationale: 'ok' });
      await post(origin, '/api/identity/runs/blocked-gate/token', { approverRole: 'captain', tokenPath: 'type.display', value: 'Inter-only hero, Georgia, serif' });
      const refused = await post(origin, '/api/identity/runs/blocked-gate/approve', { approverRole: 'captain', directionId: 'editorial-material', rationale: 'Mesmo assim.' });
      expect(refused.status).toBe(400);
      expect((await refused.json() as { error: string }).error).toMatch(/automatic selection is not allowed/);
    });
  });

  it('refuses a value the approved token cannot take with a 400 and the reason', async () => {
    await withServer(async (origin) => {
      await post(origin, '/api/identity/runs', { runId: 'typed-token' });
      await post(origin, '/api/identity/runs/typed-token/start', { approverRole: 'captain' });
      await post(origin, '/api/identity/runs/typed-token/approve', { approverRole: 'captain', directionId: 'editorial-material', rationale: 'ok' });
      const response = await post(origin, '/api/identity/runs/typed-token/token', { approverRole: 'captain', tokenPath: 'space.md', value: '#ff7a00' });
      expect(response.status).toBe(400);
      expect((await response.json() as { error: string }).error).toMatch(/dimension token expects/);
    });
  });

  it('serves, refuses re-creation of, and decides a run across a server restart', async () => {
    const dbPath = join(directory, 'restart.sqlite');
    const releaseRoot = join(directory, 'restart-releases');
    const first = await startServer({ dbPath, releaseRoot, apiPort: 0, previewPort: 0 });
    const firstOrigin = `http://127.0.0.1:${(first.api.address() as AddressInfo).port}`;
    await post(firstOrigin, '/api/identity/runs', { runId: 'restarted' });
    await post(firstOrigin, '/api/identity/runs/restarted/start', { approverRole: 'captain' });
    await first.close();

    const second = await startServer({ dbPath, releaseRoot, apiPort: 0, previewPort: 0 });
    const origin = `http://127.0.0.1:${(second.api.address() as AddressInfo).port}`;
    try {
      const fetched = await fetch(`${origin}/api/identity/runs/restarted`, { headers: { origin: STUDIO_ORIGIN } });
      expect(fetched.status).toBe(200);
      const restored = await fetched.json() as { status: string; directions: unknown[] };
      expect(restored.status).toBe('needs_review');
      expect(restored.directions).toHaveLength(3);

      // Creating over a run that is only on disk would hand the captain an empty
      // one under an id whose approvals are already in the ledger.
      const recreated = await post(origin, '/api/identity/runs', { runId: 'restarted' });
      expect(recreated.status).toBe(409);

      const approved = await post(origin, '/api/identity/runs/restarted/approve', { approverRole: 'captain', directionId: 'editorial-material', rationale: 'Decidida depois do reinício.' });
      expect((await approved.json() as { gate: { state: string } }).gate.state).toBe('closed');
    } finally { await second.close(); }
  });

  it('builds one run when two cold requests decide it at once', async () => {
    const dbPath = join(directory, 'concurrent.sqlite');
    const releaseRoot = join(directory, 'concurrent-releases');
    const first = await startServer({ dbPath, releaseRoot, apiPort: 0, previewPort: 0 });
    const firstOrigin = `http://127.0.0.1:${(first.api.address() as AddressInfo).port}`;
    await post(firstOrigin, '/api/identity/runs', { runId: 'contended' });
    await post(firstOrigin, '/api/identity/runs/contended/start', { approverRole: 'captain' });
    await first.close();

    const second = await startServer({ dbPath, releaseRoot, apiPort: 0, previewPort: 0 });
    const origin = `http://127.0.0.1:${(second.api.address() as AddressInfo).port}`;
    try {
      // Nothing is cached yet, so both requests would each rebuild the run. Two
      // instances would each read a ledger the other has already moved on from,
      // and the second decision would be swallowed as a duplicate row.
      const answers = await Promise.all([
        post(origin, '/api/identity/runs/contended/approve', { approverRole: 'captain', directionId: 'editorial-material', rationale: 'Primeira decisão.' }),
        post(origin, '/api/identity/runs/contended/approve', { approverRole: 'captain', directionId: 'modular-technical', rationale: 'Segunda decisão.' }),
      ]);
      const statuses = answers.map((answer) => answer.status).sort();
      expect(statuses).toEqual([200, 400]);

      const refused = answers.find((answer) => answer.status === 400)!;
      expect((await refused.json() as { error: string }).error).toMatch(/already closed|different direction cannot be approved/);

      const fetched = await fetch(`${origin}/api/identity/runs/contended`, { headers: { origin: STUDIO_ORIGIN } });
      const snapshot = await fetched.json() as { gate: { state: string }; approvals: Array<{ id: string }> };
      expect(snapshot.gate.state).toBe('closed');
      // The one decision the server accepted is the one the ledger holds.
      expect(snapshot.approvals).toHaveLength(1);
    } finally { await second.close(); }
  });

  it('lets only the captain stop a run', async () => {
    await withServer(async (origin) => {
      await post(origin, '/api/identity/runs', { runId: 'stoppable' });
      const refused = await post(origin, '/api/identity/runs/stoppable/cancel', { approverRole: 'designer' });
      expect(refused.status).toBe(403);

      const stopped = await post(origin, '/api/identity/runs/stoppable/cancel', { approverRole: 'captain' });
      expect(stopped.status).toBe(200);
      expect((await stopped.json() as { status: string }).status).toBe('cancelled');

      // The run is over: it cannot be started to spend the turns it was stopped before.
      const restarted = await post(origin, '/api/identity/runs/stoppable/start', { approverRole: 'captain' });
      expect(restarted.status).toBe(400);
    });
  });

  it('answers 404 for an unknown identity run', async () => {
    await withServer(async (origin) => {
      const response = await fetch(`${origin}/api/identity/runs/ghost`, { headers: { origin: STUDIO_ORIGIN } });
      expect(response.status).toBe(404);
    });
  });
});
