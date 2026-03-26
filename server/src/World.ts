import { TICK_RATE, CHUNK_SIZE, CHUNK_LOAD_RADIUS, ServerOpcode, ALL_SKILLS, type SkillId, type ItemDef } from '@projectrs/shared';
import { encodePacket, encodeStringPacket } from '@projectrs/shared';
import { addXp, levelFromXp } from '@projectrs/shared';
import { GameMap } from './GameMap';
import { Player, type EquipSlot } from './entity/Player';
import { Npc } from './entity/Npc';
import { WorldObject } from './entity/WorldObject';
import { DataLoader } from './data/DataLoader';
import { GameDatabase } from './Database';
import { processPlayerCombat, processNpcCombat, rollLoot } from './combat/Combat';
import { broadcastPlayerInfo } from './network/ChatSocket';
import { ServerChunkManager } from './ChunkManager';

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
  /** Tiles blocked by non-depleted world objects, keyed by `mapId:tileX,tileZ` */
  private blockedObjectTiles: Set<string> = new Set();

  private currentTick: number = 0;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private saveTimer: ReturnType<typeof setInterval> | null = null;

  // Player combat targets (playerId -> npcId)
  private playerCombatTargets: Map<number, number> = new Map();

  // Skilling: player -> { objectId, action, ticksLeft }
  private skillingActions: Map<number, { objectId: number; action: string; ticksLeft: number }> = new Map();

  constructor(db: GameDatabase) {
    this.db = db;
    this.data = new DataLoader();

    // Load all maps
    this.loadMap('overworld');
    this.loadMap('underground');

    // Spawn NPCs and objects from data files
    this.spawnNpcs();
    this.spawnWorldObjects();
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
    // Recreate chunk manager but preserve entity registrations
    this.chunkManagers.set(mapId, new ServerChunkManager(gameMap.width, gameMap.height));
    // Re-register entities that are on this map
    for (const [id, player] of this.players) {
      if (player.currentMapLevel === mapId) {
        this.chunkManagers.get(mapId)!.addEntity(id, player.position.x, player.position.y);
      }
    }
    for (const [id, npc] of this.npcs) {
      if (npc.currentMapLevel === mapId) {
        this.chunkManagers.get(mapId)!.addEntity(id, npc.position.x, npc.position.y);
      }
    }
    for (const [id, obj] of this.worldObjects) {
      if (obj.currentMapLevel === mapId) {
        this.chunkManagers.get(mapId)!.addEntity(id, obj.position.x, obj.position.y);
      }
    }
    console.log(`Map '${mapId}' reloaded: ${gameMap.width}x${gameMap.height}`);
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
        const npc = new Npc(npcDef, spawn.x, spawn.z);
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
      if (!spawns.objects) continue;
      for (const spawn of spawns.objects) {
        const objDef = this.data.getObject(spawn.objectId);
        if (!objDef) {
          console.warn(`Unknown object id ${spawn.objectId} in ${mapId}/spawns.json`);
          continue;
        }
        const obj = new WorldObject(objDef, spawn.x, spawn.z, mapId);
        this.worldObjects.set(obj.id, obj);
        if (objDef.blocking) {
          this.blockedObjectTiles.add(`${mapId}:${Math.floor(spawn.x)},${Math.floor(spawn.z)}`);
        }
      }
      console.log(`Spawned objects for map '${mapId}'`);
    }
    console.log(`Total world objects: ${this.worldObjects.size}`);
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
    player.currentChunkX = Math.floor(player.position.x / CHUNK_SIZE);
    player.currentChunkZ = Math.floor(player.position.y / CHUNK_SIZE);

    // Send login confirmation
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

    // Send nearby existing players
    for (const [, other] of this.players) {
      if (other.id !== player.id && other.currentMapLevel === player.currentMapLevel) {
        if (this.isNearby(player, other.position.x, other.position.y)) {
          this.sendPlayerUpdate(player, other);
        }
        if (this.isNearby(other, player.position.x, player.position.y)) {
          this.sendPlayerUpdate(other, player);
        }
      }
    }

    // Send nearby NPCs
    for (const [, npc] of this.npcs) {
      if (!npc.dead && npc.currentMapLevel === player.currentMapLevel &&
          this.isNearby(player, npc.position.x, npc.position.y)) {
        this.sendNpcUpdate(player, npc);
      }
    }

    // Send nearby ground items
    for (const [, item] of this.groundItems) {
      if (item.mapLevel === player.currentMapLevel &&
          this.isNearby(player, item.x, item.z)) {
        this.sendGroundItemUpdate(player, item);
      }
    }

    // Send nearby world objects
    for (const [, obj] of this.worldObjects) {
      if (obj.mapLevel === player.currentMapLevel &&
          this.isNearby(player, obj.x, obj.z)) {
        this.sendWorldObjectUpdate(player, obj);
      }
    }

    // Send full skills
    this.sendSkills(player);
    this.sendInventory(player);
    this.sendEquipment(player);
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
    this.playerCombatTargets.delete(playerId);
    this.skillingActions.delete(playerId);
    console.log(`Player "${player.name}" left`);

    // Notify nearby players
    for (const [, other] of this.players) {
      if (other.currentMapLevel === player.currentMapLevel &&
          this.isNearby(other, player.position.x, player.position.y)) {
        this.sendToPlayer(other, ServerOpcode.ENTITY_DEATH, playerId);
      }
    }
  }

  /** Check if a world position is within chunk load radius of a player */
  private isNearby(player: Player, worldX: number, worldZ: number): boolean {
    const cx = Math.floor(worldX / CHUNK_SIZE);
    const cz = Math.floor(worldZ / CHUNK_SIZE);
    return Math.abs(cx - player.currentChunkX) <= CHUNK_LOAD_RADIUS &&
           Math.abs(cz - player.currentChunkZ) <= CHUNK_LOAD_RADIUS;
  }

  handlePlayerMove(playerId: number, path: { x: number; z: number }[]): void {
    const player = this.players.get(playerId);
    if (!player) return;

    this.playerCombatTargets.delete(playerId);
    player.attackTarget = null;
    this.cancelSkilling(playerId);

    const map = this.getPlayerMap(player);
    const validPath: { x: number; z: number }[] = [];
    let prevX = player.position.x;
    let prevZ = player.position.y;
    const mapId = player.currentMapLevel;
    for (const step of path) {
      const pFloor = player.currentFloor;
      const tileBlocked = pFloor === 0
        ? (map.isBlocked(step.x, step.z) || this.blockedObjectTiles.has(`${mapId}:${Math.floor(step.x)},${Math.floor(step.z)}`))
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
    this.playerCombatTargets.set(playerId, npcId);

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

    const dx = Math.abs(player.position.x - item.x);
    const dz = Math.abs(player.position.y - item.z);
    if (dx > 1.5 || dz > 1.5) return;

    if (player.addItem(item.itemId, item.quantity)) {
      this.groundItems.delete(groundItemId);
      // Notify nearby players
      for (const [, p] of this.players) {
        if (p.currentMapLevel === item.mapLevel && this.isNearby(p, item.x, item.z)) {
          this.sendToPlayer(p, ServerOpcode.GROUND_ITEM_SYNC, groundItemId, 0, 0, 0, 0);
        }
      }
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

    for (const [, p] of this.players) {
      if (p.currentMapLevel === groundItem.mapLevel && this.isNearby(p, groundItem.x, groundItem.z)) {
        this.sendGroundItemUpdate(p, groundItem);
      }
    }
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
      // Queue the interaction for when player arrives
      return;
    }

    // Stop movement
    player.moveQueue = [];
    player.attackTarget = null;
    this.playerCombatTargets.delete(playerId);

    const action = obj.def.actions[actionIndex];
    if (!action) return;

    if (action === 'Examine') {
      // Just send a chat message
      this.sendToPlayer(player, ServerOpcode.CHAT_SYSTEM, 0); // Will use chat socket instead
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

      // Start skilling action
      this.skillingActions.set(playerId, {
        objectId: obj.id,
        action,
        ticksLeft: obj.def.harvestTime ?? 4,
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
        this.sendSkills(player);
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

  private tick(): void {
    this.currentTick++;

    // Process player movement + update chunk tracking
    for (const [, player] of this.players) {
      player.processMovement();
      this.updateEntityChunk(player);
    }

    // Process NPC AI
    for (const [, npc] of this.npcs) {
      if (npc.dead) {
        if (npc.tickRespawn()) {
          // Respawned — notify nearby players
          for (const [, p] of this.players) {
            if (p.currentMapLevel === npc.currentMapLevel && this.isNearby(p, npc.position.x, npc.position.y)) {
              this.sendNpcUpdate(p, npc);
            }
          }
        }
        continue;
      }

      const map = this.getMap(npc.currentMapLevel);

      // Aggressive NPC targeting
      if (npc.def.aggressive && !npc.combatTarget) {
        for (const [, player] of this.players) {
          if (player.currentMapLevel !== npc.currentMapLevel) continue;
          const dx = Math.abs(npc.position.x - player.position.x);
          const dz = Math.abs(npc.position.y - player.position.y);
          if (dx <= 5 && dz <= 5) {
            npc.combatTarget = player;
            break;
          }
        }
      }

      npc.processAI(
        (x, z) => map.isBlocked(x, z),
        (fx, fz, tx, tz) => map.isWallBlocked(fx, fz, tx, tz)
      );

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
        this.playerCombatTargets.delete(playerId);
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

        if (result.xpDrops.length > 0) {
          this.sendSkills(player);
        }

        if (!npc.alive) {
          npc.die();
          this.playerCombatTargets.delete(playerId);

          // Notify nearby players of NPC death
          for (const [, p] of this.players) {
            if (p.currentMapLevel === npc.currentMapLevel && this.isNearby(p, npc.position.x, npc.position.y)) {
              this.sendToPlayer(p, ServerOpcode.ENTITY_DEATH, npc.id);
            }
          }

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
            for (const [, p] of this.players) {
              if (p.currentMapLevel === groundItem.mapLevel && this.isNearby(p, groundItem.x, groundItem.z)) {
                this.sendGroundItemUpdate(p, groundItem);
              }
            }
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
        this.sendSkills(target);

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
          this.playerCombatTargets.delete(target.id);

          this.sendToPlayer(target, ServerOpcode.PLAYER_STATS,
            target.health, target.maxHealth
          );
          this.sendSkills(target);
        }
      }
    }

    // NPC health regeneration
    if (this.currentTick % 10 === 0) {
      for (const [, npc] of this.npcs) {
        if (npc.dead || npc.health >= npc.maxHealth) continue;
        if (npc.combatTarget) continue;
        let inCombat = false;
        for (const [, npcId] of this.playerCombatTargets) {
          if (npcId === npc.id) { inCombat = true; break; }
        }
        if (inCombat) continue;
        npc.heal(1);
      }

      // Player health regeneration
      for (const [playerId, player] of this.players) {
        if (!player.alive || player.health >= player.maxHealth) continue;
        if (this.playerCombatTargets.has(playerId)) continue;
        let inCombat = false;
        for (const [, npc] of this.npcs) {
          if (npc.combatTarget === player) { inCombat = true; break; }
        }
        if (inCombat) continue;
        player.heal(1);
        player.skills.hitpoints.currentLevel = player.health;
        this.sendToPlayer(player, ServerOpcode.PLAYER_STATS, player.health, player.maxHealth);
        this.sendSkills(player);
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
        // Success! Give item and XP
        const skillId = obj.def.skill as SkillId;
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
          this.sendSkills(player);

          // Roll depletion
          if (obj.def.depletionChance && Math.random() < obj.def.depletionChance) {
            obj.deplete();
            if (obj.def.blocking) {
              this.blockedObjectTiles.delete(`${obj.mapLevel}:${Math.floor(obj.x)},${Math.floor(obj.z)}`);
            }
            // Notify all nearby players
            for (const [, p] of this.players) {
              if (p.currentMapLevel === obj.mapLevel && this.isNearby(p, obj.x, obj.z)) {
                this.sendToPlayer(p, ServerOpcode.WORLD_OBJECT_DEPLETED, obj.id, 1);
              }
            }
            this.skillingActions.delete(playerId);
            this.sendToPlayer(player, ServerOpcode.SKILLING_STOP, 0);
          } else {
            // Reset timer for next harvest
            action.ticksLeft = obj.def.harvestTime ?? 4;
          }
        } else {
          // Inventory full
          this.skillingActions.delete(playerId);
          this.sendToPlayer(player, ServerOpcode.SKILLING_STOP, 0);
        }
      }
    }

    // Tick world object respawns
    for (const [, obj] of this.worldObjects) {
      if (obj.tickRespawn()) {
        if (obj.def.blocking) {
          this.blockedObjectTiles.add(`${obj.mapLevel}:${Math.floor(obj.x)},${Math.floor(obj.z)}`);
        }
        // Respawned — notify nearby players
        for (const [, p] of this.players) {
          if (p.currentMapLevel === obj.mapLevel && this.isNearby(p, obj.x, obj.z)) {
            this.sendToPlayer(p, ServerOpcode.WORLD_OBJECT_DEPLETED, obj.id, 0);
          }
        }
      }
    }

    // Despawn ground items
    for (const [id, item] of this.groundItems) {
      item.despawnTimer--;
      if (item.despawnTimer <= 0) {
        this.groundItems.delete(id);
        for (const [, p] of this.players) {
          if (p.currentMapLevel === item.mapLevel && this.isNearby(p, item.x, item.z)) {
            this.sendToPlayer(p, ServerOpcode.GROUND_ITEM_SYNC, id, 0, 0, 0, 0);
          }
        }
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
  }

  private handleMapTransition(player: Player, transition: { targetMap: string; targetX: number; targetZ: number }): void {
    const oldMap = player.currentMapLevel;
    const newMap = transition.targetMap;

    if (!this.maps.has(newMap)) return;

    // Save player state
    this.db.savePlayerState(player.accountId, player);

    // Remove from old map's chunk manager
    const oldCm = this.chunkManagers.get(oldMap);
    if (oldCm) oldCm.removeEntity(player.id);

    // Send ENTITY_DEATH for all entities the player was seeing (clean slate)
    for (const [, other] of this.players) {
      if (other.id !== player.id && other.currentMapLevel === oldMap) {
        this.sendToPlayer(player, ServerOpcode.ENTITY_DEATH, other.id);
        // Also tell the other player this player disappeared
        if (this.isNearby(other, player.position.x, player.position.y)) {
          this.sendToPlayer(other, ServerOpcode.ENTITY_DEATH, player.id);
        }
      }
    }
    for (const [, npc] of this.npcs) {
      if (!npc.dead && npc.currentMapLevel === oldMap) {
        this.sendToPlayer(player, ServerOpcode.ENTITY_DEATH, npc.id);
      }
    }

    // Update player state
    player.currentMapLevel = newMap;
    player.position.x = transition.targetX;
    player.position.y = transition.targetZ;
    player.moveQueue = [];
    player.attackTarget = null;
    this.playerCombatTargets.delete(player.id);

    // Update chunk position
    player.currentChunkX = Math.floor(player.position.x / CHUNK_SIZE);
    player.currentChunkZ = Math.floor(player.position.y / CHUNK_SIZE);

    // Add to new map's chunk manager
    const newCm = this.chunkManagers.get(newMap);
    if (newCm) newCm.addEntity(player.id, player.position.x, player.position.y);

    // Send MAP_CHANGE packet
    this.sendMapChange(player, newMap);

    // Send nearby entities on new map
    for (const [, other] of this.players) {
      if (other.id !== player.id && other.currentMapLevel === newMap && this.isNearby(player, other.position.x, other.position.y)) {
        this.sendPlayerUpdate(player, other);
        this.sendPlayerUpdate(other, player);
      }
    }
    for (const [, npc] of this.npcs) {
      if (!npc.dead && npc.currentMapLevel === newMap && this.isNearby(player, npc.position.x, npc.position.y)) {
        this.sendNpcUpdate(player, npc);
      }
    }
    for (const [, item] of this.groundItems) {
      if (item.mapLevel === newMap && this.isNearby(player, item.x, item.z)) {
        this.sendGroundItemUpdate(player, item);
      }
    }
    for (const [, obj] of this.worldObjects) {
      if (obj.mapLevel === newMap && this.isNearby(player, obj.x, obj.z)) {
        this.sendWorldObjectUpdate(player, obj);
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
    for (const [, viewer] of this.players) {
      // Sync players on same map within chunk range
      for (const [, subject] of this.players) {
        if (subject.currentMapLevel !== viewer.currentMapLevel) continue;
        if (!this.isNearby(viewer, subject.position.x, subject.position.y) && subject.id !== viewer.id) continue;
        this.sendPlayerUpdate(viewer, subject);
      }
      // Sync NPCs on same map within chunk range
      for (const [, npc] of this.npcs) {
        if (npc.dead || npc.currentMapLevel !== viewer.currentMapLevel) continue;
        if (!this.isNearby(viewer, npc.position.x, npc.position.y)) continue;
        this.sendNpcUpdate(viewer, npc);
      }
      // World objects don't move, but we sync them periodically for new players entering chunk range
      // (Initial sync is done in addPlayer; this handles chunk boundary crossings)
    }
  }

  private broadcastCombatHit(attackerId: number, targetId: number, damage: number, targetHp: number, targetMaxHp: number, mapLevel: string, worldX: number, worldZ: number): void {
    for (const [, p] of this.players) {
      if (p.currentMapLevel === mapLevel && this.isNearby(p, worldX, worldZ)) {
        this.sendToPlayer(p, ServerOpcode.COMBAT_HIT,
          attackerId, targetId, damage, targetHp, targetMaxHp
        );
      }
    }
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
    for (let i = 0; i < player.inventory.length; i++) {
      const slot = player.inventory[i];
      this.sendToPlayer(player, ServerOpcode.PLAYER_INVENTORY,
        i,
        slot ? slot.itemId : 0,
        slot ? slot.quantity : 0
      );
    }
  }

  sendSkills(player: Player): void {
    for (let i = 0; i < ALL_SKILLS.length; i++) {
      const skill = player.skills[ALL_SKILLS[i]];
      const xpHigh = (skill.xp >> 16) & 0xFFFF;
      const xpLow = skill.xp & 0xFFFF;
      this.sendToPlayer(player, ServerOpcode.PLAYER_SKILLS,
        i, skill.level, skill.currentLevel, xpHigh, xpLow
      );
    }
  }

  sendEquipment(player: Player): void {
    const slotNames: EquipSlot[] = ['weapon', 'shield', 'head', 'body', 'legs', 'neck', 'ring', 'hands', 'feet', 'cape'];
    for (let i = 0; i < slotNames.length; i++) {
      const itemId = player.equipment.get(slotNames[i]) ?? 0;
      this.sendToPlayer(player, ServerOpcode.PLAYER_EQUIPMENT, i, itemId);
    }
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
    return this.getMap('overworld');
  }
}
