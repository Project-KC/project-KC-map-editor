import { CHUNK_SIZE, CHUNK_LOAD_RADIUS } from '@projectrs/shared';

/**
 * Server-side spatial index for entities within a map.
 * Tracks which chunk each entity is in for efficient proximity queries.
 */
export class ServerChunkManager {
  private entityChunks: Map<number, string> = new Map(); // entityId -> "cx,cz"
  private chunkEntities: Map<string, Set<number>> = new Map(); // "cx,cz" -> set of entityIds

  readonly chunksX: number;
  readonly chunksZ: number;

  constructor(mapWidth: number, mapHeight: number) {
    this.chunksX = Math.ceil(mapWidth / CHUNK_SIZE);
    this.chunksZ = Math.ceil(mapHeight / CHUNK_SIZE);
  }

  private chunkKey(cx: number, cz: number): string {
    return `${cx},${cz}`;
  }

  private worldToChunk(x: number, z: number): [number, number] {
    return [Math.floor(x / CHUNK_SIZE), Math.floor(z / CHUNK_SIZE)];
  }

  addEntity(entityId: number, worldX: number, worldZ: number): void {
    const [cx, cz] = this.worldToChunk(worldX, worldZ);
    const key = this.chunkKey(cx, cz);
    this.entityChunks.set(entityId, key);
    if (!this.chunkEntities.has(key)) {
      this.chunkEntities.set(key, new Set());
    }
    this.chunkEntities.get(key)!.add(entityId);
  }

  removeEntity(entityId: number): void {
    const key = this.entityChunks.get(entityId);
    if (key) {
      const set = this.chunkEntities.get(key);
      if (set) {
        set.delete(entityId);
        if (set.size === 0) this.chunkEntities.delete(key);
      }
      this.entityChunks.delete(entityId);
    }
  }

  updateEntity(entityId: number, worldX: number, worldZ: number): void {
    const [cx, cz] = this.worldToChunk(worldX, worldZ);
    const newKey = this.chunkKey(cx, cz);
    const oldKey = this.entityChunks.get(entityId);
    if (oldKey === newKey) return;

    // Remove from old chunk
    if (oldKey) {
      const set = this.chunkEntities.get(oldKey);
      if (set) {
        set.delete(entityId);
        if (set.size === 0) this.chunkEntities.delete(oldKey);
      }
    }

    // Add to new chunk
    this.entityChunks.set(entityId, newKey);
    if (!this.chunkEntities.has(newKey)) {
      this.chunkEntities.set(newKey, new Set());
    }
    this.chunkEntities.get(newKey)!.add(entityId);
  }

  /** Get all entity IDs within CHUNK_LOAD_RADIUS of the given chunk */
  getEntitiesNear(cx: number, cz: number): Set<number> {
    const result = new Set<number>();
    for (let dx = -CHUNK_LOAD_RADIUS; dx <= CHUNK_LOAD_RADIUS; dx++) {
      for (let dz = -CHUNK_LOAD_RADIUS; dz <= CHUNK_LOAD_RADIUS; dz++) {
        const key = this.chunkKey(cx + dx, cz + dz);
        const set = this.chunkEntities.get(key);
        if (set) {
          for (const id of set) result.add(id);
        }
      }
    }
    return result;
  }

  getEntityChunk(entityId: number): [number, number] | null {
    const key = this.entityChunks.get(entityId);
    if (!key) return null;
    const parts = key.split(',');
    return [parseInt(parts[0]), parseInt(parts[1])];
  }
}
