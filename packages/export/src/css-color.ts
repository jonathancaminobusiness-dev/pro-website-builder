/**
 * sRGB fallbacks for modern CSS colour syntax.
 *
 * A token may legitimately hold `oklch()`, `oklab()`, `lab()`, `lch()` or
 * `color()`. Those parse as an opaque token stream inside a custom property, so
 * the usual "declare twice and let the cascade drop the invalid one" trick does
 * not work for custom properties: the compiler emits a converted sRGB hex first
 * and re-declares the modern value inside an `@supports` block.
 *
 * The conversion clips out-of-gamut components instead of performing CSS Color
 * 4 gamut mapping. That is an approximation, and it is only ever used by
 * browsers that cannot render the authored value at all.
 */

const MODERN_COLOR_FUNCTIONS = ['oklch', 'oklab', 'lch', 'lab', 'color', 'color-mix', 'light-dark'] as const;

export interface ColorFallback { hex: string; }
export interface ColorFallbackFailure { reason: string; }
export type ColorFallbackResult = ColorFallback | ColorFallbackFailure | undefined;

export function isFallbackFailure<T extends object>(result: T | ColorFallbackFailure | undefined): result is ColorFallbackFailure {
  return result !== undefined && 'reason' in result;
}

/** True when the value uses colour syntax that needs an sRGB companion declaration. */
export function needsColorFallback(value: string): boolean {
  const lowered = value.toLowerCase();
  return MODERN_COLOR_FUNCTIONS.some((name) => new RegExp(`(?:^|[^a-z-])${name}\\(`).test(lowered));
}

function clamp(value: number, low = 0, high = 1): number {
  return value < low ? low : value > high ? high : value;
}

function multiply(matrix: readonly number[][], vector: readonly number[]): [number, number, number] {
  return matrix.map((row) => row.reduce((sum, cell, index) => sum + cell * (vector[index] ?? 0), 0)) as [number, number, number];
}

function gammaEncode(channel: number): number {
  const sign = channel < 0 ? -1 : 1;
  const magnitude = Math.abs(channel);
  return magnitude <= 0.0031308 ? 12.92 * channel : sign * (1.055 * magnitude ** (1 / 2.4) - 0.055);
}

const XYZ_D65_TO_LINEAR_SRGB = [
  [3.2409699419045226, -1.5373831775700939, -0.4986107602930034],
  [-0.9692436362808796, 1.8759675015077204, 0.04155505740717559],
  [0.05563007969699366, -0.20397695888897652, 1.0569715142428786],
];
const XYZ_D50_TO_XYZ_D65 = [
  [0.9554734527042182, -0.023098536874261423, 0.0632593086610217],
  [-0.028369706963208136, 1.0099954580058226, 0.021041398966943008],
  [0.012314001688319899, -0.020507696433477912, 1.3303659366080753],
];
const LINEAR_DISPLAY_P3_TO_XYZ_D65 = [
  [0.4865709486482162, 0.26566769316909306, 0.1982172852343625],
  [0.2289745640697488, 0.6917385218365064, 0.079286914093745],
  [0, 0.04511338185890264, 1.043944368900976],
];

function oklabToLinearSrgb(lightness: number, aAxis: number, bAxis: number): [number, number, number] {
  const l = (lightness + 0.3963377774 * aAxis + 0.2158037573 * bAxis) ** 3;
  const m = (lightness - 0.1055613458 * aAxis - 0.0638541728 * bAxis) ** 3;
  const s = (lightness - 0.0894841775 * aAxis - 1.291485548 * bAxis) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const D50_WHITE = [0.3457 / 0.3585, 1, (1 - 0.3457 - 0.3585) / 0.3585] as const;

function labToLinearSrgb(lightness: number, aAxis: number, bAxis: number): [number, number, number] {
  const kappa = 24389 / 27;
  const epsilon = 216 / 24389;
  const fy = (lightness + 16) / 116;
  const fx = fy + aAxis / 500;
  const fz = fy - bAxis / 200;
  const xr = fx ** 3 > epsilon ? fx ** 3 : (116 * fx - 16) / kappa;
  const yr = lightness > kappa * epsilon ? fy ** 3 : lightness / kappa;
  const zr = fz ** 3 > epsilon ? fz ** 3 : (116 * fz - 16) / kappa;
  const xyzD50: [number, number, number] = [xr * D50_WHITE[0], yr * D50_WHITE[1], zr * D50_WHITE[2]];
  return multiply(XYZ_D65_TO_LINEAR_SRGB, multiply(XYZ_D50_TO_XYZ_D65, xyzD50));
}

function toHex(rgb: readonly number[], alpha: number): string {
  const channels = rgb.map((channel) => Math.round(clamp(gammaEncode(channel)) * 255).toString(16).padStart(2, '0')).join('');
  const suffix = alpha >= 1 ? '' : Math.round(clamp(alpha) * 255).toString(16).padStart(2, '0');
  return `#${channels}${suffix}`;
}

interface ParsedFunction { name: string; args: string[]; alpha: number; }

function parseFunction(value: string): ParsedFunction | undefined {
  const match = /^([a-z-]+)\(([\s\S]*)\)$/i.exec(value.trim());
  if (!match) return undefined;
  const body = match[2]!.trim();
  const [componentPart, alphaPart] = body.split('/');
  const args = componentPart!.trim().split(/[\s,]+/).filter((part) => part !== '');
  const alpha = alphaPart === undefined ? 1 : numberOf(alphaPart.trim(), 1) ?? 1;
  return { name: match[1]!.toLowerCase(), args, alpha };
}

/** Resolves a component that may be a bare number, a percentage or `none`. */
function numberOf(raw: string, percentReference: number): number | undefined {
  if (raw === 'none') return 0;
  if (raw.endsWith('%')) {
    const percent = Number.parseFloat(raw.slice(0, -1));
    return Number.isFinite(percent) ? (percent / 100) * percentReference : undefined;
  }
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function angleOf(raw: string): number | undefined {
  if (raw === 'none') return 0;
  const match = /^(-?[\d.]+)(deg|grad|rad|turn)?$/i.exec(raw);
  if (!match) return undefined;
  const amount = Number.parseFloat(match[1]!);
  if (!Number.isFinite(amount)) return undefined;
  const unit = (match[2] ?? 'deg').toLowerCase();
  if (unit === 'deg') return amount;
  if (unit === 'grad') return amount * 0.9;
  if (unit === 'rad') return (amount * 180) / Math.PI;
  return amount * 360;
}

/**
 * Returns an sRGB hex companion for a modern colour value, a failure with a
 * reason when the syntax cannot be converted deterministically, or `undefined`
 * when the value already works everywhere and needs no companion.
 */
export function srgbFallback(value: string): ColorFallbackResult {
  if (!needsColorFallback(value)) return undefined;
  const parsed = parseFunction(value);
  if (!parsed) return { reason: `Value ${value} is not a single colour function this compiler can convert.` };
  if (parsed.args.some((arg) => arg.toLowerCase() === 'from')) return { reason: `Relative colour syntax in ${value} has no deterministic sRGB fallback.` };
  if (parsed.name === 'color-mix' || parsed.name === 'light-dark') return { reason: `${parsed.name}() in ${value} has no deterministic sRGB fallback; declare a plain sRGB token instead.` };

  if (parsed.name === 'oklch' || parsed.name === 'oklab' || parsed.name === 'lch' || parsed.name === 'lab') {
    const polar = parsed.name === 'oklch' || parsed.name === 'lch';
    const perceptual = parsed.name.startsWith('ok');
    const lightness = numberOf(parsed.args[0] ?? '', perceptual ? 1 : 100);
    const second = numberOf(parsed.args[1] ?? '', perceptual ? 0.4 : polar ? 150 : 125);
    const third = polar ? angleOf(parsed.args[2] ?? '') : numberOf(parsed.args[2] ?? '', perceptual ? 0.4 : 125);
    if (lightness === undefined || second === undefined || third === undefined) return { reason: `Value ${value} has components this compiler cannot read.` };
    const aAxis = polar ? second * Math.cos((third * Math.PI) / 180) : second;
    const bAxis = polar ? second * Math.sin((third * Math.PI) / 180) : third;
    const linear = perceptual ? oklabToLinearSrgb(lightness, aAxis, bAxis) : labToLinearSrgb(lightness, aAxis, bAxis);
    return { hex: toHex(linear, parsed.alpha) };
  }

  if (parsed.name === 'color') {
    const space = (parsed.args[0] ?? '').toLowerCase();
    const components = parsed.args.slice(1, 4).map((arg) => numberOf(arg, 1));
    if (components.length !== 3 || components.some((component) => component === undefined)) return { reason: `Value ${value} has components this compiler cannot read.` };
    const channels = components as number[];
    if (space === 'srgb') return { hex: toHex(channels.map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)), parsed.alpha) };
    if (space === 'srgb-linear') return { hex: toHex(channels, parsed.alpha) };
    if (space === 'display-p3') {
      const linearP3 = channels.map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
      return { hex: toHex(multiply(XYZ_D65_TO_LINEAR_SRGB, multiply(LINEAR_DISPLAY_P3_TO_XYZ_D65, linearP3)), parsed.alpha) };
    }
    return { reason: `Colour space ${space || '(missing)'} in ${value} is not one this compiler can convert to sRGB.` };
  }

  return { reason: `Colour function ${parsed.name}() in ${value} has no deterministic sRGB fallback.` };
}

/** Colour functions this module can convert, wherever they appear in a value. */
const CONVERTIBLE = /(?:^|[^a-z-])(oklch|oklab|lch|lab|color)\(/gi;

interface Occurrence { name: string; start: number; end: number; text: string }

/** Finds each convertible colour function, matching parentheses so a nested `calc()` stays intact. */
function occurrences(value: string): Occurrence[] {
  const found: Occurrence[] = [];
  CONVERTIBLE.lastIndex = 0;
  for (let match = CONVERTIBLE.exec(value); match; match = CONVERTIBLE.exec(value)) {
    const start = match.index + match[0].length - match[1]!.length - 1;
    let depth = 0;
    let end = -1;
    for (let index = start; index < value.length; index += 1) {
      if (value[index] === '(') depth += 1;
      else if (value[index] === ')') { depth -= 1; if (depth === 0) { end = index + 1; break; } }
    }
    if (end === -1) break;
    found.push({ name: match[1]!.toLowerCase(), start, end, text: value.slice(start, end) });
    CONVERTIBLE.lastIndex = end;
  }
  return found;
}

/**
 * The sRGB companion for a whole declaration value.
 *
 * A token is not always a bare colour: a shadow carries offsets before the
 * colour, and a gradient carries several. Each convertible colour function is
 * replaced in place, so the rest of the value survives untouched. A value that
 * needs a companion but holds nothing this module can convert is a failure, not
 * a silent pass-through.
 */
export function srgbFallbackValue(value: string): { text: string } | ColorFallbackFailure | undefined {
  if (!needsColorFallback(value)) return undefined;
  const found = occurrences(value);
  if (found.length === 0) return { reason: `Value ${value} uses colour syntax this compiler cannot convert to sRGB.` };
  let text = '';
  let cursor = 0;
  for (const occurrence of found) {
    const converted = srgbFallback(occurrence.text);
    if (converted === undefined) return { reason: `Value ${value} holds ${occurrence.text}, which the compiler did not recognise as a colour.` };
    if (isFallbackFailure(converted)) return converted;
    text += value.slice(cursor, occurrence.start) + converted.hex;
    cursor = occurrence.end;
  }
  text += value.slice(cursor);
  // A value can still hold an unconvertible function alongside a convertible one.
  if (needsColorFallback(text)) return { reason: `Value ${value} still holds colour syntax without an sRGB fallback after conversion.` };
  return { text };
}

/** The `@supports` condition that guards a modern colour value. */
export function supportsConditionFor(value: string): string {
  const name = (occurrences(value)[0]?.name ?? parseFunction(value)?.name ?? 'oklch');
  if (name === 'lab' || name === 'lch') return 'color: lab(0% 0 0)';
  if (name === 'color') return 'color: color(srgb 0 0 0)';
  return 'color: oklch(0% 0 0)';
}
