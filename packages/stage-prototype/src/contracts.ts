import { z } from 'zod';
import { inlinedJsonSchema, pageNodeSchema, routeSchema } from '@pwb/domain';

export const sectionRoleSchema = z.enum(['hero', 'narrative', 'proof', 'action', 'support']);

/** Slot 0 of every route holds the shell the architect wires; no composer may write it. */
export const ROUTE_SHELL_SLOT = 0;

/**
 * The information architect allocates every section a disjoint window of node slots.
 * A composer owns exactly that window: it must fill every slot it was given and may not
 * reference a node outside it, which is what lets composers run in parallel without
 * two of them ever writing the same path.
 */
export const sectionPlanSchema = z.object({
  id: z.string().min(1),
  route: routeSchema,
  role: sectionRoleSchema,
  intent: z.string().min(1),
  headline: z.string().min(1),
  body: z.string().min(1),
  /** Where the section sends the visitor next; the composer emits it as the link that carries the journey. */
  callToAction: z.object({ label: z.string().min(1), href: routeSchema }).optional(),
  nodeIds: z.array(z.string().min(1)).min(1),
  nodeRange: z.object({ start: z.number().int().min(0), count: z.number().int().positive() }).strict(),
}).strict().superRefine((section, ctx) => {
  if (section.nodeIds.length !== section.nodeRange.count) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['nodeIds'], message: `Section ${section.id} reserves ${section.nodeRange.count} slots but names ${section.nodeIds.length} node ids.` });
  if (new Set(section.nodeIds).size !== section.nodeIds.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['nodeIds'], message: `Section ${section.id} repeats a node id.` });
});

export const routePlanSchema = z.object({
  id: z.string().min(1),
  route: routeSchema,
  title: z.string().min(1),
  journeyStep: z.number().int().positive(),
  purpose: z.string().min(1),
  rootNodeId: z.string().min(1),
  sections: z.array(sectionPlanSchema).min(1),
}).strict();

export const statePlanSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  motion: z.enum(['full', 'reduced']),
  hidden: z.array(z.string()),
  focus: z.string().nullable(),
}).strict();

/** What the serial information architect proposes: routes, journey, plausible content, states and ids. */
export const routeManifestSchema = z.object({
  schemaVersion: z.literal('1'),
  journey: z.string().min(1),
  routes: z.array(routePlanSchema).min(1),
  states: z.array(statePlanSchema).min(1),
}).strict().superRefine((manifest, ctx) => {
  const seenRoutes = new Set<string>();
  const seenNodeIds = new Set<string>();
  const seenSectionIds = new Set<string>();
  const destinations: Array<{ sectionId: string; href: string }> = [];
  for (const route of manifest.routes) {
    if (seenRoutes.has(route.route)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['routes'], message: `The manifest repeats the route ${route.route}.` });
    seenRoutes.add(route.route);
    seenNodeIds.add(route.rootNodeId);
    let expected = ROUTE_SHELL_SLOT + 1;
    for (const section of route.sections) {
      if (section.route !== route.route) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['routes'], message: `Section ${section.id} claims route ${section.route} inside ${route.route}.` });
      // A section id addresses one window: it names the composer task and resolves the paths that task may write.
      if (seenSectionIds.has(section.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['routes'], message: `The manifest repeats the section id ${section.id}; a section id has to name exactly one window across every route.` });
      seenSectionIds.add(section.id);
      // The composer emits this href as a real anchor, so the architect — not the composer — owns
      // the promise that it names a route this journey declares.
      if (section.callToAction) destinations.push({ sectionId: section.id, href: section.callToAction.href });
      if (section.nodeRange.start !== expected) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['routes'], message: `Section ${section.id} starts at slot ${section.nodeRange.start}; ${route.route} expects ${expected} so the windows stay contiguous and disjoint.` });
      expected += section.nodeRange.count;
      for (const nodeId of section.nodeIds) {
        if (nodeId === route.rootNodeId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['routes'], message: `Section ${section.id} claims ${nodeId}, which is the shell the architect owns.` });
        if (seenNodeIds.has(nodeId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['routes'], message: `Node id ${nodeId} is claimed by more than one section.` });
        seenNodeIds.add(nodeId);
      }
    }
  }
  for (const destination of destinations) {
    if (!seenRoutes.has(destination.href)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['routes'], message: `Section ${destination.sectionId} sends the visitor to ${destination.href}, which is not one of the routes this manifest declares.` });
  }
  if (!manifest.states.some((state) => state.id === 'default')) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['states'], message: 'The manifest must declare a default state.' });
  for (const state of manifest.states) {
    for (const nodeId of [...state.hidden, ...(state.focus === null ? [] : [state.focus])]) {
      if (!seenNodeIds.has(nodeId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['states'], message: `State ${state.id} refers to ${nodeId}, which no section declares.` });
    }
  }
});

/** What one section composer proposes: the node objects that fill its own window, and nothing else. */
export const sectionCompositionSchema = z.object({
  sectionId: z.string().min(1),
  nodes: z.array(pageNodeSchema).min(1),
  rationale: z.string().min(1),
  confidence: z.number().min(0).max(1),
}).strict();

export type SectionRole = z.infer<typeof sectionRoleSchema>;
export type SectionPlan = z.infer<typeof sectionPlanSchema>;
export type RoutePlan = z.infer<typeof routePlanSchema>;
export type StatePlan = z.infer<typeof statePlanSchema>;
export type RouteManifest = z.infer<typeof routeManifestSchema>;
export type SectionComposition = z.infer<typeof sectionCompositionSchema>;

/** The JSON pointer window a composer may write, and only that window. */
export function sectionAllowedPaths(manifest: RouteManifest, sectionId: string): string[] {
  const located = locateSection(manifest, sectionId);
  const paths: string[] = [];
  for (let offset = 0; offset < located.section.nodeRange.count; offset += 1) {
    paths.push(`/pages/routes/${located.routeIndex}/nodes/${located.section.nodeRange.start + offset}`);
  }
  return paths;
}

export function locateSection(manifest: RouteManifest, sectionId: string): { routeIndex: number; route: RoutePlan; section: SectionPlan } {
  for (const [routeIndex, route] of manifest.routes.entries()) {
    const section = route.sections.find((candidate) => candidate.id === sectionId);
    if (section) return { routeIndex, route, section };
  }
  throw new Error(`The manifest declares no section ${sectionId}.`);
}

export const stagePrototypeContractSchemaJson = {
  RouteManifest: inlinedJsonSchema(routeManifestSchema),
  SectionComposition: inlinedJsonSchema(sectionCompositionSchema),
};
