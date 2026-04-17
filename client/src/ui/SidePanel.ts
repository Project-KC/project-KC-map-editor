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
    const mount = document.getElementById('ui-right-column');
    (mount ?? document.body).appendChild(this.container);
  }

  private buildUI(): HTMLDivElement {
    const panel = document.createElement('div');
    panel.id = 'side-panel';
    panel.style.cssText = `
      width: 100%; flex: 1; min-height: 0;
      background: transparent;
      border-top: 2px solid rgba(0,0,0,0.3);
      font-family: monospace; color: #ddd;
      display: flex; flex-direction: column;
      overflow: hidden;
      justify-content: flex-start;
    `;

    // HP bar below minimap
    const hpRow = document.createElement('div');
    hpRow.style.cssText = `
      display: flex; align-items: center; gap: 6px;
      padding: 7px 10px;
      border-bottom: 1px solid rgba(0,0,0,0.25);
      border-top: 1px solid rgba(255,200,100,0.06);
    `;
    const hpIcon = document.createElement('div');
    hpIcon.textContent = 'Health';
    hpIcon.style.cssText = `font-size: 10px; font-weight: bold; color: #d44; text-shadow: 1px 1px 0 #000; width: 38px; flex-shrink: 0;`;
    hpRow.appendChild(hpIcon);

    const hpBarBg = document.createElement('div');
    hpBarBg.style.cssText = `
      flex: 1; height: 16px; background: #1a0808;
      border: 1px solid #4a2020; border-radius: 3px;
      position: relative; overflow: hidden;
      box-shadow: inset 0 1px 3px rgba(0,0,0,0.5), 0 1px 0 rgba(255,200,100,0.06);
    `;
    const hpBarFill = document.createElement('div');
    hpBarFill.id = 'side-hp-fill';
    hpBarFill.style.cssText = `
      height: 100%; width: 100%; background: linear-gradient(180deg, #1a8a1a 0%, #0a6a0a 100%);
      transition: width 0.3s; border-radius: 1px;
    `;
    hpBarBg.appendChild(hpBarFill);
    const hpText = document.createElement('div');
    hpText.id = 'side-hp-text';
    hpText.style.cssText = `
      position: absolute; top: 0; left: 0; right: 0; bottom: 0;
      display: flex; align-items: center; justify-content: center;
      font-size: 10px; font-weight: bold; color: #fff;
      text-shadow: 1px 1px 0 #000; pointer-events: none;
    `;
    hpText.textContent = '10/10';
    hpBarBg.appendChild(hpText);
    hpRow.appendChild(hpBarBg);
    panel.appendChild(hpRow);

    // Good Magic bar
    const magicRow = document.createElement('div');
    magicRow.style.cssText = `
      display: flex; align-items: center; gap: 6px;
      padding: 5px 10px 7px;
      border-bottom: 1px solid rgba(0,0,0,0.25);
    `;
    const magicIcon = document.createElement('div');
    magicIcon.textContent = 'Magic';
    magicIcon.style.cssText = `font-size: 10px; font-weight: bold; color: #4ac; text-shadow: 1px 1px 0 #000; width: 38px; flex-shrink: 0;`;
    magicRow.appendChild(magicIcon);

    const magicBarBg = document.createElement('div');
    magicBarBg.style.cssText = `
      flex: 1; height: 16px; background: #080818;
      border: 1px solid #1a2a4a; border-radius: 3px;
      position: relative; overflow: hidden;
      box-shadow: inset 0 1px 3px rgba(0,0,0,0.5), 0 1px 0 rgba(255,200,100,0.06);
    `;
    const magicBarFill = document.createElement('div');
    magicBarFill.id = 'side-magic-fill';
    magicBarFill.style.cssText = `
      height: 100%; width: 100%; background: linear-gradient(180deg, #2a7aaa 0%, #1a5a8a 100%);
      transition: width 0.3s; border-radius: 1px;
    `;
    magicBarBg.appendChild(magicBarFill);
    const magicText = document.createElement('div');
    magicText.id = 'side-magic-text';
    magicText.style.cssText = `
      position: absolute; top: 0; left: 0; right: 0; bottom: 0;
      display: flex; align-items: center; justify-content: center;
      font-size: 10px; font-weight: bold; color: #fff;
      text-shadow: 1px 1px 0 #000; pointer-events: none;
    `;
    magicText.textContent = '1';
    magicBarBg.appendChild(magicText);
    magicRow.appendChild(magicBarBg);
    panel.appendChild(magicRow);

    // Player info strip — combat level + username
    const playerInfo = document.createElement('div');
    playerInfo.id = 'side-player-info';
    playerInfo.style.cssText = `
      display: flex; align-items: center; justify-content: center; gap: 8px;
      padding: 6px 8px;
      background: rgba(0,0,0,0.3);
      border-top: 1px solid rgba(255,200,100,0.08);
      border-bottom: 1px solid rgba(0,0,0,0.4);
    `;
    const swordIcon = document.createElement('span');
    swordIcon.textContent = '\u2694';
    swordIcon.style.cssText = `font-size: 14px; color: #c8a84a;`;
    playerInfo.appendChild(swordIcon);
    const combatText = document.createElement('span');
    combatText.id = 'side-combat-level';
    combatText.textContent = 'Combat Lv: 3';
    combatText.style.cssText = `font-size: 11px; font-weight: bold; color: #fc0; text-shadow: 1px 1px 0 #000; letter-spacing: 0.5px;`;
    playerInfo.appendChild(combatText);
    const swordIcon2 = document.createElement('span');
    swordIcon2.textContent = '\u2694';
    swordIcon2.style.cssText = `font-size: 14px; color: #c8a84a;`;
    playerInfo.appendChild(swordIcon2);
    panel.appendChild(playerInfo);

    // Top tab row — 4 tabs above content
    const topTabs = document.createElement('div');
    topTabs.style.cssText = `display: flex; gap: 1px; padding: 2px 2px 0;`;

    // Bottom tab row — 4 tabs below content (added after contentArea)
    const bottomTabs = document.createElement('div');
    bottomTabs.style.cssText = `display: flex; gap: 1px; padding: 0 2px 2px;`;

    const tabStyle = `
      flex: 1; text-align: center; padding: 5px 0;
      cursor: pointer; font-size: 11px; font-weight: bold;
      color: #8a7a60;
      background: rgba(0,0,0,0.35);
      border: 1px solid rgba(0,0,0,0.4);
      transition: all 0.1s;
      text-shadow: 1px 1px 0 rgba(0,0,0,0.5);
    `;

    const tabs: { key: string; label: string; pos: 'top' | 'bottom' }[] = [
      { key: 'inventory', label: '\uD83C\uDF92 Inv', pos: 'top' },
      { key: 'skills', label: '\u2694 Skills', pos: 'top' },
      { key: 'equipment', label: '\uD83D\uDEE1 Equip', pos: 'top' },
      { key: 'quests', label: '\uD83D\uDCDC Quests', pos: 'top' },
      { key: 'good_magic', label: '\u2728 Good', pos: 'bottom' },
      { key: 'evil_magic', label: '\uD83D\uDD25 Evil', pos: 'bottom' },
      { key: 'friends', label: '\uD83D\uDC64 Friends', pos: 'bottom' },
      { key: 'ignore', label: '\uD83D\uDEAB Ignore', pos: 'bottom' },
    ];

    for (const tab of tabs) {
      const btn = document.createElement('div');
      btn.textContent = tab.label;
      btn.dataset.tab = tab.key;
      btn.style.cssText = tabStyle + (tab.pos === 'top'
        ? 'border-bottom: none; border-radius: 3px 3px 0 0;'
        : 'border-top: none; border-radius: 0 0 3px 3px;');
      btn.addEventListener('click', () => this.switchTab(tab.key as any));
      (tab.pos === 'top' ? topTabs : bottomTabs).appendChild(btn);
      this.tabButtons.push(btn);
    }

    panel.appendChild(topTabs);

    // Tab contents
    const contentArea = document.createElement('div');
    contentArea.style.cssText = `
      padding: 8px 6px; overflow-y: auto; height: 340px;
      background: rgba(0,0,0,0.4);
      box-shadow: inset 0 3px 8px rgba(0,0,0,0.5);
      border-top: 1px solid rgba(0,0,0,0.4);
    `;

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

    // Quests tab
    const questsWrap = document.createElement('div');
    questsWrap.style.display = 'none';
    questsWrap.innerHTML = `
      <div style="color: #fc0; font-weight: bold; font-size: 13px; margin-bottom: 8px; text-shadow: 1px 1px 0 #000;">Quest Journal</div>
      <div style="color: #888; font-size: 11px; font-style: italic;">No quests yet...</div>
    `;
    contentArea.appendChild(questsWrap);
    this.tabContents.set('quests', questsWrap);

    // Good Magic tab
    const goodMagicWrap = document.createElement('div');
    goodMagicWrap.style.display = 'none';
    goodMagicWrap.innerHTML = `
      <div style="color: #4ae; font-weight: bold; font-size: 13px; margin-bottom: 8px; text-shadow: 1px 1px 0 #000;">\u2728 Good Magic Spellbook</div>
      <div style="color: #888; font-size: 11px; font-style: italic;">No spells learned yet...</div>
    `;
    contentArea.appendChild(goodMagicWrap);
    this.tabContents.set('good_magic', goodMagicWrap);

    // Evil Magic tab
    const evilMagicWrap = document.createElement('div');
    evilMagicWrap.style.display = 'none';
    evilMagicWrap.innerHTML = `
      <div style="color: #c4a; font-weight: bold; font-size: 13px; margin-bottom: 8px; text-shadow: 1px 1px 0 #000;">\uD83D\uDD25 Evil Magic Spellbook</div>
      <div style="color: #888; font-size: 11px; font-style: italic;">No spells learned yet...</div>
    `;
    contentArea.appendChild(evilMagicWrap);
    this.tabContents.set('evil_magic', evilMagicWrap);

    // Friends tab
    const friendsWrap = document.createElement('div');
    friendsWrap.style.display = 'none';
    friendsWrap.innerHTML = `
      <div style="color: #0c0; font-weight: bold; font-size: 13px; margin-bottom: 8px; text-shadow: 1px 1px 0 #000;">Friends List</div>
      <div style="color: #888; font-size: 11px; font-style: italic;">Your friends list is empty.</div>
    `;
    contentArea.appendChild(friendsWrap);
    this.tabContents.set('friends', friendsWrap);

    // Ignore tab
    const ignoreWrap = document.createElement('div');
    ignoreWrap.style.display = 'none';
    ignoreWrap.innerHTML = `
      <div style="color: #c44; font-weight: bold; font-size: 13px; margin-bottom: 8px; text-shadow: 1px 1px 0 #000;">Ignore List</div>
      <div style="color: #888; font-size: 11px; font-style: italic;">Your ignore list is empty.</div>
    `;
    contentArea.appendChild(ignoreWrap);
    this.tabContents.set('ignore', ignoreWrap);

    panel.appendChild(contentArea);
    panel.appendChild(bottomTabs);

    // Spacer pushes logout to the very bottom
    const spacer = document.createElement('div');
    spacer.style.cssText = 'flex: 1;';
    panel.appendChild(spacer);

    // Logout button at the bottom
    const logoutBtn = document.createElement('div');
    logoutBtn.textContent = 'Logout';
    logoutBtn.style.cssText = `
      text-align: center; padding: 6px 0; margin: 4px 8px 6px;
      background: rgba(120,40,30,0.5);
      border: 1px solid rgba(180,80,60,0.4);
      border-radius: 3px; color: #fc0; font-size: 12px;
      cursor: pointer; font-weight: bold; letter-spacing: 1px;
      text-shadow: 1px 1px 0 rgba(0,0,0,0.5);
      box-shadow: inset 0 1px 3px rgba(0,0,0,0.3), 0 1px 0 rgba(255,200,100,0.05);
    `;
    logoutBtn.addEventListener('mouseenter', () => {
      logoutBtn.style.background = 'rgba(160,50,30,0.6)';
      logoutBtn.style.borderColor = 'rgba(220,100,60,0.5)';
    });
    logoutBtn.addEventListener('mouseleave', () => {
      logoutBtn.style.background = 'rgba(120,40,30,0.5)';
      logoutBtn.style.borderColor = 'rgba(180,80,60,0.4)';
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
      display: grid; grid-template-columns: repeat(5, 1fr);
      gap: 2px; justify-items: center;
    `;

    this.invSlotElements = [];
    for (let i = 0; i < INVENTORY_SIZE; i++) {
      const slot = document.createElement('div');
      slot.style.cssText = `
        width: 48px; height: 44px;
        background: rgba(0, 0, 0, 0.45);
        border: 1px solid rgba(0, 0, 0, 0.5);
        border-radius: 3px;
        box-shadow: inset 0 1px 3px rgba(0,0,0,0.4), 0 1px 0 rgba(255,200,100,0.05);
        display: flex; flex-direction: column;
        align-items: center; justify-content: center;
        cursor: pointer; font-size: 10px;
        position: relative;
        transition: background 0.1s;
      `;
      slot.addEventListener('mouseenter', () => { slot.style.background = 'rgba(80, 65, 50, 0.5)'; slot.style.borderColor = 'rgba(200,170,100,0.35)'; });
      slot.addEventListener('mouseleave', () => { slot.style.background = 'rgba(0, 0, 0, 0.45)'; slot.style.borderColor = 'rgba(0, 0, 0, 0.5)'; });

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
        display: flex; align-items: center; padding: 3px 4px;
        border-bottom: 1px solid rgba(60,50,40,0.4);
        transition: background 0.1s;
      `;
      row.addEventListener('mouseenter', () => { row.style.background = 'rgba(60,50,40,0.3)'; });
      row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });

      const nameEl = document.createElement('div');
      nameEl.style.cssText = `width: 72px; font-size: 11px; color: ${SKILL_COLORS[id]}; text-shadow: 1px 1px 0 #000;`;
      nameEl.textContent = SKILL_NAMES[id];
      row.appendChild(nameEl);

      const levelEl = document.createElement('div');
      levelEl.className = 'skill-level';
      levelEl.style.cssText = `width: 26px; text-align: center; font-size: 12px; font-weight: bold; color: #fc0; text-shadow: 1px 1px 0 #000;`;
      levelEl.textContent = '1';
      row.appendChild(levelEl);

      const barBg = document.createElement('div');
      barBg.style.cssText = `
        flex: 1; height: 10px; background: #181410; border: 1px solid #3a3025;
        margin-left: 4px; position: relative; border-radius: 1px;
      `;

      const barFill = document.createElement('div');
      barFill.className = 'skill-bar';
      barFill.style.cssText = `
        height: 100%; width: 0%; background: ${SKILL_COLORS[id]};
        transition: width 0.3s; border-radius: 1px;
      `;
      barBg.appendChild(barFill);

      const xpLabel = document.createElement('div');
      xpLabel.className = 'skill-xp';
      xpLabel.style.cssText = `
        position: absolute; top: 0; left: 0; right: 0; bottom: 0;
        display: flex; align-items: center; justify-content: center;
        font-size: 8px; color: #ccc; pointer-events: none;
        text-shadow: 1px 1px 0 #000;
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

  switchTab(tab: string): void {
    this.activeTab = tab;

    for (const [key, el] of this.tabContents) {
      el.style.display = key === tab ? 'block' : 'none';
    }

    for (const btn of this.tabButtons) {
      const isActive = btn.dataset.tab === tab;
      btn.style.color = isActive ? '#fc0' : '#8a7a60';
      btn.style.background = isActive ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0.35)';
      btn.style.borderColor = isActive ? 'rgba(255,200,100,0.25)' : 'rgba(0,0,0,0.4)';
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
    const sprite = def?.sprite;
    const icon = def?.icon;

    const iconHtml = sprite
      ? `<img src="/sprites/items/${sprite}" style="width:28px;height:28px;image-rendering:pixelated;object-fit:contain;" />`
      : icon
      ? `<img src="/items/${icon}" style="width:28px;height:28px;image-rendering:pixelated;object-fit:contain;" />`
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

  /** Get a snapshot of the current inventory */
  getInventory(): ({ itemId: number; quantity: number } | null)[] {
    return this.invSlots;
  }

  /** Get the player's level for a skill */
  getSkillLevel(skillId: SkillId): number {
    return this.skills.get(skillId)?.level ?? 1;
  }

  /** Get item definitions map */
  getItemDefs(): Map<number, ItemDef> {
    return this.itemDefs;
  }

  /** Update the HP bar below the minimap */
  updateHP(current: number, max: number): void {
    const fill = document.getElementById('side-hp-fill');
    const text = document.getElementById('side-hp-text');
    if (!fill || !text) return;
    const ratio = Math.max(0, current / max);
    fill.style.width = `${ratio * 100}%`;
    if (ratio > 0.5) {
      fill.style.background = 'linear-gradient(180deg, #1a8a1a 0%, #0a6a0a 100%)';
    } else if (ratio > 0.25) {
      fill.style.background = 'linear-gradient(180deg, #8a8a1a 0%, #6a6a0a 100%)';
    } else {
      fill.style.background = 'linear-gradient(180deg, #8a1a1a 0%, #6a0a0a 100%)';
    }
    text.textContent = `${current}/${max}`;
  }

  /** Update the combat level display (calculated from skills) */
  updateCombatLevel(): void {
    const acc = this.skills.get('accuracy' as SkillId)?.level ?? 1;
    const str = this.skills.get('strength' as SkillId)?.level ?? 1;
    const def = this.skills.get('defence' as SkillId)?.level ?? 1;
    const hp = this.skills.get('hitpoints' as SkillId)?.level ?? 10;
    const arch = this.skills.get('archery' as SkillId)?.level ?? 1;
    const mag = this.skills.get('good_magic' as SkillId)?.level ?? 1;
    const base = 0.25 * (def + hp);
    const melee = 0.325 * (acc + str);
    const ranged = 0.325 * (1.5 * arch);
    const magic = 0.325 * (1.5 * mag);
    const level = Math.floor(base + Math.max(melee, ranged, magic));
    const el = document.getElementById('side-combat-level');
    if (el) el.textContent = `Combat Lv: ${level}`;
  }

  /** Update the Good Magic bar below HP */
  updateMagicBar(): void {
    const data = this.skills.get('good_magic' as SkillId);
    if (!data) return;
    const fill = document.getElementById('side-magic-fill');
    const text = document.getElementById('side-magic-text');
    if (!fill || !text) return;
    text.textContent = `${data.level}`;
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
