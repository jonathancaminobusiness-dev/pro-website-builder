import { z } from 'zod';
import { flattenTokens, tokenGroupSchema } from './tokens.js';

const provenanceSchema = z.object({
  source: z.string(), author: z.string(), license: z.string(), date: z.string(), hash: z.string(),
});

export const identitySpecSchema = z.object({
  meta: z.object({ id: z.string(), version: z.string(), locale: z.string(), status: z.enum(['draft', 'approved']) }),
  strategy: z.object({ audience: z.string(), job: z.string(), promise: z.string(), proof: z.array(z.string()), exclusions: z.array(z.string()) }),
  direction: z.object({ thesis: z.string(), tension: z.string(), materiality: z.string(), density: z.enum(['airy', 'balanced', 'dense']), divergenceVector: z.array(z.string()).min(3), rationale: z.string() }),
  tokens: tokenGroupSchema,
  tokenRoles: z.object({ surface: z.string(), text: z.string(), bodyTypeface: z.string(), baseSpacing: z.string(), sectionSpacing: z.string() }),
  gridGrammar: z.object({ maxWidthToken: z.string(), columns: z.number().int().positive(), gutterToken: z.string(), rhythmToken: z.string(), responsive: z.array(z.object({ container: z.string(), rule: z.string() })) }),
  imagery: z.object({ treatment: z.string(), focalPolicy: z.string(), allowedSources: z.array(z.string()) }),
  iconography: z.object({ family: z.string(), strokeToken: z.string(), naming: z.string() }),
  content: z.object({ voice: z.string(), message: z.string(), allowedTerms: z.array(z.string()), forbiddenTerms: z.array(z.string()) }),
  do: z.array(z.string()),
  dont: z.array(z.string()),
  forbiddenDefaults: z.object({ fonts: z.array(z.string()), palettes: z.array(z.string()), motifs: z.array(z.string()) }),
  governance: z.object({ approverRole: z.literal('captain'), rationaleRequired: z.boolean(), changePolicy: z.string() }),
  provenance: provenanceSchema,
}).superRefine((identity, ctx) => {
  const paths = flattenTokens(identity.tokens);
  for (const [role, path] of Object.entries(identity.tokenRoles)) {
    if (!paths.has(path)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tokenRoles', role], message: `Token role ${role} points at ${path}, which the identity does not define.` });
  }
});

export type IdentitySpec = z.infer<typeof identitySpecSchema>;
export const IdentitySpecSchema = identitySpecSchema;
