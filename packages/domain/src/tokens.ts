import { createHash } from 'node:crypto';
import { z } from 'zod';

export const tokenTypeSchema = z.enum([
  'color', 'dimension', 'fontFamily', 'fontWeight', 'fontSize', 'duration',
  'cubicBezier', 'shadow', 'number', 'borderRadius', 'strokeStyle', 'boolean',
]);

export const tokenValueSchema = z.union([z.string(), z.number(), z.boolean()]);

export const tokenSchema = z.object({
  $value: tokenValueSchema,
  $type: tokenTypeSchema.optional(),
  $description: z.string().optional(),
}).strict();

export const tokenGroupSchema: z.ZodType<TokenGroup> = z.lazy(() => z.record(z.union([tokenSchema, tokenGroupSchema])));

export type Token = z.infer<typeof tokenSchema>;
export type TokenGroup = { [key: string]: Token | TokenGroup };
export type TokenTree = TokenGroup;

export interface ResolvedTokenSet {
  values: Record<string, string | number | boolean>;
  types: Record<string, z.infer<typeof tokenTypeSchema> | undefined>;
}

function isToken(value: Token | TokenGroup): value is Token {
  return typeof value === 'object' && value !== null && '$value' in value;
}

function flatten(group: TokenGroup, prefix = '', result = new Map<string, Token>()): Map<string, Token> {
  for (const [key, value] of Object.entries(group)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isToken(value)) result.set(path, value);
    else flatten(value, path, result);
  }
  return result;
}

export function resolveTokens(tokens: TokenTree): ResolvedTokenSet {
  const flat = flatten(tokens);
  const values: Record<string, string | number | boolean> = {};
  const types: Record<string, z.infer<typeof tokenTypeSchema> | undefined> = {};
  const resolving: string[] = [];

  const resolve = (path: string): string | number | boolean => {
    const existing = values[path];
    if (existing !== undefined) return existing;
    const token = flat.get(path);
    if (!token) throw new Error(`Orphan token alias: ${path}`);
    if (resolving.includes(path)) throw new Error(`Circular token alias: ${[...resolving, path].join(' -> ')}`);
    resolving.push(path);
    const raw = token.$value;
    const match = typeof raw === 'string' ? /^\{([^}]+)\}$/.exec(raw) : undefined;
    const resolved = match ? resolve(match[1]!) : raw;
    resolving.pop();
    values[path] = resolved;
    types[path] = token.$type;
    return resolved;
  };

  for (const path of flat.keys()) resolve(path);
  return { values, types };
}

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
}

export function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}
