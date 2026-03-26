import { ClientOpcode, decodePacket } from '@projectrs/shared';
import { World } from '../World';
import { Player } from '../entity/Player';
import type { ServerWebSocket } from 'bun';

export type GameSocketData = { type: 'game'; playerId?: number; accountId: number; username: string };

export function handleGameSocketOpen(
  ws: ServerWebSocket<GameSocketData>,
  world: World
): void {
  const { accountId, username } = ws.data;

  // Kick existing session for same account (prevent duplicate logins)
  world.kickAccountIfOnline(accountId);

  // Load saved state or use defaults
  const saved = world.db.loadPlayerState(accountId);

  // Use saved position, or map spawn point for new players
  const mapLevel = saved?.mapLevel ?? 'overworld';
  const map = world.getMap(mapLevel);
  const defaultSpawn = map.findSpawnPoint();
  const spawnX = saved ? saved.x : defaultSpawn.x;
  const spawnZ = saved ? saved.z : defaultSpawn.z;
  console.log(`[GameSocket] Player "${username}" acct=${accountId} saved=${!!saved} savedPos=(${saved?.x}, ${saved?.z}) defaultSpawn=(${defaultSpawn.x}, ${defaultSpawn.z}) final=(${spawnX}, ${spawnZ})`);

  const player = new Player(username, spawnX, spawnZ, ws, accountId);

  // Apply saved state
  if (saved) {
    player.skills = saved.skills;
    player.inventory = saved.inventory;
    player.equipment = saved.equipment;
    player.stance = saved.stance;
    player.currentMapLevel = saved.mapLevel;
    player.syncHealthFromSkills();
  }

  ws.data.playerId = player.id;
  world.addPlayer(player);
}

export function handleGameSocketMessage(
  ws: ServerWebSocket<GameSocketData>,
  message: ArrayBuffer | string,
  world: World
): void {
  if (typeof message === 'string') return;

  const { opcode, values } = decodePacket(message);
  const playerId = ws.data.playerId;
  if (!playerId) return;

  switch (opcode) {
    case ClientOpcode.PLAYER_MOVE: {
      const pathLength = values[0];
      const path: { x: number; z: number }[] = [];
      for (let i = 0; i < pathLength && (1 + i * 2 + 1) < values.length; i++) {
        path.push({
          x: values[1 + i * 2] / 10,
          z: values[1 + i * 2 + 1] / 10,
        });
      }
      world.handlePlayerMove(playerId, path);
      break;
    }

    case ClientOpcode.PLAYER_ATTACK_NPC: {
      const npcEntityId = values[0];
      world.handlePlayerAttackNpc(playerId, npcEntityId);
      break;
    }

    case ClientOpcode.PLAYER_PICKUP_ITEM: {
      const groundItemId = values[0];
      world.handlePlayerPickup(playerId, groundItemId);
      break;
    }

    case ClientOpcode.PLAYER_DROP_ITEM: {
      const slot = values[0];
      world.handlePlayerDrop(playerId, slot);
      break;
    }

    case ClientOpcode.PLAYER_EQUIP_ITEM: {
      const slot = values[0];
      world.handlePlayerEquip(playerId, slot);
      break;
    }

    case ClientOpcode.PLAYER_UNEQUIP_ITEM: {
      const equipSlot = values[0];
      world.handlePlayerUnequip(playerId, equipSlot);
      break;
    }

    case ClientOpcode.PLAYER_EAT_ITEM: {
      const slot = values[0];
      world.handlePlayerEat(playerId, slot);
      break;
    }

    case ClientOpcode.PLAYER_SET_STANCE: {
      const stanceIdx = values[0];
      world.handlePlayerSetStance(playerId, stanceIdx);
      break;
    }

    case ClientOpcode.PLAYER_INTERACT_OBJECT: {
      const objectEntityId = values[0];
      const actionIndex = values[1] ?? 0;
      world.handlePlayerInteractObject(playerId, objectEntityId, actionIndex);
      break;
    }

    default:
      console.log(`Unknown game opcode: ${opcode}`);
  }
}

export function handleGameSocketClose(
  ws: ServerWebSocket<GameSocketData>,
  world: World
): void {
  const playerId = ws.data.playerId;
  if (playerId) {
    // Save player state before removing
    const player = world.getPlayer(playerId);
    if (player) {
      world.db.savePlayerState(player.accountId, player);
    }
    world.removePlayer(playerId);
  }
}
