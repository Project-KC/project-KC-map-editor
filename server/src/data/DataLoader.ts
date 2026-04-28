import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { NpcDef, ItemDef, SpawnsFile, WorldObjectDef } from '@projectrs/shared';

const DATA_DIR = resolve(import.meta.dir, '../../data');
const MAPS_DIR = resolve(DATA_DIR, 'maps');

export interface ShopItem {
  itemId: number;
  price: number;
  stock: number;
}

export interface ShopDef {
  name: string;
  items: ShopItem[];
}

export class DataLoader {
  private npcs: Map<number, NpcDef> = new Map();
  private items: Map<number, ItemDef> = new Map();
  private objects: Map<number, WorldObjectDef> = new Map();
  private shops: Map<number, ShopDef> = new Map();
  private shopItemPrices: Map<number, number> = new Map();

  get itemDefs(): Map<number, ItemDef> {
    return this.items;
  }

  get objectDefs(): Map<number, WorldObjectDef> {
    return this.objects;
  }

  constructor() {
    this.loadNpcs();
    this.loadItems();
    this.loadObjects();
    this.loadShops();
  }

  private loadNpcs(): void {
    const path = resolve(DATA_DIR, 'npcs.json');
    try {
      const raw = readFileSync(path, 'utf-8');
      const defs: NpcDef[] = JSON.parse(raw);
      for (const def of defs) {
        this.npcs.set(def.id, def);
      }
      console.log(`Loaded ${this.npcs.size} NPC definitions`);
    } catch (e) {
      throw new Error(`Failed to load ${path}: ${e instanceof Error ? e.message : e}`);
    }
  }

  private loadItems(): void {
    const path = resolve(DATA_DIR, 'items.json');
    try {
      const raw = readFileSync(path, 'utf-8');
      const defs: ItemDef[] = JSON.parse(raw);
      for (const def of defs) {
        this.items.set(def.id, def);
      }
      console.log(`Loaded ${this.items.size} item definitions`);
    } catch (e) {
      throw new Error(`Failed to load ${path}: ${e instanceof Error ? e.message : e}`);
    }
  }

  private loadObjects(): void {
    const path = resolve(DATA_DIR, 'objects.json');
    try {
      const raw = readFileSync(path, 'utf-8');
      const defs: WorldObjectDef[] = JSON.parse(raw);
      for (const def of defs) {
        this.objects.set(def.id, def);
      }
      console.log(`Loaded ${this.objects.size} object definitions`);
    } catch (e) {
      throw new Error(`Failed to load ${path}: ${e instanceof Error ? e.message : e}`);
    }
  }

  private loadShops(): void {
    try {
      const raw = readFileSync(resolve(DATA_DIR, 'shops.json'), 'utf-8');
      const data: Record<string, ShopDef> = JSON.parse(raw);
      for (const [npcId, shop] of Object.entries(data)) {
        this.shops.set(Number(npcId), shop);
      }
      console.log(`Loaded ${this.shops.size} shop definitions`);
      for (const shop of this.shops.values()) {
        for (const si of shop.items) {
          if (!this.shopItemPrices.has(si.itemId)) {
            this.shopItemPrices.set(si.itemId, si.price);
          }
        }
      }
    } catch {
      console.log('No shops.json found, skipping');
    }
  }

  getShop(npcDefId: number): ShopDef | undefined {
    return this.shops.get(npcDefId);
  }

  getShopPrice(itemId: number): number | undefined {
    return this.shopItemPrices.get(itemId);
  }

  getObject(id: number): WorldObjectDef | undefined {
    return this.objects.get(id);
  }

  loadSpawns(mapId: string): SpawnsFile {
    const path = resolve(MAPS_DIR, mapId, 'spawns.json');
    try {
      const raw = readFileSync(path, 'utf-8');
      return JSON.parse(raw) as SpawnsFile;
    } catch (e) {
      console.warn(`Failed to load ${path}: ${e instanceof Error ? e.message : e}`);
      return { npcs: [], objects: [] };
    }
  }

  getNpc(id: number): NpcDef | undefined {
    return this.npcs.get(id);
  }

  getItem(id: number): ItemDef | undefined {
    return this.items.get(id);
  }

  getAllNpcs(): NpcDef[] {
    return Array.from(this.npcs.values());
  }

  getAllItems(): ItemDef[] {
    return Array.from(this.items.values());
  }
}
