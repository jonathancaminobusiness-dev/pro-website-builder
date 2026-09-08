import { createHash } from 'node:crypto';
import { z } from 'zod';
import { documentRules } from './rules.js';

export const tokenTypeSchema = z.enum([
  'color', 'dimension', 'fontFamily', 'fontWeight', 'fontSize', 'duration',
  'cubicBezier', 'shadow', 'number', 'borderRadius', 'strokeStyle', 'boolean',
]);

export const tokenValueSchema = z.union([z.string(), z.number(), z.boolean()]);
export type TokenValue = z.infer<typeof tokenValueSchema>;

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

export function flattenTokens(group: TokenGroup, prefix = '', result = new Map<string, Token>()): Map<string, Token> {
  for (const [key, value] of Object.entries(group)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isToken(value)) result.set(path, value);
    else flattenTokens(value, path, result);
  }
  return result;
}

export function cssCustomPropertyName(path: string): string {
  return `--${path.replaceAll('.', '-')}`;
}

/**
 * The selector that addresses one node's rules and the attribute the renderer emits are the same text
 * escaped for two different languages: the attribute is HTML-escaped, and here the id is escaped as a
 * CSS string, so an id holding a quote or a backslash still denotes the node it names.
 */
export function cssNodeSelector(nodeId: string): string {
  const escaped = nodeId
    .replaceAll(/["\\]/g, (char) => `\\${char}`)
    .replaceAll(/[\u0000-\u001f\u007f]/g, (char) => `\\${char.codePointAt(0)!.toString(16)} `);
  return `[data-node-id="${escaped}"]`;
}

export function cssTokenIssues(values: Record<string, string | number | boolean>): Array<{ path: string; message: string }> {
  const issues: Array<{ path: string; message: string }> = [];
  const owners = new Map<string, string>();
  for (const [path, value] of Object.entries(values)) {
    const name = cssCustomPropertyName(path);
    if (!/^--[A-Za-z0-9-]+$/.test(name)) issues.push({ path, message: `${documentRules.cssTokens} Token ${path} cannot become a CSS custom property.` });
    const owner = owners.get(name);
    if (owner === undefined) owners.set(name, path);
    else issues.push({ path, message: `${documentRules.cssTokens} Tokens ${owner} and ${path} both compile to the CSS custom property ${name}.` });
    if (typeof value === 'string' && (/[<>;{}]/.test(value) || value.includes('/*') || value.includes('*/'))) issues.push({ path, message: `${documentRules.cssTokens} Token ${path} holds characters that cannot be emitted into CSS.` });
  }
  return issues;
}

const tokenValueShapes: Partial<Record<z.infer<typeof tokenTypeSchema>, { accepts: (value: TokenValue) => boolean; expects: string }>> = {
  color: { accepts: (value) => typeof value === 'string' && (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value) || /^(rgb|rgba|hsl|hsla|oklch|lab|color)\(/.test(value)), expects: 'a hex colour or a CSS colour function' },
  dimension: { accepts: (value) => typeof value === 'string' && /^-?\d*\.?\d+(px|rem|em|ch|vw|vh|%)$/.test(value), expects: 'a length with a unit, such as 2rem' },
  borderRadius: { accepts: (value) => typeof value === 'string' && /^-?\d*\.?\d+(px|rem|em|ch|vw|vh|%)$/.test(value), expects: 'a length with a unit, such as 0.25rem' },
  fontSize: { accepts: (value) => typeof value === 'string' && /^-?\d*\.?\d+(px|rem|em|ch|vw|vh|%)$/.test(value), expects: 'a length with a unit, such as 1.25rem' },
  duration: { accepts: (value) => typeof value === 'string' && /^\d*\.?\d+(ms|s)$/.test(value), expects: 'a duration in ms or s, such as 220ms' },
  number: { accepts: (value) => typeof value === 'number', expects: 'a number' },
  fontWeight: { accepts: (value) => typeof value === 'number' || (typeof value === 'string' && value.trim().length > 0), expects: 'a numeric weight or a named weight' },
  boolean: { accepts: (value) => typeof value === 'boolean', expects: 'true or false' },
};

/**
 * Whether a value can stand in a token of this type. An alias is always
 * accepted: it names another token, and the document rules already require that
 * token to exist.
 */
export function tokenValueIssue(type: z.infer<typeof tokenTypeSchema> | undefined, value: TokenValue): string | undefined {
  if (typeof value === 'string' && /^\{[^}]+\}$/.test(value)) return undefined;
  if (!type) return typeof value === 'string' && value.trim().length === 0 ? 'An untyped token needs a value.' : undefined;
  const shape = tokenValueShapes[type];
  if (!shape) return typeof value === 'string' && value.trim().length > 0 ? undefined : `A ${type} token expects a non-empty value.`;
  return shape.accepts(value) ? undefined : `A ${type} token expects ${shape.expects}, not ${JSON.stringify(value)}.`;
}

/**
 * `values` and `types` are prototype-free because every downstream token check is an `in` test
 * against them (ir.ts, renderer/render.ts, linter/rules.ts) over paths a model proposes, so a
 * reference such as `{constructor}` would otherwise be reported as defined and emitted as an
 * undeclared custom property.
 */
export function resolveTokens(tokens: TokenTree): ResolvedTokenSet {
  const flat = flattenTokens(tokens);
  const values: Record<string, string | number | boolean> = Object.create(null);
  const types: Record<string, z.infer<typeof tokenTypeSchema> | undefined> = Object.create(null);
  const resolving: string[] = [];

  const resolve = (path: string): string | number | boolean => {
    const existing = values[path];
    if (existing !== undefined) return existing;
    const token = flat.get(path);
    if (!token) throw new Error(`${documentRules.tokenReferences} Orphan token alias: ${path}`);
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
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
}

export function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}
