// Folio theme system.
//
// A palette is six hexes in stack order. deriveTheme() turns a palette + mode
// (dark/light) into the full design-token set, and deriveGlassTokens() builds
// the frosted-glass material from the same slots — one mapping, so themes
// cannot drift apart.
//
// Folio role mapping (slots, top → bottom of the source cards):
// slot 1 deep base → dark surface; light-mode ink
// slot 2 raised   → dark raised-family
// slot 3 mid      → fills; light accent
// slot 4 accent-lt→ dark accent
// slot 5 pale     → dark text; light-mode surface tint
// slot 6 dual     → accent-2 (orange/gold/coral/pink) in six stacks,
//                    a slate in the other ten. An "accent2" slot 6 is both
//                    the theme's second accent and its danger color.

import { PaletteId } from '../types/note';

interface FolioPalette {
  id: PaletteId;
  name: string;
  slots: [string, string, string, string, string, string];
  slot6: 'accent2' | 'slate';
}

export const PALETTES: FolioPalette[] = [
  { id: 'forest', name: 'Forest', slots: ['#0F1F17', '#1E3A2E', '#3E5A3F', '#6B7F67', '#C7CBB8', '#3D4337'], slot6: 'slate' },
  { id: 'ember', name: 'Amber Navy', slots: ['#0B132B', '#1C2541', '#3A506B', '#5BC0DE', '#F4D6B0', '#D97706'], slot6: 'accent2' },
  { id: 'sage', name: 'Sage Gold', slots: ['#0B0F0D', '#1F2A1F', '#3E5A3F', '#8CA98C', '#D9C7A3', '#B08D57'], slot6: 'accent2' },
  { id: 'lagoon', name: 'Lagoon', slots: ['#0A0F14', '#0F3D3E', '#2E6F73', '#7FB3B8', '#EADCC8', '#C6601F'], slot6: 'accent2' },
  { id: 'ultraviolet', name: 'Ultraviolet', slots: ['#1A0F2E', '#3B1B4F', '#7A2E6F', '#D6598F', '#F4D7D4', '#FF6B6B'], slot6: 'accent2' },
  { id: 'indigo', name: 'Indigo Amber', slots: ['#1A1A1F', '#2D2B55', '#6A5ACD', '#A678B9', '#F0D9B5', '#F4A62A'], slot6: 'accent2' },
  { id: 'graphite', name: 'Graphite Pink', slots: ['#121212', '#1F2937', '#334155', '#64748B', '#F1F5F9', '#EC4899'], slot6: 'accent2' },
  { id: 'violet', name: 'Violet', slots: ['#0E0B1D', '#2A1E4D', '#5A3B8C', '#8B7CC7', '#C9C2E3', '#3A3A52'], slot6: 'slate' },
  { id: 'bronze', name: 'Bronze', slots: ['#1A120E', '#3A2418', '#6B4A2E', '#A88462', '#D5C4AE', '#4A4A46'], slot6: 'slate' },
  { id: 'teal', name: 'Deep Teal', slots: ['#0B3D3B', '#0E6860', '#14B8A6', '#99F6E4', '#E6FFFB', '#C0FBF0'], slot6: 'slate' },
  { id: 'mist', name: 'Mist Slate', slots: ['#191D23', '#2F3A41', '#57707A', '#7B919C', '#989DAA', '#C5BAC4'], slot6: 'slate' },
  { id: 'lavender', name: 'Lavender', slots: ['#0D0B2D', '#282177', '#5B4BFF', '#A78BFA', '#E6E0FF', '#C7B6FD'], slot6: 'slate' },
  { id: 'royal', name: 'Royal Blue', slots: ['#0B1F3B', '#143779', '#2563EB', '#60A5FA', '#DBEAFE', '#9EC8FC'], slot6: 'slate' },
  { id: 'tangerine', name: 'Tangerine', slots: ['#1F1D2B', '#6D3E1C', '#FF7A00', '#FFA94D', '#FFE4C7', '#FFC78A'], slot6: 'slate' },
  { id: 'amethyst', name: 'Amethyst', slots: ['#5B21B6', '#6C36CC', '#8B5CF6', '#C7B3FF', '#EDE9FE', '#DACEFF'], slot6: 'slate' },
  { id: 'rose', name: 'Rose', slots: ['#6D0D3F', '#99225F', '#EC4899', '#F9A8D4', '#FCE7F3', '#FBC8E4'], slot6: 'slate' },
];

// Forest is the first entry in PALETTES and the fallback when a stored
// palette id is unknown — one definition, referenced, never copied.
function paletteById(id: string): FolioPalette {
  const found = PALETTES.find((p) => p.id === id);
  if (!found) {
    console.warn(`Unknown palette id "${id}", falling back to Forest.`);
    return PALETTES[0] as FolioPalette;
  }
  return found;
}

// --- color helpers ---------------------------------------------------------

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '').trim();
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  if (!/^[0-9a-fA-F]{6}$/.test(v)) {
    // Never emit NaN into CSS vars; fall back to black.
    return [0, 0, 0];
  }
  const n = parseInt(v, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r: number, g: number, b: number): string {
  const c = (x: number) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Linear mix of two hex colors: t=0 → a, t=1 → b. */
function mixHex(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  return rgbToHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t);
}

/** Relative luminance (0–1) for a contrast pick. */
function luminance(hex: string): number {
  const rgb = hexToRgb(hex);
  const r = rgb[0] ?? 0, g = rgb[1] ?? 0, b = rgb[2] ?? 0;
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Contrast ratio 1–21 between two hex colors (WCAG). */
function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Pick black or white text for a background by actual contrast ratio, so
 * saturated accents get the correct pick. The candidates are the dark ink
 * and white.
 */
function bestAccentText(bg: string): string {
  return contrastRatio(bg, '#ffffff') >= contrastRatio(bg, '#0F1F17') ? '#ffffff' : '#0F1F17';
}

/** Hex → rgba() string. */
function hexToRgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Alpha a translucent surface needs so --glass stays readable on --bg. */
function glassAlphaForMode(mode: 'dark' | 'light'): number {
  return mode === 'dark' ? 0.62 : 0.55;
}

// --- glass derivation ------------------------------------------------------
//
// Dark: translucent versions of the raised family (slots 1→2 mix), so the
// aurora accent glow bleeds through.
// Light: white-based translucent surfaces, with a hairline border in slot-1
// ink at 12%.

interface GlassTokens {
  /** Translucent glass surface (panels, cards). */
  glass: string;
  /** More opaque glass (menus, modals, dropdowns). */
  glassStrong: string;
  /** Hairline border for glass surfaces. */
  glassBorder: string;
  /** Inset specular highlight (top edge light). */
  glassHighlight: string;
  /** Aurora backdrop blob 1 (primary accent). */
  auroraA: string;
  /** Aurora backdrop blob 2 (secondary accent). */
  auroraB: string;
}

function deriveGlassTokens(palette: FolioPalette, mode: 'dark' | 'light'): GlassTokens {
  const [s1, s2, s3, s4, s5, s6] = palette.slots;
  const accent2 = palette.slot6 === 'accent2' ? s6 : s3;

  if (mode === 'dark') {
    const accent = s4;
    return {
      glass: hexToRgba(mixHex(s1, s2, 0.3), glassAlphaForMode(mode)),
      glassStrong: hexToRgba(mixHex(s1, s2, 0.55), 0.84),
      glassBorder: hexToRgba(s5, 0.16),
      glassHighlight: hexToRgba(s5, 0.1),
      auroraA: hexToRgba(accent, 0.16),
      auroraB: hexToRgba(accent2, 0.14),
    };
  }

  const accent = s3;
  return {
    glass: `rgba(255, 255, 255, ${glassAlphaForMode(mode)})`,
    glassStrong: 'rgba(255, 255, 255, 0.84)',
    glassBorder: hexToRgba(s1, 0.12),
    glassHighlight: 'rgba(255, 255, 255, 0.75)',
    auroraA: hexToRgba(accent, 0.12),
    auroraB: hexToRgba(accent2, 0.1),
  };
}

/** Map the glassiness setting (0–100) to backdrop-filter amounts.
 *  0 = almost solid (minimal blur), 100 = full frost. */
export function glassFilterForIntensity(glassiness: number): { blurPx: number; saturatePct: number } {
  const g = Math.max(0, Math.min(100, glassiness));
  return {
    blurPx: 6 + g * 0.18, // 6 – 24px
    saturatePct: 130 + g * 0.7, // 130% – 200%
  };
}

// --- derivation -------------------------------------------------------------

interface ThemeTokens {
  bg: string;
  surface: string;
  raised: string;
  border: string;
  text: string;
  muted: string;
  faint: string;
  accent: string;
  accent2: string;
  accentText: string;
  danger: string;
  dangerText: string;
  ok: string;
  warn: string;
  shadow: string;
  /** Selection background + text, guaranteed readable (see selectionPair). */
  selectionBg: string;
  selectionText: string;
  /** Glass material + aurora tints. */
  glass: string;
  glassStrong: string;
  glassBorder: string;
  glassHighlight: string;
  auroraA: string;
  auroraB: string;
}

/**
 * Selection colors, guaranteed readable by construction.
 *
 * Light mode is always a solid accent: the translucent wash rendered the
 * selected text in (nearly) the wash color in WebView2, so a selection was
 * unreadable there. Dark mode keeps the wash look — pre-mixed to a solid
 * hex over the background, so no color-mix ever reaches ::selection — but
 * only when the wash reads (contrast >= 4.5 against the text); otherwise
 * it falls back to the solid pair. A solid background that misses 4.5:1
 * is darkened in 5% steps until it passes (Amethyst light), so every
 * palette clears the bar in both modes.
 */
function selectionPair(
  mode: 'dark' | 'light',
  bg: string,
  accent: string,
  text: string,
  accentText: string
): { selectionBg: string; selectionText: string } {
  if (mode === 'dark') {
    const washHex = mixHex(bg, accent, 0.45);
    if (contrastRatio(washHex, text) >= 4.5) {
      return { selectionBg: washHex, selectionText: text };
    }
  }
  let selectionBg = accent;
  let selectionText = accentText;
  for (let d = 0; d <= 0.3; d += 0.05) {
    selectionBg = mixHex(accent, '#000000', d);
    selectionText = bestAccentText(selectionBg);
    if (contrastRatio(selectionBg, selectionText) >= 4.5) break;
  }
  return { selectionBg, selectionText };
}

function deriveTheme(palette: FolioPalette, mode: 'dark' | 'light'): ThemeTokens {
  const [s1, s2, s3, s4, s5, s6] = palette.slots;
  const accent2 = palette.slot6 === 'accent2' ? s6 : s3;
  // A hot accent-2 is a better danger than an imported red; otherwise a
  // standing red stepped for the mode.
  const danger = palette.slot6 === 'accent2' ? s6 : mode === 'dark' ? '#f87171' : '#dc2626';
  const glassTokens = deriveGlassTokens(palette, mode);

  if (mode === 'dark') {
    const accent = s4;
    return {
      bg: s1,
      surface: s1,
      raised: mixHex(s1, s2, 0.5),
      border: mixHex(s1, s5, 0.14),
      text: s5,
      muted: mixHex(s5, s4, 0.3),
      faint: mixHex(s5, s4, 0.55),
      accent,
      accent2,
      accentText: bestAccentText(accent),
      danger,
      dangerText: bestAccentText(danger),
      ok: '#4ade80',
      warn: '#fbbf24',
      shadow: hexToRgba(accent, 0.25),
      ...selectionPair(mode, s1, accent, s5, bestAccentText(accent)),
      ...glassTokens,
    };
  }

  // Light: surface is the pale slot tinted toward white; ink is slot 1.
  const bg = mixHex(s5, '#ffffff', 0.3);
  const accent = s3;
  return {
    bg,
    surface: bg,
    raised: mixHex(s5, '#ffffff', 0.12),
    border: mixHex(s1, bg, 0.82),
    text: s1,
    muted: mixHex(s3, s1, 0.35),
    faint: mixHex(s1, bg, 0.42),
    accent,
    accent2,
    accentText: bestAccentText(accent),
    danger,
    dangerText: bestAccentText(danger),
    ok: '#16a34a',
    warn: '#d97706',
    shadow: hexToRgba(accent, 0.18),
    ...selectionPair(mode, bg, accent, s1, bestAccentText(accent)),
    ...glassTokens,
  };
}

/**
 * Apply a palette + mode: sets the design tokens as CSS variables on
 * <html> and toggles the .dark class. Call whenever settings change.
 */
export function applyTheme(paletteId: string, mode: 'dark' | 'light', glassiness = 70): void {
  const palette = paletteById(paletteId);
  const t = deriveTheme(palette, mode);
  const root = document.documentElement;
  root.setAttribute('data-palette', palette.id);
  if (mode === 'dark') root.classList.add('dark');
  else root.classList.remove('dark');
  const set = (name: string, value: string) => root.style.setProperty(name, value);
  set('--bg', t.bg);
  set('--surface', t.surface);
  set('--raised', t.raised);
  set('--border', t.border);
  set('--text', t.text);
  set('--muted', t.muted);
  set('--faint', t.faint);
  set('--accent', t.accent);
  set('--accent-2', t.accent2);
  set('--accent-text', t.accentText);
  set('--danger', t.danger);
  set('--danger-text', t.dangerText);
  set('--ok', t.ok);
  set('--warn', t.warn);
  set('--shadow', t.shadow);
  set('--selection-bg', t.selectionBg);
  set('--selection-text', t.selectionText);
  // Glass material.
  set('--glass', t.glass);
  set('--glass-strong', t.glassStrong);
  set('--glass-border', t.glassBorder);
  set('--glass-highlight', t.glassHighlight);
  set('--aurora-a', t.auroraA);
  set('--aurora-b', t.auroraB);
  const filter = glassFilterForIntensity(glassiness);
  set('--blur', `${Math.round(filter.blurPx)}px`);
  set('--saturate', `${Math.round(filter.saturatePct)}%`);
}
