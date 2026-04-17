import {
  type PlayerAppearance,
  DEFAULT_APPEARANCE,
  SHIRT_COLORS,
  PANTS_COLORS,
  SHOES_COLORS,
  HAIR_COLORS,
  BELT_COLORS,
  SHIRT_STYLES,
} from '@projectrs/shared';
import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { Vector3, Color3, Color4 } from '@babylonjs/core/Maths/math';
import { CharacterEntity } from '../rendering/CharacterEntity';

export type CharacterCreatorCallback = (appearance: PlayerAppearance) => void;

/**
 * Full-screen character creation overlay shown to new accounts.
 * Renders a live 3D preview in its own Babylon Engine + Scene.
 */
export class CharacterCreator {
  private container: HTMLDivElement;
  private onConfirm: CharacterCreatorCallback;
  private appearance: PlayerAppearance;

  // 3D preview — own engine to avoid fog/lighting conflicts with game scene
  private previewCanvas: HTMLCanvasElement | null = null;
  private previewEngine: Engine | null = null;
  private previewScene: Scene | null = null;
  private previewCharacter: CharacterEntity | null = null;

  constructor(_gameScene: Scene, onConfirm: CharacterCreatorCallback) {
    this.onConfirm = onConfirm;
    this.appearance = { ...DEFAULT_APPEARANCE };
    this.container = this.buildUI();
    document.body.appendChild(this.container);
    // Defer preview init to next frame so the DOM canvas is attached
    requestAnimationFrame(() => this.initPreview());
  }

  private buildUI(): HTMLDivElement {
    const overlay = document.createElement('div');
    overlay.id = 'character-creator';
    overlay.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(0, 0, 0, 0.85);
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      z-index: 10000; font-family: monospace;
    `;

    const title = document.createElement('div');
    title.textContent = 'Create Your Character';
    title.style.cssText = `
      font-size: 32px; font-weight: bold; color: #fc0;
      text-shadow: 2px 2px 4px rgba(0,0,0,0.8), 0 0 20px rgba(255,204,0,0.3);
      margin-bottom: 6px; letter-spacing: 2px;
    `;
    overlay.appendChild(title);

    const subtitle = document.createElement('div');
    subtitle.textContent = 'Choose your appearance';
    subtitle.style.cssText = `font-size: 13px; color: #8a7a60; margin-bottom: 24px;`;
    overlay.appendChild(subtitle);

    const card = document.createElement('div');
    card.style.cssText = `
      display: flex; gap: 24px;
      background: rgba(30, 25, 18, 0.95);
      border: 2px solid #5a4a35; border-radius: 6px;
      padding: 24px; box-shadow: 0 4px 20px rgba(0,0,0,0.6);
    `;

    // Left: 3D preview
    const previewCol = document.createElement('div');
    previewCol.style.cssText = `display: flex; flex-direction: column; align-items: center;`;

    const canvas = document.createElement('canvas');
    canvas.id = 'character-preview-canvas';
    canvas.width = 280;
    canvas.height = 400;
    canvas.style.cssText = `
      width: 280px; height: 400px;
      border: 1px solid #5a4a35; border-radius: 4px;
      background: #1a1a1a;
    `;
    this.previewCanvas = canvas;
    previewCol.appendChild(canvas);

    const hint = document.createElement('div');
    hint.textContent = 'Drag to rotate';
    hint.style.cssText = `font-size: 10px; color: #666; margin-top: 6px;`;
    previewCol.appendChild(hint);
    card.appendChild(previewCol);

    // Right: swatches + confirm
    const swatchCol = document.createElement('div');
    swatchCol.style.cssText = `display: flex; flex-direction: column; min-width: 280px;`;

    this.addStyleRow(swatchCol);
    this.addColorRow(swatchCol, 'Shirt', 'shirtColor', SHIRT_COLORS);
    this.addColorRow(swatchCol, 'Pants', 'pantsColor', PANTS_COLORS);
    this.addColorRow(swatchCol, 'Belt', 'beltColor', BELT_COLORS);
    this.addColorRow(swatchCol, 'Shoes', 'shoesColor', SHOES_COLORS);
    this.addColorRow(swatchCol, 'Hair', 'hairColor', HAIR_COLORS);

    const btn = document.createElement('button');
    btn.textContent = 'Confirm';
    btn.style.cssText = `
      width: 100%; padding: 12px; margin-top: 16px;
      background: linear-gradient(180deg, #5a4a35 0%, #3a3025 100%);
      border: 2px solid #7a6a50; border-radius: 4px;
      color: #fc0; font-family: monospace; font-size: 16px;
      font-weight: bold; cursor: pointer; letter-spacing: 1px;
    `;
    btn.addEventListener('mouseenter', () => {
      btn.style.background = 'linear-gradient(180deg, #7a6a50 0%, #5a4a35 100%)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.background = 'linear-gradient(180deg, #5a4a35 0%, #3a3025 100%)';
    });
    btn.addEventListener('click', () => {
      this.onConfirm({ ...this.appearance });
    });
    swatchCol.appendChild(btn);

    card.appendChild(swatchCol);
    overlay.appendChild(card);
    return overlay;
  }

  private initPreview(): void {
    if (!this.previewCanvas) return;

    this.previewEngine = new Engine(this.previewCanvas, true, {
      preserveDrawingBuffer: true,
      stencil: false,
      antialias: true,
    });
    this.previewScene = new Scene(this.previewEngine);
    this.previewScene.clearColor = new Color4(0.1, 0.1, 0.1, 1);

    const cam = new ArcRotateCamera(
      'previewCam', Math.PI * 0.75, Math.PI * 0.4, 3.0,
      new Vector3(0, 0.7, 0), this.previewScene,
    );
    cam.lowerRadiusLimit = 2;
    cam.upperRadiusLimit = 5;
    cam.lowerBetaLimit = 0.3;
    cam.upperBetaLimit = Math.PI * 0.55;
    cam.attachControl(this.previewCanvas, true);
    cam.inputs.removeByType('ArcRotateCameraKeyboardMoveInput');

    const hemi = new HemisphericLight('previewHemi', new Vector3(0, 1, 0), this.previewScene);
    hemi.intensity = 0.6;
    hemi.groundColor = new Color3(0.15, 0.15, 0.15);
    const dir = new DirectionalLight('previewDir', new Vector3(-0.5, -1, 0.5), this.previewScene);
    dir.intensity = 0.5;

    this.loadPreviewCharacter();

    this.previewEngine.runRenderLoop(() => {
      this.previewScene?.render();
    });
  }

  private loadPreviewCharacter(): void {
    if (!this.previewScene) return;
    this.previewCharacter = new CharacterEntity(this.previewScene, {
      name: 'previewChar',
      modelPath: this.getModelPath(),
      targetHeight: 1.53,
      additionalAnimations: [
        { name: 'idle', path: '/Character models/animations/idle.glb', fallback: { path: '/Character models/Universal Animation Library[Standard]/Unreal-Godot/UAL1_Standard.glb', animName: 'Idle_Loop' } },
      ],
    });
    this.previewCharacter.whenReady().then(() => {
      if (this.previewCharacter) {
        this.previewCharacter.applyAppearance(this.appearance);
      }
    });
  }

  private getModelPath(): string {
    const style = SHIRT_STYLES[this.appearance.shirtStyle] ?? SHIRT_STYLES[0];
    return `/Character models/main character${style.glbSuffix}.glb`;
  }

  private updatePreview(): void {
    if (this.previewCharacter?.isReady) {
      this.previewCharacter.applyAppearance(this.appearance);
    }
  }

  private rebuildPreview(): void {
    if (this.previewCharacter) {
      this.previewCharacter.dispose();
      this.previewCharacter = null;
    }
    this.loadPreviewCharacter();
  }

  private addStyleRow(parent: HTMLDivElement): void {
    const row = document.createElement('div');
    row.style.cssText = `margin-bottom: 14px;`;
    const labelEl = document.createElement('div');
    labelEl.textContent = 'Shirt Style';
    labelEl.style.cssText = `font-size: 12px; color: #ccc; margin-bottom: 6px; font-weight: bold;`;
    row.appendChild(labelEl);

    const btns = document.createElement('div');
    btns.style.cssText = `display: flex; gap: 6px;`;

    SHIRT_STYLES.forEach((style, index) => {
      const btn = document.createElement('div');
      btn.textContent = style.name;
      const isSelected = this.appearance.shirtStyle === index;
      btn.style.cssText = `
        padding: 6px 14px; border-radius: 3px; cursor: pointer;
        font-size: 12px; font-family: monospace; font-weight: bold;
        background: ${isSelected ? 'rgba(90,74,53,0.6)' : 'rgba(40,35,28,0.6)'};
        color: ${isSelected ? '#fc0' : '#999'};
        border: 2px solid ${isSelected ? '#fc0' : '#555'};
        transition: all 0.15s;
      `;
      btn.addEventListener('mouseenter', () => {
        if (this.appearance.shirtStyle !== index) { btn.style.borderColor = '#aaa'; btn.style.color = '#ccc'; }
      });
      btn.addEventListener('mouseleave', () => {
        const sel = this.appearance.shirtStyle === index;
        btn.style.borderColor = sel ? '#fc0' : '#555'; btn.style.color = sel ? '#fc0' : '#999';
      });
      btn.addEventListener('click', () => {
        if (this.appearance.shirtStyle === index) return;
        this.appearance.shirtStyle = index;
        btns.querySelectorAll('div').forEach((b, i) => {
          const el = b as HTMLDivElement; const sel = i === index;
          el.style.borderColor = sel ? '#fc0' : '#555'; el.style.color = sel ? '#fc0' : '#999';
          el.style.background = sel ? 'rgba(90,74,53,0.6)' : 'rgba(40,35,28,0.6)';
        });
        this.rebuildPreview();
      });
      btns.appendChild(btn);
    });
    row.appendChild(btns);
    parent.appendChild(row);
  }

  private addColorRow(parent: HTMLDivElement, label: string, slot: keyof PlayerAppearance, palette: [number, number, number][]): void {
    const row = document.createElement('div');
    row.style.cssText = `margin-bottom: 14px;`;
    const labelEl = document.createElement('div');
    labelEl.textContent = label;
    labelEl.style.cssText = `font-size: 12px; color: #ccc; margin-bottom: 6px; font-weight: bold;`;
    row.appendChild(labelEl);

    const swatches = document.createElement('div');
    swatches.style.cssText = `display: flex; flex-wrap: wrap; gap: 6px;`;

    palette.forEach((rgb, index) => {
      const swatch = document.createElement('div');
      const isNoBelt = slot === 'beltColor' && index === 0;
      const r = Math.round(Math.pow(rgb[0], 1 / 2.2) * 255);
      const g = Math.round(Math.pow(rgb[1], 1 / 2.2) * 255);
      const b = Math.round(Math.pow(rgb[2], 1 / 2.2) * 255);
      const isSelected = this.appearance[slot] === index;
      swatch.style.cssText = `
        width: ${isNoBelt ? 'auto' : '28px'}; height: 28px; border-radius: 3px; cursor: pointer;
        background: ${isNoBelt ? 'linear-gradient(135deg, #555, #333)' : `rgb(${r}, ${g}, ${b})`};
        border: 2px solid ${isSelected ? '#fc0' : '#555'};
        transition: border-color 0.15s, transform 0.1s;
        ${isNoBelt ? 'padding: 0 6px; display: flex; align-items: center; font-size: 9px; color: #ccc; font-family: monospace;' : ''}
      `;
      if (isNoBelt) swatch.textContent = 'None';
      swatch.dataset.slot = slot;
      swatch.dataset.index = String(index);
      swatch.addEventListener('mouseenter', () => {
        if (this.appearance[slot] !== index) { swatch.style.borderColor = '#aaa'; swatch.style.transform = 'scale(1.1)'; }
      });
      swatch.addEventListener('mouseleave', () => {
        swatch.style.borderColor = this.appearance[slot] === index ? '#fc0' : '#555'; swatch.style.transform = 'scale(1)';
      });
      swatch.addEventListener('click', () => {
        this.appearance[slot] = index;
        swatches.querySelectorAll('div').forEach((s) => {
          const el = s as HTMLDivElement;
          el.style.borderColor = (el.dataset.slot === slot && el.dataset.index === String(index)) ? '#fc0' : '#555';
        });
        this.updatePreview();
      });
      swatches.appendChild(swatch);
    });
    row.appendChild(swatches);
    parent.appendChild(row);
  }

  destroy(): void {
    if (this.previewCharacter) { this.previewCharacter.dispose(); this.previewCharacter = null; }
    if (this.previewEngine) {
      this.previewEngine.stopRenderLoop();
      this.previewScene?.dispose();
      this.previewEngine.dispose();
      this.previewEngine = null;
      this.previewScene = null;
    }
    this.container.remove();
  }
}
