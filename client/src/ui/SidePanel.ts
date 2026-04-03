import {
  INVENTORY_SIZE, ClientOpcode, encodePacket,
  ALL_SKILLS, SKILL_NAMES, SKILL_COLORS, xpForLevel,
  type SkillId, type MeleeStance, type ItemDef,
} from '@projectrs/shared';
import type { NetworkManager } from '../managers/NetworkManager';

const EQUIP_SLOT_NAMES = ['Weapon', 'Shield', 'Head', 'Body', 'Legs', 'Neck', 'Ring', 'Hands', 'Feet', 'Cape'];

export interface SkillData {
  level: number;
  currentLevel: number;
  xp: number;
}

export class SidePanel {
  private container: HTMLDivElement;
  private network: NetworkManager;
  private token: string;
  private activeTab: 'inventory' | 'skills' | 'equipment' = 'inventory';

  // Inventory state
  private invSlots: ({ itemId: number; quantity: number } | null)[] = new Array(INVENTORY_SIZE).fill(null);
  private invSlotElements: HTMLDivElement[] = [];
  private invGrid: HTMLDivElement | null = null;

  // Skills state
  private skills: Map<SkillId, SkillData> = new Map();
  private skillsContent: HTMLDivElement | null = null;

  // Equipment state
  private equipment: Map<number, number> = new Map(); // slotIndex -> itemId
  private equipContent: HTMLDivElement | null = null;

  // Stance
  private currentStance: MeleeStance = 'accurate';
  private stanceButtons: HTMLDivElement[] = [];

  // Item definitions
  private itemDefs: Map<number, ItemDef> = new Map();

  // Optional sell callback (active when shop is open)
  private sellCallback: ((slot: number) => void) | null = null;

  // Tab content areas
  private tabContents: Map<string, HTMLDivElement> = new Map();
  private tabButtons: HTMLDivElement[] = [];

  constructor(network: NetworkManager, token: string = '') {
    this.network = network;
    this.token = token;

    // Init skills with defaults
    for (const id of ALL_SKILLS) {
      if (id === 'hitpoints') {
        this.skills.set(id, { level: 10, currentLevel: 10, xp: xpForLevel(10) });
      } else {
        this.skills.set(id, { level: 1, currentLevel: 1, xp: 0 });
      }
    }

    this.container = this.buildUI();
    document.body.appendChild(this.container);
  }

  private buildUI(): HTMLDivElement {
    const panel = document.createElement('div');
    panel.id = 'side-panel';
    panel.style.cssText = `
      position: fixed; right: 10px; bottom: 10px;
      width: 216px; background: rgba(30, 25, 18, 0.92);
      border: 2px solid #5a4a35; border-radius: 4px;
      z-index: 100; font-family: monospace; color: #ddd;
      display: flex; flex-direction: column;
    `;

    // Tab bar
    const tabBar = document.createElement('div');
    tabBar.style.cssText = `
      display: flex; border-bottom: 2px solid #5a4a35;
    `;

    const tabs: { key: string; label: string }[] = [
      { key: 'inventory', label: 'Inv' },
      { key: 'skills', label: 'Skills' },
      { key: 'equipment', label: 'Equip' },
    ];

    for (const tab of tabs) {
      const btn = document.createElement('div');
      btn.textContent = tab.label;
      btn.dataset.tab = tab.key;
      btn.style.cssText = `
        flex: 1; text-align: center; padding: 6px 0;
        cursor: pointer; font-size: 12px; font-weight: bold;
        color: #aaa; transition: background 0.15s;
      `;
      btn.addEventListener('click', () => this.switchTab(tab.key as any));
      tabBar.appendChild(btn);
      this.tabButtons.push(btn);
    }

    panel.appendChild(tabBar);

    // Tab contents
    const contentArea = document.createElement('div');
    contentArea.style.cssText = `padding: 6px; height: 390px; overflow-y: auto;`;

    // Inventory tab
    this.invGrid = this.buildInventoryContent();
    const invWrap = document.createElement('div');
    invWrap.appendChild(this.invGrid);
    contentArea.appendChild(invWrap);
    this.tabContents.set('inventory', invWrap);

    // Skills tab
    this.skillsContent = this.buildSkillsContent();
    const skillsWrap = document.createElement('div');
    skillsWrap.appendChild(this.skillsContent);
    skillsWrap.style.display = 'none';
    contentArea.appendChild(skillsWrap);
    this.tabContents.set('skills', skillsWrap);

    // Equipment tab
    this.equipContent = this.buildEquipmentContent();
    const equipWrap = document.createElement('div');
    equipWrap.appendChild(this.equipContent);
    equipWrap.style.display = 'none';
    contentArea.appendChild(equipWrap);
    this.tabContents.set('equipment', equipWrap);

    panel.appendChild(contentArea);

    // Logout button below content
    const logoutBtn = document.createElement('div');
    logoutBtn.textContent = 'Logout';
    logoutBtn.style.cssText = `
      text-align: center; padding: 6px 0; margin: 4px 6px 6px;
      background: rgba(60, 40, 30, 0.6); border: 1px solid #5a4a35;
      border-radius: 3px; color: #fc0; font-size: 11px;
      cursor: pointer; font-weight: bold;
    `;
    logoutBtn.addEventListener('mouseenter', () => {
      logoutBtn.style.background = 'rgba(90, 60, 40, 0.8)';
    });
    logoutBtn.addEventListener('mouseleave', () => {
      logoutBtn.style.background = 'rgba(60, 40, 30, 0.6)';
    });
    logoutBtn.addEventListener('click', async () => {
      try {
        await fetch('/api/logout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: this.token }),
        });
      } catch { /* ignore */ }
      localStorage.removeItem('projectrs_token');
      localStorage.removeItem('projectrs_username');
      location.reload();
    });
    panel.appendChild(logoutBtn);

    // Highlight active tab
    this.switchTab('inventory');

    return panel;
  }

  private buildInventoryContent(): HTMLDivElement {
    const grid = document.createElement('div');
    grid.style.cssText = `
      display: grid; grid-template-columns: repeat(4, 1fr);
      gap: 2px;
    `;

    this.invSlotElements = [];
    for (let i = 0; i < INVENTORY_SIZE; i++) {
      const slot = document.createElement('div');
      slot.style.cssText = `
        width: 46px; height: 46px;
        background: rgba(0, 0, 0, 0.4);
        border: 1px solid #3a3025;
        display: flex; flex-direction: column;
        align-items: center; justify-content: center;
        cursor: pointer; font-size: 10px;
        position: relative;
      `;

      slot.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.onInvSlotRightClick(i, e);
      });

      slot.addEventListener('click', () => {
        this.onInvSlotClick(i);
      });

      grid.appendChild(slot);
      this.invSlotElements.push(slot);
    }

    return grid;
  }

  private buildSkillsContent(): HTMLDivElement {
    const wrap = document.createElement('div');

    for (const id of ALL_SKILLS) {
      const row = document.createElement('div');
      row.dataset.skill = id;
      row.style.cssText = `
        display: flex; align-items: center; padding: 3px 2px;
        border-bottom: 1px solid rgba(90,74,53,0.3);
      `;

      const nameEl = document.createElement('div');
      nameEl.style.cssText = `width: 70px; font-size: 11px; color: ${SKILL_COLORS[id]};`;
      nameEl.textContent = SKILL_NAMES[id];
      row.appendChild(nameEl);

      const levelEl = document.createElement('div');
      levelEl.className = 'skill-level';
      levelEl.style.cssText = `width: 24px; text-align: center; font-size: 12px; font-weight: bold; color: #fff;`;
      levelEl.textContent = '1';
      row.appendChild(levelEl);

      const barBg = document.createElement('div');
      barBg.style.cssText = `
        flex: 1; height: 10px; background: #222; border: 1px solid #444;
        margin-left: 4px; position: relative;
      `;

      const barFill = document.createElement('div');
      barFill.className = 'skill-bar';
      barFill.style.cssText = `
        height: 100%; width: 0%; background: ${SKILL_COLORS[id]};
        transition: width 0.3s;
      `;
      barBg.appendChild(barFill);

      const xpLabel = document.createElement('div');
      xpLabel.className = 'skill-xp';
      xpLabel.style.cssText = `
        position: absolute; top: 0; left: 0; right: 0; bottom: 0;
        display: flex; align-items: center; justify-content: center;
        font-size: 8px; color: #ddd; pointer-events: none;
      `;
      barBg.appendChild(xpLabel);

      row.appendChild(barBg);
      wrap.appendChild(row);
    }

    // Combat level display
    const clRow = document.createElement('div');
    clRow.id = 'combat-level-row';
    clRow.style.cssText = `
      text-align: center; padding: 6px 0; margin-top: 4px;
      border-top: 1px solid #5a4a35; color: #fc0; font-size: 12px;
    `;
    clRow.textContent = 'Combat Lv: 3';
    wrap.appendChild(clRow);

    // Stance selector
    const stanceRow = document.createElement('div');
    stanceRow.style.cssText = `
      display: flex; gap: 2px; margin-top: 4px;
    `;

    const stances: { key: MeleeStance; label: string }[] = [
      { key: 'accurate', label: 'Acc' },
      { key: 'aggressive', label: 'Agg' },
      { key: 'defensive', label: 'Def' },
      { key: 'controlled', label: 'Ctrl' },
    ];

    this.stanceButtons = [];
    for (let i = 0; i < stances.length; i++) {
      const btn = document.createElement('div');
      btn.textContent = stances[i].label;
      btn.style.cssText = `
        flex: 1; text-align: center; padding: 3px 0;
        font-size: 10px; cursor: pointer;
        border: 1px solid #5a4a35; color: #aaa;
      `;
      btn.addEventListener('click', () => {
        this.currentStance = stances[i].key;
        this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_SET_STANCE, i));
        this.updateStanceUI();
      });
      stanceRow.appendChild(btn);
      this.stanceButtons.push(btn);
    }

    wrap.appendChild(stanceRow);
    this.updateStanceUI();

    return wrap;
  }

  private buildEquipmentContent(): HTMLDivElement {
    const wrap = document.createElement('div');

    for (let i = 0; i < EQUIP_SLOT_NAMES.length; i++) {
      const row = document.createElement('div');
      row.dataset.equipSlot = i.toString();
      row.style.cssText = `
        display: flex; align-items: center; padding: 4px 2px;
        border-bottom: 1px solid rgba(90,74,53,0.3);
        cursor: pointer;
      `;
      row.addEventListener('click', () => this.onEquipSlotClick(i));

      const label = document.createElement('div');
      label.style.cssText = `width: 60px; font-size: 11px; color: #aaa;`;
      label.textContent = EQUIP_SLOT_NAMES[i];
      row.appendChild(label);

      const itemEl = document.createElement('div');
      itemEl.className = 'equip-item';
      itemEl.style.cssText = `flex: 1; font-size: 11px; color: #fc0;`;
      itemEl.textContent = '—';
      row.appendChild(itemEl);

      wrap.appendChild(row);
    }

    return wrap;
  }

  switchTab(tab: 'inventory' | 'skills' | 'equipment'): void {
    this.activeTab = tab;

    for (const [key, el] of this.tabContents) {
      el.style.display = key === tab ? 'block' : 'none';
    }

    for (const btn of this.tabButtons) {
      if (btn.dataset.tab === tab) {
        btn.style.color = '#fc0';
        btn.style.background = 'rgba(90,74,53,0.3)';
      } else {
        btn.style.color = '#aaa';
        btn.style.background = 'transparent';
      }
    }
  }

  // === Inventory methods ===

  setItemDefs(defs: Map<number, ItemDef>): void {
    this.itemDefs = defs;
    for (let i = 0; i < this.invSlots.length; i++) this.renderInvSlot(i);
  }

  updateInvSlot(index: number, itemId: number, quantity: number): void {
    if (index < 0 || index >= INVENTORY_SIZE) return;
    this.invSlots[index] = itemId === 0 ? null : { itemId, quantity };
    this.renderInvSlot(index);
  }

  private renderInvSlot(index: number): void {
    const el = this.invSlotElements[index];
    const slot = this.invSlots[index];

    if (!slot) {
      el.innerHTML = '';
      el.style.borderColor = '#3a3025';
      return;
    }

    const def = this.itemDefs.get(slot.itemId);
    const name = def?.name || `Item ${slot.itemId}`;
    const sprite = (def as any)?.sprite;

    const iconHtml = sprite
      ? `<img src="/sprites/items/${sprite}" style="width:28px;height:28px;image-rendering:pixelated;object-fit:contain;" />`
      : `<div style="width:24px;height:24px;background:#aaa;border-radius:3px;"></div>`;

    el.innerHTML = `
      ${iconHtml}
      <div style="font-size: 9px; color: #ccc; text-align: center; line-height: 1;">${name.length > 10 ? name.substring(0, 9) + '..' : name}</div>
      ${slot.quantity > 1 ? `<div style="position: absolute; top: 1px; left: 3px; font-size: 9px; color: #fd0;">${slot.quantity}</div>` : ''}
    `;
    el.style.borderColor = '#5a4a35';
  }

  private onInvSlotClick(index: number): void {
    const slot = this.invSlots[index];
    if (!slot) return;
    const def = this.itemDefs.get(slot.itemId);
    if (def?.healAmount) {
      this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_EAT_ITEM, index));
    }
  }

  private onInvSlotRightClick(index: number, event: MouseEvent): void {
    const slot = this.invSlots[index];
    if (!slot) return;

    const def = this.itemDefs.get(slot.itemId);
    const name = def?.name || 'Item';
    const menu = document.createElement('div');
    menu.style.cssText = `
      position: fixed; left: ${event.clientX}px; top: ${event.clientY}px;
      background: #3a3125; border: 2px solid #5a4a35;
      font-family: monospace; font-size: 12px; z-index: 1001;
      min-width: 100px; box-shadow: 2px 2px 8px rgba(0,0,0,0.5);
    `;

    const options: { label: string; action: () => void }[] = [];

    if (def?.equippable) {
      options.push({
        label: `Equip ${name}`,
        action: () => this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_EQUIP_ITEM, index)),
      });
    }

    if (def?.healAmount) {
      options.push({
        label: `Eat ${name}`,
        action: () => this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_EAT_ITEM, index)),
      });
    }

    if (this.sellCallback) {
      const sellPrice = Math.max(1, Math.floor((def?.value || 1) / 2));
      options.push({
        label: `Sell ${name} (${sellPrice} gp)`,
        action: () => this.sellCallback!(index),
      });
    }

    options.push({
      label: `Drop ${name}`,
      action: () => this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_DROP_ITEM, index)),
    });

    for (const opt of options) {
      const item = document.createElement('div');
      item.textContent = opt.label;
      item.style.cssText = `padding: 3px 10px; color: #ffcc00; cursor: pointer;`;
      item.addEventListener('mouseenter', () => item.style.background = '#5a4a35');
      item.addEventListener('mouseleave', () => item.style.background = 'transparent');
      item.addEventListener('click', () => {
        opt.action();
        menu.remove();
      });
      menu.appendChild(item);
    }

    document.body.appendChild(menu);
    const close = () => { menu.remove(); document.removeEventListener('click', close); };
    setTimeout(() => document.addEventListener('click', close), 0);
  }

  // === Skills methods ===

  updateSkill(skillIndex: number, level: number, currentLevel: number, xp: number): void {
    if (skillIndex < 0 || skillIndex >= ALL_SKILLS.length) return;
    const id = ALL_SKILLS[skillIndex];
    this.skills.set(id, { level, currentLevel, xp });
    this.renderSkill(id);
    this.updateCombatLevel();
  }

  private renderSkill(id: SkillId): void {
    if (!this.skillsContent) return;
    const row = this.skillsContent.querySelector(`[data-skill="${id}"]`);
    if (!row) return;

    const data = this.skills.get(id);
    if (!data) return;

    const levelEl = row.querySelector('.skill-level') as HTMLDivElement;
    const barEl = row.querySelector('.skill-bar') as HTMLDivElement;
    const xpEl = row.querySelector('.skill-xp') as HTMLDivElement;

    if (levelEl) levelEl.textContent = data.level.toString();

    // XP progress to next level
    const currentLevelXp = xpForLevel(data.level);
    const nextLevelXp = xpForLevel(data.level + 1);
    const xpInLevel = data.xp - currentLevelXp;
    const xpNeeded = nextLevelXp - currentLevelXp;
    const progress = xpNeeded > 0 ? Math.min(100, (xpInLevel / xpNeeded) * 100) : 100;

    if (barEl) barEl.style.width = `${progress}%`;
    if (xpEl) xpEl.textContent = data.level >= 99 ? '99' : `${xpInLevel}/${xpNeeded}`;
  }

  private updateCombatLevel(): void {
    const hp = this.skills.get('hitpoints')?.level || 10;
    const def = this.skills.get('defence')?.level || 1;
    const acc = this.skills.get('accuracy')?.level || 1;
    const str = this.skills.get('strength')?.level || 1;
    const arch = this.skills.get('archery')?.level || 1;
    const goodMag = this.skills.get('goodmagic')?.level || 1;
    const evilMag = this.skills.get('evilmagic')?.level || 1;

    const base = 0.25 * (def + hp);
    const melee = 0.325 * (acc + str);
    const range = 0.325 * (Math.floor(arch / 2) + arch);
    const magicLevel = Math.max(goodMag, evilMag);
    const mage = 0.325 * (Math.floor(magicLevel / 2) + magicLevel);
    const cl = Math.floor(base + Math.max(melee, range, mage));

    const el = document.getElementById('combat-level-row');
    if (el) el.textContent = `Combat Lv: ${cl}`;
  }

  private updateStanceUI(): void {
    const stanceNames: MeleeStance[] = ['accurate', 'aggressive', 'defensive', 'controlled'];
    for (let i = 0; i < this.stanceButtons.length; i++) {
      if (stanceNames[i] === this.currentStance) {
        this.stanceButtons[i].style.background = 'rgba(90,74,53,0.5)';
        this.stanceButtons[i].style.color = '#fc0';
      } else {
        this.stanceButtons[i].style.background = 'transparent';
        this.stanceButtons[i].style.color = '#aaa';
      }
    }
  }

  /** Get the current melee stance */
  getStance(): MeleeStance {
    return this.currentStance;
  }

  /** Set a sell callback (when shop is open) or null to clear */
  setSellCallback(cb: ((slot: number) => void) | null): void {
    this.sellCallback = cb;
  }

  /** Get the item ID in a given equipment slot (0 = empty) */
  getEquipItem(slotIndex: number): number {
    return this.equipment.get(slotIndex) ?? 0;
  }

  // === Equipment methods ===

  updateEquipSlot(slotIndex: number, itemId: number): void {
    if (itemId === 0) {
      this.equipment.delete(slotIndex);
    } else {
      this.equipment.set(slotIndex, itemId);
    }
    this.renderEquipSlot(slotIndex);
  }

  private renderEquipSlot(slotIndex: number): void {
    if (!this.equipContent) return;
    const row = this.equipContent.querySelector(`[data-equip-slot="${slotIndex}"]`);
    if (!row) return;

    const itemEl = row.querySelector('.equip-item') as HTMLDivElement;
    if (!itemEl) return;

    const itemId = this.equipment.get(slotIndex);
    if (itemId) {
      const def = this.itemDefs.get(itemId);
      const name = def?.name || `Item ${itemId}`;
      itemEl.textContent = name;
      itemEl.style.color = '#cda';
    } else {
      itemEl.textContent = '—';
      itemEl.style.color = '#555';
    }
  }

  private onEquipSlotClick(slotIndex: number): void {
    if (!this.equipment.has(slotIndex)) return;
    this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_UNEQUIP_ITEM, slotIndex));
  }
}
