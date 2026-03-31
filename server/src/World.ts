import { TICK_RATE, CHUNK_SIZE, CHUNK_LOAD_RADIUS, ServerOpcode, ALL_SKILLS, ASSET_TO_OBJECT_DEF, WallEdge, type SkillId, type ItemDef } from '@projectrs/shared';
import { encodePacket, encodeStringPacket } from '@projectrs/shared';
import { addXp, levelFromXp, statRandom } from '@projectrs/shared';
import { GameMap } from './GameMap';
import { Player, type EquipSlot } from './entity/Player';
import { Npc } from './entity/Npc';
import { WorldObject } from './entity/WorldObject';
import { DataLoader } from './data/DataLoader';
import { GameDatabase } from './Database';
import { processPlayerCombat, processNpcCombat, rollLoot } from './combat/Combat';
import { broadcastPlayerInfo } from './network/ChatSocket';
import { ServerChunkManager } from './ChunkManager';
import { readdirSync } from 'fs';

/** Map string IDs to small integers for blockedObjectTiles encoding */
const mapIdRegistry: Map<string, number> = new Map();
let nextMapIdx = 0;
function getMapIdx(mapId: string): number {
  let idx = mapIdRegistry.get(mapId);
  if (idx === undefined) { idx = nextMapIdx++; mapIdRegistry.set(mapId, idx); }
  return idx;
}
/** Encode map+tile into a single number. Supports tiles up to 65535x65535 with up to ~2000 maps. */
function blockedKey(mapIdx: number, tileX: number, tileZ: number): number {
  return mapIdx * 4294967296 + tileX * 65536 + tileZ;
}
const HITPOINTS_SKILL_INDEX = ALL_SKILLS.indexOf('hitpoints' as SkillId);

export interface GroundItem {
  id: number;
  itemId: number;
  quantity: number;
  x: number;
  z: number;
  mapLevel: string;
  despawnTimer: number;
}

let nextGroundItemId = 1;

export class World {
  readonly maps: Map<string, GameMap> = new Map();
  readonly chunkManagers: Map<string, ServerChunkManager> = new Map();
  readonly data: DataLoader;
  readonly db: GameDatabase;
  readonly players: Map<number, Player> = new Map();
  readonly npcs: Map<number, Npc> = new Map();
  readonly groundItems: Map<number, GroundItem> = new Map();
  readonly worldObjects: Map<number, WorldObject> = new Map();
  /** Tiles blocked by non-depleted world objects, encoded as numeric key */
  private blockedObjectTiles: Set<number> = new Set();

  private currentTick: number = 0;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private saveTimer: ReturnType<typeof setInterval> | null = null;

  // Player combat targets (playerId -> npcId)
  private playerCombatTargets: Map<number, number> = new Map();
  // Reverse lookup: npcId -> set of playerIds targeting it (kept in sync with playerCombatTargets)
  private npcTargetedBy: Map<number, Set<number>> = new Map();

  /** Ground items with active despawn timers (avoids iterating all permanent items) */
  private despawningItemIds: Set<number> = new Set();

  /** World objects currently depleted and awaiting respawn */
  private depletedObjectIds: Set<number> = new Set();

  /** Reusable set for health regen — avoids allocation every 10 ticks */
  private _playersUnderNpcAttack: Set<number> = new Set();

  // Skilling: player -> { objectId, action, ticksLeft }
  private skillingActions: Map<number, { objectId: number; action: string; ticksLeft: number; toolItemId?: number }> = new Map();

  constructor(db: GameDatabase) {
    this.db = db;
    this.data = new DataLoader();

    // Auto-discover maps from server/data/maps/
    this.discoverAndLoadMaps();

    // Spawn NPCs and objects from data files
    this.spawnNpcs();
    this.spawnWorldObjects();
  }

  private discoverAndLoadMaps(): void {
    const mapsDir = `${import.meta.dir}/../data/maps`;
    try {
      const entries = readdirSync(mapsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          try {
            this.loadMap(entry.name);
          } catch (e) {
            console.warn(`Failed to load map '${entry.name}':`, e);
          }
        }
      }
    } catch (e) {
      console.error('Failed to discover maps:', e);
    }
    console.log(`Loaded ${this.maps.size} maps: ${[...this.maps.keys()].join(', ')}`);
  }

  private loadMap(mapId: string): void {
    const gameMap = new GameMap(mapId);
    this.maps.set(mapId, gameMap);
    this.chunkManagers.set(mapId, new ServerChunkManager(gameMap.width, gameMap.height));
  }

  reloadMap(mapId: string): void {
    console.log(`Hot-reloading map '${mapId}'...`);
    const gameMap = new GameMap(mapId);
    this.maps.set(mapId, gameMap);
    const cm = new ServerChunkManager(gameMap.width, gameMap.height);
    this.chunkManagers.set(mapId, cm);

    // Remove old NPCs and world objects for this map
    for (const [id, npc] of this.npcs) {
      if (npc.currentMapLevel === mapId) this.npcs.delete(id);
    }
    for (const [id, obj] of this.worldObjects) {
      if (obj.mapLevel === mapId) {
        this.blockedObjectTiles.delete(this.blockedKeyFor(mapId, obj.x, obj.z));
        this.worldObjects.delete(id);
      }
    }

    // Re-spawn NPCs and world objects
    const spawns = this.data.loadSpawns(mapId);
    for (const spawn of spawns.npcs ?? []) {
      const npcDef = this.data.getNpc(spawn.npcId);
      if (!npcDef) continue;
      const npc = new Npc(npcDef, spawn.x, spawn.z, spawn.wanderRange);
      npc.currentMapLevel = mapId;
      this.npcs.set(npc.id, npc);
      cm.addEntity(npc.id, spawn.x, spawn.z);
    }
    // Derive world objects from placed objects in map.json (single source of truth)
    const objectSpawns: { objectId: number; x: number; z: number; rotY?: number }[] = [];
    for (const placed of gameMap.placedObjects) {
      const defId = ASSET_TO_OBJECT_DEF[placed.assetId];
      if (defId != null) {
        objectSpawns.push({ objectId: defId, x: placed.position.x, z: placed.position.z, rotY: placed.rotation?.y });
      }
    }
    // Fallback: sprite-only objects from spawns.json
    for (const obj of spawns.objects ?? []) {
      objectSpawns.push(obj);
    }
    for (const spawn of objectSpawns) {
      const objDef = this.data.getObject(spawn.objectId);
      if (!objDef) continue;
      const obj = new WorldObject(objDef, spawn.x, spawn.z, mapId);
      if (spawn.rotY != null) obj.rotationY = spawn.rotY;
      this.worldObjects.set(obj.id, obj);
      if (objDef.blocking) {
        this.blockedObjectTiles.add(this.blockedKeyFor(mapId, spawn.x, spawn.z));
      }
      cm.addEntity(obj.id, spawn.x, spawn.z);
    }

    // Re-spawn ground items for this map
    for (const [id, item] of this.groundItems) {
      if (item.mapLevel === mapId) this.groundItems.delete(id);
    }
    for (const item of (spawns as any).items ?? []) {
      const groundItem: GroundItem = {
        id: nextGroundItemId++,
        itemId: item.itemId,
        quantity: item.quantity ?? 1,
        x: item.x,
        z: item.z,
        mapLevel: mapId,
        despawnTimer: -1,
      };
      this.groundItems.set(groundItem.id, groundItem);
      cm.addEntity(groundItem.id, groundItem.x, groundItem.z);
    }

    // Re-register players on this map
    for (const [id, player] of this.players) {
      if (player.currentMapLevel === mapId) {
        cm.addEntity(id, player.position.x, player.position.y);
      }
    }
    // Send MAP_CHANGE to all players — entity data will be sent when client responds with MAP_READY
    for (const [, player] of this.players) {
      if (player.currentMapLevel === mapId) {
        this.sendMapChange(player, mapId);
      }
    }
    console.log(`Map '${mapId}' reloaded: ${gameMap.width}x${gameMap.height}`);
  }

  /** Client finished loading the map — send all entity data now */
  handleMapReady(playerId: number): void {
    const player = this.players.get(playerId);
    if (!player) return;
    const mapId = player.currentMapLevel;
    const cm = this.chunkManagers.get(mapId);
    if (!cm) return;

    // Use chunk manager to get all nearby entities (players, NPCs, world objects, ground items)
    const nearbyIds = cm.getEntitiesNear(player.position.x, player.position.y);
    for (const eid of nearbyIds) {
      if (eid === player.id) continue;
      const other = this.players.get(eid);
      if (other) { this.sendPlayerUpdate(player, other); continue; }
      const npc = this.npcs.get(eid);
      if (npc && !npc.dead) { this.sendNpcUpdate(player, npc); continue; }
      const obj = this.worldObjects.get(eid);
      if (obj) { this.sendWorldObjectUpdate(player, obj); continue; }
      const item = this.groundItems.get(eid);
      if (item) { this.sendGroundItemUpdate(player, item); continue; }
    }
    this.sendSkills(player);
    this.sendInventory(player);
    this.sendEquipment(player);
  }

  getMap(mapId: string): GameMap {
    const m = this.maps.get(mapId);
    if (!m) throw new Error(`Unknown map: ${mapId}`);
    return m;
  }

  /** Get the map the player is currently on */
  getPlayerMap(player: Player): GameMap {
    return this.getMap(player.currentMapLevel);
  }

  private spawnNpcs(): void {
    for (const [mapId, gameMap] of this.maps) {
      const spawns = this.data.loadSpawns(mapId);
      for (const spawn of spawns.npcs) {
        const npcDef = this.data.getNpc(spawn.npcId);
        if (!npcDef) {
          console.warn(`Unknown NPC id ${spawn.npcId} in ${mapId}/spawns.json`);
          continue;
        }
        const npc = new Npc(npcDef, spawn.x, spawn.z, spawn.wanderRange);
        npc.currentMapLevel = mapId;
        this.npcs.set(npc.id, npc);

        // Register with chunk manager
        const cm = this.chunkManagers.get(mapId)!;
        cm.addEntity(npc.id, spawn.x, spawn.z);
      }
      console.log(`Spawned NPCs for map '${mapId}'`);
    }
    console.log(`Total NPCs: ${this.npcs.size}`);
  }

  private spawnWorldObjects(): void {
    for (const [mapId] of this.maps) {
      const spawns = this.data.loadSpawns(mapId);

      // Derive world objects from placed objects in map.json (single source of truth)
      const gameMap = this.maps.get(mapId)!;
      const objectSpawns: { objectId: number; x: number; z: number; rotY?: number }[] = [];
      for (const placed of gameMap.placedObjects ?? []) {
        const defId = ASSET_TO_OBJECT_DEF[placed.assetId];
        if (defId != null) {
          objectSpawns.push({ objectId: defId, x: placed.position.x, z: placed.position.z, rotY: placed.rotation?.y });
        }
      }

      // Fallback: sprite-only objects from spawns.json (fishing spots, altars, etc. without GLBs)
      for (const obj of spawns.objects ?? []) {
        objectSpawns.push(obj);
      }

      for (const spawn of objectSpawns) {
        const objDef = this.data.getObject(spawn.objectId);
        if (!objDef) {
          console.warn(`Unknown object id ${spawn.objectId} in ${mapId}/spawns.json`);
          continue;
        }
        const obj = new WorldObject(objDef, spawn.x, spawn.z, mapId);
        if (spawn.rotY != null) obj.rotationY = spawn.rotY;
        this.worldObjects.set(obj.id, obj);
        if (objDef.blocking) {
          this.blockedObjectTiles.add(this.blockedKeyFor(mapId, spawn.x, spawn.z));
        }
        const cm = this.chunkManagers.get(mapId);
        if (cm) cm.addEntity(obj.id, spawn.x, spawn.z);
      }
      console.log(`Spawned objects for map '${mapId}'`);
    }
    console.log(`Total world objects: ${this.worldObjects.size}`);

    // Spawn ground items from spawns.json
    let itemCount = 0;
    for (const [mapId] of this.maps) {
      const spawns = this.data.loadSpawns(mapId);
      for (const item of (spawns as any).items ?? []) {
        const groundItem: GroundItem = {
          id: nextGroundItemId++,
          itemId: item.itemId,
          quantity: item.quantity ?? 1,
          x: item.x,
          z: item.z,
          mapLevel: mapId,
          despawnTimer: -1, // permanent spawn
        };
        this.groundItems.set(groundItem.id, groundItem);
        const cm = this.chunkManagers.get(mapId);
        if (cm) cm.addEntity(groundItem.id, groundItem.x, groundItem.z);
        itemCount++;
      }
    }
    if (itemCount > 0) console.log(`Spawned ${itemCount} ground items from spawns`);
  }

  start(): void {
    console.log(`World starting — tick rate: ${TICK_RATE}ms`);
    this.tickTimer = setInterval(() => this.tick(), TICK_RATE);
    // Auto-save all players every 60 seconds
    this.saveTimer = setInterval(() => this.saveAllPlayers(), 60_000);
  }

  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.saveTimer) {
      clearInterval(this.saveTimer);
      this.saveTimer = null;
    }
    this.saveAllPlayers();
  }

  private saveAllPlayers(): void {
    for (const [, player] of this.players) {
      this.db.savePlayerState(player.accountId, player);
    }
  }

  kickAccountIfOnline(accountId: number): void {
    for (const [id, player] of this.players) {
      if (player.accountId === accountId) {
        try {
          player.ws.close(1000, 'Logged in from another session');
        } catch { /* ignore */ }
        this.removePlayer(id);
        break;
      }
    }
  }

  addPlayer(player: Player): void {
    this.players.set(player.id, player);
    console.log(`Player "${player.name}" (id=${player.id}) joined on ${player.currentMapLevel}`);

    // Register with chunk manager
    const cm = this.chunkManagers.get(player.currentMapLevel)!;
    cm.addEntity(player.id, player.position.x, player.position.y);
    cm.registerPlayer(player.id);
    player.currentChunkX = Math.floor(player.position.x / CHUNK_SIZE);
    player.currentChunkZ = Math.floor(player.position.y / CHUNK_SIZE);

    // Send login confirmation — entity data will be sent when client responds with MAP_READY
    this.sendToPlayer(player, ServerOpcode.LOGIN_OK, player.id,
      Math.round(player.position.x * 10),
      Math.round(player.position.y * 10)
    );

    // Broadcast player name to all chat sockets
    broadcastPlayerInfo(player.id, player.name);
    for (const [, other] of this.players) {
      if (other.id !== player.id) {
        broadcastPlayerInfo(other.id, other.name);
      }
    }
  }

  private cancelSkilling(playerId: number): void {
    if (this.skillingActions.has(playerId)) {
      this.skillingActions.delete(playerId);
      const player = this.players.get(playerId);
      if (player) {
        this.sendToPlayer(player, ServerOpcode.SKILLING_STOP, 0);
      }
    }
  }

  removePlayer(playerId: number): void {
    const player = this.players.get(playerId);
    if (!player) return;

    // Remove from chunk manager
    const cm = this.chunkManagers.get(player.currentMapLevel);
    if (cm) cm.removeEntity(player.id);

    this.players.delete(playerId);
    this.clearCombatTarget(playerId);
    this.skillingActions.delete(playerId);
    console.log(`Player "${player.name}" left`);

    // Notify nearby players
    this.broadcastNearby(player.currentMapLevel, player.position.x, player.position.y, ServerOpcode.ENTITY_DEATH, playerId);
  }

  /** Check if a world position is within chunk load radius of a player */
  /** Find the best tool of a given type that the player can use (checks equipped weapon + inventory) */
  private toggleDoor(obj: WorldObject): void {
    const map = this.maps.get(obj.mapLevel);
    if (!map) return;
    const tx = Math.floor(obj.x);
    const tz = Math.floor(obj.z);

    // Derive wall edge from door rotation (normalize to 0-360)
    const degRaw = Math.round((obj.rotationY * 180 / Math.PI) % 360 + 360) % 360;
    // Map rotation to the wall edges the door blocks
    // 0° or 360° → N/S edge, 90° or 270° → E/W edge
    let edgeMask: number;
    if (degRaw === 0 || degRaw === 180) {
      edgeMask = WallEdge.N | WallEdge.S;
    } else {
      edgeMask = WallEdge.E | WallEdge.W;
    }

    const isOpen = obj.depleted;
    const currentWall = map.getWall(tx, tz);

    if (isOpen) {
      // Close door — restore wall collision
      map.setWall(tx, tz, currentWall | edgeMask);
      this.blockedObjectTiles.add(blockedKey(getMapIdx(obj.mapLevel), tx, tz));
      obj.depleted = false;
      // Update action to "Open"
      obj.def = { ...obj.def, actions: ['Open', 'Examine'] };
    } else {
      // Open door — remove wall collision
      map.setWall(tx, tz, currentWall & ~edgeMask);
      this.blockedObjectTiles.delete(blockedKey(getMapIdx(obj.mapLevel), tx, tz));
      obj.depleted = true;
      obj.respawnTimer = obj.def.respawnTime ?? 15;
      this.depletedObjectIds.add(obj.id);
      // Update action to "Close"
      obj.def = { ...obj.def, actions: ['Close', 'Examine'] };
    }

    // Broadcast state to nearby players
    this.broadcastNearby(obj.mapLevel, obj.x, obj.z, ServerOpcode.WORLD_OBJECT_DEPLETED, obj.id, obj.depleted ? 1 : 0);
  }

  private findBestTool(player: Player, toolType: string, playerSkillLevel: number): ItemDef | null {
    let best: ItemDef | null = null;
    const check = (itemId: number) => {
      const def = this.data.getItem(itemId);
      if (!def || (def as any).toolType !== toolType) return;
      const toolLvl = (def as any).toolLevel ?? 1;
      if (toolLvl > playerSkillLevel) return;
      const bonus = (def as any).toolBonus ?? 0;
      if (!best || bonus > ((best as any).toolBonus ?? 0)) best = def;
    };
    // Check equipped weapon
    const weaponId = player.equipment.get('weapon' as EquipSlot);
    if (weaponId) check(weaponId);
    // Check inventory
    for (const slot of player.inventory) {
      if (slot) check(slot.itemId);
    }
    return best;
  }

  private isNearby(player: Player, worldX: number, worldZ: number): boolean {
    const cx = Math.floor(worldX / CHUNK_SIZE);
    const cz = Math.floor(worldZ / CHUNK_SIZE);
    return Math.abs(cx - player.currentChunkX) <= CHUNK_LOAD_RADIUS &&
           Math.abs(cz - player.currentChunkZ) <= CHUNK_LOAD_RADIUS;
  }

  /** Send an opcode to all players near a world position on a given map (zero-allocation) */
  private broadcastNearby(mapId: string, worldX: number, worldZ: number, opcode: ServerOpcode, ...values: number[]): void {
    const cm = this.chunkManagers.get(mapId);
    if (!cm) return;
    const packet = encodePacket(opcode, ...values);
    cm.forEachPlayerNear(worldX, worldZ, (pid) => {
      const p = this.players.get(pid);
      if (p) {
        try { p.ws.sendBinary(packet); } catch { /* connection closed */ }
      }
    });
  }

  /** Call fn for each player near a world position on a given map (zero-allocation) */
  private forEachPlayerNear(mapId: string, worldX: number, worldZ: number, fn: (p: Player) => void): void {
    const cm = this.chunkManagers.get(mapId);
    if (!cm) return;
    cm.forEachPlayerNear(worldX, worldZ, (pid) => {
      const p = this.players.get(pid);
      if (p) fn(p);
    });
  }

  private setCombatTarget(playerId: number, npcId: number): void {
    this.clearCombatTarget(playerId);
    this.playerCombatTargets.set(playerId, npcId);
    let set = this.npcTargetedBy.get(npcId);
    if (!set) { set = new Set(); this.npcTargetedBy.set(npcId, set); }
    set.add(playerId);
  }

  private clearCombatTarget(playerId: number): void {
    const oldNpc = this.playerCombatTargets.get(playerId);
    if (oldNpc !== undefined) {
      const set = this.npcTargetedBy.get(oldNpc);
      if (set) {
        set.delete(playerId);
        if (set.size === 0) this.npcTargetedBy.delete(oldNpc);
      }
      this.playerCombatTargets.delete(playerId);
    }
  }

  private blockedKeyFor(mapId: string, x: number, z: number): number {
    return blockedKey(getMapIdx(mapId), Math.floor(x), Math.floor(z));
  }

  handlePlayerMove(playerId: number, path: { x: number; z: number }[]): void {
    const player = this.players.get(playerId);
    if (!player) return;

    this.clearCombatTarget(playerId);
    player.attackTarget = null;
    player.pendingInteraction = null;
    this.cancelSkilling(playerId);

    const map = this.getPlayerMap(player);
    const validPath: { x: number; z: number }[] = [];
    let prevX = player.position.x;
    let prevZ = player.position.y;
    const mapId = player.currentMapLevel;
    for (const step of path) {
      const pFloor = player.currentFloor;
      const tileBlocked = pFloor === 0
        ? (map.isBlocked(step.x, step.z) || this.blockedObjectTiles.has(this.blockedKeyFor(mapId, step.x, step.z)))
        : map.isTileBlockedOnFloor(Math.floor(step.x), Math.floor(step.z), pFloor);
      const wallBlocked = pFloor === 0
        ? map.isWallBlocked(prevX, prevZ, step.x, step.z)
        : map.isWallBlockedOnFloor(prevX, prevZ, step.x, step.z, pFloor);
      if (!tileBlocked && !wallBlocked) {
        validPath.push(step);
        prevX = step.x;
        prevZ = step.z;
      } else {
        break;
      }
    }
    player.moveQueue = validPath;
  }

  handlePlayerAttackNpc(playerId: number, npcId: number): void {
    const player = this.players.get(playerId);
    const npc = this.npcs.get(npcId);
    if (!player || !npc || npc.dead) return;
    this.cancelSkilling(playerId);
    if (npc.currentMapLevel !== player.currentMapLevel) return;

    player.attackTarget = npc;
    this.setCombatTarget(playerId, npcId);

    const dx = npc.position.x - player.position.x;
    const dz = npc.position.y - player.position.y;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist > 1.5) {
      const map = this.getPlayerMap(player);
      const path = map.findPathOnFloor(player.position.x, player.position.y, npc.position.x, npc.position.y, player.currentFloor);
      if (path.length > 1) {
        player.moveQueue = path.slice(0, -1);
      } else {
        player.moveQueue = path;
      }
    } else {
      player.moveQueue = [];
    }
  }

  handlePlayerPickup(playerId: number, groundItemId: number): void {
    const player = this.players.get(playerId);
    const item = this.groundItems.get(groundItemId);
    if (!player || !item) return;
    if (item.mapLevel !== player.currentMapLevel) return;

    // Walk to item if not in range
    const dx = Math.abs(player.position.x - item.x);
    const dz = Math.abs(player.position.y - item.z);
    if (dx > 1.5 || dz > 1.5) {
      const map = this.getPlayerMap(player);
      const path = map.findPathOnFloor(player.position.x, player.position.y, item.x, item.z, player.currentFloor);
      if (path.length > 0) {
        player.moveQueue = path;
        player.pendingPickup = groundItemId;
      }
      return;
    }

    if (player.addItem(item.itemId, item.quantity)) {
      this.groundItems.delete(groundItemId);
      this.despawningItemIds.delete(groundItemId);
      const itemCm = this.chunkManagers.get(item.mapLevel);
      if (itemCm) itemCm.removeEntity(groundItemId);
      this.broadcastNearby(item.mapLevel, item.x, item.z, ServerOpcode.GROUND_ITEM_SYNC, groundItemId, 0, 0, 0, 0);
      this.sendInventory(player);
    }
  }

  handlePlayerDrop(playerId: number, slotIndex: number): void {
    const player = this.players.get(playerId);
    if (!player) return;

    const removed = player.removeItem(slotIndex);
    if (!removed) return;

    const groundItem: GroundItem = {
      id: nextGroundItemId++,
      itemId: removed.itemId,
      quantity: removed.quantity,
      x: player.position.x,
      z: player.position.y,
      mapLevel: player.currentMapLevel,
      despawnTimer: 200,
    };
    this.groundItems.set(groundItem.id, groundItem);
    this.despawningItemIds.add(groundItem.id);
    const dropCm = this.chunkManagers.get(groundItem.mapLevel);
    if (dropCm) dropCm.addEntity(groundItem.id, groundItem.x, groundItem.z);

    this.forEachPlayerNear(groundItem.mapLevel, groundItem.x, groundItem.z, p => this.sendGroundItemUpdate(p, groundItem));
    this.sendInventory(player);
  }

  handlePlayerInteractObject(playerId: number, objectEntityId: number, actionIndex: number): void {
    const player = this.players.get(playerId);
    const obj = this.worldObjects.get(objectEntityId);
    if (!player || !obj) return;
    if (obj.mapLevel !== player.currentMapLevel) return;
    if (obj.depleted) return;

    // Check distance — must be adjacent
    const dx = Math.abs(player.position.x - obj.x);
    const dz = Math.abs(player.position.y - obj.z);
    if (dx > 2.0 || dz > 2.0) {
      // Walk toward the object first
      const map = this.getPlayerMap(player);
      const path = map.findPathOnFloor(player.position.x, player.position.y, obj.x, obj.z, player.currentFloor);
      if (path.length > 1) {
        // Remove last step if it's on the object's tile
        const last = path[path.length - 1];
        if (Math.floor(last.x) === Math.floor(obj.x) && Math.floor(last.z) === Math.floor(obj.z)) {
          path.pop();
        }
      }
      player.moveQueue = path;
      player.pendingInteraction = { objectEntityId, actionIndex };
      return;
    }

    // Stop movement
    player.moveQueue = [];
    player.attackTarget = null;
    this.clearCombatTarget(playerId);

    const action = obj.def.actions[actionIndex];
    if (!action) return;

    if (action === 'Examine') {
      // Just send a chat message
      this.sendToPlayer(player, ServerOpcode.CHAT_SYSTEM, 0); // Will use chat socket instead
      return;
    }

    // Door open/close
    if (obj.def.category === 'door' && (action === 'Open' || action === 'Close')) {
      this.toggleDoor(obj);
      return;
    }

    // Harvesting actions (Chop, Mine, Fish)
    if (obj.def.skill && obj.def.harvestItemId) {
      const skillId = obj.def.skill as SkillId;
      const playerLevel = player.skills[skillId]?.level ?? 1;
      if (playerLevel < (obj.def.levelRequired ?? 1)) {
        // Send level requirement message via chat
        return;
      }

      // Tool check: forestry requires an axe, mining requires a pickaxe
      const requiredTool = obj.def.category === 'tree' ? 'axe' : obj.def.category === 'rock' ? 'pickaxe' : null;
      let toolItemId: number | undefined;
      let toolBonus = 0;
      if (requiredTool) {
        const bestTool = this.findBestTool(player, requiredTool, playerLevel);
        if (!bestTool) {
          // No suitable tool — notify via chat socket
          return;
        }
        toolItemId = bestTool.id;
        toolBonus = bestTool.toolBonus ?? 0;
      }

      // Probability-based harvesting (trees): fixed cycle, success rolled per attempt
      // Fixed harvesting (mining, fishing): toolBonus reduces cycle time
      const baseTime = obj.def.harvestTime ?? 4;
      const harvestTime = obj.def.successChances ? baseTime : Math.max(2, baseTime - toolBonus);

      // Start skilling action
      this.skillingActions.set(playerId, {
        objectId: obj.id,
        action,
        ticksLeft: harvestTime,
        toolItemId,
      });

      // Notify client of skilling start
      this.sendToPlayer(player, ServerOpcode.SKILLING_START, obj.id);
      return;
    }

    // Crafting station actions (Smelt, Cook)
    if (obj.def.recipes && obj.def.recipes.length > 0) {
      // Find first valid recipe in player's inventory
      for (const recipe of obj.def.recipes) {
        const skillId = recipe.skill as SkillId;
        const playerLevel = player.skills[skillId]?.level ?? 1;
        if (playerLevel < recipe.levelRequired) continue;

        // Check if player has the input item
        let inputSlot = -1;
        for (let i = 0; i < player.inventory.length; i++) {
          const slot = player.inventory[i];
          if (slot && slot.itemId === recipe.inputItemId && slot.quantity >= recipe.inputQuantity) {
            inputSlot = i;
            break;
          }
        }
        if (inputSlot < 0) continue;

        // Consume input, give output
        player.removeItem(inputSlot, recipe.inputQuantity);
        player.addItem(recipe.outputItemId, recipe.outputQuantity);

        // Award XP
        const result = addXp(player.skills, skillId, recipe.xpReward);
        const skillIdx = ALL_SKILLS.indexOf(skillId);
        if (skillIdx >= 0) {
          this.sendToPlayer(player, ServerOpcode.XP_GAIN, skillIdx, recipe.xpReward);
          if (result.leveled) {
            this.sendToPlayer(player, ServerOpcode.LEVEL_UP, skillIdx, result.newLevel);
          }
        }

        this.sendInventory(player);
        if (skillIdx >= 0) this.sendSingleSkill(player, skillIdx);
        return;
      }
      // No valid recipe found - player doesn't have required items/level
      return;
    }
  }

  handlePlayerEquip(playerId: number, slotIndex: number): void {
    const player = this.players.get(playerId);
    if (!player) return;

    const slot = player.inventory[slotIndex];
    if (!slot) return;

    const itemDef = this.data.getItem(slot.itemId);
    if (!itemDef || !itemDef.equippable || !itemDef.equipSlot) return;

    const equipSlot = itemDef.equipSlot as EquipSlot;

    const currentEquipped = player.equipment.get(equipSlot);
    if (currentEquipped !== undefined) {
      player.inventory[slotIndex] = { itemId: currentEquipped, quantity: 1 };
    } else {
      player.removeItem(slotIndex);
    }

    player.equipment.set(equipSlot, slot.itemId);

    this.sendInventory(player);
    this.sendEquipment(player);
  }

  handlePlayerUnequip(playerId: number, equipSlotIndex: number): void {
    const player = this.players.get(playerId);
    if (!player) return;

    const slotNames: EquipSlot[] = ['weapon', 'shield', 'head', 'body', 'legs', 'neck', 'ring', 'hands', 'feet', 'cape'];
    const slotName = slotNames[equipSlotIndex];
    if (!slotName) return;

    const itemId = player.equipment.get(slotName);
    if (itemId === undefined) return;

    if (player.addItem(itemId, 1)) {
      player.equipment.delete(slotName);
      this.sendInventory(player);
      this.sendEquipment(player);
    }
  }

  handlePlayerEat(playerId: number, slotIndex: number): void {
    const player = this.players.get(playerId);
    if (!player) return;

    const slot = player.inventory[slotIndex];
    if (!slot) return;

    const itemDef = this.data.getItem(slot.itemId);
    if (!itemDef || !itemDef.healAmount) return;

    if (player.health >= player.maxHealth) return;

    player.heal(itemDef.healAmount);
    player.skills.hitpoints.currentLevel = player.health;
    player.removeItem(slotIndex, 1);

    this.sendInventory(player);
    this.sendToPlayer(player, ServerOpcode.PLAYER_STATS,
      player.health, player.maxHealth
    );
  }

  handlePlayerSetStance(playerId: number, stanceIndex: number): void {
    const player = this.players.get(playerId);
    if (!player) return;

    const stances = ['accurate', 'aggressive', 'defensive', 'controlled'] as const;
    if (stanceIndex >= 0 && stanceIndex < stances.length) {
      player.stance = stances[stanceIndex];
    }
  }

  // Tick performance monitoring
  private tickOverrunCount: number = 0;
  private lastTickWarnTime: number = 0;

  private tick(): void {
    const tickStart = performance.now();
    this.currentTick++;

    // Process player movement + update chunk tracking + pending pickups
    for (const [playerId, player] of this.players) {
      player.processMovement();
      this.updateEntityChunk(player);
      // Check pending pickup after movement
      if (player.pendingPickup >= 0 && player.moveQueue.length === 0) {
        const pickupId = player.pendingPickup;
        player.pendingPickup = -1;
        this.handlePlayerPickup(playerId, pickupId);
      }
      // Check pending object interaction after movement
      if (player.pendingInteraction && player.moveQueue.length === 0) {
        const { objectEntityId, actionIndex } = player.pendingInteraction;
        player.pendingInteraction = null;
        this.handlePlayerInteractObject(playerId, objectEntityId, actionIndex);
      }
    }

    // Process NPC AI
    for (const [, npc] of this.npcs) {
      if (npc.dead) {
        if (npc.tickRespawn()) {
          // Respawned — notify nearby players
          this.forEachPlayerNear(npc.currentMapLevel, npc.position.x, npc.position.y, p => this.sendNpcUpdate(p, npc));
        }
        continue;
      }

      const map = this.getMap(npc.currentMapLevel);

      // Aggressive NPC targeting — use chunk manager to find nearby players (zero-allocation)
      if (npc.def.aggressive && !npc.combatTarget) {
        const cm = this.chunkManagers.get(npc.currentMapLevel);
        if (cm) {
          cm.forEachPlayerNear(npc.position.x, npc.position.y, (pid) => {
            if (npc.combatTarget) return; // already found a target
            const player = this.players.get(pid);
            if (!player) return;
            const dx = Math.abs(npc.position.x - player.position.x);
            const dz = Math.abs(npc.position.y - player.position.y);
            if (dx <= 5 && dz <= 5) {
              npc.combatTarget = player;
            }
          });
        }
      }

      npc.processAI(map.isBlockedCb, map.isWallBlockedCb);

      // Update NPC chunk position
      const cm = this.chunkManagers.get(npc.currentMapLevel);
      if (cm) cm.updateEntity(npc.id, npc.position.x, npc.position.y);
    }

    // Process combat — chase phase
    const itemDefs = this.data.itemDefs;

    for (const [playerId, npcId] of this.playerCombatTargets) {
      const player = this.players.get(playerId);
      const npc = this.npcs.get(npcId);
      if (!player || !npc || npc.dead || npc.currentMapLevel !== player.currentMapLevel) {
        this.clearCombatTarget(playerId);
        continue;
      }

      const map = this.getPlayerMap(player);

      player.position.x = Math.floor(player.position.x) + 0.5;
      player.position.y = Math.floor(player.position.y) + 0.5;
      const cdx = npc.position.x - player.position.x;
      const cdz = npc.position.y - player.position.y;
      const combatDist = Math.sqrt(cdx * cdx + cdz * cdz);
      if (combatDist > 1.5) {
        player.moveQueue = [];
        const sx = cdx !== 0 ? Math.sign(cdx) : 0;
        const sz = cdz !== 0 ? Math.sign(cdz) : 0;
        const nx = player.position.x + sx;
        const nz = player.position.y + sz;
        const npcTileX = Math.floor(npc.position.x);
        const npcTileZ = Math.floor(npc.position.y);
        const wouldOverlap = (px: number, pz: number) =>
          Math.floor(px) === npcTileX && Math.floor(pz) === npcTileZ;
        const px = player.position.x, py = player.position.y;
        if (sx !== 0 && sz !== 0 && !map.isBlocked(nx, nz) && !wouldOverlap(nx, nz) && !map.isWallBlocked(px, py, nx, nz)) {
          player.position.x = nx;
          player.position.y = nz;
        } else if (sx !== 0 && !map.isBlocked(px + sx, py) && !wouldOverlap(px + sx, py) && !map.isWallBlocked(px, py, px + sx, py)) {
          player.position.x += sx;
        } else if (sz !== 0 && !map.isBlocked(px, py + sz) && !wouldOverlap(px, py + sz) && !map.isWallBlocked(px, py, px, py + sz)) {
          player.position.y += sz;
        }
      }

      const result = processPlayerCombat(player, npc, itemDefs);
      if (result) {
        this.broadcastCombatHit(result.hit.attackerId, result.hit.targetId, result.hit.damage, result.hit.targetHealth, result.hit.targetMaxHealth, player.currentMapLevel, npc.position.x, npc.position.y);

        for (const xp of result.xpDrops) {
          const skillIdx = ALL_SKILLS.indexOf(xp.skill as SkillId);
          if (skillIdx >= 0) {
            this.sendToPlayer(player, ServerOpcode.XP_GAIN, skillIdx, xp.amount);
          }
        }

        for (const lu of result.levelUps) {
          const skillIdx = ALL_SKILLS.indexOf(lu.skill as SkillId);
          if (skillIdx >= 0) {
            this.sendToPlayer(player, ServerOpcode.LEVEL_UP, skillIdx, lu.level);
          }
        }

        for (const xp of result.xpDrops) {
          const skillIdx = ALL_SKILLS.indexOf(xp.skill as SkillId);
          if (skillIdx >= 0) this.sendSingleSkill(player, skillIdx);
        }

        if (!npc.alive) {
          npc.die();
          this.clearCombatTarget(playerId);

          // Notify nearby players of NPC death
          this.broadcastNearby(npc.currentMapLevel, npc.position.x, npc.position.y, ServerOpcode.ENTITY_DEATH, npc.id);

          // Drop loot
          const loot = rollLoot(npc);
          for (const drop of loot) {
            const groundItem: GroundItem = {
              id: nextGroundItemId++,
              itemId: drop.itemId,
              quantity: drop.quantity,
              x: npc.spawnX,
              z: npc.spawnZ,
              mapLevel: npc.currentMapLevel,
              despawnTimer: 200,
            };
            this.groundItems.set(groundItem.id, groundItem);
            this.despawningItemIds.add(groundItem.id);
            const lootCm = this.chunkManagers.get(groundItem.mapLevel);
            if (lootCm) lootCm.addEntity(groundItem.id, groundItem.x, groundItem.z);
            this.forEachPlayerNear(groundItem.mapLevel, groundItem.x, groundItem.z, p => this.sendGroundItemUpdate(p, groundItem));
          }
        }
      }
    }

    // Process NPC combat (NPCs attacking players)
    for (const [, npc] of this.npcs) {
      if (npc.dead || !npc.combatTarget) continue;
      const target = npc.combatTarget as Player;
      if (!target.alive || !this.players.has(target.id) || target.currentMapLevel !== npc.currentMapLevel) {
        npc.combatTarget = null;
        continue;
      }

      const hit = processNpcCombat(npc, target, itemDefs);
      if (hit) {
        this.broadcastCombatHit(hit.attackerId, hit.targetId, hit.damage, hit.targetHealth, hit.targetMaxHealth, npc.currentMapLevel, target.position.x, target.position.y);

        this.sendToPlayer(target, ServerOpcode.PLAYER_STATS,
          target.health, target.maxHealth
        );
        this.sendSingleSkill(target, HITPOINTS_SKILL_INDEX);

        if (!target.alive) {
          const map = this.getMap(target.currentMapLevel);
          const spawn = map.findSpawnPoint();
          target.health = target.maxHealth;
          target.skills.hitpoints.currentLevel = target.maxHealth;
          target.position.x = spawn.x;
          target.position.y = spawn.z;
          target.moveQueue = [];
          target.attackTarget = null;
          npc.combatTarget = null;
          this.clearCombatTarget(target.id);

          this.sendToPlayer(target, ServerOpcode.PLAYER_STATS,
            target.health, target.maxHealth
          );
          this.sendSkills(target);  // Full sync on respawn
        }
      }
    }

    // NPC health regeneration — use npcTargetedBy reverse map for O(1) combat check
    if (this.currentTick % 10 === 0) {
      for (const [, npc] of this.npcs) {
        if (npc.dead || npc.health >= npc.maxHealth) continue;
        if (npc.combatTarget) continue;
        if (this.npcTargetedBy.has(npc.id)) continue;
        npc.heal(1);
      }

      // Player health regeneration — only regen if not in combat (attacking or being attacked)
      // playersUnderNpcAttack is rebuilt only every 10 ticks (same frequency as regen)
      this._playersUnderNpcAttack.clear();
      for (const [, npc] of this.npcs) {
        if (!npc.dead && npc.combatTarget) {
          this._playersUnderNpcAttack.add((npc.combatTarget as Player).id);
        }
      }
      for (const [playerId, player] of this.players) {
        if (!player.alive || player.health >= player.maxHealth) continue;
        if (this.playerCombatTargets.has(playerId)) continue;
        if (this._playersUnderNpcAttack.has(playerId)) continue;
        player.heal(1);
        player.skills.hitpoints.currentLevel = player.health;
        this.sendToPlayer(player, ServerOpcode.PLAYER_STATS, player.health, player.maxHealth);
        this.sendSingleSkill(player, HITPOINTS_SKILL_INDEX);
      }
    }

    // Process skilling actions
    for (const [playerId, action] of this.skillingActions) {
      const player = this.players.get(playerId);
      if (!player) {
        this.skillingActions.delete(playerId);
        continue;
      }

      const obj = this.worldObjects.get(action.objectId);
      if (!obj || obj.depleted || obj.mapLevel !== player.currentMapLevel) {
        this.skillingActions.delete(playerId);
        this.sendToPlayer(player, ServerOpcode.SKILLING_STOP, 0);
        continue;
      }

      // Check still adjacent
      const sdx = Math.abs(player.position.x - obj.x);
      const sdz = Math.abs(player.position.y - obj.z);
      if (sdx > 2.0 || sdz > 2.0) {
        this.skillingActions.delete(playerId);
        this.sendToPlayer(player, ServerOpcode.SKILLING_STOP, 0);
        continue;
      }

      action.ticksLeft--;
      if (action.ticksLeft <= 0) {
        const skillId = obj.def.skill as SkillId;
        const cycleTime = obj.def.harvestTime ?? 4;

        // Probability-based harvesting: roll success per cycle
        if (obj.def.successChances) {
          const chances = action.toolItemId != null ? obj.def.successChances[String(action.toolItemId)] : null;
          if (!chances) {
            // No valid axe for this tree — shouldn't happen, but stop gracefully
            this.skillingActions.delete(playerId);
            this.sendToPlayer(player, ServerOpcode.SKILLING_STOP, 0);
            continue;
          }
          const playerLevel = player.skills[skillId]?.level ?? 1;
          if (!statRandom(playerLevel, chances[0], chances[1])) {
            // Failed roll — reset cycle and try again
            action.ticksLeft = cycleTime;
            continue;
          }
        }

        // Success! Give item and XP
        const itemId = obj.def.harvestItemId!;
        const qty = obj.def.harvestQuantity ?? 1;
        const xpReward = obj.def.xpReward ?? 0;

        if (player.addItem(itemId, qty)) {
          // Award XP
          if (xpReward > 0) {
            const result = addXp(player.skills, skillId, xpReward);
            const skillIdx = ALL_SKILLS.indexOf(skillId);
            if (skillIdx >= 0) {
              this.sendToPlayer(player, ServerOpcode.XP_GAIN, skillIdx, xpReward);
              if (result.leveled) {
                this.sendToPlayer(player, ServerOpcode.LEVEL_UP, skillIdx, result.newLevel);
              }
            }
          }

          this.sendInventory(player);
          const harvestSkillIdx = ALL_SKILLS.indexOf(skillId);
          if (harvestSkillIdx >= 0) this.sendSingleSkill(player, harvestSkillIdx);

          // Roll depletion
          if (obj.def.depletionChance && Math.random() < obj.def.depletionChance) {
            obj.deplete();
            this.depletedObjectIds.add(obj.id);
            if (obj.def.blocking) {
              this.blockedObjectTiles.delete(this.blockedKeyFor(obj.mapLevel, obj.x, obj.z));
            }
            this.broadcastNearby(obj.mapLevel, obj.x, obj.z, ServerOpcode.WORLD_OBJECT_DEPLETED, obj.id, 1);
            this.skillingActions.delete(playerId);
            this.sendToPlayer(player, ServerOpcode.SKILLING_STOP, 0);
          } else {
            // Reset cycle for next harvest attempt
            action.ticksLeft = cycleTime;
          }
        } else {
          // Inventory full
          this.skillingActions.delete(playerId);
          this.sendToPlayer(player, ServerOpcode.SKILLING_STOP, 0);
        }
      }
    }

    // Tick world object respawns — only iterate depleted objects
    for (const objId of this.depletedObjectIds) {
      const obj = this.worldObjects.get(objId);
      if (!obj) { this.depletedObjectIds.delete(objId); continue; }
      if (obj.tickRespawn()) {
        this.depletedObjectIds.delete(objId);
        if (obj.def.blocking) {
          this.blockedObjectTiles.add(this.blockedKeyFor(obj.mapLevel, obj.x, obj.z));
        }
        // Door auto-close: restore wall collision and action text
        if (obj.def.category === 'door') {
          const map = this.maps.get(obj.mapLevel);
          if (map) {
            const tx = Math.floor(obj.x), tz = Math.floor(obj.z);
            const degRaw = Math.round((obj.rotationY * 180 / Math.PI) % 360 + 360) % 360;
            const edgeMask = (degRaw === 0 || degRaw === 180) ? (WallEdge.N | WallEdge.S) : (WallEdge.E | WallEdge.W);
            map.setWall(tx, tz, map.getWall(tx, tz) | edgeMask);
          }
          obj.def = { ...obj.def, actions: ['Open', 'Examine'] };
        }
        // Respawned — notify nearby players
        this.broadcastNearby(obj.mapLevel, obj.x, obj.z, ServerOpcode.WORLD_OBJECT_DEPLETED, obj.id, 0);
      }
    }

    // Despawn ground items — only iterate items with active timers
    for (const id of this.despawningItemIds) {
      const item = this.groundItems.get(id);
      if (!item) { this.despawningItemIds.delete(id); continue; }
      item.despawnTimer--;
      if (item.despawnTimer <= 0) {
        this.despawningItemIds.delete(id);
        this.groundItems.delete(id);
        const despawnCm = this.chunkManagers.get(item.mapLevel);
        if (despawnCm) despawnCm.removeEntity(id);
        this.broadcastNearby(item.mapLevel, item.x, item.z, ServerOpcode.GROUND_ITEM_SYNC, id, 0, 0, 0, 0);
      }
    }

    // Check transitions
    for (const [, player] of this.players) {
      const map = this.getPlayerMap(player);
      const transition = map.getTransitionAt(player.position.x, player.position.y);
      if (transition) {
        this.handleMapTransition(player, transition);
        continue;
      }

      // Check stair floor transitions
      const tx = Math.floor(player.position.x);
      const tz = Math.floor(player.position.y);
      const oldFloor = player.currentFloor;
      const stair = map.getStairOnFloor(tx, tz, player.currentFloor);
      if (stair) {
        // Check if there's a corresponding stair on the floor above
        const upperStair = map.getStairOnFloor(tx, tz, player.currentFloor + 1);
        if (upperStair) {
          player.currentFloor += 1;
        }
      } else if (player.currentFloor > 0) {
        // Check if standing on a stair from the floor below (descend)
        const lowerStair = map.getStairOnFloor(tx, tz, player.currentFloor - 1);
        if (lowerStair) {
          player.currentFloor -= 1;
        }
      }
      if (player.currentFloor !== oldFloor) {
        this.sendToPlayer(player, ServerOpcode.FLOOR_CHANGE, player.currentFloor);
      }
    }

    // Broadcast positions (chunk-filtered)
    this.broadcastSync();

    // Tick performance monitoring
    const tickDuration = performance.now() - tickStart;
    if (tickDuration > TICK_RATE * 0.8) {
      this.tickOverrunCount++;
      const now = Date.now();
      // Log at most once every 10 seconds to avoid spam
      if (now - this.lastTickWarnTime > 10_000) {
        this.lastTickWarnTime = now;
        console.warn(`[perf] Tick ${this.currentTick} took ${tickDuration.toFixed(1)}ms (budget: ${TICK_RATE}ms), ` +
          `${this.tickOverrunCount} slow ticks, ${this.players.size} players, ${this.npcs.size} NPCs`);
        this.tickOverrunCount = 0;
      }
    }
  }

  private handleMapTransition(player: Player, transition: { targetMap: string; targetX: number; targetZ: number }): void {
    const oldMap = player.currentMapLevel;
    const newMap = transition.targetMap;

    if (!this.maps.has(newMap)) return;

    // Save player state
    this.db.savePlayerState(player.accountId, player);

    // Get nearby entities before removing from chunk manager (for cleanup)
    const oldCm = this.chunkManagers.get(oldMap);
    let oldNearbyIds: Set<number> | undefined;
    if (oldCm) {
      oldNearbyIds = oldCm.getEntitiesNear(player.position.x, player.position.y);
      oldCm.removeEntity(player.id);
    }

    // Send ENTITY_DEATH for all entities the player was seeing (clean slate)
    if (oldNearbyIds) {
      for (const eid of oldNearbyIds) {
        if (eid === player.id) continue;
        this.sendToPlayer(player, ServerOpcode.ENTITY_DEATH, eid);
        // Also tell the other player this player disappeared
        const other = this.players.get(eid);
        if (other) {
          this.sendToPlayer(other, ServerOpcode.ENTITY_DEATH, player.id);
        }
      }
    }

    // Update player state
    player.currentMapLevel = newMap;
    player.position.x = transition.targetX;
    player.position.y = transition.targetZ;
    player.moveQueue = [];
    player.attackTarget = null;
    this.clearCombatTarget(player.id);

    // Update chunk position
    player.currentChunkX = Math.floor(player.position.x / CHUNK_SIZE);
    player.currentChunkZ = Math.floor(player.position.y / CHUNK_SIZE);

    // Add to new map's chunk manager
    const newCm = this.chunkManagers.get(newMap);
    if (newCm) {
      newCm.addEntity(player.id, player.position.x, player.position.y);
      newCm.registerPlayer(player.id);
    }

    // Send MAP_CHANGE packet
    this.sendMapChange(player, newMap);

    // Send nearby entities on new map using chunk manager (all entity types registered)
    if (newCm) {
      const nearbyIds = newCm.getEntitiesNear(player.position.x, player.position.y);
      for (const eid of nearbyIds) {
        if (eid === player.id) continue;
        const other = this.players.get(eid);
        if (other) {
          this.sendPlayerUpdate(player, other);
          this.sendPlayerUpdate(other, player);
          continue;
        }
        const npc = this.npcs.get(eid);
        if (npc && !npc.dead) { this.sendNpcUpdate(player, npc); continue; }
        const obj = this.worldObjects.get(eid);
        if (obj) { this.sendWorldObjectUpdate(player, obj); continue; }
        const item = this.groundItems.get(eid);
        if (item) { this.sendGroundItemUpdate(player, item); continue; }
      }
    }

    console.log(`Player "${player.name}" transitioned from ${oldMap} to ${newMap}`);
  }

  private updateEntityChunk(player: Player): void {
    const newCX = Math.floor(player.position.x / CHUNK_SIZE);
    const newCZ = Math.floor(player.position.y / CHUNK_SIZE);

    if (newCX !== player.currentChunkX || newCZ !== player.currentChunkZ) {
      player.currentChunkX = newCX;
      player.currentChunkZ = newCZ;

      const cm = this.chunkManagers.get(player.currentMapLevel);
      if (cm) cm.updateEntity(player.id, player.position.x, player.position.y);
    }
  }

  private broadcastSync(): void {
    // Phase 1: Mark dirty entities (position or health changed since last sync)
    // Use rounded coords to match what we actually send (x*10 truncated to int)
    for (const [, player] of this.players) {
      const sx = Math.round(player.position.x * 10);
      const sz = Math.round(player.position.y * 10);
      if (sx !== player.lastSyncX || sz !== player.lastSyncZ || player.health !== player.lastSyncHealth) {
        player.lastSyncX = sx;
        player.lastSyncZ = sz;
        player.lastSyncHealth = player.health;
        player.syncDirty = true;
      }
    }
    for (const [, npc] of this.npcs) {
      if (npc.dead) continue;
      const sx = Math.round(npc.position.x * 10);
      const sz = Math.round(npc.position.y * 10);
      if (sx !== npc.lastSyncX || sz !== npc.lastSyncZ || npc.health !== npc.lastSyncHealth) {
        npc.lastSyncX = sx;
        npc.lastSyncZ = sz;
        npc.lastSyncHealth = npc.health;
        npc.syncDirty = true;
      }
    }

    // Phase 2a: Dirty players → push updates to nearby viewers (O(dirty_players × viewers_per_area))
    for (const [, subject] of this.players) {
      if (!subject.syncDirty) continue;
      const cm = this.chunkManagers.get(subject.currentMapLevel);
      if (!cm) continue;
      const packet = encodePacket(ServerOpcode.PLAYER_SYNC,
        subject.id,
        Math.round(subject.position.x * 10),
        Math.round(subject.position.y * 10),
        subject.health,
        subject.maxHealth
      );
      cm.forEachPlayerNearChunk(subject.currentChunkX, subject.currentChunkZ, (viewerId) => {
        const viewer = this.players.get(viewerId);
        if (viewer) {
          try { viewer.ws.sendBinary(packet); } catch { /* closed */ }
        }
      });
    }

    // Phase 2b: Dirty NPCs → push updates to nearby viewers (O(dirty_npcs × viewers_per_area))
    for (const [, npc] of this.npcs) {
      if (!npc.syncDirty || npc.dead) continue;
      const cm = this.chunkManagers.get(npc.currentMapLevel);
      if (!cm) continue;
      const packet = encodePacket(ServerOpcode.NPC_SYNC,
        npc.id,
        npc.npcId,
        Math.round(npc.position.x * 10),
        Math.round(npc.position.y * 10),
        npc.health,
        npc.maxHealth
      );
      const ncx = Math.floor(npc.position.x / CHUNK_SIZE);
      const ncz = Math.floor(npc.position.y / CHUNK_SIZE);
      cm.forEachPlayerNearChunk(ncx, ncz, (viewerId) => {
        const viewer = this.players.get(viewerId);
        if (viewer) {
          try { viewer.ws.sendBinary(packet); } catch { /* closed */ }
        }
      });
    }

    // Phase 2c: Viewers who changed chunks get a full sync of non-dirty nearby entities
    // (Dirty ones were already sent in 2a/2b)
    for (const [, viewer] of this.players) {
      const chunkChanged = viewer.currentChunkX !== viewer.lastBroadcastChunkX ||
                            viewer.currentChunkZ !== viewer.lastBroadcastChunkZ;
      if (!chunkChanged) continue;
      viewer.lastBroadcastChunkX = viewer.currentChunkX;
      viewer.lastBroadcastChunkZ = viewer.currentChunkZ;

      const cm = this.chunkManagers.get(viewer.currentMapLevel);
      if (!cm) continue;

      cm.forEachEntityNearChunk(viewer.currentChunkX, viewer.currentChunkZ, (eid) => {
        if (eid === viewer.id) return;
        const subject = this.players.get(eid);
        if (subject) {
          if (!subject.syncDirty) this.sendPlayerUpdate(viewer, subject);
          return;
        }
        const npc = this.npcs.get(eid);
        if (npc && !npc.dead && !npc.syncDirty) {
          this.sendNpcUpdate(viewer, npc);
        }
      });
    }

    // Phase 3: Clear dirty flags
    for (const [, player] of this.players) player.syncDirty = false;
    for (const [, npc] of this.npcs) npc.syncDirty = false;
  }

  private broadcastCombatHit(attackerId: number, targetId: number, damage: number, targetHp: number, targetMaxHp: number, mapLevel: string, worldX: number, worldZ: number): void {
    this.broadcastNearby(mapLevel, worldX, worldZ, ServerOpcode.COMBAT_HIT, attackerId, targetId, damage, targetHp, targetMaxHp);
  }

  private sendMapChange(player: Player, mapId: string): void {
    const packet = encodeStringPacket(
      ServerOpcode.MAP_CHANGE,
      mapId,
      Math.round(player.position.x * 10),
      Math.round(player.position.y * 10)
    );
    try {
      player.ws.sendBinary(packet);
    } catch { /* connection closed */ }
  }

  private sendPlayerUpdate(viewer: Player, subject: Player): void {
    this.sendToPlayer(viewer, ServerOpcode.PLAYER_SYNC,
      subject.id,
      Math.round(subject.position.x * 10),
      Math.round(subject.position.y * 10),
      subject.health,
      subject.maxHealth
    );
  }

  private sendNpcUpdate(viewer: Player, npc: Npc): void {
    this.sendToPlayer(viewer, ServerOpcode.NPC_SYNC,
      npc.id,
      npc.npcId,
      Math.round(npc.position.x * 10),
      Math.round(npc.position.y * 10),
      npc.health,
      npc.maxHealth
    );
  }

  private sendWorldObjectUpdate(viewer: Player, obj: WorldObject): void {
    // [objectEntityId, objectDefId, x*10, z*10, depleted(0/1)]
    this.sendToPlayer(viewer, ServerOpcode.WORLD_OBJECT_SYNC,
      obj.id,
      obj.defId,
      Math.round(obj.x * 10),
      Math.round(obj.z * 10),
      obj.depleted ? 1 : 0
    );
  }

  private sendGroundItemUpdate(viewer: Player, item: GroundItem): void {
    this.sendToPlayer(viewer, ServerOpcode.GROUND_ITEM_SYNC,
      item.id,
      item.itemId,
      item.quantity,
      Math.round(item.x * 10),
      Math.round(item.z * 10)
    );
  }

  sendInventory(player: Player): void {
    // Batch: [slot0_itemId, slot0_qty, slot1_itemId, slot1_qty, ...] — 1 packet instead of 28
    const values: number[] = [];
    for (let i = 0; i < player.inventory.length; i++) {
      const slot = player.inventory[i];
      values.push(slot ? slot.itemId : 0, slot ? slot.quantity : 0);
    }
    this.sendToPlayer(player, ServerOpcode.PLAYER_INVENTORY_BATCH, ...values);
  }

  sendSkills(player: Player): void {
    // Batch: [skill0_level, skill0_currentLevel, skill0_xpHigh, skill0_xpLow, ...] — 1 packet instead of 13
    const values: number[] = [];
    for (let i = 0; i < ALL_SKILLS.length; i++) {
      const skill = player.skills[ALL_SKILLS[i]];
      values.push(skill.level, skill.currentLevel, (skill.xp >> 16) & 0xFFFF, skill.xp & 0xFFFF);
    }
    this.sendToPlayer(player, ServerOpcode.PLAYER_SKILLS_BATCH, ...values);
  }

  /** Send a single skill update (used for XP gains during gameplay) */
  private sendSingleSkill(player: Player, skillIndex: number): void {
    const skill = player.skills[ALL_SKILLS[skillIndex]];
    const xpHigh = (skill.xp >> 16) & 0xFFFF;
    const xpLow = skill.xp & 0xFFFF;
    this.sendToPlayer(player, ServerOpcode.PLAYER_SKILLS,
      skillIndex, skill.level, skill.currentLevel, xpHigh, xpLow
    );
  }

  sendEquipment(player: Player): void {
    // Batch: [slot0_itemId, slot1_itemId, ...] — 1 packet instead of 10
    const slotNames: EquipSlot[] = ['weapon', 'shield', 'head', 'body', 'legs', 'neck', 'ring', 'hands', 'feet', 'cape'];
    const values: number[] = [];
    for (let i = 0; i < slotNames.length; i++) {
      values.push(player.equipment.get(slotNames[i]) ?? 0);
    }
    this.sendToPlayer(player, ServerOpcode.PLAYER_EQUIPMENT_BATCH, ...values);
  }

  private sendToPlayer(player: Player, opcode: ServerOpcode, ...values: number[]): void {
    try {
      player.ws.sendBinary(encodePacket(opcode, ...values));
    } catch { /* connection closed */ }
  }

  getPlayer(id: number): Player | undefined {
    return this.players.get(id);
  }

  /** Convenience: get the 'overworld' map (used by legacy callers) */
  get map(): GameMap {
    return this.getMap('kcmap');
  }
}
