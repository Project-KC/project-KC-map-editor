import { TileType } from '@projectrs/shared';
import type { ChunkManager } from '../rendering/ChunkManager';

const TILE_COLORS_MAP: Record<number, string> = {
  [TileType.GRASS]: '#4a8a30',
  [TileType.DIRT]:  '#8c6840',
  [TileType.STONE]: '#808080',
  [TileType.WATER]: '#3060b0',
  [TileType.WALL]:  '#504040',
  [TileType.SAND]:  '#c0b080',
  [TileType.WOOD]:  '#705028',
};

// How many tiles the minimap shows in each direction from center
// Slightly larger than visible radius to fill corners when rotated
const VIEW_RADIUS = 52;

export class Minimap {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private size: number;

  // Offscreen canvas for tile rendering (putImageData ignores transforms)
  private offCanvas: HTMLCanvasElement;
  private offCtx: CanvasRenderingContext2D;

  // Destination marker (world coords, null = no destination)
  private destX: number | null = null;
  private destZ: number | null = null;
  private destBlinkTimer: number = 0;

  // Click-to-move callback
  private onClickMove: ((worldX: number, worldZ: number) => void) | null = null;

  // Cached view params for click mapping
  private lastPlayerX: number = 0;
  private lastPlayerZ: number = 0;
  private lastScale: number = 1;
  private lastAlpha: number = 0;

  constructor(size: number = 150) {
    this.size = size;

    this.canvas = document.createElement('canvas');
    this.canvas.width = size;
    this.canvas.height = size;
    this.canvas.style.cssText = `
      position: fixed; top: 10px; right: 10px;
      width: ${size}px; height: ${size}px;
      border: 2px solid #5a4a35; border-radius: 50%;
      z-index: 100; image-rendering: pixelated; cursor: pointer;
    `;

    this.ctx = this.canvas.getContext('2d')!;
    document.body.appendChild(this.canvas);

    // Offscreen canvas for tile imageData
    this.offCanvas = document.createElement('canvas');
    this.offCanvas.width = size;
    this.offCanvas.height = size;
    this.offCtx = this.offCanvas.getContext('2d')!;

    this.canvas.addEventListener('click', (e) => this.handleClick(e));
  }

  /** Set callback for when the player clicks the minimap to move */
  setClickMoveHandler(handler: (worldX: number, worldZ: number) => void): void {
    this.onClickMove = handler;
  }

  /** Show destination marker at world position */
  setDestination(worldX: number, worldZ: number): void {
    this.destX = worldX;
    this.destZ = worldZ;
    this.destBlinkTimer = 0;
  }

  /** Hide destination marker */
  clearDestination(): void {
    this.destX = null;
    this.destZ = null;
  }

  private handleClick(e: MouseEvent): void {
    if (!this.onClickMove) return;
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const pz = e.clientY - rect.top;
    const center = this.size / 2;

    // Inverse transform: undo scale(-1,1) then undo rotation
    const relX = -(px - center); // undo X flip
    const relZ = -(pz - center); // undo Z flip
    const angle = -(this.lastAlpha + Math.PI / 2);
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    const urX = relX * cosA - relZ * sinA;
    const urZ = relX * sinA + relZ * cosA;

    // Map unrotated minimap coords to world coords
    const worldX = this.lastPlayerX + urX / this.lastScale;
    const worldZ = this.lastPlayerZ + urZ / this.lastScale;
    this.onClickMove(worldX, worldZ);
  }

  /** Update minimap with entity positions (windowed view from ChunkManager) */
  update(
    playerX: number,
    playerZ: number,
    remotePlayers: { x: number; z: number }[],
    npcs: { x: number; z: number }[],
    chunkManager: ChunkManager,
    cameraAlpha: number = 0
  ): void {
    const { tiles, size: tileSize, startX, startZ } = chunkManager.getTilesForMinimap(playerX, playerZ, VIEW_RADIUS);
    const scale = this.size / tileSize;
    const center = this.size / 2;

    // Cache for click mapping
    this.lastPlayerX = playerX;
    this.lastPlayerZ = playerZ;
    this.lastScale = scale;
    this.lastAlpha = cameraAlpha;

    // Build tile image on offscreen canvas
    const imageData = this.offCtx.createImageData(this.size, this.size);

    for (let dz = 0; dz < tileSize; dz++) {
      for (let dx = 0; dx < tileSize; dx++) {
        const tileType = tiles[dz * tileSize + dx];
        const color = TILE_COLORS_MAP[tileType] || '#000';
        const r = parseInt(color.substring(1, 3), 16);
        const g = parseInt(color.substring(3, 5), 16);
        const b = parseInt(color.substring(5, 7), 16);

        const px = Math.floor(dx * scale);
        const pz = Math.floor(dz * scale);
        const pw = Math.max(1, Math.ceil(scale));
        const ph = Math.max(1, Math.ceil(scale));

        for (let ddx = 0; ddx < pw; ddx++) {
          for (let ddz = 0; ddz < ph; ddz++) {
            const fx = px + ddx;
            const fz = pz + ddz;
            if (fx < this.size && fz < this.size) {
              const idx = (fz * this.size + fx) * 4;
              imageData.data[idx] = r;
              imageData.data[idx + 1] = g;
              imageData.data[idx + 2] = b;
              imageData.data[idx + 3] = 255;
            }
          }
        }
      }
    }

    this.offCtx.putImageData(imageData, 0, 0);

    // Clear main canvas
    this.ctx.clearRect(0, 0, this.size, this.size);

    // Draw rotated content: tiles, entities, markers
    // scale(-1,1) flips X to correct left-handed (BabylonJS) vs right-handed (canvas) mismatch
    this.ctx.save();
    this.ctx.translate(center, center);
    this.ctx.scale(-1, -1);
    this.ctx.rotate(cameraAlpha + Math.PI / 2);
    this.ctx.translate(-center, -center);

    // Draw tile image (rotated)
    this.ctx.drawImage(this.offCanvas, 0, 0);

    // Draw NPCs as yellow dots
    this.ctx.fillStyle = '#ff0';
    for (const npc of npcs) {
      const relX = (npc.x - startX) * scale;
      const relZ = (npc.z - startZ) * scale;
      if (relX >= -4 && relX < this.size + 4 && relZ >= -4 && relZ < this.size + 4) {
        this.ctx.fillRect(relX - 1, relZ - 1, 3, 3);
      }
    }

    // Draw remote players as white dots
    this.ctx.fillStyle = '#fff';
    for (const rp of remotePlayers) {
      const relX = (rp.x - startX) * scale;
      const relZ = (rp.z - startZ) * scale;
      if (relX >= -4 && relX < this.size + 4 && relZ >= -4 && relZ < this.size + 4) {
        this.ctx.fillRect(relX - 1, relZ - 1, 3, 3);
      }
    }

    // Draw destination marker (yellow blinking X)
    if (this.destX !== null && this.destZ !== null) {
      this.destBlinkTimer += 0.016; // ~60fps
      const blink = Math.sin(this.destBlinkTimer * 6) > -0.3; // mostly on, brief off
      if (blink) {
        const dx = (this.destX - startX) * scale;
        const dz = (this.destZ - startZ) * scale;
        if (dx >= -4 && dx < this.size + 4 && dz >= -4 && dz < this.size + 4) {
          this.ctx.strokeStyle = '#ff0';
          this.ctx.lineWidth = 1.5;
          this.ctx.beginPath();
          this.ctx.moveTo(dx - 3, dz - 3);
          this.ctx.lineTo(dx + 3, dz + 3);
          this.ctx.moveTo(dx + 3, dz - 3);
          this.ctx.lineTo(dx - 3, dz + 3);
          this.ctx.stroke();
        }
      }
    }

    this.ctx.restore();

    // Draw local player as bright green dot (always center, unrotated)
    this.ctx.fillStyle = '#0f0';
    this.ctx.fillRect(center - 2, center - 2, 4, 4);
  }
}
