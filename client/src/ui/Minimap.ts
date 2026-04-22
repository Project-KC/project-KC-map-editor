import { TileType, WallEdge } from '@projectrs/shared';
import type { ChunkManager } from '../rendering/ChunkManager';

/** Minimap dot color for a world-object category. Undefined = don't draw. */
const OBJECT_COLORS: Record<string, string> = {
  tree: '#3a6a2e',
  rock: '#909088',
  fishingspot: '#62aac8',
  furnace: '#c67838',
  cookingrange: '#c67838',
  anvil: '#7a7a74',
  altar: '#a07ac8',
  door: '#7a5a38',
  chest: '#d8b050',
};

export interface MinimapObject { x: number; z: number; category: string; }

// RSC-inspired painted palette — warm, a touch more saturated than pure
// muted earth tones so the map doesn't feel flat.
const TILE_COLORS_RGB: Record<number, [number, number, number]> = {
  [TileType.GRASS]: [0x5e, 0x88, 0x38],
  [TileType.DIRT]:  [0x9a, 0x74, 0x48],
  [TileType.STONE]: [0x96, 0x8e, 0x7e],
  [TileType.WATER]: [0x36, 0x64, 0x9e],
  [TileType.WALL]:  [0x3a, 0x2e, 0x24],
  [TileType.SAND]:  [0xd4, 0xba, 0x7a],
  [TileType.WOOD]:  [0x84, 0x5e, 0x38],
  [TileType.MUD]:   [0x72, 0x54, 0x30],
};
const TILE_COLOR_DEFAULT: [number, number, number] = [0x1a, 0x16, 0x10];
// Interior of a roofed tile: warm wood-floor tone so buildings read as
// "inside" from above, the way RS Classic showed roofed buildings.
const ROOF_TINT_RGB: [number, number, number] = [0x6a, 0x48, 0x26];
// Stroke color for wall edges.
const WALL_STROKE_RGB: [number, number, number] = [0x16, 0x0e, 0x08];

// How many tiles the minimap shows in each direction from center.
// Matches RuneScape's click-to-move reach (~17 tiles). A few extra tiles
// fill the corners while the map rotates with the camera.
const VIEW_RADIUS = 20;

export class Minimap {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private size: number;

  // Offscreen canvas for tile rendering (putImageData ignores transforms)
  private offCanvas: HTMLCanvasElement;
  private offCtx: CanvasRenderingContext2D;
  private imageData: ImageData;

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

  // Cached tile window: only rebuild the offscreen tile bitmap when the player
  // crosses a tile boundary. Entities/destination marker still redraw per frame.
  private cachedStartX: number = Number.NaN;
  private cachedStartZ: number = Number.NaN;
  private cachedTileSize: number = 0;

  constructor(size: number = 150) {
    this.size = size;

    this.canvas = document.createElement('canvas');
    this.canvas.width = size;
    this.canvas.height = size;
    // Square minimap framed with a dark border + thin brass line — keeps the
    // RSC painted-tile feel but in a unique rectangular form-factor.
    this.canvas.style.cssText = `
      width: 100%; height: ${Math.min(size, 200)}px;
      display: block;
      border-bottom: 3px solid #1a1208;
      image-rendering: pixelated; cursor: pointer;
      background: #0a0a08;
      box-shadow:
        inset 0 0 0 1px rgba(220,180,80,0.22),
        inset 0 0 12px rgba(0,0,0,0.45);
    `;

    this.ctx = this.canvas.getContext('2d')!;
    const mount = document.getElementById('ui-right-column');
    (mount ?? document.body).appendChild(this.canvas);

    // Offscreen canvas for tile imageData
    this.offCanvas = document.createElement('canvas');
    this.offCanvas.width = size;
    this.offCanvas.height = size;
    this.offCtx = this.offCanvas.getContext('2d')!;
    this.imageData = this.offCtx.createImageData(size, size);

    this.canvas.addEventListener('click', (e) => this.handleClick(e));
  }

  /** Set callback for when the player clicks the minimap to move */
  setClickMoveHandler(handler: (worldX: number, worldZ: number) => void): void {
    this.onClickMove = handler;
  }

  /** Invalidate the cached tile bitmap — call after a map change. */
  invalidateTileCache(): void {
    this.cachedStartX = Number.NaN;
    this.cachedStartZ = Number.NaN;
    this.cachedTileSize = 0;
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
    const relZ = -(pz - center); // undo Y flip
    const angle = this.lastAlpha + Math.PI / 2; // undo negated rotation
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
    cameraAlpha: number = 0,
    worldObjects: MinimapObject[] = [],
  ): void {
    // Fast path: only rebuild the tile bitmap when the player crosses a tile boundary.
    // getTilesForMinimap() allocates a fresh Uint8Array + scans ~11k tiles — skip it when nothing changed.
    const floorX = Math.floor(playerX) - VIEW_RADIUS;
    const floorZ = Math.floor(playerZ) - VIEW_RADIUS;
    let startX: number;
    let startZ: number;
    let tileSize: number;

    if (floorX === this.cachedStartX && floorZ === this.cachedStartZ && this.cachedTileSize > 0) {
      startX = this.cachedStartX;
      startZ = this.cachedStartZ;
      tileSize = this.cachedTileSize;
    } else {
      const queried = chunkManager.getTilesForMinimap(playerX, playerZ, VIEW_RADIUS);
      startX = queried.startX;
      startZ = queried.startZ;
      tileSize = queried.size;
      this.cachedStartX = startX;
      this.cachedStartZ = startZ;
      this.cachedTileSize = tileSize;

      // Rebuild the offscreen tile bitmap (reuse pre-allocated ImageData)
      const tiles = queried.tiles;
      const walls = queried.walls;
      const roofs = queried.roofs;
      const scaleInner = this.size / tileSize;
      const imageData = this.imageData;
      const data = imageData.data;
      data.fill(0);

      const setPx = (fx: number, fz: number, r: number, g: number, b: number) => {
        if (fx < 0 || fz < 0 || fx >= this.size || fz >= this.size) return;
        const idx = (fz * this.size + fx) * 4;
        data[idx] = r; data[idx + 1] = g; data[idx + 2] = b; data[idx + 3] = 255;
      };

      // Deterministic per-tile noise so identical adjacent tiles aren't flat.
      // Amplitude is small (-6..+6 per channel) to keep the painted feel.
      const tileShade = (worldX: number, worldZ: number): number => {
        const h = (worldX * 73856093) ^ (worldZ * 19349663);
        return ((h & 0xff) / 255) * 12 - 6;
      };
      const clamp255 = (v: number) => v < 0 ? 0 : v > 255 ? 255 : v;

      // Pass 1: fill each tile with its type color (+ roof tint + noise)
      for (let dz = 0; dz < tileSize; dz++) {
        for (let dx = 0; dx < tileSize; dx++) {
          const tIdx = dz * tileSize + dx;
          const tileType = tiles[tIdx];
          const isRoofed = roofs[tIdx] === 1;
          const base = isRoofed
            ? ROOF_TINT_RGB
            : (TILE_COLORS_RGB[tileType] || TILE_COLOR_DEFAULT);
          const shade = tileShade(startX + dx, startZ + dz);
          const r = clamp255(base[0] + shade);
          const g = clamp255(base[1] + shade);
          const b = clamp255(base[2] + shade);

          const px = Math.floor(dx * scaleInner);
          const pz = Math.floor(dz * scaleInner);
          const pw = Math.max(1, Math.ceil(scaleInner));
          const ph = Math.max(1, Math.ceil(scaleInner));

          for (let ddx = 0; ddx < pw; ddx++) {
            for (let ddz = 0; ddz < ph; ddz++) {
              setPx(px + ddx, pz + ddz, r, g, b);
            }
          }
        }
      }

      // Pass 2: overdraw wall edges as thick dark lines. At scale ≈ 3-4 px
      // per tile a 2-pixel edge reads clearly, so walls look like buildings
      // instead of hair-thin scratches.
      const WR = WALL_STROKE_RGB[0], WG = WALL_STROKE_RGB[1], WB = WALL_STROKE_RGB[2];
      const wallThickness = Math.max(1, Math.min(2, Math.floor(scaleInner / 2)));
      for (let dz = 0; dz < tileSize; dz++) {
        for (let dx = 0; dx < tileSize; dx++) {
          const mask = walls[dz * tileSize + dx];
          if (!mask) continue;
          const px0 = Math.floor(dx * scaleInner);
          const pz0 = Math.floor(dz * scaleInner);
          const px1 = Math.floor((dx + 1) * scaleInner) - 1;
          const pz1 = Math.floor((dz + 1) * scaleInner) - 1;
          const drawH = (y: number) => { for (let x = px0; x <= px1; x++) setPx(x, y, WR, WG, WB); };
          const drawV = (x: number) => { for (let z = pz0; z <= pz1; z++) setPx(x, z, WR, WG, WB); };
          if (mask & WallEdge.N) for (let t = 0; t < wallThickness; t++) drawH(pz0 + t);
          if (mask & WallEdge.S) for (let t = 0; t < wallThickness; t++) drawH(pz1 - t);
          if (mask & WallEdge.W) for (let t = 0; t < wallThickness; t++) drawV(px0 + t);
          if (mask & WallEdge.E) for (let t = 0; t < wallThickness; t++) drawV(px1 - t);
        }
      }

      this.offCtx.putImageData(imageData, 0, 0);
    }

    const scale = this.size / tileSize;
    const center = this.size / 2;

    // Cache for click mapping
    this.lastPlayerX = playerX;
    this.lastPlayerZ = playerZ;
    this.lastScale = scale;
    this.lastAlpha = cameraAlpha;

    // Clear main canvas
    this.ctx.clearRect(0, 0, this.size, this.size);

    // Draw rotated content: tiles, entities, markers
    // Rotate so "up" on the minimap = the direction the camera faces
    // scale(1, -1) flips Y to correct BabylonJS left-handed coords vs canvas
    this.ctx.save();
    this.ctx.translate(center, center);
    this.ctx.scale(-1, -1);
    this.ctx.rotate(-(cameraAlpha + Math.PI / 2));
    this.ctx.translate(-center, -center);

    // Draw tile image (rotated)
    this.ctx.drawImage(this.offCanvas, 0, 0);

    // Draw world objects (trees, rocks, fishing spots, stations) as small colored dots
    for (const obj of worldObjects) {
      const color = OBJECT_COLORS[obj.category];
      if (!color) continue;
      const relX = (obj.x - startX) * scale;
      const relZ = (obj.z - startZ) * scale;
      if (relX < -2 || relX > this.size + 2 || relZ < -2 || relZ > this.size + 2) continue;
      this.ctx.fillStyle = color;
      this.ctx.fillRect(relX - 1, relZ - 1, 2, 2);
    }

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

    // Player marker: RSC-style arrow pointing in the camera's forward
    // direction. Since the tile layer is rotated to match the camera, "up"
    // on the canvas is always forward for the player.
    this.ctx.save();
    this.ctx.translate(center, center);
    this.ctx.fillStyle = '#ffffff';
    this.ctx.strokeStyle = '#000000';
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    this.ctx.moveTo(0, -4);   // tip
    this.ctx.lineTo(3, 3);    // back-right
    this.ctx.lineTo(0, 1);    // notch (arrow shape, not triangle)
    this.ctx.lineTo(-3, 3);   // back-left
    this.ctx.closePath();
    this.ctx.fill();
    this.ctx.stroke();
    this.ctx.restore();
  }
}
