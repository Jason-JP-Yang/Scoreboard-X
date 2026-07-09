/*
 * palette.js — derive a full team palette from a single primary color.
 * Conversions go through OKLab/OKLCH (perceptually uniform), so darker /
 * brighter / hue-shifted tones keep the character of the input color.
 */

/* ---------------------------------------------------------- conversions */

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return [1, 0, 0];
  const n = parseInt(m[1], 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

export function rgbToHex([r, g, b]) {
  const q = v => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  return '#' + q(r) + q(g) + q(b);
}

const srgbToLin = c => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const linToSrgb = c => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

function rgbToOklab([r, g, b]) {
  r = srgbToLin(r); g = srgbToLin(g); b = srgbToLin(b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

function oklabToRgbRaw([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return [
    linToSrgb(+4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s),
  ];
}

function inGamut(rgb) { return rgb.every(v => v >= -0.0001 && v <= 1.0001); }

/* OKLCH -> hex, reducing chroma (not clipping) when out of the sRGB gamut,
 * which preserves hue and lightness. */
export function oklchToHex(L, C, H) {
  const rad = H * Math.PI / 180;
  let lo = 0, hi = Math.max(0, C);
  let rgb = oklabToRgbRaw([L, hi * Math.cos(rad), hi * Math.sin(rad)]);
  if (!inGamut(rgb)) {
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      const test = oklabToRgbRaw([L, mid * Math.cos(rad), mid * Math.sin(rad)]);
      if (inGamut(test)) { lo = mid; rgb = test; } else hi = mid;
    }
  }
  return rgbToHex(rgb);
}

export function hexToOklch(hex) {
  const [L, a, b] = rgbToOklab(hexToRgb(hex));
  return { L, C: Math.hypot(a, b), H: ((Math.atan2(b, a) * 180 / Math.PI) + 360) % 360 };
}

/* WCAG relative luminance, for picking readable ink color */
export function relLuminance(hex) {
  const [r, g, b] = hexToRgb(hex).map(srgbToLin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function hexToRgba(hex, alpha) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${alpha})`;
}

/* ------------------------------------------------------------- palette */

export function buildPalette(hex) {
  let { L, C, H } = hexToOklch(hex);
  // keep extreme inputs usable as a background (near-white / near-black jerseys)
  L = Math.min(0.82, Math.max(0.30, L));

  const base    = oklchToHex(L, C, H);
  const deep    = oklchToHex(L * 0.74, C * 0.96, H);
  const deeper  = oklchToHex(L * 0.55, C * 0.88, H - 4);
  const bright  = oklchToHex(Math.min(0.93, L + 0.17), C * 1.08, H);
  const glow    = oklchToHex(0.87, Math.min(C, 0.13), H);
  const shift   = oklchToHex(L * 0.86, C * 0.92, H + 14);

  const isLight = relLuminance(base) > 0.42;
  const ink     = isLight ? '#0D0F13' : '#FFFFFF';

  return {
    input: hex,
    base, deep, deeper, bright, glow, shift, ink, isLight,
    inkSoft:  isLight ? 'rgba(13,15,19,0.72)' : 'rgba(255,255,255,0.78)',
    inkFaint: isLight ? 'rgba(13,15,19,0.16)' : 'rgba(255,255,255,0.16)',
    line: hexToRgba(bright, 0.65),
  };
}

/* ------------------------------------------------- faceted background
 * A modern, minimal "cut facet" backdrop: large calm angular shapes in
 * derived tones + hairline texture + soft top light. Not a flat fill,
 * not a plain gradient. `mirror` flips it for the away team.
 */
let facetSeq = 0;
export function facetSVG(pal, { mirror = false } = {}) {
  const uid = 'fx' + (++facetSeq);
  const flip = mirror ? ' transform="translate(100 0) scale(-1 1)"' : '';
  return `
<svg class="facet-svg" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice"
     xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="${uid}-light" cx="22%" cy="0%" r="85%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.16"/>
      <stop offset="55%" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="${uid}-shade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="55%" stop-color="#000000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.22"/>
    </linearGradient>
    <pattern id="${uid}-hair" width="7" height="7" patternTransform="rotate(24)" patternUnits="userSpaceOnUse">
      <rect width="7" height="7" fill="none"/>
      <rect width="0.55" height="7" fill="${pal.ink}" opacity="0.05"/>
    </pattern>
  </defs>
  <rect width="100" height="100" fill="${pal.base}"/>
  <g${flip}>
    <g class="facet-drift">
      <polygon points="-8,-6 74,-12 44,34 -8,52"  fill="${pal.deep}"   opacity="0.92"/>
      <polygon points="112,62 118,112 30,112 66,70" fill="${pal.deeper}" opacity="0.85"/>
      <polygon points="-8,58 34,40 60,108 -8,108"  fill="${pal.shift}"  opacity="0.45"/>
      <polygon points="74,-12 112,-16 112,30 44,34" fill="${pal.shift}" opacity="0.30"/>
      <polygon points="44,34 46.4,34 66,70 63.6,70" fill="${pal.bright}" opacity="0.9"/>
      <polygon points="-8,52 44,34 44.9,36.2 -8,54.4" fill="${pal.bright}" opacity="0.55"/>
    </g>
  </g>
  <rect width="100" height="100" fill="url(#${uid}-hair)"/>
  <rect width="100" height="100" fill="url(#${uid}-light)"/>
  <rect width="100" height="100" fill="url(#${uid}-shade)"/>
</svg>`;
}
