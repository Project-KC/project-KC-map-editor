import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { NpcDef, ItemDef, SpawnsFile, WorldObjectDef } from '@projectrs/shared';

const DATA_DIR = resolve(import.meta.dir, '../../data');
const MAPS_DIR = resolve(DATA_DIR, 'maps');

export class DataLoader {
  private npcs: Map<number, NpcDef> = new Map();
  private items: Map<number, ItemDef> = new Map();
  private objects: Map<number, WorldObjectDef> = new Map();

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
  }

  private loadNpcs(): void {
    const raw = readFileSync(resolve(DATA_DIR, 'npcs.json'), 'utf-8');
    const defs: NpcDef[] = JSON.parse(raw);
    for (const def of defs) {
      this.npcs.set(def.id, def);
    }
    console.log(`Loaded ${this.npcs.size} NPC definitions`);
  }

  private loadItems(): void {
    const raw = readFileSync(resolve(DATA_DIR, 'items.json'), 'utf-8');
    const defs: ItemDef[] = JSON.parse(raw);
    for (const def of defs) {
      this.items.set(def.id, def);
    }
    console.log(`Loaded ${this.items.size} item definitions`);
  }

  private loadObjects(): void {
    const raw = readFileSync(resolve(DATA_DIR, 'objects.json'), 'utf-8');
    const defs: WorldObjectDef[] = JSON.parse(raw);
    for (const def of defs) {
      this.objects.set(def.id, def);
    }
    console.log(`Loaded ${this.objects.size} object definitions`);
  }

  getObject(id: number): WorldObjectDef | undefined {
    return this.objects.get(id);
  }

  loadSpawns(mapId: string): SpawnsFile {
    const raw = readFileSync(resolve(MAPS_DIR, mapId, 'spawns.json'), 'utf-8');
    return JSON.parse(raw) as SpawnsFile;
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
