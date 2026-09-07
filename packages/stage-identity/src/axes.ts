import { divergenceAxes, type DivergenceAxis } from '@pwb/domain';

export const identityAxisBriefIds = ['editorial-material', 'modular-technical', 'typographic-low-chroma'] as const;
export type IdentityAxisBriefId = (typeof identityAxisBriefIds)[number];

/**
 * The three seats of the identity fan-out. Each director is handed one seat and
 * is told which axis keys the other two already hold, so divergence is
 * constrained on the input. The seats are opposed on every axis — no two of them
 * share a key — but a seat is a demand, not a measurement: DIV-030 compares the
 * signals the produced documents actually show.
 */
export interface IdentityAxisBrief {
  id: IdentityAxisBriefId;
  label: string;
  /** What this direction argues, in the captain's language. */
  premise: string;
  /** The axis key this seat must claim, from the closed vocabulary in `@pwb/domain`. */
  required: Record<DivergenceAxis, string>;
  /** Material, craft, editorial or architectural references only; never a company's website. */
  references: string[];
  /** Moves this seat must refuse even when they would be defensible elsewhere. */
  refusals: string[];
}

export const identityAxisBriefs: readonly IdentityAxisBrief[] = [
  {
    id: 'editorial-material',
    label: 'Editorial e material',
    premise: 'A página se comporta como uma publicação impressa: a assimetria carrega a hierarquia e o material carrega a confiança.',
    required: { composition: 'asymmetric-editorial', typography: 'serif-display-contrast', materiality: 'paper-ink', color: 'earth-pigment', imagery: 'documentary-photo', motion: 'weighted-settle' },
    references: ['encadernação e papel não branqueado', 'revistas de arquitetura dos anos 1960', 'tinta offset sobre papel absorvente'],
    refusals: ['grid de três cartões iguais', 'ícone decorativo sem função', 'centralizar o argumento principal'],
  },
  {
    id: 'modular-technical',
    label: 'Modular e técnico',
    premise: 'A página se comporta como um instrumento: o módulo é visível, a medida é declarada e o sinal aparece uma vez só.',
    required: { composition: 'modular-grid', typography: 'grotesque-monospace-pair', materiality: 'engineered-surface', color: 'duotone-contrast', imagery: 'technical-diagram', motion: 'mechanical-step' },
    references: ['desenho técnico cotado', 'painel de instrumentos de oficina', 'sinalização ferroviária suíça'],
    refusals: ['textura orgânica', 'fotografia de pessoas sorrindo', 'movimento com inércia'],
  },
  {
    id: 'typographic-low-chroma',
    label: 'Tipográfico e de baixo cromatismo',
    premise: 'A página se comporta como um documento: só o tipo e a margem constroem a hierarquia, e a cor quase não trabalha.',
    required: { composition: 'margin-driven', typography: 'single-family-optical-scale', materiality: 'printed-matter', color: 'low-chroma-neutral', imagery: 'no-photography', motion: 'no-motion' },
    references: ['relatório anual composto em uma família só', 'contrato tipografado', 'catálogo de exposição em duas tintas'],
    refusals: ['cor de destaque saturada', 'imagem de apoio', 'qualquer transição que não seja instantânea'],
  },
];

export function identityAxisBrief(id: IdentityAxisBriefId): IdentityAxisBrief {
  const brief = identityAxisBriefs.find((entry) => entry.id === id);
  if (!brief) throw new Error(`Unknown identity axis brief ${id}.`);
  return brief;
}

/** Proves at module scope that the three seats claim a different key on every axis. */
export function overlappingAxisKeys(): Array<{ axis: DivergenceAxis; key: string; briefs: IdentityAxisBriefId[] }> {
  const overlaps: Array<{ axis: DivergenceAxis; key: string; briefs: IdentityAxisBriefId[] }> = [];
  for (const axis of divergenceAxes) {
    const byKey = new Map<string, IdentityAxisBriefId[]>();
    for (const brief of identityAxisBriefs) {
      const key = brief.required[axis];
      byKey.set(key, [...(byKey.get(key) ?? []), brief.id]);
    }
    for (const [key, briefs] of byKey) if (briefs.length > 1) overlaps.push({ axis, key, briefs });
  }
  return overlaps;
}
