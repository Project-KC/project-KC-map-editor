import type { WorldObjectDef } from '@projectrs/shared';

let nextObjectEntityId = 10000; // Start high to avoid collision with NPC/player entity IDs

export class WorldObject {
  readonly id: number;
  readonly defId: number;
  /** Mutable: doors swap action labels by replacing this with a copy. */
  def: WorldObjectDef;
  readonly x: number;
  readonly z: number;
  readonly mapLevel: string;

  depleted: boolean = false;
  respawnTimer: number = 0;
  rotationY: number = 0;
  doorOpen: boolean = false;
  closedEdge: number = 0;
  /** Per-instance transition override from editor trigger data */
  trigger?: { type: string; destChunk: string; entryX: number; entryY: number; entryZ: number };

  constructor(def: WorldObjectDef, x: number, z: number, mapLevel: string) {
    this.id = nextObjectEntityId++;
    this.defId = def.id;
    this.def = def;
    this.x = x;
    this.z = z;
    this.mapLevel = mapLevel;
  }

  /** Tick respawn. Returns true when object respawns. */
  tickRespawn(): boolean {
    if (!this.depleted) return false;
    this.respawnTimer--;
    if (this.respawnTimer <= 0) {
      this.depleted = false;
      return true;
    }
    return false;
  }

  /** Deplete the object (e.g. tree chopped down). */
  deplete(): void {
    this.depleted = true;
    this.respawnTimer = this.def.respawnTime ?? 15;
  }
}
