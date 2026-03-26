import { World } from '../World';
import type { ServerWebSocket } from 'bun';

export type ChatSocketData = { type: 'chat'; playerId?: number; accountId: number; username: string };

// Keep track of all chat sockets for broadcasting
const chatSockets: Set<ServerWebSocket<ChatSocketData>> = new Set();

export function handleChatSocketOpen(
  ws: ServerWebSocket<ChatSocketData>,
  world: World
): void {
  chatSockets.add(ws);
}

export function handleChatSocketMessage(
  ws: ServerWebSocket<ChatSocketData>,
  message: string | ArrayBuffer,
  world: World
): void {
  if (typeof message !== 'string') return;

  try {
    const data = JSON.parse(message);

    switch (data.type) {
      case 'identify': {
        ws.data.playerId = data.playerId;
        break;
      }

      case 'local': {
        const from = ws.data.username || 'Unknown';
        const msg = (data.message as string).substring(0, 200); // Cap length

        // Handle commands
        if (msg.startsWith('/')) {
          handleCommand(ws, from, msg, world);
          return;
        }

        // Broadcast to all connected chat sockets
        const payload = JSON.stringify({
          type: 'local',
          from,
          message: msg,
        });

        for (const sock of chatSockets) {
          try {
            sock.send(payload);
          } catch { /* ignore closed */ }
        }
        break;
      }
    }
  } catch {
    // Invalid JSON
  }
}

function handleCommand(
  ws: ServerWebSocket<ChatSocketData>,
  from: string,
  command: string,
  world: World
): void {
  const parts = command.split(' ');
  const cmd = parts[0].toLowerCase();

  switch (cmd) {
    case '/players': {
      const count = world.players.size;
      const names = Array.from(world.players.values()).map(p => p.name).join(', ');
      ws.send(JSON.stringify({
        type: 'system',
        message: `${count} player(s) online: ${names}`,
      }));
      break;
    }

    case '/msg': {
      const targetName = parts[1];
      const msg = parts.slice(2).join(' ');
      if (!targetName || !msg) {
        ws.send(JSON.stringify({ type: 'system', message: 'Usage: /msg <player> <message>' }));
        return;
      }

      // Find target player's chat socket
      let targetPlayer = null;
      for (const [, p] of world.players) {
        if (p.name.toLowerCase() === targetName.toLowerCase()) {
          targetPlayer = p;
          break;
        }
      }

      if (!targetPlayer) {
        ws.send(JSON.stringify({ type: 'system', message: `Player "${targetName}" not found.` }));
        return;
      }

      // Find their chat socket by username
      for (const sock of chatSockets) {
        if (sock.data.username.toLowerCase() === targetPlayer.name.toLowerCase()) {
          sock.send(JSON.stringify({ type: 'private', from, message: msg }));
          break;
        }
      }

      // Confirm to sender
      ws.send(JSON.stringify({ type: 'private_sent', to: targetPlayer.name, message: msg }));
      break;
    }

    default: {
      ws.send(JSON.stringify({ type: 'system', message: `Unknown command: ${cmd}` }));
    }
  }
}

export function handleChatSocketClose(
  ws: ServerWebSocket<ChatSocketData>,
  world: World
): void {
  chatSockets.delete(ws);
}

/** Broadcast player info to all chat sockets so clients can map entityId → name */
export function broadcastPlayerInfo(entityId: number, name: string): void {
  const payload = JSON.stringify({ type: 'player_info', entityId, name });
  for (const sock of chatSockets) {
    try {
      sock.send(payload);
    } catch { /* ignore */ }
  }
}
