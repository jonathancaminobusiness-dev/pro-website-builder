import { describe, expect, it } from 'vitest';
import { createFixtureIR, visualPropKeys, type AgentTask } from '@pwb/domain';
import {
  FakeInformationArchitect, locateSection, patchablePropSchema, routeManifestSchema,
  sectionAllowedPaths, stagePrototypeContractSchemaJson, critiqueSchemaJson, type RouteManifest,
} from './index.js';

const identity = createFixtureIR().identity;
const task: AgentTask = {
  id: 'task-architect', attempt: 1, stage: 'prototype', role: 'composer', state: 'queued', lane: 'claude',
  baseVersionId: 'v0', inputDigest: 'digest', promptVersion: 'p1', modelAlias: 'fake', deadlineMs: 5000,
  allowedPaths: ['/pages'], brief: 'Briefing fixo.', documentSlice: { '/identity': identity },
};

async function manifest(): Promise<RouteManifest> {
  return new FakeInformationArchitect().plan(task);
}

describe('prototype contracts', () => {
  it('gives every section a contiguous window that never overlaps another', async () => {
    const plan = await manifest();
    for (const route of plan.routes) {
      let expected = 1;
      for (const section of route.sections) {
        expect(section.nodeRange.start).toBe(expected);
        expect(section.nodeIds).toHaveLength(section.nodeRange.count);
        expected += section.nodeRange.count;
      }
    }
    const paths = plan.routes.flatMap((route) => route.sections.flatMap((section) => sectionAllowedPaths(plan, section.id)));
    expect(new Set(paths).size).toBe(paths.length);
    expect(sectionAllowedPaths(plan, 'home-hero')).toEqual(['/pages/routes/0/nodes/1', '/pages/routes/0/nodes/2', '/pages/routes/0/nodes/3', '/pages/routes/0/nodes/4']);
    expect(locateSection(plan, 'proof-narrative').routeIndex).toBe(1);
    expect(() => locateSection(plan, 'nope')).toThrow('no section nope');
  });

  it('refuses a manifest whose windows collide, skip a slot or claim the route shell', async () => {
    const plan = await manifest();
    const overlapping = structuredClone(plan);
    overlapping.routes[0]!.sections[1]!.nodeRange.start = 2;
    expect(() => routeManifestSchema.parse(overlapping)).toThrow(/expects 5 so the windows stay contiguous and disjoint/);

    const shellClaim = structuredClone(plan);
    shellClaim.routes[0]!.sections[0]!.nodeIds[0] = 'home-shell';
    expect(() => routeManifestSchema.parse(shellClaim)).toThrow(/is the shell the architect owns/);

    const shared = structuredClone(plan);
    shared.routes[1]!.sections[0]!.nodeIds[1] = 'home-hero-title';
    expect(() => routeManifestSchema.parse(shared)).toThrow(/claimed by more than one section/);
  });

  it('refuses two sections that share an id, because an id resolves one window and one composer task', async () => {
    const plan = await manifest();
    const collision = structuredClone(plan);
    collision.routes[1]!.sections[0]!.id = 'home-hero';
    expect(() => routeManifestSchema.parse(collision)).toThrow(/repeats the section id home-hero/);

    // Left unchecked, both sections would resolve to the window of the first one that matches.
    expect(sectionAllowedPaths(collision, 'home-hero')).toEqual(sectionAllowedPaths(plan, 'home-hero'));
  });

  it('refuses a state that names a node no section declares, and requires a default state', async () => {
    const plan = await manifest();
    const ghost = structuredClone(plan);
    ghost.states[0]!.hidden = ['not-a-node'];
    expect(() => routeManifestSchema.parse(ghost)).toThrow(/refers to not-a-node/);

    const stateless = structuredClone(plan);
    stateless.states = stateless.states.filter((state) => state.id !== 'default');
    expect(() => routeManifestSchema.parse(stateless)).toThrow(/must declare a default state/);
  });

  it('keeps the critic prop vocabulary identical to the renderer vocabulary', () => {
    expect(new Set(patchablePropSchema.options)).toEqual(visualPropKeys);
  });

  it('emits JSON Schema a strict validator accepts, with no bare type unions', () => {
    const documents = [stagePrototypeContractSchemaJson.RouteManifest, stagePrototypeContractSchemaJson.SectionComposition, critiqueSchemaJson.CritiqueReport, critiqueSchemaJson.Finding];
    const unions: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) { node.forEach((entry, index) => walk(entry, `${path}/${index}`)); return; }
      if (!node || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === 'type' && Array.isArray(value)) unions.push(path);
        walk(value, `${path}/${key}`);
      }
    };
    for (const [index, document] of documents.entries()) walk(document, `#${index}`);
    expect(unions).toEqual([]);
    expect(JSON.stringify(documents[0])).toContain('nodeRange');
  });
});
