/**
 * In-game debug panel for adjusting equipment position, rotation, and scale.
 * Toggle with /geardebug chat command.
 * Supports switching between all equipment slots in real-time.
 */

import { TransformNode } from '@babylonjs/core/Meshes/transformNode';

type SlotGetter = (slot: string) => TransformNode | null;
type BoneGetter = (slot: string) => string;
type ItemInfoGetter = (slot: string) => { id: number; name: string; toolType?: string } | null;

interface ParamDef {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  fineStep: number;
  value: number;
  group: 'pos' | 'rot' | 'scale';
  color: string;
}

const PARAMS: ParamDef[] = [
  { key: 'pos.x', label: 'X', min: -2, max: 2, step: 0.01, fineStep: 0.005, value: 0, group: 'pos', color: '#f66' },
  { key: 'pos.y', label: 'Y', min: -2, max: 2, step: 0.01, fineStep: 0.005, value: 0, group: 'pos', color: '#6f6' },
  { key: 'pos.z', label: 'Z', min: -2, max: 2, step: 0.01, fineStep: 0.005, value: 0, group: 'pos', color: '#66f' },
  { key: 'rot.x', label: 'X', min: -3.15, max: 3.15, step: 0.05, fineStep: 0.01, value: 0, group: 'rot', color: '#f66' },
  { key: 'rot.y', label: 'Y', min: -3.15, max: 3.15, step: 0.05, fineStep: 0.01, value: 0, group: 'rot', color: '#6f6' },
  { key: 'rot.z', label: 'Z', min: -3.15, max: 3.15, step: 0.05, fineStep: 0.01, value: 0, group: 'rot', color: '#66f' },
  { key: 'scale', label: 'S', min: 0.05, max: 3, step: 0.05, fineStep: 0.01, value: 1, group: 'scale', color: '#f8c' },
];

const SLOTS = ['weapon', 'shield', 'head', 'body', 'legs', 'neck', 'ring', 'hands', 'feet', 'cape'];

const SLOT_COLORS: Record<string, string> = {
  weapon: '#f66', shield: '#66f', head: '#ff6', body: '#6cf',
  legs: '#c96', neck: '#f6f', ring: '#6f6', hands: '#fc6', feet: '#c6f', cape: '#6ff',
};

export class GearDebugPanel {
  private container: HTMLDivElement;
  private visible = false;
  private target: TransformNode | null = null;
  private sliders: Map<string, HTMLInputElement> = new Map();
  private numInputs: Map<string, HTMLInputElement> = new Map();
  private slotButtons: Map<string, HTMLButtonElement> = new Map();
  private itemInfoLabel!: HTMLDivElement;
  private boneLabel!: HTMLSpanElement;
  private statusLabel!: HTMLSpanElement;
  private getSlotNode: SlotGetter = () => null;
  private getSlotBone: BoneGetter = () => '';
  private getItemInfo: ItemInfoGetter = () => null;
  private activeSlot = 'weapon';

  constructor() {
    this.container = this.buildUI();
    document.body.appendChild(this.container);
  }

  setSlotGetter(getter: SlotGetter): void {
    this.getSlotNode = getter;
  }

  setSlotBoneGetter(getter: BoneGetter): void {
    this.getSlotBone = getter;
  }

  setItemInfoGetter(getter: ItemInfoGetter): void {
    this.getItemInfo = getter;
  }

  private buildUI(): HTMLDivElement {
    const div = document.createElement('div');
    div.id = 'gear-debug-panel';
    Object.assign(div.style, {
      position: 'fixed', top: '60px', left: '10px', width: '320px',
      background: 'rgba(15,12,8,0.95)', color: '#ddd', fontFamily: 'monospace',
      fontSize: '12px', padding: '12px', borderRadius: '6px', zIndex: '9999',
      display: 'none', userSelect: 'none', border: '1px solid #554a3a',
    });

    // Title
    const title = document.createElement('div');
    title.style.cssText = 'font-weight:bold;color:#ffd700;font-size:14px;margin-bottom:8px;text-align:center;';
    title.textContent = 'Gear Fitting';
    div.appendChild(title);

    // Slot grid — colored buttons showing equipped state
    const slotGrid = document.createElement('div');
    slotGrid.style.cssText = 'display:flex;flex-wrap:wrap;gap:3px;margin-bottom:10px;';
    for (const slot of SLOTS) {
      const btn = document.createElement('button');
      btn.textContent = slot;
      const color = SLOT_COLORS[slot] || '#888';
      Object.assign(btn.style, {
        padding: '4px 6px', cursor: 'pointer',
        background: '#1a1510', color: '#555',
        border: '1px solid #2a2520', borderRadius: '3px',
        fontFamily: 'monospace', fontSize: '10px',
        transition: 'all 0.15s',
      });
      btn.addEventListener('click', () => this.switchSlot(slot));
      slotGrid.appendChild(btn);
      this.slotButtons.set(slot, btn);
    }
    div.appendChild(slotGrid);

    // Item info — prominent display of what's equipped
    this.itemInfoLabel = document.createElement('div');
    Object.assign(this.itemInfoLabel.style, {
      padding: '6px 8px', marginBottom: '8px',
      background: '#1a1510', borderRadius: '4px',
      border: '1px solid #2a2520', minHeight: '32px',
    });
    div.appendChild(this.itemInfoLabel);

    // Bone label
    this.boneLabel = document.createElement('div');
    this.boneLabel.style.cssText = 'color:#555;font-size:10px;margin-bottom:8px;';
    div.appendChild(this.boneLabel);

    // Control groups
    const groups: [string, string, ParamDef[]][] = [
      ['Position', '#8cf', PARAMS.filter(p => p.group === 'pos')],
      ['Rotation', '#cf8', PARAMS.filter(p => p.group === 'rot')],
      ['Scale', '#f8c', PARAMS.filter(p => p.group === 'scale')],
    ];

    for (const [groupName, color, params] of groups) {
      const groupLabel = document.createElement('div');
      groupLabel.style.cssText = `color:${color};font-size:11px;font-weight:bold;margin:6px 0 3px;`;
      groupLabel.textContent = groupName;
      div.appendChild(groupLabel);

      for (const p of params) {
        div.appendChild(this.buildRow(p));
      }
    }

    // Buttons
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:6px;margin-top:10px;';

    const copyBtn = this.makeButton('Copy Code', '#2a4a2a', '#4a4', () => this.copyCode());
    const resetBtn = this.makeButton('Reset All', '#4a2a2a', '#a44', () => this.resetAll());
    copyBtn.style.flex = '1';
    resetBtn.style.flex = '1';
    btnRow.appendChild(copyBtn);
    btnRow.appendChild(resetBtn);
    div.appendChild(btnRow);

    // Status
    this.statusLabel = document.createElement('div');
    this.statusLabel.style.cssText = 'color:#666;font-size:10px;margin-top:6px;text-align:center;height:14px;';
    div.appendChild(this.statusLabel);

    return div;
  }

  private buildRow(p: ParamDef): HTMLDivElement {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;margin-bottom:2px;gap:4px;';

    const label = document.createElement('span');
    label.style.cssText = `width:14px;flex-shrink:0;color:${p.color};font-weight:bold;font-size:11px;`;
    label.textContent = p.label;

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = String(p.min);
    slider.max = String(p.max);
    slider.step = String(p.step);
    slider.value = String(p.value);
    slider.style.cssText = `flex:1;height:14px;cursor:pointer;accent-color:${p.color};`;

    const numInput = document.createElement('input');
    numInput.type = 'number';
    numInput.min = String(p.min);
    numInput.max = String(p.max);
    numInput.step = String(p.fineStep);
    numInput.value = p.value.toFixed(3);
    Object.assign(numInput.style, {
      width: '58px', flexShrink: '0', background: '#1a1510', color: '#ddd',
      border: '1px solid #3a3530', borderRadius: '2px', padding: '1px 3px',
      fontFamily: 'monospace', fontSize: '11px', textAlign: 'right',
    });

    const resetBtn = document.createElement('button');
    resetBtn.textContent = '↺';
    Object.assign(resetBtn.style, {
      width: '18px', height: '18px', flexShrink: '0', background: 'none',
      color: '#666', border: 'none', cursor: 'pointer', padding: '0',
      fontSize: '12px', lineHeight: '18px',
    });
    resetBtn.addEventListener('mouseenter', () => { resetBtn.style.color = '#ffd700'; });
    resetBtn.addEventListener('mouseleave', () => { resetBtn.style.color = '#666'; });

    slider.addEventListener('input', () => {
      numInput.value = parseFloat(slider.value).toFixed(3);
      this.applyToTarget();
    });
    numInput.addEventListener('input', () => {
      const v = parseFloat(numInput.value);
      if (!isNaN(v)) {
        slider.value = String(v);
        this.applyToTarget();
      }
    });
    resetBtn.addEventListener('click', () => {
      const def = p.group === 'scale' ? 1 : 0;
      slider.value = String(def);
      numInput.value = def.toFixed(3);
      this.applyToTarget();
    });

    row.appendChild(label);
    row.appendChild(slider);
    row.appendChild(numInput);
    row.appendChild(resetBtn);

    this.sliders.set(p.key, slider);
    this.numInputs.set(p.key, numInput);
    return row;
  }

  private makeButton(text: string, bg: string, borderColor: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.textContent = text;
    Object.assign(btn.style, {
      padding: '5px 8px', cursor: 'pointer', background: bg, color: '#ddd',
      border: `1px solid ${borderColor}`, borderRadius: '3px',
      fontFamily: 'monospace', fontSize: '11px',
    });
    btn.addEventListener('click', onClick);
    return btn;
  }

  get isVisible(): boolean {
    return this.visible;
  }

  toggle(): void {
    this.visible = !this.visible;
    this.container.style.display = this.visible ? 'block' : 'none';
    if (this.visible) {
      this.switchSlot(this.activeSlot);
    }
  }

  private updateSlotButtons(): void {
    for (const [slot, btn] of this.slotButtons) {
      const hasGear = !!this.getSlotNode(slot);
      const isActive = slot === this.activeSlot;
      const color = SLOT_COLORS[slot] || '#888';

      if (isActive) {
        btn.style.background = '#3a3020';
        btn.style.color = color;
        btn.style.border = `1px solid ${color}`;
        btn.style.fontWeight = 'bold';
      } else if (hasGear) {
        btn.style.background = '#1a1510';
        btn.style.color = color;
        btn.style.border = `1px solid ${color}44`;
        btn.style.fontWeight = 'normal';
      } else {
        btn.style.background = '#1a1510';
        btn.style.color = '#444';
        btn.style.border = '1px solid #2a2520';
        btn.style.fontWeight = 'normal';
      }
    }
  }

  private switchSlot(slot: string): void {
    this.activeSlot = slot;
    this.updateSlotButtons();

    const node = this.getSlotNode(slot);
    const bone = this.getSlotBone(slot);
    const item = this.getItemInfo(slot);
    const color = SLOT_COLORS[slot] || '#888';

    // Update item info display
    if (node && item) {
      this.itemInfoLabel.innerHTML = '';
      const nameEl = document.createElement('div');
      nameEl.style.cssText = `color:${color};font-size:13px;font-weight:bold;`;
      nameEl.textContent = item.name;
      this.itemInfoLabel.appendChild(nameEl);

      const detailEl = document.createElement('div');
      detailEl.style.cssText = 'color:#888;font-size:10px;margin-top:2px;';
      const parts = [`id: ${item.id}`, `slot: ${slot}`];
      if (item.toolType) parts.push(`tool: ${item.toolType}`);
      detailEl.textContent = parts.join('  |  ');
      this.itemInfoLabel.appendChild(detailEl);

      this.itemInfoLabel.style.borderColor = `${color}44`;
    } else {
      this.itemInfoLabel.innerHTML = `<span style="color:#555;font-size:11px;">No gear in <span style="color:${color}">${slot}</span> slot</span>`;
      this.itemInfoLabel.style.borderColor = '#2a2520';
    }

    this.boneLabel.textContent = bone ? `bone: ${bone}` : '';

    if (node) {
      this.target = node;
      this.setVal('pos.x', node.position.x);
      this.setVal('pos.y', node.position.y);
      this.setVal('pos.z', node.position.z);
      this.setVal('rot.x', node.rotation.x);
      this.setVal('rot.y', node.rotation.y);
      this.setVal('rot.z', node.rotation.z);
      this.setVal('scale', node.scaling.x);
    } else {
      this.target = null;
    }
  }

  private setVal(key: string, value: number): void {
    const slider = this.sliders.get(key);
    const num = this.numInputs.get(key);
    if (slider) slider.value = String(value);
    if (num) num.value = value.toFixed(3);
  }

  private getVal(key: string): number {
    return parseFloat(this.numInputs.get(key)?.value ?? '0');
  }

  private applyToTarget(): void {
    if (!this.target) return;
    this.target.position.set(this.getVal('pos.x'), this.getVal('pos.y'), this.getVal('pos.z'));
    this.target.rotation.set(this.getVal('rot.x'), this.getVal('rot.y'), this.getVal('rot.z'));
    const s = this.getVal('scale');
    this.target.scaling.set(s, s, s);
  }

  private resetAll(): void {
    for (const p of PARAMS) {
      const def = p.group === 'scale' ? 1 : 0;
      this.setVal(p.key, def);
    }
    this.applyToTarget();
    this.flashStatus('Reset to defaults');
  }

  private copyCode(): void {
    const slot = this.activeSlot;
    const bone = this.getSlotBone(slot);
    const item = this.getItemInfo(slot);
    const px = this.getVal('pos.x'), py = this.getVal('pos.y'), pz = this.getVal('pos.z');
    const rx = this.getVal('rot.x'), ry = this.getVal('rot.y'), rz = this.getVal('rot.z');
    const s = this.getVal('scale');

    const itemLabel = item
      ? `// ${item.name} (id: ${item.id}${item.toolType ? `, toolType: ${item.toolType}` : ''})`
      : `// ${slot}`;
    const code = `${itemLabel}\n${slot}: { boneName: '${bone}', localPosition: { x: ${px}, y: ${py}, z: ${pz} }, localRotation: { x: ${rx}, y: ${ry}, z: ${rz} }, scale: ${s} },`;

    navigator.clipboard.writeText(code).then(() => {
      this.flashStatus('Copied to clipboard');
    }).catch(() => {
      this.flashStatus('Copy failed — see console');
    });
    console.log(`[GearDebug] ${code}`);
  }

  private flashStatus(msg: string): void {
    this.statusLabel.textContent = msg;
    this.statusLabel.style.color = '#ffd700';
    setTimeout(() => {
      this.statusLabel.style.color = '#666';
      this.statusLabel.textContent = '';
    }, 2000);
  }

  dispose(): void {
    this.container.remove();
  }
}
