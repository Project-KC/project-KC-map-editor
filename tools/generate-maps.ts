#!/usr/bin/env bun
/**
 * Generate map.json, meta.json, spawns.json, and walls.json
 * for the overworld (1024x1024) and underground (256x256) maps.
 *
 * Run: bun tools/generate-maps.ts
 *
 * Overworld has distinct regions: central village, NE mountains, E forest,
 * SE ruins (dungeon entrance), SW goblin camp, NW swamp, river, south coast.
 * Underground has structured rooms and corridors.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';

const OVERWORLD_SIZE = 1024;
const UNDERGROUND_SIZE = 256;

// Tile type constants (used internally during generation)
const GRASS = 0;
const DIRT = 1;
const STONE = 2;
const WATER = 3;
const WALL = 4;
const SAND = 5;
const WOOD = 6;

// Map old tile type constants to KC ground type strings
const GROUND_TYPE: Record<number, string> = {
  [GRASS]: 'grass',
  [DIRT]:  'dirt',
  [STONE]: 'road',
  [WATER]: 'water',
  [WALL]:  'grass',
  [SAND]:  'sand',
  [WOOD]:  'path',
};

// Wall edge bitmask constants (matching WallEdge in shared/types.ts)
const WALL_N = 1;
const WALL_E = 2;
const WALL_S = 4;
const WALL_W = 8;

// ---------- KC tile helper ----------

function tile(ground: string, waterPainted = false) {
  return {
    ground, groundB: null, split: 'forward' as const,
    textureId: null, textureRotation: 0, textureScale: 1,
    textureWorldUV: false, textureHalfMode: false,
    textureIdB: null, textureRotationB: 0, textureScaleB: 1,
    waterPainted,
  };
}

// ---------- helpers ----------

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function dist(x1: number, z1: number, x2: number, z2: number): number {
  const dx = x1 - x2;
  const dz = z1 - z2;
  return Math.sqrt(dx * dx + dz * dz);
}

function inRect(x: number, z: number, rx: number, rz: number, rw: number, rh: number): boolean {
  return x >= rx && x < rx + rw && z >= rz && z < rz + rh;
}

// Seeded pseudo-random for reproducible generation
let _seed = 12345;
function seededRandom(): number {
  _seed = (_seed * 1103515245 + 12345) & 0x7fffffff;
  return _seed / 0x7fffffff;
}
function resetSeed(s: number = 12345): void {
  _seed = s;
}

// Distance from point to line segment
function distToSegment(
  px: number, pz: number,
  ax: number, az: number,
  bx: number, bz: number,
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  if (len2 === 0) return dist(px, pz, ax, az);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len2));
  return dist(px, pz, ax + t * dx, az + t * dz);
}

// River path (shared between heightmap and tilemap)
const RIVER_POINTS = [
  { x: 350, z: 200 },
  { x: 400, z: 350 },
  { x: 480, z: 450 },
  { x: 520, z: 550 },
  { x: 530, z: 700 },
  { x: 512, z: 900 },
];

function distToRiver(x: number, z: number): number {
  let minD = Infinity;
  for (let i = 0; i < RIVER_POINTS.length - 1; i++) {
    const p1 = RIVER_POINTS[i];
    const p2 = RIVER_POINTS[i + 1];
    const d = distToSegment(x, z, p1.x, p1.z, p2.x, p2.z);
    if (d < minD) minD = d;
  }
  return minD;
}

// Dungeon entrance in SE ruins
const DUNGEON_ENTRANCE_X = 750;
const DUNGEON_ENTRANCE_Z = 720;

// Type for the KC map file format
interface KCMapFile {
  map: {
    width: number;
    height: number;
    waterLevel: number;
    chunkWaterLevels: Record<string, never>;
    texturePlanes: never[];
    tiles: ReturnType<typeof tile>[][];
    heights: number[][];
  };
  placedObjects: never[];
  layers: { id: string; name: string; visible: boolean }[];
  activeLayerId: string;
}

// ========== OVERWORLD HEIGHTS (1025x1025 vertices) ==========

function generateOverworldHeights(): number[][] {
  const SIZE = OVERWORLD_SIZE;
  const V = SIZE + 1;

  function baseNoise(x: number, z: number): number {
    const nx = x / SIZE;
    const nz = z / SIZE;
    const h =
      Math.sin(nx * 2.1 * Math.PI + 0.3) * Math.cos(nz * 1.7 * Math.PI + 0.7) * 1.0 +
      Math.sin(nx * 4.3 * Math.PI + 1.2) * Math.cos(nz * 3.9 * Math.PI + 2.1) * 0.5 +
      Math.sin(nx * 8.7 * Math.PI + 3.1) * Math.cos(nz * 7.3 * Math.PI + 1.4) * 0.2 +
      Math.sin(nx * 17.1 * Math.PI + 0.8) * Math.cos(nz * 15.7 * Math.PI + 4.2) * 0.08;
    return ((h + 1.78) / 3.56) * 2.0; // ~[0, 2]
  }

  // Building flat zones for heightmap
  const BUILDING_RECTS = [
    { bx: 495, bz: 520, w: 7, h: 6 },
    { bx: 505, bz: 495, w: 6, h: 7 },
    { bx: 518, bz: 500, w: 7, h: 6 },
    { bx: 490, bz: 505, w: 6, h: 6 },
    { bx: 520, bz: 515, w: 6, h: 7 },
    { bx: 500, bz: 508, w: 5, h: 6 },
    { bx: 485, bz: 515, w: 6, h: 6 },
    // Mining camp
    { bx: 720, bz: 280, w: 8, h: 6 },
    { bx: 735, bz: 285, w: 7, h: 7 },
  ];

  function terrainHeight(x: number, z: number): number {
    let h = baseNoise(x, z);

    // --- NE Mountains (650-850, 200-400): peaks up to 4-8 ---
    {
      const cx = 750, cz = 300, radius = 130;
      const d = dist(x, z, cx, cz);
      if (d < radius) {
        const blend = 1 - smoothstep(radius * 0.3, radius, d);
        const peak = 4.0 +
          Math.sin(x * 0.05 + 1.3) * Math.cos(z * 0.07 + 0.5) * 2.0 +
          Math.sin(x * 0.12 + 2.7) * Math.cos(z * 0.09 + 1.1) * 1.0;
        h = h * (1 - blend) + Math.max(h, peak) * blend;
      }
    }

    // --- Central village (480-550, 480-550): flat plateau 0.5 ---
    {
      const cx = 512, cz = 512, radius = 45;
      const d = dist(x, z, cx, cz);
      const blend = 1 - smoothstep(radius * 0.7, radius, d);
      if (blend > 0) h = h * (1 - blend) + 0.5 * blend;
    }

    // --- NW Swamp (200-400, 200-400): low, near water level ---
    {
      const cx = 300, cz = 300, radius = 120;
      const d = dist(x, z, cx, cz);
      const blend = 1 - smoothstep(radius * 0.5, radius, d);
      if (blend > 0) {
        const swampH = 0.0 + Math.sin(x * 0.2) * Math.cos(z * 0.15) * 0.15;
        h = h * (1 - blend) + swampH * blend;
      }
    }

    // --- River depression ---
    {
      const rd = distToRiver(x, z);
      const riverW = 8, bankW = 16;
      if (rd < bankW) {
        const blend = 1 - smoothstep(riverW * 0.5, bankW, rd);
        h = h * (1 - blend) + (-0.5) * blend;
      }
    }

    // --- Southern coast (z > 850): drops below water ---
    {
      if (z > 850) {
        const blend = smoothstep(850, 950, z);
        h = h * (1 - blend) + (-1.0) * blend;
      }
    }

    // --- SE Ruins (700-800, 700-800): flattened ---
    {
      const cx = 750, cz = 750, radius = 60;
      const d = dist(x, z, cx, cz);
      const blend = 1 - smoothstep(radius * 0.7, radius, d);
      if (blend > 0) h = h * (1 - blend) + 0.3 * blend;
    }

    // --- SW Goblin territory: mild hills ---
    {
      const cx = 310, cz = 720, radius = 80;
      const d = dist(x, z, cx, cz);
      const blend = 1 - smoothstep(radius * 0.5, radius, d);
      if (blend > 0) {
        const goblinH = 0.5 + Math.sin(x * 0.08) * 0.3;
        h = h * (1 - blend) + goblinH * blend;
      }
    }

    // --- Lake east of village ---
    {
      const lcx = 565, lcz = 515, lr = 12;
      const d = dist(x, z, lcx, lcz);
      const blend = 1 - smoothstep(lr * 0.5, lr * 1.3, d);
      if (blend > 0) h = h * (1 - blend) + (-0.8) * blend;
    }

    // --- Building flat zones ---
    for (const rect of BUILDING_RECTS) {
      if (x >= rect.bx && x <= rect.bx + rect.w &&
          z >= rect.bz && z <= rect.bz + rect.h) {
        return rect.bz < 400 ? 3.0 : 0.5; // mining camp at 3.0, village at 0.5
      }
    }

    return h;
  }

  const heights: number[][] = [];
  for (let vz = 0; vz < V; vz++) {
    heights[vz] = [];
    for (let vx = 0; vx < V; vx++) {
      heights[vz][vx] = terrainHeight(vx, vz);
    }
  }

  return heights;
}

// ========== OVERWORLD TILEMAP (1024x1024) ==========

function generateOverworldTiles(): { tiles: number[][]; walls: Record<string, number> } {
  const SIZE = OVERWORLD_SIZE;

  // Initialize all to grass
  const tiles: number[][] = [];
  for (let x = 0; x < SIZE; x++) {
    tiles[x] = new Array(SIZE).fill(GRASS);
  }

  // Edge-based wall data: "x,z" -> bitmask (N=1, E=2, S=4, W=8)
  const wallEdges: Record<string, number> = {};

  function addWallEdge(x: number, z: number, edge: number): void {
    const key = `${x},${z}`;
    wallEdges[key] = (wallEdges[key] || 0) | edge;
  }

  /** Set wall edge and its reciprocal on the neighbor tile */
  function setWallEdgePair(x: number, z: number, edge: number): void {
    addWallEdge(x, z, edge);
    // Set reciprocal
    if (edge === WALL_N && z > 0)          addWallEdge(x, z - 1, WALL_S);
    if (edge === WALL_S && z < SIZE - 1)   addWallEdge(x, z + 1, WALL_N);
    if (edge === WALL_E && x < SIZE - 1)   addWallEdge(x + 1, z, WALL_W);
    if (edge === WALL_W && x > 0)          addWallEdge(x - 1, z, WALL_E);
  }

  // Helper: place a building (wood floor + wall edges on perimeter, dirt doorway)
  function placeBuilding(bx: number, bz: number, w: number, h: number): void {
    const doorX = bx + Math.floor(w / 2);
    for (let x = bx; x < bx + w; x++) {
      for (let z = bz; z < bz + h; z++) {
        if (x === bx || x === bx + w - 1 || z === bz || z === bz + h - 1) {
          // Perimeter tile — use wood floor (or dirt for doorway)
          if (z === bz && x === doorX) {
            tiles[x][z] = DIRT; // doorway — no wall edges here
          } else {
            tiles[x][z] = WOOD;
            // Add wall edges on all outward-facing sides
            if (x === bx)         setWallEdgePair(x, z, WALL_W);
            if (x === bx + w - 1) setWallEdgePair(x, z, WALL_E);
            if (z === bz)         setWallEdgePair(x, z, WALL_N);
            if (z === bz + h - 1) setWallEdgePair(x, z, WALL_S);
          }
        } else {
          tiles[x][z] = WOOD;
        }
      }
    }
  }

  // Helper: place a tent (dirt floor + wall edges on perimeter, doorway gap)
  function placeTent(cx: number, cz: number, size: number): void {
    const doorX = cx + Math.floor(size / 2);
    for (let x = cx; x < cx + size; x++) {
      for (let z = cz; z < cz + size; z++) {
        if (x === cx || x === cx + size - 1 || z === cz || z === cz + size - 1) {
          if (z === cz && x === doorX) {
            tiles[x][z] = DIRT; // doorway
            continue;
          }
          tiles[x][z] = DIRT;
          // Add wall edges on outward-facing sides
          if (x === cx)              setWallEdgePair(x, z, WALL_W);
          if (x === cx + size - 1)   setWallEdgePair(x, z, WALL_E);
          if (z === cz)              setWallEdgePair(x, z, WALL_N);
          if (z === cz + size - 1)   setWallEdgePair(x, z, WALL_S);
        } else {
          tiles[x][z] = DIRT;
        }
      }
    }
  }

  // ===== 1. NATURAL WATER FEATURES =====

  // River (water + sand banks)
  for (let z = 0; z < SIZE; z++) {
    for (let x = 0; x < SIZE; x++) {
      const rd = distToRiver(x, z);
      if (rd < 2) {
        tiles[x][z] = WATER;
      } else if (rd < 5) {
        tiles[x][z] = SAND;
      }
    }
  }

  // NW Swamp (220-380, 220-380)
  resetSeed(55);
  for (let x = 220; x <= 380; x++) {
    for (let z = 220; z <= 380; z++) {
      const d = dist(x, z, 300, 300);
      if (d < 90) {
        const r = seededRandom();
        if (r < 0.25) tiles[x][z] = WATER;
        else if (r < 0.45) tiles[x][z] = SAND;
      } else if (d < 110) {
        const r = seededRandom();
        if (r < 0.12) tiles[x][z] = WATER;
        else if (r < 0.25) tiles[x][z] = SAND;
      } else {
        seededRandom(); // consume to keep deterministic
      }
    }
  }

  // Southern coast (z > 870)
  for (let x = 0; x < SIZE; x++) {
    for (let z = 870; z < SIZE; z++) {
      if (z >= 920) {
        tiles[x][z] = WATER;
      } else if (z >= 900) {
        if (tiles[x][z] === GRASS) tiles[x][z] = WATER;
      } else if (z >= 885) {
        if (tiles[x][z] === GRASS) tiles[x][z] = SAND;
      }
    }
  }

  // Lake east of village (555-575, 505-525)
  for (let x = 555; x <= 575; x++) {
    for (let z = 505; z <= 525; z++) {
      const d2 = (x - 565) * (x - 565) + (z - 515) * (z - 515);
      if (d2 < 50) tiles[x][z] = WATER;
      else if (d2 < 80 && tiles[x][z] === GRASS) tiles[x][z] = SAND;
    }
  }

  // ===== 2. NATURAL TERRAIN =====

  // NE Mountains (650-850, 200-400): stone + dirt
  resetSeed(42);
  for (let x = 650; x <= 850; x++) {
    for (let z = 200; z <= 400; z++) {
      const d = dist(x, z, 750, 300);
      if (d < 100) {
        const r = seededRandom();
        if (r < 0.4) tiles[x][z] = STONE;
        else if (r < 0.6) tiles[x][z] = DIRT;
      } else if (d < 130) {
        if (seededRandom() < 0.2) tiles[x][z] = STONE;
      } else {
        seededRandom();
      }
    }
  }

  // E Forest (650-850, 450-570): dense wall-tile trees
  resetSeed(77);
  for (let x = 650; x <= 850; x++) {
    for (let z = 450; z <= 570; z++) {
      const nx = x * 0.08;
      const nz = z * 0.06;
      const noise = Math.sin(nx + nz * 1.3) * Math.cos(nz * 0.7 + nx * 0.4);
      if (noise > 0.3) {
        tiles[x][z] = WALL; // tree
      } else if (noise > 0.0 && seededRandom() < 0.3) {
        tiles[x][z] = DIRT; // clearing
      } else {
        seededRandom();
      }
    }
  }

  // ===== 3. ROADS (drawn over water = bridges) =====

  // North-south highway (x=511-512, z=200-850)
  for (let z = 200; z <= 850; z++) {
    tiles[511][z] = DIRT;
    tiles[512][z] = DIRT;
  }

  // East-west highway (z=511-512, x=200-850)
  for (let x = 200; x <= 850; x++) {
    tiles[x][511] = DIRT;
    tiles[x][512] = DIRT;
  }

  // Diagonal to NE mountains (from ~550,480 to 720,280)
  for (let t = 0; t <= 1; t += 0.0005) {
    const x = Math.round(550 + t * (720 - 550));
    const z = Math.round(480 + t * (280 - 480));
    if (x >= 0 && x < SIZE && z >= 0 && z < SIZE) {
      tiles[x][z] = DIRT;
      if (x + 1 < SIZE) tiles[x + 1][z] = DIRT;
    }
  }

  // Diagonal to SE ruins (from ~550,550 to 720,720)
  for (let t = 0; t <= 1; t += 0.0005) {
    const x = Math.round(550 + t * (720 - 550));
    const z = Math.round(550 + t * (720 - 550));
    if (x >= 0 && x < SIZE && z >= 0 && z < SIZE) {
      tiles[x][z] = DIRT;
      if (x + 1 < SIZE) tiles[x + 1][z] = DIRT;
    }
  }

  // Diagonal to NW swamp (from ~480,480 to 320,280)
  for (let t = 0; t <= 1; t += 0.0005) {
    const x = Math.round(480 + t * (320 - 480));
    const z = Math.round(480 + t * (280 - 480));
    if (x >= 0 && x < SIZE && z >= 0 && z < SIZE) {
      tiles[x][z] = DIRT;
      if (x + 1 < SIZE) tiles[x + 1][z] = DIRT;
    }
  }

  // Diagonal to SW goblins (from ~480,550 to 300,720)
  for (let t = 0; t <= 1; t += 0.0005) {
    const x = Math.round(480 + t * (300 - 480));
    const z = Math.round(550 + t * (720 - 550));
    if (x >= 0 && x < SIZE && z >= 0 && z < SIZE) {
      tiles[x][z] = DIRT;
      if (x + 1 < SIZE) tiles[x + 1][z] = DIRT;
    }
  }

  // ===== 4. CENTRAL VILLAGE (480-550, 480-550) =====

  // Stone plaza (504-520, 504-520)
  for (let x = 504; x <= 520; x++)
    for (let z = 504; z <= 520; z++)
      tiles[x][z] = STONE;

  // Dirt paths connecting plaza to roads
  for (let z = 495; z <= 525; z++) { tiles[512][z] = DIRT; tiles[511][z] = DIRT; }
  for (let x = 490; x <= 530; x++) { tiles[x][512] = DIRT; tiles[x][511] = DIRT; }

  // 7 buildings around the plaza
  placeBuilding(495, 520, 7, 6);   // S of plaza (shop)
  placeBuilding(505, 495, 6, 7);   // N of plaza
  placeBuilding(518, 500, 7, 6);   // E of plaza
  placeBuilding(490, 505, 6, 6);   // W of plaza
  placeBuilding(520, 515, 6, 7);   // SE of plaza
  placeBuilding(500, 508, 5, 6);   // center
  placeBuilding(485, 515, 6, 6);   // SW of plaza

  // Farm area (530-545, 525-540)
  for (let x = 530; x <= 545; x++) {
    for (let z = 525; z <= 540; z++) {
      if (x === 530 || x === 545 || z === 525 || z === 540) {
        tiles[x][z] = WOOD; // fence
      } else {
        tiles[x][z] = DIRT; // farm soil
      }
    }
  }

  // ===== 5. SE RUINS (710-790, 710-790) =====

  // Stone floor base
  for (let x = 710; x <= 790; x++)
    for (let z = 710; z <= 790; z++)
      tiles[x][z] = STONE;

  // Outer walls with gaps — edge-based walls on the boundary tiles
  for (let x = 710; x <= 790; x++) {
    if (x % 8 !== 0) {
      setWallEdgePair(x, 710, WALL_N); // north edge of top row
      setWallEdgePair(x, 790, WALL_S); // south edge of bottom row
    }
  }
  for (let z = 710; z <= 790; z++) {
    if (z % 8 !== 0) {
      setWallEdgePair(710, z, WALL_W); // west edge of left col
      setWallEdgePair(790, z, WALL_E); // east edge of right col
    }
  }

  // Inner partial wall structures — edge-based
  for (let z = 740; z <= 780; z++) {
    if (z % 3 !== 0) {
      setWallEdgePair(730, z, WALL_W);
      setWallEdgePair(770, z, WALL_E);
    }
  }
  for (let x = 730; x <= 770; x++) {
    if (x % 3 !== 0) {
      setWallEdgePair(x, 740, WALL_N);
      setWallEdgePair(x, 780, WALL_S);
    }
  }

  // Boss chamber in south of ruins (745-755, 765-775) — edge-based walls
  for (let x = 745; x <= 755; x++) {
    if (!(x === 750)) { // skip doorway at x=750 on north edge
      setWallEdgePair(x, 765, WALL_N);
    }
    setWallEdgePair(x, 775, WALL_S);
  }
  for (let z = 765; z <= 775; z++) {
    setWallEdgePair(745, z, WALL_W);
    setWallEdgePair(755, z, WALL_E);
  }

  // Dungeon entrance marker: stone staircase pattern at (750, 720)
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      const tx = DUNGEON_ENTRANCE_X + dx;
      const tz = DUNGEON_ENTRANCE_Z + dz;
      if (Math.abs(dx) <= 1 && Math.abs(dz) <= 1) {
        tiles[tx][tz] = DIRT; // dirt ring marks the entrance
      }
    }
  }
  tiles[DUNGEON_ENTRANCE_X][DUNGEON_ENTRANCE_Z] = STONE; // center stone

  // ===== 6. SW GOBLIN TERRITORY (260-370, 660-770) =====

  // Dirt camp areas
  resetSeed(99);
  for (let x = 260; x <= 370; x++) {
    for (let z = 660; z <= 770; z++) {
      if (seededRandom() < 0.35) tiles[x][z] = DIRT;
    }
  }

  // Goblin tents
  placeTent(280, 680, 5);
  placeTent(300, 700, 6);
  placeTent(320, 680, 5);
  placeTent(290, 720, 5);
  placeTent(340, 710, 6);

  // ===== 7. MINING CAMP BUILDINGS (NE mountains) =====
  placeBuilding(720, 280, 8, 6);
  placeBuilding(735, 285, 7, 7);

  // ===== 8. SCATTERED DECORATIONS =====

  // Scattered wall-tile trees in open grass
  resetSeed(123);
  for (let x = 10; x < SIZE - 10; x += 3) {
    for (let z = 10; z < SIZE - 10; z += 3) {
      const r = seededRandom();
      if (r < 0.015 && tiles[x][z] === GRASS) {
        // Skip village area, roads, and other features
        if (inRect(x, z, 480, 480, 70, 70)) continue;
        if (inRect(x, z, 700, 700, 100, 100)) continue; // ruins
        if (inRect(x, z, 250, 650, 130, 130)) continue; // goblin camp
        tiles[x][z] = WALL;
      }
    }
  }

  // Small stone patches
  resetSeed(456);
  for (let x = 50; x < SIZE - 50; x += 25) {
    for (let z = 50; z < SIZE - 50; z += 25) {
      if (seededRandom() < 0.04 && tiles[x][z] === GRASS) {
        for (let dx = 0; dx < 3; dx++)
          for (let dz = 0; dz < 3; dz++)
            if (x + dx < SIZE && z + dz < SIZE && tiles[x + dx][z + dz] === GRASS)
              tiles[x + dx][z + dz] = STONE;
      }
    }
  }

  // ===== 9. MAP BORDER WALLS =====
  for (let i = 0; i < SIZE; i++) {
    tiles[0][i] = WALL;
    tiles[SIZE - 1][i] = WALL;
    tiles[i][0] = WALL;
    tiles[i][SIZE - 1] = WALL;
  }

  return { tiles, walls: wallEdges };
}

// ========== UNDERGROUND HEIGHTS (257x257 vertices) ==========

function generateUndergroundHeights(): number[][] {
  const SIZE = UNDERGROUND_SIZE;
  const V = SIZE + 1;

  const heights: number[][] = [];
  for (let vz = 0; vz < V; vz++) {
    heights[vz] = [];
    for (let vx = 0; vx < V; vx++) {
      // Mostly flat with slight variation
      heights[vz][vx] = 0.3 + Math.sin(vx * 0.1) * Math.cos(vz * 0.1) * 0.2;
    }
  }

  return heights;
}

// ========== UNDERGROUND TILEMAP (256x256) ==========

function generateUndergroundTiles(): { tiles: number[][]; walls: Record<string, number> } {
  const SIZE = UNDERGROUND_SIZE;

  // Start everything as WALL (impassable darkness)
  const tiles: number[][] = [];
  for (let x = 0; x < SIZE; x++) {
    tiles[x] = new Array(SIZE).fill(WALL);
  }

  // Edge-based wall data (underground doesn't need many — solid WALL tiles handle blocking)
  const wallEdges: Record<string, number> = {};

  // Carve a rectangular room (stone floor, wall border, doorways)
  function carveRoom(
    rx: number, rz: number, rw: number, rh: number,
    doors: { side: 'n' | 's' | 'e' | 'w'; pos: number }[] = [],
  ): void {
    for (let x = rx; x < rx + rw; x++) {
      for (let z = rz; z < rz + rh; z++) {
        if (x === rx || x === rx + rw - 1 || z === rz || z === rz + rh - 1) {
          tiles[x][z] = WALL;
        } else {
          tiles[x][z] = STONE;
        }
      }
    }
    for (const door of doors) {
      switch (door.side) {
        case 'n':
          for (let dx = -1; dx <= 1; dx++) {
            const tx = rx + door.pos + dx;
            if (tx > rx && tx < rx + rw - 1) tiles[tx][rz] = STONE;
          }
          break;
        case 's':
          for (let dx = -1; dx <= 1; dx++) {
            const tx = rx + door.pos + dx;
            if (tx > rx && tx < rx + rw - 1) tiles[tx][rz + rh - 1] = STONE;
          }
          break;
        case 'w':
          for (let dz = -1; dz <= 1; dz++) {
            const tz = rz + door.pos + dz;
            if (tz > rz && tz < rz + rh - 1) tiles[rx][tz] = STONE;
          }
          break;
        case 'e':
          for (let dz = -1; dz <= 1; dz++) {
            const tz = rz + door.pos + dz;
            if (tz > rz && tz < rz + rh - 1) tiles[rx + rw - 1][tz] = STONE;
          }
          break;
      }
    }
  }

  // Carve a corridor between two points
  function carveCorridor(x1: number, z1: number, x2: number, z2: number, width: number = 4): void {
    const half = Math.floor(width / 2);
    if (x1 === x2) {
      // Vertical
      for (let z = Math.min(z1, z2); z <= Math.max(z1, z2); z++) {
        for (let w = -half; w < half; w++) {
          const tx = x1 + w;
          if (tx >= 0 && tx < SIZE) tiles[tx][z] = STONE;
        }
      }
    } else if (z1 === z2) {
      // Horizontal
      for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
        for (let w = -half; w < half; w++) {
          const tz = z1 + w;
          if (tz >= 0 && tz < SIZE) tiles[x][tz] = STONE;
        }
      }
    }
  }

  // --- Central hub (110-145, 110-145) - 35x35 room ---
  carveRoom(110, 110, 35, 35, [
    { side: 'n', pos: 17 }, // to north corridor
    { side: 'e', pos: 17 }, // to east corridor
    { side: 's', pos: 17 }, // to south corridor
  ]);

  // --- Entrance area marker inside hub (122-134, 122-134) ---
  // Dirt border marks the transition area
  for (let x = 122; x <= 134; x++) {
    for (let z = 122; z <= 134; z++) {
      if (x === 122 || x === 134 || z === 122 || z === 134) {
        if (x === 128 && (z === 122 || z === 134)) continue; // doorways
        if (z === 128 && (x === 122 || x === 134)) continue;
        tiles[x][z] = DIRT;
      }
    }
  }

  // --- North corridor → Mining chamber ---
  carveCorridor(128, 70, 128, 110, 4);
  carveRoom(115, 50, 25, 20, [
    { side: 's', pos: 13 },
  ]);

  // --- East corridor → Skeleton hall ---
  carveCorridor(145, 128, 180, 128, 4);
  carveRoom(180, 115, 25, 25, [
    { side: 'w', pos: 13 },
  ]);

  // --- South corridor → Boss chamber ---
  carveCorridor(128, 145, 128, 180, 4);
  carveRoom(115, 180, 30, 25, [
    { side: 'n', pos: 13 },
  ]);

  return { tiles, walls: wallEdges };
}

// ========== Convert integer tile grid to KC tile grid ==========

function convertTilesToKC(tiles: number[][], size: number): ReturnType<typeof tile>[][] {
  const kcTiles: ReturnType<typeof tile>[][] = [];
  for (let z = 0; z < size; z++) {
    kcTiles[z] = [];
    for (let x = 0; x < size; x++) {
      const tileType = tiles[x][z];
      const ground = GROUND_TYPE[tileType] || 'grass';
      const waterPainted = tileType === WATER;
      kcTiles[z][x] = tile(ground, waterPainted);
    }
  }
  return kcTiles;
}

// ========== Build KC map file ==========

function buildKCMapFile(
  width: number, height: number, waterLevel: number,
  kcTiles: ReturnType<typeof tile>[][],
  heights: number[][],
): KCMapFile {
  return {
    map: {
      width,
      height,
      waterLevel,
      chunkWaterLevels: {},
      texturePlanes: [],
      tiles: kcTiles,
      heights,
    },
    placedObjects: [],
    layers: [{ id: 'layer_0', name: 'Layer 1', visible: true }],
    activeLayerId: 'layer_0',
  };
}

// ========== WRITE EVERYTHING ==========

const BASE = resolve(import.meta.dir, '../server/data/maps');

// --- Overworld ---
{
  const dir = resolve(BASE, 'overworld');
  mkdirSync(dir, { recursive: true });

  console.log('Generating overworld heights (1025x1025)...');
  const heights = generateOverworldHeights();

  console.log('Generating overworld tiles (1024x1024)...');
  const overworldResult = generateOverworldTiles();
  const kcTiles = convertTilesToKC(overworldResult.tiles, OVERWORLD_SIZE);

  console.log('Writing overworld map.json...');
  const kcMap = buildKCMapFile(OVERWORLD_SIZE, OVERWORLD_SIZE, -0.3, kcTiles, heights);
  writeFileSync(resolve(dir, 'map.json'), JSON.stringify(kcMap));

  writeFileSync(resolve(dir, 'walls.json'), JSON.stringify({ walls: overworldResult.walls }, null, 2));
  console.log(`  ${Object.keys(overworldResult.walls).length} wall edges written.`);

  const meta = {
    id: 'overworld',
    name: 'Overworld',
    width: OVERWORLD_SIZE,
    height: OVERWORLD_SIZE,
    waterLevel: -0.3,
    spawnPoint: { x: 512.5, z: 512.5 },
    fogColor: [0.4, 0.6, 0.9],
    fogStart: 30,
    fogEnd: 50,
    transitions: [
      {
        tileX: DUNGEON_ENTRANCE_X,
        tileZ: DUNGEON_ENTRANCE_Z,
        targetMap: 'underground',
        targetX: 130.5,
        targetZ: 130.5,
      },
    ],
  };
  writeFileSync(resolve(dir, 'meta.json'), JSON.stringify(meta, null, 2));

  const spawns = {
    npcs: [
      // Chickens near village farm (530-545, 525-540)
      { npcId: 1, x: 535.5, z: 530.5 },
      { npcId: 1, x: 537.5, z: 533.5 },
      { npcId: 1, x: 540.5, z: 531.5 },
      { npcId: 1, x: 538.5, z: 535.5 },

      // Rats in NW swamp
      { npcId: 2, x: 280.5, z: 290.5 },
      { npcId: 2, x: 310.5, z: 270.5 },
      { npcId: 2, x: 290.5, z: 320.5 },
      { npcId: 2, x: 320.5, z: 310.5 },

      // Goblins in SW territory (10 spawns)
      { npcId: 3, x: 282.5, z: 682.5 },
      { npcId: 3, x: 302.5, z: 702.5 },
      { npcId: 3, x: 322.5, z: 682.5 },
      { npcId: 3, x: 292.5, z: 722.5 },
      { npcId: 3, x: 342.5, z: 712.5 },
      { npcId: 3, x: 310.5, z: 690.5 },
      { npcId: 3, x: 330.5, z: 730.5 },
      { npcId: 3, x: 275.5, z: 700.5 },
      { npcId: 3, x: 350.5, z: 695.5 },
      { npcId: 3, x: 300.5, z: 740.5 },

      // Wolves in NE mountains + E forest edge
      { npcId: 4, x: 720.5, z: 310.5 },
      { npcId: 4, x: 760.5, z: 280.5 },
      { npcId: 4, x: 740.5, z: 330.5 },
      { npcId: 4, x: 680.5, z: 460.5 },
      { npcId: 4, x: 710.5, z: 470.5 },

      // Skeletons in SE ruins (6 spawns)
      { npcId: 5, x: 720.5, z: 720.5 },
      { npcId: 5, x: 760.5, z: 720.5 },
      { npcId: 5, x: 720.5, z: 760.5 },
      { npcId: 5, x: 760.5, z: 760.5 },
      { npcId: 5, x: 740.5, z: 740.5 },
      { npcId: 5, x: 780.5, z: 735.5 },

      // Spiders in E forest
      { npcId: 6, x: 730.5, z: 500.5 },
      { npcId: 6, x: 760.5, z: 520.5 },
      { npcId: 6, x: 790.5, z: 490.5 },
      { npcId: 6, x: 750.5, z: 540.5 },

      // Guards in village center
      { npcId: 7, x: 510.5, z: 510.5 },
      { npcId: 7, x: 514.5, z: 514.5 },

      // Shopkeeper inside south shop building
      { npcId: 8, x: 498.5, z: 523.5 },

      // Dark Knight boss in SE ruins boss chamber
      { npcId: 9, x: 750.5, z: 770.5 },
    ],
    objects: [
      // Trees near village (scattered)
      { objectId: 1, x: 530.5, z: 500.5 },
      { objectId: 1, x: 525.5, z: 495.5 },
      { objectId: 1, x: 540.5, z: 498.5 },
      { objectId: 1, x: 480.5, z: 500.5 },
      { objectId: 1, x: 478.5, z: 530.5 },
      { objectId: 1, x: 545.5, z: 510.5 },
      { objectId: 1, x: 535.5, z: 548.5 },
      { objectId: 1, x: 485.5, z: 548.5 },

      // Oak Trees in E forest clearings
      { objectId: 2, x: 680.5, z: 470.5 },
      { objectId: 2, x: 710.5, z: 490.5 },
      { objectId: 2, x: 740.5, z: 510.5 },
      { objectId: 2, x: 760.5, z: 470.5 },
      { objectId: 2, x: 800.5, z: 500.5 },
      { objectId: 2, x: 820.5, z: 480.5 },

      // Copper Rocks in NE mountains
      { objectId: 3, x: 730.5, z: 295.5 },
      { objectId: 3, x: 740.5, z: 310.5 },
      { objectId: 3, x: 760.5, z: 300.5 },
      { objectId: 3, x: 750.5, z: 320.5 },
      { objectId: 3, x: 770.5, z: 290.5 },

      // Iron Rocks in NE mountains (deeper)
      { objectId: 4, x: 790.5, z: 260.5 },
      { objectId: 4, x: 800.5, z: 280.5 },
      { objectId: 4, x: 810.5, z: 270.5 },

      // Fishing Spots — river banks
      { objectId: 5, x: 405.5, z: 355.5 },
      { objectId: 5, x: 485.5, z: 455.5 },
      { objectId: 5, x: 525.5, z: 558.5 },
      // Fishing Spots — swamp
      { objectId: 5, x: 290.5, z: 295.5 },
      { objectId: 5, x: 310.5, z: 305.5 },
      // Fishing Spots — south coast
      { objectId: 5, x: 480.5, z: 888.5 },
      { objectId: 5, x: 520.5, z: 888.5 },
      // Fishing Spots — village pond
      { objectId: 5, x: 560.5, z: 510.5 },

      // Furnace — village + NE mining camp
      { objectId: 6, x: 509.5, z: 515.5 },
      { objectId: 6, x: 725.5, z: 283.5 },

      // Cooking Range — village
      { objectId: 7, x: 509.5, z: 517.5 },

      // Altar — village + SE ruins
      { objectId: 8, x: 511.5, z: 515.5 },
      { objectId: 8, x: 738.5, z: 738.5 },
    ],
  };
  writeFileSync(resolve(dir, 'spawns.json'), JSON.stringify(spawns, null, 2));

  console.log('Overworld done.');
}

// --- Underground ---
{
  const dir = resolve(BASE, 'underground');
  mkdirSync(dir, { recursive: true });

  console.log('Generating underground heights (257x257)...');
  const heights = generateUndergroundHeights();

  console.log('Generating underground tiles (256x256)...');
  const undergroundResult = generateUndergroundTiles();
  const kcTiles = convertTilesToKC(undergroundResult.tiles, UNDERGROUND_SIZE);

  console.log('Writing underground map.json...');
  const kcMap = buildKCMapFile(UNDERGROUND_SIZE, UNDERGROUND_SIZE, -0.5, kcTiles, heights);
  writeFileSync(resolve(dir, 'map.json'), JSON.stringify(kcMap));

  writeFileSync(resolve(dir, 'walls.json'), JSON.stringify({ walls: undergroundResult.walls }, null, 2));
  console.log(`  ${Object.keys(undergroundResult.walls).length} wall edges written.`);

  const meta = {
    id: 'underground',
    name: 'Underground',
    width: UNDERGROUND_SIZE,
    height: UNDERGROUND_SIZE,
    waterLevel: -0.5,
    spawnPoint: { x: 130.5, z: 130.5 }, // away from transition tile at (128,128)
    fogColor: [0.1, 0.08, 0.15],
    fogStart: 8,
    fogEnd: 20,
    transitions: [
      {
        tileX: 128,
        tileZ: 128,
        targetMap: 'overworld',
        targetX: DUNGEON_ENTRANCE_X + 0.5,
        targetZ: DUNGEON_ENTRANCE_Z + 2.5,
      },
    ],
  };
  writeFileSync(resolve(dir, 'meta.json'), JSON.stringify(meta, null, 2));

  const spawns = {
    npcs: [
      // Skeletons in skeleton hall (180-205, 115-140)
      { npcId: 5, x: 190.5, z: 125.5 },
      { npcId: 5, x: 195.5, z: 130.5 },
      { npcId: 5, x: 192.5, z: 135.5 },
      { npcId: 5, x: 198.5, z: 120.5 },

      // Dark Knight boss in boss chamber (115-145, 180-205)
      { npcId: 9, x: 130.5, z: 192.5 },
    ],
    objects: [
      // Iron Rocks in mining chamber (115-140, 50-70)
      { objectId: 4, x: 125.5, z: 58.5 },
      { objectId: 4, x: 130.5, z: 55.5 },
      { objectId: 4, x: 135.5, z: 60.5 },
      { objectId: 4, x: 128.5, z: 63.5 },

      // Furnace in mining chamber
      { objectId: 6, x: 120.5, z: 55.5 },
    ],
  };
  writeFileSync(resolve(dir, 'spawns.json'), JSON.stringify(spawns, null, 2));

  console.log('Underground done.');
}

console.log('\nAll maps generated successfully!');
