// Character appearance customization — shared between client and server

/**
 * A player's appearance: indices into the color palettes below.
 * Stored in the DB as JSON, synced to other players via PLAYER_SYNC.
 */
export interface PlayerAppearance {
  shirtColor: number;
  pantsColor: number;
  shoesColor: number;
  hairColor: number;
  beltColor: number;
  shirtStyle: number;
}

/** RGB triplets (0-1 linear) — index maps to PlayerAppearance.*Color fields */
export const SHIRT_COLORS: [number, number, number][] = [
  [0.032, 0.052, 0.123],  // 0  dark blue (default)
  [0.015, 0.080, 0.025],  // 1  forest green
  [0.120, 0.010, 0.010],  // 2  crimson
  [0.080, 0.020, 0.090],  // 3  purple
  [0.100, 0.060, 0.010],  // 4  brown
  [0.020, 0.080, 0.090],  // 5  teal
  [0.110, 0.080, 0.010],  // 6  gold
  [0.060, 0.060, 0.065],  // 7  charcoal
  [0.130, 0.130, 0.130],  // 8  light grey
  [0.010, 0.010, 0.010],  // 9  black
  [0.140, 0.060, 0.010],  // 10 orange
  [0.090, 0.010, 0.050],  // 11 magenta
  [0.500, 0.500, 0.500],  // 12 white
  [0.060, 0.020, 0.080],  // 13 dark purple
  [0.010, 0.040, 0.080],  // 14 navy
  [0.120, 0.010, 0.060],  // 15 pink
];

export const PANTS_COLORS: [number, number, number][] = [
  [0.443, 0.404, 0.404],  // 0  light grey (default)
  [0.180, 0.120, 0.070],  // 1  brown
  [0.032, 0.052, 0.123],  // 2  dark blue
  [0.020, 0.050, 0.020],  // 3  dark green
  [0.060, 0.060, 0.065],  // 4  charcoal
  [0.010, 0.010, 0.010],  // 5  black
  [0.100, 0.050, 0.020],  // 6  tan
  [0.100, 0.010, 0.010],  // 7  dark red
  [0.200, 0.180, 0.160],  // 8  khaki
  [0.050, 0.020, 0.060],  // 9  dark purple
  [0.140, 0.140, 0.140],  // 10 silver
  [0.070, 0.050, 0.010],  // 11 olive
  [0.500, 0.500, 0.500],  // 12 white
];

export const SHOES_COLORS: [number, number, number][] = [
  [0.057, 0.052, 0.054],  // 0  near black (default)
  [0.080, 0.040, 0.015],  // 1  dark brown
  [0.140, 0.090, 0.050],  // 2  tan
  [0.030, 0.030, 0.050],  // 3  dark navy
  [0.050, 0.020, 0.020],  // 4  dark red
  [0.020, 0.040, 0.020],  // 5  dark green
  [0.100, 0.100, 0.100],  // 6  grey
  [0.010, 0.010, 0.010],  // 7  black
  [0.400, 0.400, 0.400],  // 8  white
];

/** Belt color index 0 = "No Belt" (matches shirt color). Handled in applyAppearance. */
export const BELT_NO_BELT = 0;

export const BELT_COLORS: [number, number, number][] = [
  [0.000, 0.000, 0.000],  // 0  No Belt (placeholder — replaced by shirt color at runtime)
  [0.182, 0.006, 0.006],  // 1  dark red
  [0.080, 0.040, 0.015],  // 2  dark brown
  [0.010, 0.010, 0.010],  // 3  black
  [0.060, 0.060, 0.065],  // 4  charcoal
  [0.110, 0.080, 0.010],  // 5  gold
  [0.020, 0.050, 0.020],  // 6  dark green
  [0.032, 0.052, 0.123],  // 7  dark blue
  [0.140, 0.090, 0.050],  // 8  tan
  [0.500, 0.500, 0.500],  // 9  white
];

export const HAIR_COLORS: [number, number, number][] = [
  [0.130, 0.063, 0.028],  // 0  brown (default)
  [0.180, 0.140, 0.050],  // 1  blonde
  [0.010, 0.010, 0.010],  // 2  black
  [0.120, 0.030, 0.010],  // 3  auburn
  [0.200, 0.080, 0.020],  // 4  ginger
  [0.150, 0.150, 0.150],  // 5  grey
  [0.080, 0.025, 0.025],  // 6  dark red
  [0.060, 0.040, 0.020],  // 7  dark brown
  [0.450, 0.450, 0.450],  // 8  white
  [0.250, 0.200, 0.080],  // 9  light blonde
];

/** Default appearance for the character creator preview */
/** Shirt style variants — index maps to GLB filename suffix */
export const SHIRT_STYLES: { name: string; glbSuffix: string }[] = [
  { name: 'Short Sleeve', glbSuffix: '' },
  { name: 'Long Sleeve',  glbSuffix: '_longsleeve' },
];

export const DEFAULT_APPEARANCE: PlayerAppearance = {
  shirtColor: 0,
  pantsColor: 0,
  shoesColor: 0,
  hairColor: 0,
  beltColor: 1,
  shirtStyle: 0,
};

/** Validate that all indices are within palette range */
export function isValidAppearance(a: PlayerAppearance): boolean {
  return (
    Number.isInteger(a.shirtColor) && a.shirtColor >= 0 && a.shirtColor < SHIRT_COLORS.length &&
    Number.isInteger(a.pantsColor) && a.pantsColor >= 0 && a.pantsColor < PANTS_COLORS.length &&
    Number.isInteger(a.shoesColor) && a.shoesColor >= 0 && a.shoesColor < SHOES_COLORS.length &&
    Number.isInteger(a.hairColor)  && a.hairColor >= 0  && a.hairColor < HAIR_COLORS.length &&
    Number.isInteger(a.beltColor)  && a.beltColor >= 0  && a.beltColor < BELT_COLORS.length &&
    Number.isInteger(a.shirtStyle) && a.shirtStyle >= 0 && a.shirtStyle < SHIRT_STYLES.length
  );
}

/** Fill in missing fields from older saved appearances (backwards compat) */
export function normalizeAppearance(a: Partial<PlayerAppearance>): PlayerAppearance {
  return {
    shirtColor: a.shirtColor ?? 0,
    pantsColor: a.pantsColor ?? 0,
    shoesColor: a.shoesColor ?? 0,
    hairColor:  a.hairColor ?? 0,
    beltColor:  a.beltColor ?? 0,
    shirtStyle: a.shirtStyle ?? 0,
  };
}

/**
 * Material name → appearance slot mapping.
 * When a GLB is loaded, materials matching these names get recolored.
 * Names are matched case-insensitively, with optional .001 suffix stripped.
 */
/** Color slots that map to GLB material names (excludes non-color fields like shirtStyle) */
export type AppearanceColorSlot = 'shirtColor' | 'pantsColor' | 'shoesColor' | 'hairColor' | 'beltColor';

export const APPEARANCE_MATERIAL_MAP: Record<AppearanceColorSlot, string[]> = {
  shirtColor: ['Shirt', 'shirt openings'],
  pantsColor: ['pants'],
  shoesColor: ['socks', 'mat_4550'],
  hairColor:  ['Hair_1'],
  beltColor:  ['belt'],
};

/** Get the palette array for a given color slot */
export function getPalette(slot: AppearanceColorSlot): [number, number, number][] {
  switch (slot) {
    case 'shirtColor': return SHIRT_COLORS;
    case 'pantsColor': return PANTS_COLORS;
    case 'shoesColor': return SHOES_COLORS;
    case 'hairColor':  return HAIR_COLORS;
    case 'beltColor':  return BELT_COLORS;
  }
}
