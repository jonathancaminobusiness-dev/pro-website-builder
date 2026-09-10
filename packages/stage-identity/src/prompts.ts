import { documentPathSchemas, documentRules, flattenTokens, governedContractFields, imagerySourceSchema, RASTER_IMAGERY_SOURCE, stageRoles, visualPropKeys, type DesignIR, type IdentitySpec } from '@pwb/domain';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { identityAxisBrief, identityAxisBriefs, type IdentityAxisBriefId } from './axes.js';
import { briefSpecSchema, critiqueReportSchema, directionVectorDraftSchemaFor, imagePromptPlanSchemaFor, IDENTITY_PROMPT_VERSION, RUBRIC_MINIMUM, type BriefSpec, type CritiqueReport } from './contracts.js';

/**
 * Every prompt in this stage obeys the same six rules the fidelity research
 * settled on: structured input carrying evidence ids, extraction before
 * creation, explicit negatives taken from `forbiddenDefaults`, references drawn
 * from material, craft, editorial or architecture and never from a company's
 * website, contract before code, and a closed JSON answer.
 */
const HOUSE_RULES = [
  'Extract before you create: restate the facts you were given, name what is missing, and turn a gap into a declared assumption instead of a visual default.',
  'Every visual choice must cite an evidence id from the brief, a written rationale, or the divergence axis it belongs to. "It looks good" is not a reason.',
  'Draw references from material, craft, editorial design and architecture. Never reference a company website, a product UI or a named brand.',
  'Propose a contract, never code. You may not write HTML, JSX, CSS or a framework component, and no raw visual value may appear outside a token definition.',
  'Answer with one JSON document that matches the schema exactly. No prose before or after it, no markdown fence, no commentary.',
  'Write the identity prose in Brazilian Portuguese. Ids, token paths, axis keys and schema field names stay in English.',
].map((rule, index) => `${index + 1}. ${rule}`).join('\n');

function schemaBlock(name: string, schema: unknown): string {
  return `The answer's \`artifact\` field must match this ${name} schema exactly:\n${JSON.stringify(schema)}`;
}

const briefSpecJsonSchema = zodToJsonSchema(briefSpecSchema);
const critiqueReportJsonSchema = zodToJsonSchema(critiqueReportSchema);

function negatives(forbidden: IdentitySpec['forbiddenDefaults'] | BriefSpec['forbiddenDefaults']): string {
  return [
    `Forbidden fonts and font moves, with the reason they are forbidden: ${forbidden.fonts.join('; ')}.`,
    `Forbidden palettes: ${forbidden.palettes.join('; ')}.`,
    `Forbidden motifs: ${forbidden.motifs.join('; ')}.`,
    'These are refusals, not preferences. If one of them is the only answer you can find, return the direction without it and say so in the rationale.',
  ].join('\n');
}

function tokenContract(identity: IdentitySpec): string {
  const roles = Object.entries(identity.tokenRoles).map(([role, path]) => `${role}=${path}`).join(', ');
  const paths = [...flattenTokens(identity.tokens).keys()].sort().join(', ');
  return [
    `The identity token contract is closed for this stage. Keep exactly these token paths: ${paths}. Change token values only; do not add, remove or rename token paths.`,
    `The \`tokenRoles\` object is closed and has exactly these supported role names and paths: ${roles}. Keep this exact set; do not add, remove or rename roles.`,
    'Never invent role fields such as focusIndicator, stateSurface, stateText, secondaryText or signal. If a finding names one of those unsupported roles, repair it by reusing one of the supported role paths above or leave that finding open for the captain; never expand the schema.',
  ].join('\n');
}

export function briefCuratorPrompt(briefing: string): string {
  return [
    'You are the brief curator of the identity stage. You do not design anything.',
    'Turn one raw briefing into a structured BriefSpec whose evidence ids the three identity directors will cite for the rest of the stage.',
    HOUSE_RULES,
    'Give every evidence item a stable id in the form ev-<slug>, a verbatim quote from the briefing, and the place in the briefing it came from.',
    'Anything the briefing does not state belongs in `unknowns` or in `assumptions` with a risk level. Do not invent audiences, proofs or constraints.',
    '`forbiddenDefaults` must name the generic moves this particular project has to refuse, derived from the briefing rather than from a stock list.',
    schemaBlock('BriefSpec', briefSpecJsonSchema),
    `Raw briefing:\n${briefing}`,
  ].join('\n\n');
}

export function identityDirectorPrompt(input: { brief: BriefSpec; axisBriefId: IdentityAxisBriefId; baseVersionId: string; allowedPaths: string[]; currentIdentity: IdentitySpec }): string {
  const seat = identityAxisBrief(input.axisBriefId);
  const others = identityAxisBriefs.filter((entry) => entry.id !== input.axisBriefId);
  return [
    `You are the identity director for the "${seat.label}" seat of a three-way fan-out. Two other directors are working from the same brief at the same time; you will never see their answers.`,
    `Your premise: ${seat.premise}`,
    HOUSE_RULES,
    `Your seat has already been assigned one key per divergence axis and you must claim exactly these:\n${Object.entries(seat.required).map(([axis, key]) => `- ${axis}: ${key}`).join('\n')}`,
    `The other two seats hold these keys, so do not drift towards them:\n${others.map((entry) => `- ${entry.label}: ${Object.entries(entry.required).map(([axis, key]) => `${axis}=${key}`).join(', ')}`).join('\n')}`,
    `References to work from: ${seat.references.join('; ')}.`,
    `Moves this seat refuses: ${seat.refusals.join('; ')}.`,
    negatives(input.brief.forbiddenDefaults),
    `The brief, with the evidence ids you must cite:\n${JSON.stringify(input.brief)}`,
    `The identity contract currently in the document, which you are replacing wholesale. Keep the same token paths so the existing pages keep resolving; change what the tokens mean, not what they are called:\n${JSON.stringify(input.currentIdentity)}`,
    tokenContract(input.currentIdentity),
    `Every token you define and every one of these governed contract fields needs exactly one entry in \`decisions\`: ${governedContractFields.join(', ')}. A decision carries an axis, at least one evidence id, and a rationale that says what the choice does to hierarchy or use.`,
    `Answer with an AgentResult that carries both a \`proposal\` and an \`artifact\`; an answer missing either one is discarded. The \`proposal\` is a patch: it must set baseVersionId to ${input.baseVersionId}, declare stage "identity" and role "${stageRoles.identity}", touch only ${input.allowedPaths.join(', ')}, and contain exactly one operation: replace /identity with the complete IdentitySpec.`,
    `The \`artifact\` is the DirectionVectorDraft for your seat: \`directionId\` is "${input.axisBriefId}" and nothing else, \`label\` names this direction in one phrase, \`descriptors\` says in one sentence per axis what your choice on that axis means, \`constants\` lists what must hold across the whole fan-out, and \`incompatibilities\` names the pairs of moves this direction refuses to combine. The axis keys and the palette are measured from the document you propose, so the draft describes what you built; it cannot claim divergence the document does not carry.`,
    schemaBlock('DirectionVectorDraft', zodToJsonSchema(directionVectorDraftSchemaFor(input.axisBriefId))),
    `The imagery policy you write is enforced: \`imagery.allowedSources\` accepts only ${imagerySourceSchema.options.map((source) => `"${source}"`).join(' and ')}, and "${RASTER_IMAGERY_SOURCE}" is the one source that can be generated. A direction that does not list it is never asked for image prompts and never generates an image.`,
    `A page node may only declare these props: ${[...visualPropKeys].join(', ')} and text, and every visual prop must be a token reference such as {color.ink}. You are not editing pages in this stage.`,
    `The gate also enforces rules no JSON Schema can state, and rejects a proposal that breaks any of them: ${Object.values(documentRules).join(' ')}`,
    `The IdentitySpec schema:\n${JSON.stringify(documentPathSchemas['/identity'])}`,
  ].join('\n\n');
}

export interface CriticPromptInput {
  criticId: string;
  dimension: CritiqueReport['dimension'];
  brief: BriefSpec;
  subject: CritiqueReport['subject'];
  /** The rubric always precedes the artefact, so the critic is not anchored by what it is about to read. */
  rubric: string[];
  vetoes: string[];
  document: unknown;
}

export function criticPrompt(input: CriticPromptInput): string {
  return [
    `You are the ${input.criticId} of the identity stage. You are a separate session from the director that produced this document, you have no access to how it was produced, and you may not edit it.`,
    'Read the rubric and the veto list below before you read the document.',
    `Rubric for ${input.dimension}, scored 0 to 4 with ${RUBRIC_MINIMUM} as the minimum that passes:\n${input.rubric.map((line, index) => `${index}. ${line}`).join('\n')}`,
    `Score ${input.dimension} and nothing else: every entry in \`scores\` must name ${input.dimension}, which is the only rubric you were given. A score in another dimension is not yours to give and is discarded.`,
    `Immediate vetoes, which are not scores:\n${input.vetoes.map((line) => `- ${line}`).join('\n')}`,
    input.subject.kind === 'matrix'
      ? 'You are reviewing the whole fan-out at once. Report with `subject` set to { "kind": "matrix" }.'
      : `You are reviewing the direction ${input.subject.directionId} and no other. Report with \`subject\` set to { "kind": "direction", "directionId": "${input.subject.directionId}" }, using that exact id and not the direction's label.`,
    HOUSE_RULES,
    'Report perception first (what the document literally declares), then comprehension (what that means for the audience and the promise), then findings. Never answer "rewrite the identity": each finding names one cause, its evidence, and the smallest repair that fixes it.',
    'Every finding and suggested repair must use paths and fields already present in the supplied identity contract. Do not propose a new tokenRoles key, token path or schema field to represent a missing capability; reuse the existing contract or report the limitation as a finding for the captain.',
    'If you cannot decide, set `abstain` to true and say why. That escalates to the captain, which is a better answer than invented precision.',
    `The brief and its evidence ids:\n${JSON.stringify(input.brief)}`,
    `The document under review:\n${JSON.stringify(input.document)}`,
    schemaBlock('CritiqueReport', critiqueReportJsonSchema),
  ].join('\n\n');
}

export function identityRefinerPrompt(input: { brief: BriefSpec; directionId: string; baseVersionId: string; allowedPaths: string[]; identity: IdentitySpec; findings: unknown }): string {
  return [
    `You are the identity refiner for direction ${input.directionId}. You get one cycle and no more.`,
    'Repair only what the findings name. Preserve every other part of the contract, including token paths, axis keys and the divergence matrix.',
    HOUSE_RULES,
    'A repair is small and causal: change a token value, tighten an axis descriptor, add the missing rationale or evidence to a decision, or correct one governed contract field. Do not restructure the identity and do not add tokens the pages do not use.',
    `The blocking findings you must clear:\n${JSON.stringify(input.findings)}`,
    `A \`rubric\` entry is a finding like any other: the named dimension scored below ${RUBRIC_MINIMUM} and the repair has to raise it in the document, never by arguing with the score.`,
    `The brief and its evidence ids:\n${JSON.stringify(input.brief)}`,
    `The identity to repair:\n${JSON.stringify(input.identity)}`,
    tokenContract(input.identity),
    `The repaired \`/identity\` value must match this IdentitySpec schema exactly:\n${JSON.stringify(documentPathSchemas['/identity'])}`,
    `Answer with an AgentResult whose \`proposal\` is a patch. It must set baseVersionId to ${input.baseVersionId}, declare stage "identity" and role "${stageRoles.identity}", touch only ${input.allowedPaths.join(', ')}, and contain exactly one operation: replace /identity with the repaired IdentitySpec.`,
  ].join('\n\n');
}

export function imageArtDirectorPrompt(input: { brief: BriefSpec; directionId: IdentityAxisBriefId; identity: IdentitySpec }): string {
  return [
    `You are the image art director for direction ${input.directionId}. You write prompt plans only. Nothing is generated until the captain approves one direction, and only that direction is ever generated.`,
    HOUSE_RULES,
    `The direction's imagery policy is binding: treatment "${input.identity.imagery.treatment}", focal policy "${input.identity.imagery.focalPolicy}", allowed sources ${input.identity.imagery.allowedSources.join(', ')}.`,
    'If the direction refuses photography, say so by planning textures or diagrams that respect that refusal instead of smuggling a photograph back in.',
    negatives(input.identity.forbiddenDefaults),
    'Every plan states the axis it carries, an alt text a screen reader can use, and the licence you expect the provider to return. A plan whose licence you cannot state is not a plan.',
    `The brief and its evidence ids:\n${JSON.stringify(input.brief)}`,
    `The approved-direction contract:\n${JSON.stringify({ direction: input.identity.direction, imagery: input.identity.imagery, iconography: input.identity.iconography, content: input.identity.content })}`,
    schemaBlock('ImagePromptPlan', zodToJsonSchema(imagePromptPlanSchemaFor(input.directionId))),
  ].join('\n\n');
}

export function documentSliceOf(ir: DesignIR, allowedPaths: string[]): Record<string, unknown> {
  const slice: Record<string, unknown> = { '/identity': ir.identity };
  for (const path of allowedPaths) {
    const value = path.split('/').slice(1).reduce<unknown>((current, segment) => (current && typeof current === 'object' ? (current as Record<string, unknown>)[segment] : undefined), ir);
    slice[path] = value;
  }
  return slice;
}
