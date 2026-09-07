import type { DesignIR } from '@pwb/domain';
import type { FontDecision } from './fonts.js';

/**
 * One row of the release licence inventory. Every byte the bundle ships has a
 * row: rasters and vectors from the IR, self-hosted font files, and the
 * toolchain that produced the HTML and CSS.
 */
export interface LicenseEntry {
  id: string;
  kind: 'raster' | 'vector' | 'font' | 'manual' | 'toolchain';
  source: string;
  author: string;
  license: string;
  date: string;
  hash: string;
  bundled: boolean;
  modifications: string;
  termsNote?: string;
}

export interface LicenseInventory {
  entries: LicenseEntry[];
  /** Assets and faces that reached the compiler without usable terms. */
  missing: Array<{ id: string; detail: string }>;
}

function blank(value: string): boolean {
  return value.trim() === '';
}

const UNRESOLVED_LICENSES = new Set(['unknown', 'unlicensed', 'tbd', 'pending', 'pending provider terms', 'n/a', 'none']);

export function isUsableLicense(license: string): boolean {
  return !blank(license) && !UNRESOLVED_LICENSES.has(license.trim().toLowerCase());
}

export function buildLicenseInventory(ir: DesignIR, fonts: FontDecision[], toolchain: { rendererVersion: string; compilerVersion: string }): LicenseInventory {
  const entries: LicenseEntry[] = [];
  const missing: LicenseInventory['missing'] = [];

  for (const asset of [...ir.assets.items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const { provenance } = asset;
    entries.push({
      id: asset.id,
      kind: asset.kind,
      source: provenance.source,
      author: provenance.author,
      license: provenance.license,
      date: provenance.date,
      hash: provenance.hash,
      bundled: asset.status === 'ready',
      modifications: provenance.prompt ? `Generated with ${provenance.model ?? 'an unnamed model'} from a recorded prompt.` : 'None recorded.',
      ...(provenance.termsNote ? { termsNote: provenance.termsNote } : {}),
    });
    if (!isUsableLicense(provenance.license)) missing.push({ id: asset.id, detail: `Asset ${asset.id} carries the licence "${provenance.license}", which does not clear it for release.` });
  }

  for (const font of fonts) {
    const id = `font:${font.family}:${font.weight}:${font.style}`;
    entries.push({
      id,
      kind: 'font',
      source: font.path ?? 'not bundled',
      author: font.family,
      license: font.license,
      date: '',
      hash: '',
      bundled: font.selfHosted,
      modifications: 'None recorded.',
      termsNote: font.reason,
    });
    if (font.selfHosted && !isUsableLicense(font.license)) missing.push({ id, detail: `Font ${id} is bundled under the licence "${font.license}", which does not clear it for release.` });
  }

  entries.push({
    id: 'toolchain:pro-website-builder',
    kind: 'toolchain',
    source: `${toolchain.rendererVersion} + ${toolchain.compilerVersion}`,
    author: 'pro-website-builder',
    license: 'internal',
    date: '',
    hash: '',
    bundled: false,
    modifications: 'HTML and CSS are generated from the approved DesignIR.',
  });

  return { entries, missing };
}
