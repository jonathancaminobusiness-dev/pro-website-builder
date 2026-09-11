import { describe, expect, it } from 'vitest';
import { agentTaskSchema, createFixtureIR, stageRoles, type AgentTask, type IdentitySpec } from '@pwb/domain';
import { Applier, PatchGate, Scheduler, VersionStore } from '@pwb/orchestrator';
import {
  ClaudeInformationArchitect, ClaudeSectionComposer, ClaudeSessionError, DerivedEvidenceSource,
  FakeCritiqueProvider, FakeInformationArchitect, FakeSectionComposer, PrototypeStage,
  type RouteManifest, type SectionPlan, type StructuredSession,
} from './index.js';

const identity: IdentitySpec = createFixtureIR().identity;

function task(id: string, attempt = 1): AgentTask {
  return agentTaskSchema.parse({
    id, attempt, stage: 'prototype', role: stageRoles.prototype, state: 'queued', lane: 'claude',
    baseVersionId: 'v0', inputDigest: 'brief', promptVersion: '1', modelAlias: 'claude-local', deadlineMs: 60_000,
    allowedPaths: ['/pages'], brief: 'Compilar a identidade aprovada.', documentSlice: { '/identity': identity },
  } satisfies AgentTask);
}

/** A session the test answers for, so the adapter's own prompt and schema are what is observed. */
function scripted(answer: unknown | Error): { asked: Array<{ prompt: string; schema: unknown; deadlineMs: number }>; session: StructuredSession } {
  const asked: Array<{ prompt: string; schema: unknown; deadlineMs: number }> = [];
  return {
    asked,
    session: {
      ask: async (input) => {
        asked.push({ prompt: input.prompt, schema: input.schema, deadlineMs: input.deadlineMs });
        if (answer instanceof Error) throw answer;
        return input.parse(answer);
      },
    },
  };
}

async function fixtureManifest(): Promise<RouteManifest> {
  return new FakeInformationArchitect().plan(task('manifest'));
}

describe('ClaudeInformationArchitect', () => {
  it('asks one session for a RouteManifest against the closed schema and validates the answer itself', async () => {
    const manifest = await fixtureManifest();
    const { asked, session } = scripted(manifest);

    const planned = await new ClaudeInformationArchitect({ session }).plan(task('run-1-architect'));

    expect(planned).toEqual(manifest);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.deadlineMs).toBe(60_000);
    // The prompt carries the frozen identity contract and the brief, and never the whole document.
    expect(asked[0]!.prompt).toContain(identity.direction.thesis);
    expect(asked[0]!.prompt).toContain('frozen and read-only');
    expect(asked[0]!.schema).toMatchObject({ type: 'object' });
  });

  it('refuses an answer that is not a RouteManifest rather than handing the stage a shape it never checked', async () => {
    const { session } = scripted({ schemaVersion: '1', journey: 'sem rotas', routes: [], states: [] });
    await expect(new ClaudeInformationArchitect({ session }).plan(task('run-1-architect'))).rejects.toThrow();
  });

  it('lets the session error reach the stage as the typed failure it is', async () => {
    const { session } = scripted(new ClaudeSessionError('TIMEOUT', 'The Claude Code process was terminated by a timeout.'));
    await expect(new ClaudeInformationArchitect({ session }).plan(task('run-1-architect')))
      .rejects.toMatchObject({ name: 'ClaudeSessionError', errorCode: 'TIMEOUT' });
  });
});

describe('ClaudeSectionComposer', () => {
  it('asks one session per section for its own window, and gives it only that window to fill', async () => {
    const manifest = await fixtureManifest();
    const section: SectionPlan = manifest.routes[0]!.sections[0]!;
    const composition = await new FakeSectionComposer().compose(task('run-1-compose-home-hero'), section, manifest);
    const { asked, session } = scripted(composition);

    const answer = await new ClaudeSectionComposer({ session }).compose(task('run-1-compose-home-hero'), section, manifest);

    expect(answer.sectionId).toBe(section.id);
    expect(asked[0]!.prompt).toContain(section.nodeIds.join(', '));
    expect(asked[0]!.prompt).toContain('Other composers are working on other sections at the same time');
    // The identity is handed over frozen, and the routes a link may point at are the journey's own.
    expect(asked[0]!.prompt).toContain('frozen and read-only');
    for (const route of manifest.routes) expect(asked[0]!.prompt).toContain(route.route);
  });

  it('refuses a composition whose nodes leave the token system before the stage ever sees it', async () => {
    const manifest = await fixtureManifest();
    const section: SectionPlan = manifest.routes[0]!.sections[0]!;
    const composition = await new FakeSectionComposer().compose(task('run-1-compose-home-hero'), section, manifest);
    const [root, ...rest] = composition.nodes;
    const { session } = scripted({ ...composition, nodes: [{ ...root!, props: { ...root!.props, background: '#101010' } }, ...rest] });

    await expect(new ClaudeSectionComposer({ session }).compose(task('run-1-compose-home-hero'), section, manifest)).rejects.toThrow();
  });

  it('degrades to a reviewable gap when its session keeps failing, instead of ending the stage', async () => {
    const store = new VersionStore();
    const applier = new Applier(store, new PatchGate());
    const base = applier.createRoot(createFixtureIR());
    const events: string[] = [];
    let attempts = 0;

    // The real adapter, with a session that never answers for one section: exactly what a local binary
    // that will not start looks like from here.
    const failing = new ClaudeSectionComposer({
      session: { ask: async () => { attempts += 1; throw new ClaudeSessionError('ENOENT', 'The Claude Code process failed with ENOENT.'); } },
    });
    const composer = {
      compose: async (queued: AgentTask, section: SectionPlan, manifest: RouteManifest, signal?: AbortSignal) =>
        section.id === 'home-proof'
          ? failing.compose(queued, section, manifest, signal)
          : new FakeSectionComposer().compose(queued, section, manifest, signal),
    };

    const outcome = await new PrototypeStage({
      modelAlias: 'claude-local',
      store, applier, scheduler: new Scheduler({ maxActiveClaude: 3 }),
      architect: new FakeInformationArchitect(), composer, critique: new FakeCritiqueProvider(),
      evidence: new DerivedEvidenceSource(), brief: 'Compilar a identidade aprovada.',
      onEvent: (type) => { events.push(type); },
    }).run({ runId: 'run-degrade', baseVersionId: base.id });

    // One retry, then the section is handed on as a gap and the rest of the review survives.
    expect(attempts).toBe(2);
    expect(outcome.failedSections).toEqual([{ sectionId: 'home-proof', route: '/', reason: 'The Claude Code process failed with ENOENT.' }]);
    expect(events).toContain('prototype.section.unavailable');
    expect(outcome.gate).toBe('needs_review');
    expect(outcome.reports.length).toBeGreaterThan(0);
  });
});
