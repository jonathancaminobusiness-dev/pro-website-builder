import type { DesignIR } from '@pwb/domain';
import type { FontDecision } from './fonts.js';

/**
 * One row of the release licence inventory: rasters and vectors from the IR,
 * font faces, and the toolchain that produced the HTML and CSS. `bundled` says
 * whether the bundle carries that row's bytes, so a row is a disclosure and
 * never a claim the published artifact cannot keep. A row for bytes the release
 * does not ship carries the licence and the reason it stays out, and nothing
 * the owner declared about it.
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
  licenseUrl?: string;
  termsNote?: string;
}

export interface LicenseInventory {
  entries: LicenseEntry[];
  /** Bytes the bundle ships without usable terms. Each one is a veto. */
  missing: Array<{ id: string; detail: string }>;
  /**
   * Assets the bundle does not ship whose terms are still unresolved — a
   * provider placeholder, for instance. They escalate to the captain instead of
   * blocking a release that never publishes them.
   */
  warnings: Array<{ id: string; detail: string }>;
}

function blank(value: string): boolean {
  return value.trim() === '';
}

const UNRESOLVED_LICENSES = new Set(['unknown', 'unlicensed', 'tbd', 'pending', 'pending provider terms', 'n/a', 'none']);

/** Why an asset row carries no bytes: no document of the release holds the image. */
const NOT_BUNDLED = 'No document of the release carries this asset, so the bundle ships none of its bytes.';

export function isUsableLicense(license: string): boolean {
  return !blank(license) && !UNRESOLVED_LICENSES.has(license.trim().toLowerCase());
}

export function buildLicenseInventory(ir: DesignIR, fonts: FontDecision[], toolchain: { rendererVersion: string; compilerVersion: string }, bundledAssets: ReadonlySet<string>): LicenseInventory {
  const entries: LicenseEntry[] = [];
  const missing: LicenseInventory['missing'] = [];
  const warnings: LicenseInventory['warnings'] = [];

  // The inventory is a public artifact, so it discloses provenance for the assets
  // the release actually ships. An asset that stays out is named with its licence
  // and the reason it stays out; what the owner declared about it — a stock
  // invoice, a private note — is not this artifact's business, exactly as for a
  // face the release does not redistribute.
  for (const asset of [...ir.assets.items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const { provenance } = asset;
    const bundled = bundledAssets.has(asset.id);
    entries.push(bundled
      ? {
        id: asset.id,
        kind: asset.kind,
        source: provenance.source,
        author: provenance.author,
        license: provenance.license,
        date: provenance.date,
        hash: provenance.hash,
        bundled: true,
        modifications: provenance.prompt ? `Generated with ${provenance.model ?? 'an unnamed model'} from a recorded prompt.` : 'None recorded.',
        ...(provenance.termsNote ? { termsNote: provenance.termsNote } : {}),
      }
      : {
        id: asset.id, kind: asset.kind, source: 'not bundled', author: '', license: provenance.license,
        date: '', hash: '', bundled: false, modifications: 'None recorded.', termsNote: NOT_BUNDLED,
      });
    if (isUsableLicense(provenance.license)) continue;
    const detail = `Asset ${asset.id} carries the licence "${provenance.license}", which does not clear it for release.`;
    // Only what the bundle ships can be published without terms; an asset the
    // release never carries is named for the captain rather than vetoed.
    (bundled ? missing : warnings).push({ id: asset.id, detail });
  }

  // The inventory is a public artifact, so it discloses provenance for the faces
  // the release actually ships. A face that stays out is named with its licence
  // and the reason it stays out; what the owner declared about it — an invoice,
  // a private note — is not this artifact's business.
  for (const font of fonts) {
    const id = `font:${font.family}:${font.weight}:${font.style}`;
    entries.push(font.selfHosted
      ? {
        id, kind: 'font', source: font.source, author: font.author, license: font.license, date: font.date,
        hash: font.hash ?? '', bundled: true, modifications: 'None recorded.',
        ...(font.licenseUrl ? { licenseUrl: font.licenseUrl } : {}), termsNote: font.reason,
      }
      : { id, kind: 'font', source: 'not bundled', author: '', license: font.license, date: '', hash: '', bundled: false, modifications: 'None recorded.', termsNote: font.reason });
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

  return { entries, missing, warnings };
}
