import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFixtureIR } from '@pwb/domain';
import { CODEX_ALLOWLIST_DIRECTORY } from '@pwb/providers';
import type { QaCheck } from '@pwb/qa-deterministic';
import {
  ClaudeCritiqueRunner, CodexSession, CritiqueUnavailableError, FakeCritiqueProvider, MIN_RUBRIC_SCORE, criticRegistry,
  critiqueReportSchema, definitionFor, issueHash, renderCritiquePrompt, rubricAverage,
  ALLOWED_PATCH_OPERATIONS, type CritiqueTask, type Finding,
} from './index.js';

const identity = createFixtureIR().identity;

function task(overrides: Partial<CritiqueTask> = {}): CritiqueTask {
  return {
    id: 'run-critique-coherence-c1', dimension: 'coherence', stage: 'prototype', promptVersion: 'v1',
    criticSessionId: 'session-1', deadlineMs: 60_000, brief: 'Briefing fixo.', identity,
    routeSlices: [{ route: '/', title: 'Início', nodes: createFixtureIR().pages.routes[0]!.nodes }],
    qaChecks: [], captures: [{ context: { route: '/', viewport: 390, state: 'default', colorScheme: 'light', reducedMotion: false }, screenshotPath: '/tmp/home.png' }],
    allowedOperations: ALLOWED_PATCH_OPERATIONS,
    ...overrides,
  };
}

const rhythmCheck: QaCheck = {
  id: 'QA1-RHYTHM', tier: 1, severity: 'major', title: 'Ritmo', nodeIds: ['home-title'],
  message: 'O nó home-title usa gap de 19.0px, fora do ritmo de 24px.',
  context: { route: '/', viewport: 390, state: 'default', colorScheme: 'light', reducedMotion: false },
};

/** Deliberately loose so the negative cases can hand the schema shapes it must refuse. */
function report(overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: '1', stage: 'prototype', dimension: 'coherence', criticSessionId: 'session-1',
    perception: { summary: 'Uma rota, três blocos.', regions: [] },
    comprehension: { hierarchy: 'título domina', intent: 'apresentar', brandAlignment: 'coerente' },
    projection: { verdict: 'pass', rubric: [{ criterion: 'Token fidelity', score: 4, evidence: 'tokens resolvidos' }], findings: [], ...overrides },
  };
}

describe('critique contract', () => {
  it('registers exactly the four prototype critics, each with a rubric and its own vetoes', () => {
    expect(criticRegistry.map((critic) => critic.dimension)).toEqual(['narrative', 'responsiveness', 'a11y-interaction', 'coherence']);
    for (const critic of criticRegistry) {
      expect(critic.rubric.length).toBeGreaterThanOrEqual(4);
      expect(critic.vetoes.length).toBeGreaterThan(0);
      expect(critic.rubric.every((entry) => entry.behaviour.includes('4 ='))).toBe(true);
    }
    expect(() => definitionFor('narrative')).not.toThrow();
  });

  it('refuses a pass that hides a low score or a blocking finding', () => {
    expect(() => critiqueReportSchema.parse(report({ rubric: [{ criterion: 'Token fidelity', score: 2, evidence: 'baixa' }] })))
      .toThrow(new RegExp(`needs at least ${MIN_RUBRIC_SCORE}`));
    const blocking: Finding = {
      id: 'f1', dimension: 'coherence', severity: 'blocker', evidence: { route: '/', viewport: 390, state: 'default', colorScheme: 'light', reducedMotion: false, nodeIds: ['home-title'] },
      observation: 'default proibido', why: 'contradiz o contrato', confidence: 0.9, checks: [], abstain: false,
    };
    expect(() => critiqueReportSchema.parse(report({ findings: [blocking] }))).toThrow(/cannot carry a blocking or major finding/);
    expect(() => critiqueReportSchema.parse(report({ verdict: 'revise', findings: [] }))).toThrow(/must say what to revise/);
  });

  it('refuses a finding from another dimension and a repair attached to an abstention', () => {
    const foreign = { id: 'f1', dimension: 'narrative', severity: 'minor', evidence: { route: '/', viewport: 390, state: 'default', colorScheme: 'light', reducedMotion: false, nodeIds: ['home-title'] }, observation: 'o', why: 'w', confidence: 0.6, checks: [], abstain: false };
    expect(() => critiqueReportSchema.parse(report({ verdict: 'revise', findings: [foreign] }))).toThrow(/may only report findings of its own dimension/);
    const abstaining = { ...foreign, dimension: 'coherence', abstain: true, patch: { operation: 'replace_copy', nodeId: 'home-title', text: 'novo' } };
    expect(() => critiqueReportSchema.parse(report({ verdict: 'revise', findings: [abstaining] }))).toThrow(/abstains, so it must not carry a repair/);
  });

  it('keeps the causal identity of a problem stable and separates different repairs', () => {
    const base: Finding = {
      id: 'f1', dimension: 'coherence', severity: 'major', evidence: { route: '/', viewport: 390, state: 'default', colorScheme: 'light', reducedMotion: false, nodeIds: ['b', 'a'] },
      observation: 'ritmo fora', why: 'contrato', confidence: 0.8, checks: ['QA1-RHYTHM'], abstain: false,
      patch: { operation: 'set_token', nodeId: 'home-title', prop: 'gap', token: '{space.md}' },
    };
    const reworded = { ...base, id: 'f9', observation: 'outro texto', confidence: 0.6, evidence: { ...base.evidence, viewport: 1440, nodeIds: ['a', 'b'] } };
    expect(issueHash(reworded)).toBe(issueHash(base));
    expect(issueHash({ ...base, patch: { operation: 'set_token', nodeId: 'home-title', prop: 'padding', token: '{space.md}' } })).not.toBe(issueHash(base));
    expect(rubricAverage([critiqueReportSchema.parse(report())])).toBe(4);
    expect(rubricAverage([])).toBe(0);
  });
});

describe('critique prompt', () => {
  it('places the contract and the rubric before the screenshots', () => {
    const prompt = renderCritiquePrompt(task({ qaChecks: [rhythmCheck] }));
    const contract = prompt.indexOf('Approved identity contract');
    const rubric = prompt.indexOf('Rubric.');
    const images = prompt.indexOf('Screenshots to read last');
    expect(contract).toBeGreaterThan(-1);
    expect(rubric).toBeGreaterThan(contract);
    expect(images).toBeGreaterThan(rubric);
    expect(prompt).toContain('you never edit the document');
    expect(prompt).toContain('QA1-RHYTHM');
    expect(prompt).toContain('/tmp/home.png');
    expect(prompt).toContain(ALLOWED_PATCH_OPERATIONS.join(', '));
    expect(prompt).not.toContain('token=');
  });
});

describe('critique providers', () => {
  it('turns Tier 1 evidence into a typed report with one minimal repair per defect', async () => {
    const answer = await new FakeCritiqueProvider().critique(task({ qaChecks: [rhythmCheck, { ...rhythmCheck, context: { ...rhythmCheck.context!, viewport: 1440 } }] }));
    expect(answer.projection.verdict).toBe('revise');
    expect(answer.projection.findings).toHaveLength(1);
    expect(answer.projection.findings[0]!.patch).toEqual({ operation: 'set_token', nodeId: 'home-title', prop: 'gap', token: identity.gridGrammar.rhythmToken });
    expect(answer.projection.rubric.every((entry) => entry.score < MIN_RUBRIC_SCORE)).toBe(true);
  });

  it('passes a clean revision and abstains rather than judging partial accessibility', async () => {
    expect((await new FakeCritiqueProvider().critique(task())).projection.verdict).toBe('pass');
    const axe: QaCheck = { id: 'QA1-AXE', tier: 1, severity: 'minor', title: 'axe', nodeIds: ['home-root'], message: 'axe region (moderate)', context: rhythmCheck.context! };
    const answer = await new FakeCritiqueProvider().critique(task({ dimension: 'a11y-interaction', qaChecks: [axe] }));
    expect(answer.projection.verdict).toBe('uncertain');
    expect(answer.projection.findings[0]!.abstain).toBe(true);
    expect(answer.projection.findings[0]!.patch).toBeUndefined();
  });

  it('runs a real critic as its own session with a closed schema, and never leaks a credential', async () => {
    const calls: string[][] = [];
    const runner = new ClaudeCritiqueRunner({
      execute: async (_executable, args) => { calls.push(args); return JSON.stringify({ structured_output: report() }); },
    });
    const answer = await runner.critique(task());
    expect(answer.dimension).toBe('coherence');
    const args = calls[0]!;
    expect(args).toContain('--no-session-persistence');
    expect(args).toContain('--json-schema');
    // The process gets a fresh id, never the task's own name: the CLI takes a UUID, and a correction
    // has to reach a session that has never seen the answer it is correcting.
    expect(args[args.indexOf('--session-id') + 1]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(args[args.indexOf('--disallowed-tools') + 1]).toContain('Bash');
    expect(args[args.indexOf('--disallowed-tools') + 1]).not.toContain('Read');
    // "token" appears legitimately in the schema as a design token reference; a credential never does.
    expect(args.join(' ')).not.toMatch(/(api[_-]?key|secret|password|bearer|authorization|oauth)\s*[:=]/i);
    expect(args.join(' ')).not.toMatch(/\bsk-[A-Za-z0-9]/);
    expect(args).not.toContain('--api-key');
  });

  it('hands a sandboxed critic its own captures and nothing else, with the prompt pointing at the copies', async () => {
    const captures = await mkdtemp(join(tmpdir(), 'pwb-critic-captures-'));
    const screenshotPath = join(captures, 'home.png');
    await writeFile(screenshotPath, 'fixture-capture-bytes', 'utf8');
    const repository = resolve(dirname(new URL(import.meta.url).pathname), '..', '..', '..');
    try {
      let entries: string[] = [];
      let prompt = '';
      let copied = '';
      const runner = new ClaudeCritiqueRunner({
        session: new CodexSession({
          execute: async (_executable, args) => {
            const workspace = args[args.indexOf('-C') + 1]!;
            prompt = args[args.length - 1]!;
            entries = (await readdir(workspace)).sort();
            copied = await readFile(join(workspace, CODEX_ALLOWLIST_DIRECTORY, '0', 'home.png'), 'utf8');
            return { stdout: `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(report()) } })}\n`, stderr: '' };
          },
        }),
      });

      await expect(runner.critique(task({ captures: [{ context: { route: '/', viewport: 390, state: 'default', colorScheme: 'light', reducedMotion: false }, screenshotPath }] })))
        .resolves.toMatchObject({ dimension: 'coherence' });
      // The capture is in the workspace; the checkout the suite runs in is not.
      expect(entries).toEqual([CODEX_ALLOWLIST_DIRECTORY, 'schema.json']);
      expect(copied).toBe('fixture-capture-bytes');
      expect(prompt).not.toContain(screenshotPath);
      expect(prompt).toContain(join(CODEX_ALLOWLIST_DIRECTORY, '0', 'home.png'));
      expect(prompt).not.toContain(repository + sep);
    } finally {
      await rm(captures, { recursive: true, force: true });
    }
  });

  it('still critiques when a browserless run names captures no file backs', async () => {
    let entries: string[] = [];
    let prompt = '';
    // What DerivedEvidenceSource and createCleanEvidence hand a browserless `run:prototype`.
    const captures = [
      { context: { route: '/', viewport: 390, state: 'default', colorScheme: 'light', reducedMotion: false }, screenshotPath: 'derived://cli-prototype/#390-default' },
      { context: { route: '/', viewport: 768, state: 'default', colorScheme: 'light', reducedMotion: false }, screenshotPath: 'memory:///' },
    ] as CritiqueTask['captures'];
    const runner = new ClaudeCritiqueRunner({
      session: new CodexSession({
        execute: async (_executable, args) => {
          const workspace = args[args.indexOf('-C') + 1]!;
          prompt = args[args.length - 1]!;
          entries = (await readdir(workspace)).sort();
          return { stdout: `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(report()) } })}\n`, stderr: '' };
        },
      }),
    });

    await expect(runner.critique(task({ captures }))).resolves.toMatchObject({ dimension: 'coherence' });
    // Nothing was copied in, and the prompt names the pseudo-paths exactly as it always did.
    expect(entries).toEqual(['schema.json']);
    for (const capture of captures) expect(prompt).toContain(capture.screenshotPath);
  });

  it('escalates instead of inventing a verdict when the critic cannot answer its contract', async () => {
    const invalid = new ClaudeCritiqueRunner({ execute: async () => JSON.stringify({ structured_output: { schemaVersion: '1' } }) });
    await expect(invalid.critique(task())).rejects.toThrow(CritiqueUnavailableError);

    const wrongDimension = new ClaudeCritiqueRunner({ execute: async () => JSON.stringify({ structured_output: { ...(report() as object), dimension: 'narrative' } }) });
    await expect(wrongDimension.critique(task())).rejects.toThrow(/answered as narrative/);
  });

  it('retries a malformed answer exactly once before escalating', async () => {
    let attempts = 0;
    const runner = new ClaudeCritiqueRunner({
      execute: async () => { attempts += 1; return attempts === 1 ? 'not json' : JSON.stringify({ structured_output: report() }); },
    });
    await expect(runner.critique(task())).resolves.toMatchObject({ dimension: 'coherence' });
    expect(attempts).toBe(2);
  });
});
