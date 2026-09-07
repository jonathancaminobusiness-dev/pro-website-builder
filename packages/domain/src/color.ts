/**
 * Hue-invariant colour analysis for the divergence contract.
 *
 * DIV-030 has to answer one question mechanically: do two identity directions
 * differ, or did someone rotate the hue and call it a new direction? A palette
 * signature therefore records lightness and chroma only. Hue is deliberately
 * dropped, so a hue rotation produces the same signature and cannot register as
 * a difference.
 */

export interface Oklch { l: number; c: number; h: number; }

const LIGHTNESS_STEPS = 20;
const CHROMA_STEPS = 50;

function srgbToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function parseHex(value: string): [number, number, number] | undefined {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim());
  if (!match) return undefined;
  const digits = match[1]!;
  const expanded = digits.length <= 4 ? [...digits].map((digit) => `${digit}${digit}`).join('') : digits;
  const [red, green, blue] = [0, 2, 4].map((offset) => Number.parseInt(expanded.slice(offset, offset + 2), 16) / 255);
  return [red!, green!, blue!];
}

function parseOklchFunction(value: string): Oklch | undefined {
  const match = /^oklch\(\s*([0-9.]+)(%?)\s+([0-9.]+)(%?)\s+([0-9.]+)(?:deg)?\s*(?:\/\s*[0-9.%]+\s*)?\)$/i.exec(value.trim());
  if (!match) return undefined;
  const lightness = match[2] === '%' ? Number(match[1]) / 100 : Number(match[1]);
  const chroma = match[4] === '%' ? (Number(match[3]) / 100) * 0.4 : Number(match[3]);
  const hue = Number(match[5]);
  if (![lightness, chroma, hue].every((entry) => Number.isFinite(entry))) return undefined;
  return { l: lightness, c: chroma, h: hue };
}

/** Converts a CSS colour the identity may use into OKLCH, or undefined when the notation is not supported. */
export function toOklch(value: string): Oklch | undefined {
  const fromFunction = parseOklchFunction(value);
  if (fromFunction) return fromFunction;
  const rgb = parseHex(value);
  if (!rgb) return undefined;
  const [red, green, blue] = rgb.map(srgbToLinear) as [number, number, number];
  const long = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue);
  const medium = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue);
  const short = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue);
  const lightness = 0.2104542553 * long + 0.793617785 * medium - 0.0040720468 * short;
  const greenRed = 1.9779984951 * long - 2.428592205 * medium + 0.4505937099 * short;
  const blueYellow = 0.0259040371 * long + 0.7827717662 * medium - 0.808675766 * short;
  const chroma = Math.hypot(greenRed, blueYellow);
  const hue = (Math.atan2(blueYellow, greenRed) * 180) / Math.PI;
  return { l: lightness, c: chroma, h: hue < 0 ? hue + 360 : hue };
}

function quantize(value: number, steps: number): number {
  return Math.round(value * steps) / steps;
}

/**
 * A sorted, hue-free fingerprint of one palette. Entries a direction expresses
 * in a notation this module cannot read are kept verbatim under a `raw:` prefix
 * so they still take part in the comparison instead of being silently dropped.
 */
export interface PaletteSignature { entries: string[]; unparsed: string[]; }

export function paletteSignature(colors: string[]): PaletteSignature {
  const entries: string[] = [];
  const unparsed: string[] = [];
  for (const color of colors) {
    const oklch = toOklch(color);
    if (!oklch) { const raw = `raw:${color.trim().toLowerCase()}`; entries.push(raw); unparsed.push(color); continue; }
    entries.push(`${quantize(oklch.l, LIGHTNESS_STEPS).toFixed(2)}|${quantize(oklch.c, CHROMA_STEPS).toFixed(2)}`);
  }
  return { entries: [...entries].sort(), unparsed: [...unparsed].sort() };
}

export function paletteSignaturesMatch(a: PaletteSignature, b: PaletteSignature): boolean {
  return a.entries.length === b.entries.length && a.entries.every((entry, index) => entry === b.entries[index]);
}
