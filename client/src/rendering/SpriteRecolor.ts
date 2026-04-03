import { Scene } from '@babylonjs/core/scene';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { DirectionalSpriteSet, AnimationSpriteSet } from './SpriteEntity';

/**
 * HSL color zone definitions for the player sprite.
 * Determined by analyzing south.png pixel data:
 *   - Shirt: hue 208-212, saturation 0.67-1.0, lightness 0.18-0.38
 *   - Pants: saturation < 0.08, lightness > 0.40
 *   - Skin:  hue 1-36, saturation > 0.20, lightness > 0.60
 *   - Hair:  hue 13-32, saturation > 0.15, lightness 0.15-0.47
 */

/** Target colors for recoloring a humanoid sprite. All values are HSL. */
export interface RecolorConfig {
  /** Shirt hue shift (0-360). null = keep original blue. */
  shirtHue?: number;
  /** Shirt saturation override (0-1). null = keep original. */
  shirtSat?: number;
  /** Shirt lightness offset (-1 to 1). Added to original lightness. */
  shirtLightOffset?: number;

  /** Pants hue (0-360). null = keep original white/grey. */
  pantsHue?: number;
  /** Pants saturation (0-1). null = keep original (near 0). */
  pantsSat?: number;
  /** Pants lightness offset. */
  pantsLightOffset?: number;

  /** Skin hue shift. null = keep original. */
  skinHue?: number;
  /** Skin saturation override. */
  skinSat?: number;
  /** Skin lightness offset. */
  skinLightOffset?: number;

  /** Hair hue. null = keep original brown. */
  hairHue?: number;
  /** Hair saturation override. */
  hairSat?: number;
  /** Hair lightness offset. */
  hairLightOffset?: number;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return [h * 360, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(1, s));
  l = Math.max(0, Math.min(1, l));
  h /= 360;
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, h + 1/3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1/3) * 255),
  ];
}

type Zone = 'shirt' | 'pants' | 'skin' | 'hair' | 'none';

function classifyPixel(h: number, s: number, l: number): Zone {
  // Outline / near-black: don't recolor
  if (l < 0.12) return 'none';
  // Blue shirt: hue 190-230, high saturation
  if (h > 190 && h < 235 && s > 0.30) return 'shirt';
  // White/grey pants: very low saturation, medium-high lightness
  if (s < 0.10 && l > 0.35) return 'pants';
  // Skin: warm hue, moderate+ saturation, high lightness
  if (h >= 0 && h < 42 && s > 0.18 && l > 0.55) return 'skin';
  // Hair: warm hue, moderate saturation, darker
  if (h >= 0 && h < 55 && s > 0.12 && l >= 0.12 && l < 0.55) return 'hair';
  return 'none';
}

/**
 * Recolor RGBA pixel data in-place according to the given config.
 */
function recolorPixels(data: Uint8ClampedArray, config: RecolorConfig): void {
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a < 128) continue;

    const r = data[i], g = data[i + 1], b = data[i + 2];
    const [h, s, l] = rgbToHsl(r, g, b);
    const zone = classifyPixel(h, s, l);

    let newH = h, newS = s, newL = l;
    let changed = false;

    switch (zone) {
      case 'shirt':
        if (config.shirtHue != null) { newH = config.shirtHue; changed = true; }
        if (config.shirtSat != null) { newS = config.shirtSat; changed = true; }
        if (config.shirtLightOffset != null) { newL = l + config.shirtLightOffset; changed = true; }
        break;
      case 'pants':
        if (config.pantsHue != null) { newH = config.pantsHue; changed = true; }
        if (config.pantsSat != null) { newS = config.pantsSat; changed = true; }
        if (config.pantsLightOffset != null) { newL = l + config.pantsLightOffset; changed = true; }
        break;
      case 'skin':
        if (config.skinHue != null) { newH = config.skinHue; changed = true; }
        if (config.skinSat != null) { newS = config.skinSat; changed = true; }
        if (config.skinLightOffset != null) { newL = l + config.skinLightOffset; changed = true; }
        break;
      case 'hair':
        if (config.hairHue != null) { newH = config.hairHue; changed = true; }
        if (config.hairSat != null) { newS = config.hairSat; changed = true; }
        if (config.hairLightOffset != null) { newL = l + config.hairLightOffset; changed = true; }
        break;
    }

    if (changed) {
      const [nr, ng, nb] = hslToRgb(newH, newS, newL);
      data[i] = nr;
      data[i + 1] = ng;
      data[i + 2] = nb;
    }
  }
}

/**
 * Load an image from a URL into an ImageBitmap, draw it to a canvas,
 * recolor the pixels, and return a Babylon.js RawTexture.
 */
async function loadAndRecolorImage(
  url: string, config: RecolorConfig, scene: Scene, name: string
): Promise<Texture | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      recolorPixels(imageData.data, config);
      ctx.putImageData(imageData, 0, 0);

      // Create RawTexture from the recolored data
      const engine = scene.getEngine();
      const tex = RawTexture.CreateRGBATexture(
        imageData.data,
        canvas.width,
        canvas.height,
        scene,
        false,     // generateMipMaps
        true,      // invertY — canvas is top-down, WebGL expects bottom-up
        Texture.NEAREST_SAMPLINGMODE
      );
      tex.hasAlpha = true;
      tex.name = name;
      resolve(tex);
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function makeSpriteMat(scene: Scene, name: string, tex: Texture | null): StandardMaterial {
  const mat = new StandardMaterial(name, scene);
  if (tex) {
    mat.diffuseTexture = tex;
    mat.useAlphaFromDiffuseTexture = true;
  }
  mat.specularColor = new Color3(0, 0, 0);
  mat.emissiveColor = new Color3(0.3, 0.3, 0.3);
  mat.backFaceCulling = false;
  mat.transparencyMode = 1;
  return mat;
}

/**
 * Load directional sprites from the player sprite folder, recolored with the given config.
 * Same logic as loadDirectionalSprites but applies pixel recoloring.
 */
export async function loadRecoloredDirectionalSprites(
  scene: Scene, basePath: string, name: string, config: RecolorConfig
): Promise<DirectionalSpriteSet> {
  const allFiles = [
    'south.png', 'south-east.png', 'east.png', 'north-east.png',
    'north.png', 'north-west.png', 'west.png', 'south-west.png',
  ];

  const textures = await Promise.all(
    allFiles.map((file, i) =>
      loadAndRecolorImage(`${basePath}/${file}`, config, scene, `${name}_${file}`)
    )
  );

  const [texS, texSE, texE, texNE, texN, texNW, texW, texSW] = textures;

  const texNorth = texN ?? texNE;
  const texNorthWest = texNW ?? texNE;
  const texWest = texW ?? texE;
  const texSouthWest = texSW ?? texSE;

  const materials = [
    makeSpriteMat(scene, `${name}_S`, texS),
    makeSpriteMat(scene, `${name}_SE`, texSE),
    makeSpriteMat(scene, `${name}_E`, texE),
    makeSpriteMat(scene, `${name}_NE`, texNE),
    makeSpriteMat(scene, `${name}_N`, texNorth),
    makeSpriteMat(scene, `${name}_NW`, texNorthWest),
    makeSpriteMat(scene, `${name}_W`, texWest),
    makeSpriteMat(scene, `${name}_SW`, texSouthWest),
  ];

  const mirrored = [false, false, false, false, false, !texNW, !texW, !texSW];
  return { materials, mirrored };
}

/**
 * Load 8-direction animation sprites, recolored.
 */
export async function loadRecolored8DirAnimationSprites(
  scene: Scene, basePath: string, name: string, frameCount: number, config: RecolorConfig
): Promise<AnimationSpriteSet> {
  const dirNames = ['south', 'south-east', 'east', 'north-east', 'north', 'north-west', 'west', 'south-west'];
  const materials: StandardMaterial[][] = [];
  const loaded: boolean[] = [];

  for (let d = 0; d < dirNames.length; d++) {
    const dirMats: StandardMaterial[] = [];
    let dirLoaded = false;
    for (let f = 0; f < frameCount; f++) {
      const frameStr = String(f).padStart(3, '0');
      const filePath = `${basePath}/${dirNames[d]}/frame_${frameStr}.png`;
      const tex = await loadAndRecolorImage(filePath, config, scene, `${name}_8anim_${dirNames[d]}_${f}`);
      if (tex) dirLoaded = true;
      dirMats.push(makeSpriteMat(scene, `${name}_8anim_${dirNames[d]}_${f}_mat`, tex));
    }
    materials.push(dirMats);
    loaded.push(dirLoaded);
  }

  // Fallback mirroring
  const DIR_NW = 5, DIR_W = 6, DIR_SW = 7, DIR_NE = 3, DIR_E = 2, DIR_SE = 1, DIR_N = 4;
  const mirrored8 = [false, false, false, false, false, false, false, false];
  if (!loaded[DIR_NW]) { materials[DIR_NW] = materials[DIR_NE]; mirrored8[DIR_NW] = true; }
  if (!loaded[DIR_W])  { materials[DIR_W]  = materials[DIR_E];  mirrored8[DIR_W]  = true; }
  if (!loaded[DIR_SW]) { materials[DIR_SW] = materials[DIR_SE]; mirrored8[DIR_SW] = true; }
  if (!loaded[DIR_N] && loaded[DIR_NE]) { materials[DIR_N] = materials[DIR_NE]; }

  return { materials, frameCount, mirrorW: false, meshScaleX: 1, meshScaleY: 1, mirrored8 };
}

/**
 * Load 4-cardinal animation sprites, recolored.
 */
export async function loadRecoloredAnimationSprites(
  scene: Scene, basePath: string, name: string, frameCount: number, config: RecolorConfig
): Promise<AnimationSpriteSet> {
  const dirs = ['south', 'east', 'north', 'west'];
  const materials: StandardMaterial[][] = [];
  const CARD_W = 3, CARD_E = 1;

  for (let d = 0; d < dirs.length; d++) {
    const dirMats: StandardMaterial[] = [];
    for (let f = 0; f < frameCount; f++) {
      const frameStr = String(f).padStart(3, '0');
      const filePath = `${basePath}/${dirs[d]}/frame_${frameStr}.png`;
      const tex = await loadAndRecolorImage(filePath, config, scene, `${name}_anim_${dirs[d]}_${f}`);
      dirMats.push(makeSpriteMat(scene, `${name}_anim_${dirs[d]}_${f}_mat`, tex));
    }
    materials.push(dirMats);
  }

  let mirrorW = false;
  if (materials[CARD_W].length > 0 && materials[CARD_W][0].diffuseTexture) {
    mirrorW = false;
  } else {
    materials[CARD_W] = materials[CARD_E];
    mirrorW = true;
  }

  return { materials, frameCount, mirrorW, meshScaleX: 1, meshScaleY: 1 };
}
