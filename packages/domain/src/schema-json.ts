import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { agentResultSchema, patchOperationSchema, patchSchema, stageSchema, taskRoleSchema } from './agent.js';
import { assetsSchema, pagesSchema, reviewRecordSchema } from './ir.js';
import { identitySpecSchema } from './identity.js';

type Stage = z.infer<typeof stageSchema>;
type Role = z.infer<typeof taskRoleSchema>;

/** Rewrites `type: [...]` unions into `anyOf`, which the Claude Code strict schema validator accepts. */
export function withoutUnionTypes(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutUnionTypes);
  if (!node || typeof node !== 'object') return node;
  const entry = Object.fromEntries(Object.entries(node as Record<string, unknown>).map(([key, value]) => [key, withoutUnionTypes(value)]));
  if (!Array.isArray(entry.type)) return entry;
  const { type, ...rest } = entry;
  return { ...rest, anyOf: (type as string[]).map((item) => ({ type: item })) };
}

function inlinedJsonSchema(schema: z.ZodTypeAny): unknown {
  return withoutUnionTypes(zodToJsonSchema(schema, { $refStrategy: 'none' }));
}

const pathValueSchemas = {
  '/identity': identitySpecSchema,
  '/pages': pagesSchema,
  '/assets': assetsSchema,
  '/reviewRecord': reviewRecordSchema,
} as const;

export const stageRoles: Record<Stage, Role> = { identity: 'director', prototype: 'composer', finalization: 'compiler' };

export const stageWritablePaths: Record<Stage, Array<keyof typeof pathValueSchemas>> = {
  identity: ['/identity', '/reviewRecord'],
  prototype: ['/pages', '/assets', '/reviewRecord'],
  finalization: ['/pages', '/assets', '/reviewRecord'],
};

export const documentPathSchemas: Record<string, unknown> = Object.fromEntries(
  Object.entries(pathValueSchemas).map(([path, schema]) => [path, inlinedJsonSchema(schema)]),
);

function stageOperationSchema(stage: Stage): z.ZodTypeAny {
  const paths = stageWritablePaths[stage];
  const roots: z.ZodTypeAny[] = paths.map((path) => patchOperationSchema.extend({ path: z.literal(path), value: pathValueSchemas[path].optional() }));
  const nested: z.ZodTypeAny = patchOperationSchema.extend({ path: z.string().regex(new RegExp(`^(${paths.join('|')})/`), `A ${stage} operation replaces ${paths.join(' or ')} as a whole subtree matching its schema, or writes a path beneath one of them.`) });
  const alternatives: [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]] = [roots[0]!, nested, ...roots.slice(1)];
  return z.union(alternatives);
}

function stagePatchSchema(stage: Stage): z.ZodTypeAny {
  const declared = { errorMap: () => ({ message: `This task is the ${stage} stage worked by the ${stageRoles[stage]}; a proposal must declare exactly that stage and role.` }) };
  return patchSchema.extend({ stage: z.literal(stage, declared), role: z.literal(stageRoles[stage], declared), operations: z.array(stageOperationSchema(stage)).min(1) });
}

export const stagePatchSchemas: Record<Stage, z.ZodTypeAny> = {
  identity: stagePatchSchema('identity'),
  prototype: stagePatchSchema('prototype'),
  finalization: stagePatchSchema('finalization'),
};

export const stageResultJsonSchemas: Record<Stage, unknown> = {
  identity: inlinedJsonSchema(agentResultSchema.extend({ proposal: stagePatchSchemas.identity.optional() })),
  prototype: inlinedJsonSchema(agentResultSchema.extend({ proposal: stagePatchSchemas.prototype.optional() })),
  finalization: inlinedJsonSchema(agentResultSchema.extend({ proposal: stagePatchSchemas.finalization.optional() })),
};
