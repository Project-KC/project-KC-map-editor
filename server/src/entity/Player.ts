import { Entity } from './Entity';
import {
  InventorySlot, INVENTORY_SIZE,
  SkillBlock, SkillId, MeleeStance, CombatBonuses,
  initSkills, addXp, combatLevel, zeroBonuses, STANCE_XP,
  ACC_BASE, osrsMeleeMaxHit, calculateHitChance, STANCE_BONUSES,
} from '@projectrs/shared';
import type { ServerWebSocket } from 'bun';

export const EQUIP_SLOTS = ['weapon', 'shield', 'head', 'body', 'legs', 'neck', 'ring', 'hands', 'feet', 'cape'] as const;
export type EquipSlot = typeof EQUIP_SLOTS[number];

export interface EquippedItem {
  itemId: number;
  slot: EquipSlot;
}

export class Player extends Entity {
  ws: ServerWebSocket<{ type: string; playerId?: number }>;
  accountId: number;
  inventory: (InventorySlot | null)[];
  equipment: Map<EquipSlot, number> = new Map(); // slot -> itemId
  skills: SkillBlock;
  stance: MeleeStance = 'accurate';
  moveQueue: { x: number; z: number }[] = [];
  moveSpeed: number = 1;
  pendingPickup: number = -1;
  pendingInteraction: { objectEntityId: number; actionIndex: number } | null = null;

  // Chunk tracking
  currentChunkX: number = -1;
  currentChunkZ: number = -1;
  /** Previous chunk position for broadcastSync — when this changes, viewer needs full resync */
  lastBroadcastChunkX: number = -9999;
  lastBroadcastChunkZ: number = -9999;

  // Combat
  attackTarget: Entity | null = null;
  attackCooldown: number = 0;

  // Rate limiting: max messages per window
  private _rlCount: number = 0;
  private _rlWindowStart: number = 0;
  private static RL_MAX_MESSAGES = 30;   // max messages per window
  private static RL_WINDOW_MS = 1000;    // 1-second window

  /** Returns true if the message should be processed, false if rate-limited */
  checkRateLimit(): boolean {
    const now = Date.now();
    if (now - this._rlWindowStart > Player.RL_WINDOW_MS) {
      this._rlWindowStart = now;
      this._rlCount = 0;
    }
    this._rlCount++;
    return this._rlCount <= Player.RL_MAX_MESSAGES;
  }

  constructor(
    name: string,
    x: number,
    z: number,
    ws: ServerWebSocket<{ type: string; playerId?: number }>,
    accountId: number = 0
  ) {
    super(name, x, z, 10); // maxHealth set from skills
    this.ws = ws;
    this.accountId = accountId;
    this.inventory = new Array(INVENTORY_SIZE).fill(null);
    this.skills = initSkills();
    this.health = this.skills.hitpoints.currentLevel;
    this.maxHealth = this.skills.hitpoints.level;
  }

  get combatLevel(): number {
    return combatLevel(this.skills);
  }

  // Recompute bonuses from all equipped items
  computeBonuses(itemDefs: Map<number, any>): CombatBonuses {
    const b = zeroBonuses();
    for (const [, itemId] of this.equipment) {
      const def = itemDefs.get(itemId);
      if (!def) continue;
      b.stabAttack += def.stabAttack || 0;
      b.slashAttack += def.slashAttack || 0;
      b.crushAttack += def.crushAttack || 0;
      b.stabDefence += def.stabDefence || 0;
      b.slashDefence += def.slashDefence || 0;
      b.crushDefence += def.crushDefence || 0;
      b.meleeStrength += def.meleeStrength || 0;
      b.rangedAccuracy += def.rangedAccuracy || 0;
      b.rangedStrength += def.rangedStrength || 0;
      b.rangedDefence += def.rangedDefence || 0;
      b.magicAccuracy += def.magicAccuracy || 0;
      b.magicDefence += def.magicDefence || 0;
    }
    return b;
  }

  getAttackSpeed(itemDefs: Map<number, any>): number {
    const weaponId = this.equipment.get('weapon');
    if (weaponId) {
      const def = itemDefs.get(weaponId);
      if (def?.attackSpeed) return def.attackSpeed;
    }
    return 4; // Unarmed
  }

  getWeaponStyle(itemDefs: Map<number, any>): 'stab' | 'slash' | 'crush' | 'bow' | 'crossbow' {
    const weaponId = this.equipment.get('weapon');
    if (weaponId) {
      const def = itemDefs.get(weaponId);
      if (def?.weaponStyle) return def.weaponStyle;
    }
    return 'crush'; // Unarmed = crush (fists)
  }

  isRangedWeapon(itemDefs: Map<number, any>): boolean {
    const style = this.getWeaponStyle(itemDefs);
    return style === 'bow' || style === 'crossbow';
  }

  /** Find the first matching ammo in inventory. Returns slot index + item def, or null. */
  findAmmo(itemDefs: Map<number, any>): { slotIndex: number; itemDef: any } | null {
    const weaponId = this.equipment.get('weapon');
    if (!weaponId) return null;
    const weaponDef = itemDefs.get(weaponId);
    if (!weaponDef?.ammoType) return null;

    for (let i = 0; i < this.inventory.length; i++) {
      const slot = this.inventory[i];
      if (!slot) continue;
      const def = itemDefs.get(slot.itemId);
      if (def?.isAmmo) return { slotIndex: i, itemDef: def };
    }
    return null;
  }

  /** Remove quantity from an inventory slot. Returns true if successful. */
  removeItemFromSlot(slotIndex: number, quantity: number): boolean {
    const slot = this.inventory[slotIndex];
    if (!slot || slot.quantity < quantity) return false;
    slot.quantity -= quantity;
    if (slot.quantity <= 0) this.inventory[slotIndex] = null;
    return true;
  }

  addItem(itemId: number, quantity: number = 1, itemDefs?: Map<number, any>): boolean {
    const def = itemDefs?.get(itemId);
    const stackable = def?.stackable === true;

    // Only stack if the item is explicitly marked as stackable
    if (stackable) {
      for (let i = 0; i < this.inventory.length; i++) {
        const slot = this.inventory[i];
        if (slot && slot.itemId === itemId) {
          slot.quantity += quantity;
          return true;
        }
      }
    }

    // Non-stackable: each unit takes its own slot
    const toPlace = stackable ? 1 : quantity;
    for (let q = 0; q < toPlace; q++) {
      const emptySlot = this.inventory.findIndex(s => s === null);
      if (emptySlot < 0) return false;
      this.inventory[emptySlot] = { itemId, quantity: stackable ? quantity : 1 };
    }
    return true;
  }

  removeItem(slot: number, quantity: number = 1): InventorySlot | null {
    const item = this.inventory[slot];
    if (!item) return null;
    if (item.quantity <= quantity) {
      this.inventory[slot] = null;
      return item;
    }
    item.quantity -= quantity;
    return { itemId: item.itemId, quantity };
  }

  processMovement(): void {
    // Process 1 waypoint per tick to match RS2 walk speed (~1.67 tiles/sec)
    for (let i = 0; i < 1 && this.moveQueue.length > 0; i++) {
      const target = this.moveQueue.shift()!;
      this.position.x = target.x;
      this.position.y = target.z;
    }
  }

  syncHealthFromSkills(): void {
    this.maxHealth = this.skills.hitpoints.level;
    this.health = this.skills.hitpoints.currentLevel;
  }
}
