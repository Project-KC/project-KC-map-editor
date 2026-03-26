import { INVENTORY_SIZE, ClientOpcode, encodePacket } from '@projectrs/shared';
import type { NetworkManager } from '../managers/NetworkManager';

// Item name lookup (mirror of server data — in real game this would be loaded from server)
const ITEM_NAMES: Record<number, string> = {
  1: 'Bones',
  2: 'Bronze Sword',
  3: 'Bronze Shield',
  4: 'Raw Rat Meat',
  5: 'Iron Sword',
  6: 'Leather Body',
  7: 'Leather Legs',
  8: 'Cooked Meat',
  9: 'Bread',
  10: 'Coins',
};

const ITEM_COLORS: Record<number, string> = {
  1: '#ccc',
  2: '#b87333',
  3: '#b87333',
  4: '#c44',
  5: '#888',
  6: '#8b5e3c',
  7: '#8b5e3c',
  8: '#a52',
  9: '#da5',
  10: '#fd0',
};

export interface InventorySlotData {
  itemId: number;
  quantity: number;
}

export class InventoryPanel {
  private container: HTMLDivElement;
  private slots: (InventorySlotData | null)[] = new Array(INVENTORY_SIZE).fill(null);
  private slotElements: HTMLDivElement[] = [];
  private network: NetworkManager;
  private visible: boolean = true;

  constructor(network: NetworkManager) {
    this.network = network;
    this.container = this.buildUI();
    document.body.appendChild(this.container);
  }

  private buildUI(): HTMLDivElement {
    const panel = document.createElement('div');
    panel.id = 'inventory-panel';
    panel.style.cssText = `
      position: fixed; right: 10px; bottom: 10px;
      width: 204px; background: rgba(30, 25, 18, 0.92);
      border: 2px solid #5a4a35; border-radius: 4px;
      padding: 6px; z-index: 100;
      font-family: monospace; color: #ddd;
    `;

    // Header
    const header = document.createElement('div');
    header.style.cssText = `
      text-align: center; padding: 4px; margin-bottom: 4px;
      border-bottom: 1px solid #5a4a35; color: #fc0;
      font-size: 13px; font-weight: bold;
    `;
    header.textContent = 'Inventory';
    panel.appendChild(header);

    // Grid — 4 columns x 7 rows = 28 slots
    const grid = document.createElement('div');
    grid.style.cssText = `
      display: grid; grid-template-columns: repeat(4, 1fr);
      gap: 2px;
    `;

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

      // Right-click to drop/equip
      slot.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.onSlotRightClick(i, e);
      });

      // Left-click to use
      slot.addEventListener('click', () => {
        this.onSlotClick(i);
      });

      grid.appendChild(slot);
      this.slotElements.push(slot);
    }

    panel.appendChild(grid);
    return panel;
  }

  updateSlot(index: number, itemId: number, quantity: number): void {
    if (index < 0 || index >= INVENTORY_SIZE) return;

    if (itemId === 0) {
      this.slots[index] = null;
    } else {
      this.slots[index] = { itemId, quantity };
    }

    this.renderSlot(index);
  }

  private renderSlot(index: number): void {
    const el = this.slotElements[index];
    const slot = this.slots[index];

    if (!slot) {
      el.innerHTML = '';
      el.style.borderColor = '#3a3025';
      return;
    }

    const name = ITEM_NAMES[slot.itemId] || `Item ${slot.itemId}`;
    const color = ITEM_COLORS[slot.itemId] || '#aaa';

    el.innerHTML = `
      <div style="width: 24px; height: 24px; background: ${color}; border-radius: 3px; margin-bottom: 2px;"></div>
      <div style="font-size: 9px; color: #ccc; text-align: center; line-height: 1;">${name.substring(0, 8)}</div>
      ${slot.quantity > 1 ? `<div style="position: absolute; top: 1px; left: 3px; font-size: 9px; color: #fd0;">${slot.quantity}</div>` : ''}
    `;
    el.style.borderColor = '#5a4a35';
  }

  private onSlotClick(index: number): void {
    const slot = this.slots[index];
    if (!slot) return;
    // TODO: Use item (eat food, etc.)
  }

  private onSlotRightClick(index: number, event: MouseEvent): void {
    const slot = this.slots[index];
    if (!slot) return;

    const name = ITEM_NAMES[slot.itemId] || 'Item';

    // Create mini context menu
    const menu = document.createElement('div');
    menu.style.cssText = `
      position: fixed; left: ${event.clientX}px; top: ${event.clientY}px;
      background: #3a3125; border: 2px solid #5a4a35;
      font-family: monospace; font-size: 12px; z-index: 1001;
      min-width: 100px; box-shadow: 2px 2px 8px rgba(0,0,0,0.5);
    `;

    const options: { label: string; action: () => void }[] = [
      {
        label: `Drop ${name}`,
        action: () => {
          this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_DROP_ITEM, index));
        },
      },
    ];

    // Check if equippable (IDs 2,3,5,6,7 are equippable)
    const equippableIds = [2, 3, 5, 6, 7];
    if (equippableIds.includes(slot.itemId)) {
      options.unshift({
        label: `Equip ${name}`,
        action: () => {
          this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_EQUIP_ITEM, index));
        },
      });
    }

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

  toggle(): void {
    this.visible = !this.visible;
    this.container.style.display = this.visible ? 'block' : 'none';
  }
}
