import { Scene } from '@babylonjs/core/scene';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { Vector3, Quaternion } from '@babylonjs/core/Maths/math.vector';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { SceneLoader } from '@babylonjs/core/Loading/sceneLoader';
import '@babylonjs/loaders/glTF';
import { CHUNK_SIZE, CHUNK_LOAD_RADIUS, TILE_SIZE, TileType, BLOCKING_TILES, WallEdge, DEFAULT_WALL_HEIGHT, groundTypeToTileType, shouldTileRenderWater } from '@projectrs/shared';
import type { MapMeta, WallsFile, StairData, RoofData, FloorLayerData, KCMapFile, KCMapData, KCTile, GroundType, PlacedObject, TexturePlane } from '@projectrs/shared';

// --- KC Editor shading helpers ---

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function sampleNoise(x: number, z: number, scaleA = 1, scaleB = 1): number {
  return (Math.sin(x * scaleA + z * scaleB) + Math.cos(x * (scaleB * 0.73) - z * (scaleA * 0.81))) * 0.5;
}

interface RGB { r: number; g: number; b: number; }

function groundColor(type: GroundType, shade: number): RGB {
  switch (type) {
    case 'dirt':  return { r: 0.45 * shade, g: 0.31 * shade, b: 0.14 * shade };
    case 'sand':  return { r: 0.72 * shade, g: 0.60 * shade, b: 0.24 * shade };
    case 'path':  return { r: 0.42 * shade, g: 0.30 * shade, b: 0.13 * shade };
    case 'road':  return { r: 0.47 * shade, g: 0.46 * shade, b: 0.43 * shade };
    case 'water': return { r: 0.40 * shade, g: 0.47 * shade, b: 0.66 * shade };
    default:      return { r: 0.13 * shade, g: 0.43 * shade, b: 0.07 * shade }; // grass
  }
}

function getNoiseExtra(type: GroundType, vx: number, vz: number): number {
  if (type === 'grass') {
    return sampleNoise(vx * 0.18, vz * 0.18, 1.0, 1.2) * 0.10
      + sampleNoise(vx * 0.42, vz * 0.42, 0.8, 1.0) * 0.038
      + sampleNoise(vx * 2.4, vz * 2.4, 1.5, 1.9) * 0.014;
  } else if (type === 'path') {
    return sampleNoise(vx * 0.22, vz * 0.22, 1.0, 1.1) * 0.04
      + sampleNoise(vx * 1.8, vz * 1.8, 1.3, 1.7) * 0.012;
  } else if (type === 'road') {
    return sampleNoise(vx * 1.2, vz * 1.2, 1.5, 0.9) * 0.025
      + sampleNoise(vx * 3.0, vz * 3.0, 2.0, 1.5) * 0.01;
  } else if (type === 'dirt' || type === 'sand') {
    return sampleNoise(vx * 0.5, vz * 0.5, 0.8, 1.1) * 0.02;
  }
  return 0;
}

// --- Building mesh types ---

interface FloorMeshSet {
  wall: Mesh | null;
  roof: Mesh | null;
  floor: Mesh | null;
  stairs: Mesh | null;
}

interface ChunkMeshes {
  ground: Mesh;
  water: Mesh | null;
  cliff: Mesh | null;
  wall: Mesh | null;
  roof: Mesh | null;
  floor: Mesh | null;
  stairs: Mesh | null;
  upperFloors: Map<number, FloorMeshSet>;
}

interface FloorLayerClientData {
  walls: Map<number, number>;
  wallHeights: Map<number, number>;
  floors: Map<number, number>;
  stairs: Map<number, StairData>;
  roofs: Map<number, RoofData>;
}

/**
 * Client-side chunk manager.
 * Loads KC editor map.json via HTTP, builds/destroys chunk terrain
 * meshes based on player position.
 */
export class ChunkManager {
  private scene: Scene;
  private mapId: string = '';
  private meta: MapMeta | null = null;

  // KC map data
  private mapData: KCMapData | null = null;
  private mapWidth: number = 0;
  private mapHeight: number = 0;

  // Cached flat arrays for fast access
  private heights: Float32Array | null = null;
  private tileTypes: Uint8Array | null = null;

  // Building data
  private walls: Uint8Array | null = null;
  private wallHeights: Map<number, number> = new Map();
  private floorHeights: Map<number, number> = new Map();
  private stairData: Map<number, StairData> = new Map();
  private roofData: Map<number, RoofData> = new Map();
  private texturePlaneFloorTiles: Set<number> = new Set(); // floors from texture planes (don't render floor mesh)

  // Multi-floor layer data (floor 1+)
  private floorLayerData: Map<number, FloorLayerClientData> = new Map();
  private currentFloor: number = 0;

  // Active chunk meshes
  private chunks: Map<string, ChunkMeshes> = new Map();
  private lastChunkX: number = -999;
  private lastChunkZ: number = -999;

  // Shared materials
  private groundMat: StandardMaterial | null = null;
  private waterMat: StandardMaterial | null = null;
  private cliffMat: StandardMaterial | null = null;
  private wallMat: StandardMaterial | null = null;
  private roofMat: StandardMaterial | null = null;
  private floorMat: StandardMaterial | null = null;
  private stairMat: StandardMaterial | null = null;

  private loaded: boolean = false;

  // Water texture + animation
  private waterTexture: Texture | null = null;
  private waterStartTime: number = 0;

  // Placed objects and texture planes from KC editor
  private placedObjectNodes: TransformNode[] = [];
  private texturePlaneMeshes: Mesh[] = [];
  private assetRegistry: Map<string, { path: string }> = new Map();
  private loadedModelCache: Map<string, TransformNode | null> = new Map();
  private textureCache: Map<string, Texture> = new Map();
  private textureRegistry: Map<string, { path: string }> = new Map();

  constructor(scene: Scene) {
    this.scene = scene;
  }

  isLoaded(): boolean { return this.loaded; }
  getMeta(): MapMeta | null { return this.meta; }
  getMapWidth(): number { return this.mapWidth; }
  getMapHeight(): number { return this.mapHeight; }

  /** Load map data from server via HTTP */
  async loadMap(mapId: string): Promise<void> {
    this.disposeAll();
    this.loaded = false;
    this.mapId = mapId;

    const cacheBust = `?t=${Date.now()}`;

    // Fetch meta
    const metaRes = await fetch(`/maps/${mapId}/meta.json${cacheBust}`);
    this.meta = await metaRes.json() as MapMeta;
    this.mapWidth = this.meta.width;
    this.mapHeight = this.meta.height;

    // Fetch KC map data
    const mapRes = await fetch(`/maps/${mapId}/map.json${cacheBust}`);
    const mapFile: KCMapFile = await mapRes.json();
    this.mapData = mapFile.map;

    // Build height cache
    const vw = this.mapWidth + 1;
    const vh = this.mapHeight + 1;
    this.heights = new Float32Array(vw * vh);
    for (let z = 0; z <= this.mapHeight; z++) {
      for (let x = 0; x <= this.mapWidth; x++) {
        this.heights[z * vw + x] = this.mapData.heights[z]?.[x] ?? 0;
      }
    }

    // Build tile type cache for collision/pathfinding
    this.tileTypes = new Uint8Array(this.mapWidth * this.mapHeight);
    for (let z = 0; z < this.mapHeight; z++) {
      for (let x = 0; x < this.mapWidth; x++) {
        const tile = this.getTileRaw(x, z);
        if (!tile) { this.tileTypes[z * this.mapWidth + x] = TileType.GRASS; continue; }
        const corners = this.getTileCornerHeights(x, z);
        const wl = this.getChunkWaterLevel(x, z);
        if (shouldTileRenderWater(tile, corners, wl)) {
          this.tileTypes[z * this.mapWidth + x] = TileType.WATER;
        } else {
          this.tileTypes[z * this.mapWidth + x] = groundTypeToTileType(tile.ground);
        }
      }
    }

    // Fetch walls data
    this.walls = new Uint8Array(this.mapWidth * this.mapHeight);
    this.wallHeights.clear();
    this.floorHeights.clear();
    this.stairData.clear();
    this.roofData.clear();
    this.floorLayerData.clear();
    this.currentFloor = 0;
    try {
      const wallsRes = await fetch(`/maps/${mapId}/walls.json${cacheBust}`);
      if (wallsRes.ok) {
        const wallsData: WallsFile = await wallsRes.json();
        const parseKey = (key: string): number | null => {
          const [xStr, zStr] = key.split(',');
          const x = parseInt(xStr);
          const z = parseInt(zStr);
          if (x >= 0 && x < this.mapWidth && z >= 0 && z < this.mapHeight) return z * this.mapWidth + x;
          return null;
        };
        for (const [key, mask] of Object.entries(wallsData.walls)) {
          const idx = parseKey(key);
          if (idx !== null) this.walls[idx] = mask;
        }
        if (wallsData.wallHeights) for (const [key, h] of Object.entries(wallsData.wallHeights)) { const idx = parseKey(key); if (idx !== null) this.wallHeights.set(idx, h); }
        if (wallsData.floors) for (const [key, h] of Object.entries(wallsData.floors)) { const idx = parseKey(key); if (idx !== null) this.floorHeights.set(idx, h); }
        if (wallsData.stairs) for (const [key, data] of Object.entries(wallsData.stairs)) { const idx = parseKey(key); if (idx !== null) this.stairData.set(idx, data); }
        if (wallsData.roofs) for (const [key, data] of Object.entries(wallsData.roofs)) { const idx = parseKey(key); if (idx !== null) this.roofData.set(idx, data); }
        if (wallsData.floorLayers) {
          for (const [floorStr, ld] of Object.entries(wallsData.floorLayers)) {
            const floorIdx = parseInt(floorStr as string);
            const layer: FloorLayerClientData = { walls: new Map(), wallHeights: new Map(), floors: new Map(), stairs: new Map(), roofs: new Map() };
            const ldd = ld as FloorLayerData;
            if (ldd.walls) for (const [k, v] of Object.entries(ldd.walls)) { const i = parseKey(k); if (i !== null) layer.walls.set(i, v); }
            if (ldd.wallHeights) for (const [k, v] of Object.entries(ldd.wallHeights)) { const i = parseKey(k); if (i !== null) layer.wallHeights.set(i, v); }
            if (ldd.floors) for (const [k, v] of Object.entries(ldd.floors)) { const i = parseKey(k); if (i !== null) layer.floors.set(i, v); }
            if (ldd.stairs) for (const [k, v] of Object.entries(ldd.stairs)) { const i = parseKey(k); if (i !== null) layer.stairs.set(i, v as StairData); }
            if (ldd.roofs) for (const [k, v] of Object.entries(ldd.roofs)) { const i = parseKey(k); if (i !== null) layer.roofs.set(i, v as RoofData); }
            this.floorLayerData.set(floorIdx, layer);
          }
        }
      }
    } catch { /* no walls.json */ }

    // Create shared materials
    if (!this.groundMat) {
      this.groundMat = new StandardMaterial('chunkGroundMat', this.scene);
      this.groundMat.specularColor = new Color3(0, 0, 0);
    }
    if (!this.waterMat) {
      this.waterMat = new StandardMaterial('chunkWaterMat', this.scene);
      this.waterMat.specularColor = new Color3(0.3, 0.3, 0.4);
      this.waterMat.alpha = 0.88;
      this.waterMat.diffuseColor = new Color3(0.83, 0.91, 1.0); // 0xd4e8ff tint
      // Load water texture
      this.waterTexture = new Texture('/assets/textures/1.png', this.scene);
      this.waterTexture.uScale = 1;
      this.waterTexture.vScale = 1;
      this.waterTexture.wrapU = Texture.WRAP_ADDRESSMODE;
      this.waterTexture.wrapV = Texture.WRAP_ADDRESSMODE;
      this.waterMat.diffuseTexture = this.waterTexture;
      this.waterStartTime = performance.now() / 1000;
    }
    if (!this.cliffMat) {
      this.cliffMat = new StandardMaterial('chunkCliffMat', this.scene);
      this.cliffMat.specularColor = new Color3(0, 0, 0);
      this.cliffMat.backFaceCulling = false;
    }
    if (!this.wallMat) {
      this.wallMat = new StandardMaterial('chunkWallMat', this.scene);
      this.wallMat.specularColor = new Color3(0.05, 0.05, 0.05);
      this.wallMat.backFaceCulling = false;
    }
    if (!this.roofMat) {
      this.roofMat = new StandardMaterial('chunkRoofMat', this.scene);
      this.roofMat.specularColor = new Color3(0.05, 0.05, 0.05);
      this.roofMat.backFaceCulling = false;
    }
    if (!this.floorMat) {
      this.floorMat = new StandardMaterial('chunkFloorMat', this.scene);
      this.floorMat.specularColor = new Color3(0, 0, 0);
    }
    if (!this.stairMat) {
      this.stairMat = new StandardMaterial('chunkStairMat', this.scene);
      this.stairMat.specularColor = new Color3(0.05, 0.05, 0.05);
    }

    // Load asset/texture registry before marking loaded so chunk texture overlays work immediately
    await this.loadAssetRegistry();

    this.loaded = true;
    this.lastChunkX = -999;
    this.lastChunkZ = -999;
    console.log(`[ChunkManager] Loaded map '${mapId}': ${this.mapWidth}x${this.mapHeight}, tiles: ${this.mapData?.tiles?.length}, heights: ${this.mapData?.heights?.length}, waterLevel: ${this.mapData?.waterLevel}`);

    // Register horizontal texture planes as walkable floors (bridges, platforms)
    this.registerTexturePlaneFloors();

    // Load KC placed objects and texture planes
    this.loadPlacedObjects(mapFile.placedObjects || []);
    this.loadTexturePlanes(this.mapData!.texturePlanes || []);
  }

  // --- KC data accessors ---

  private getTileRaw(x: number, z: number): KCTile | null {
    if (!this.mapData) return null;
    if (x < 0 || x >= this.mapWidth || z < 0 || z >= this.mapHeight) return null;
    return this.mapData.tiles[z]?.[x] ?? null;
  }

  private getBaseGroundType(x: number, z: number): GroundType {
    const tile = this.getTileRaw(x, z);
    return tile?.ground ?? 'grass';
  }

  private getChunkWaterLevel(tileX: number, tileZ: number): number {
    if (!this.mapData) return -0.3;
    const chunkX = Math.floor(tileX / 64);
    const chunkZ = Math.floor(tileZ / 64);
    const key = `${chunkX},${chunkZ}`;
    return this.mapData.chunkWaterLevels[key] ?? this.mapData.waterLevel;
  }

  private shouldRenderWater(x: number, z: number): boolean {
    const tile = this.getTileRaw(x, z);
    if (!tile) return false;
    if (tile.waterPainted) return true;
    const corners = this.getTileCornerHeights(x, z);
    return shouldTileRenderWater(tile, corners, this.getChunkWaterLevel(x, z));
  }

  private getTileCornerHeights(x: number, z: number): { tl: number; tr: number; bl: number; br: number } {
    return {
      tl: this.getVertexHeight(x, z),
      tr: this.getVertexHeight(x + 1, z),
      bl: this.getVertexHeight(x, z + 1),
      br: this.getVertexHeight(x + 1, z + 1),
    };
  }

  // --- KC shading methods ---

  private getSlopeShade(h: { tl: number; tr: number; bl: number; br: number }): number {
    const dx = ((h.tr + h.br) - (h.tl + h.bl)) * 0.5;
    const dz = ((h.bl + h.br) - (h.tl + h.tr)) * 0.5;
    const steepness = Math.abs(dx) + Math.abs(dz);
    let shade = 1.0 - steepness * 0.22;
    shade += (-dx * 0.18) + (-dz * 0.12);
    return clamp(shade, 0.46, 1.04);
  }

  private getVertexSlopeShade(vx: number, vz: number): number {
    const sharingTiles: [number, number][] = [[vx - 1, vz - 1], [vx, vz - 1], [vx - 1, vz], [vx, vz]];
    let total = 0, count = 0;
    for (const [tx, tz] of sharingTiles) {
      if (!this.getTileRaw(tx, tz)) continue;
      total += this.getSlopeShade(this.getTileCornerHeights(tx, tz));
      count++;
    }
    return count > 0 ? total / count : 1.0;
  }

  private getVertexAO(vx: number, vz: number): number {
    const h = this.getVertexHeight(vx, vz);
    let sum = 0, count = 0;
    for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as [number, number][]) {
      const nx = vx + dx, nz = vz + dz;
      if (nx < 0 || nx > this.mapWidth || nz < 0 || nz > this.mapHeight) continue;
      sum += this.getVertexHeight(nx, nz);
      count++;
    }
    if (count === 0) return 1.0;
    const depression = (sum / count) - h;
    return 1.0 - clamp(depression * 0.16, 0, 0.40);
  }

  private getVertexWaterProximity(vx: number, vz: number): number {
    let maxProx = 0;
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        const tx = vx + dx, tz = vz + dz;
        if (!this.shouldRenderWater(tx, tz)) continue;
        const cx = clamp(vx, tx, tx + 1);
        const cz = clamp(vz, tz, tz + 1);
        const dist = Math.sqrt((vx - cx) * (vx - cx) + (vz - cz) * (vz - cz));
        const prox = Math.max(0, 1 - dist / 2.5);
        if (prox > maxProx) maxProx = prox;
      }
    }
    return maxProx;
  }

  private isCliffNearby(x: number, z: number): boolean {
    const h = this.getTileCornerHeights(x, z);
    const minH = Math.min(h.tl, h.tr, h.bl, h.br);
    const maxH = Math.max(h.tl, h.tr, h.bl, h.br);
    if ((maxH - minH) > 1.1) return true;
    const centerAvg = (h.tl + h.tr + h.bl + h.br) / 4;
    for (const [nx, nz] of [[x - 1, z], [x + 1, z], [x, z - 1], [x, z + 1]] as [number, number][]) {
      if (!this.getTileRaw(nx, nz)) continue;
      const nh = this.getTileCornerHeights(nx, nz);
      const nAvg = (nh.tl + nh.tr + nh.bl + nh.br) / 4;
      if (Math.abs(centerAvg - nAvg) > 0.9) return true;
    }
    return false;
  }

  private getCornerBlendedColor(cornerX: number, cornerZ: number, shade: number): RGB {
    const sharingTiles: [number, number][] = [[cornerX - 1, cornerZ - 1], [cornerX, cornerZ - 1], [cornerX - 1, cornerZ], [cornerX, cornerZ]];
    let r = 0, g = 0, b = 0, noise = 0, totalWeight = 0;
    for (const [nx, nz] of sharingTiles) {
      if (!this.getTileRaw(nx, nz)) continue;
      const type = this.getBaseGroundType(nx, nz);
      if (type === 'road') continue; // road doesn't bleed into neighbours
      const c = groundColor(type, 1.0);
      r += c.r; g += c.g; b += c.b;
      noise += getNoiseExtra(type, cornerX, cornerZ);
      totalWeight += 1;
    }
    if (totalWeight === 0) return groundColor('grass', shade);
    const s = shade + noise / totalWeight;
    return { r: (r / totalWeight) * s, g: (g / totalWeight) * s, b: (b / totalWeight) * s };
  }

  // --- Chunk update ---

  updatePlayerPosition(playerX: number, playerZ: number): void {
    if (!this.loaded) { return; }
    const cx = Math.floor(playerX / CHUNK_SIZE);
    const cz = Math.floor(playerZ / CHUNK_SIZE);
    if (cx === this.lastChunkX && cz === this.lastChunkZ) return;
    console.log(`[ChunkManager] updatePlayerPosition(${playerX}, ${playerZ}) => chunk (${cx}, ${cz}), mapSize: ${this.mapWidth}x${this.mapHeight}`);
    this.lastChunkX = cx;
    this.lastChunkZ = cz;

    const desired = new Set<string>();
    for (let dx = -CHUNK_LOAD_RADIUS; dx <= CHUNK_LOAD_RADIUS; dx++) {
      for (let dz = -CHUNK_LOAD_RADIUS; dz <= CHUNK_LOAD_RADIUS; dz++) {
        const chunkX = cx + dx;
        const chunkZ = cz + dz;
        const maxCX = Math.ceil(this.mapWidth / CHUNK_SIZE);
        const maxCZ = Math.ceil(this.mapHeight / CHUNK_SIZE);
        if (chunkX >= 0 && chunkX < maxCX && chunkZ >= 0 && chunkZ < maxCZ) {
          desired.add(`${chunkX},${chunkZ}`);
        }
      }
    }

    for (const [key, meshes] of this.chunks) {
      if (!desired.has(key)) {
        meshes.ground.dispose();
        meshes.water?.dispose();
        meshes.cliff?.dispose();
        meshes.wall?.dispose();
        meshes.roof?.dispose();
        meshes.floor?.dispose();
        meshes.stairs?.dispose();
        for (const [, floorSet] of meshes.upperFloors) {
          floorSet.wall?.dispose();
          floorSet.roof?.dispose();
          floorSet.floor?.dispose();
          floorSet.stairs?.dispose();
        }
        this.chunks.delete(key);
      }
    }

    for (const key of desired) {
      if (!this.chunks.has(key)) {
        const [chunkX, chunkZ] = key.split(',').map(Number);
        const meshes = this.buildChunkMeshes(chunkX, chunkZ);
        this.chunks.set(key, meshes);
      }
    }
  }

  private buildChunkMeshes(chunkX: number, chunkZ: number): ChunkMeshes {
    const startX = chunkX * CHUNK_SIZE;
    const startZ = chunkZ * CHUNK_SIZE;
    const endX = Math.min(startX + CHUNK_SIZE, this.mapWidth);
    const endZ = Math.min(startZ + CHUNK_SIZE, this.mapHeight);

    console.log(`[ChunkManager] Building chunk (${chunkX},${chunkZ}): tiles ${startX}-${endX}, ${startZ}-${endZ}`);
    const ground = this.buildGroundMesh(chunkX, chunkZ, startX, startZ, endX, endZ);
    this.buildTextureOverlays(chunkX, chunkZ, startX, startZ, endX, endZ);
    console.log(`[ChunkManager] Ground mesh vertices: ${ground.getTotalVertices()}`);
    const water = this.buildWaterMesh(chunkX, chunkZ, startX, startZ, endX, endZ);
    const cliff = this.buildCliffMesh(chunkX, chunkZ, startX, startZ, endX, endZ);
    const wall = this.buildWallMesh(chunkX, chunkZ, startX, startZ, endX, endZ);
    const roof = this.buildRoofMesh(chunkX, chunkZ, startX, startZ, endX, endZ);
    const floor = this.buildFloorMesh(chunkX, chunkZ, startX, startZ, endX, endZ);
    const stairs = this.buildStairMesh(chunkX, chunkZ, startX, startZ, endX, endZ);

    const upperFloors = new Map<number, FloorMeshSet>();
    for (const [floorIdx, layerData] of this.floorLayerData) {
      const floorSet = this.buildFloorLayerMeshes(chunkX, chunkZ, startX, startZ, endX, endZ, floorIdx, layerData);
      if (floorSet) {
        upperFloors.set(floorIdx, floorSet);
        this.setFloorMeshSetVisibility(floorSet, floorIdx);
      }
    }

    return { ground, water, cliff, wall, roof, floor, stairs, upperFloors };
  }

  // --- Ground mesh with KC editor shading ---

  private buildGroundMesh(chunkX: number, chunkZ: number, startX: number, startZ: number, endX: number, endZ: number): Mesh {
    const positions: number[] = [];
    const indices: number[] = [];
    const colors: number[] = [];
    let vertexIndex = 0;

    for (let x = startX; x < endX; x++) {
      for (let z = startZ; z < endZ; z++) {
        const tile = this.getTileRaw(x, z);
        const tileType = tile?.ground ?? 'grass';
        const h = this.getTileCornerHeights(x, z);
        const splitDir = tile?.split ?? 'forward';
        const groundBType = tile?.groundB ?? null;

        // Compute per-vertex shading
        const shadeTL = this.getVertexSlopeShade(x, z);
        const shadeTR = this.getVertexSlopeShade(x + 1, z);
        const shadeBL = this.getVertexSlopeShade(x, z + 1);
        const shadeBR = this.getVertexSlopeShade(x + 1, z + 1);
        const slopeShade = (shadeTL + shadeTR + shadeBL + shadeBR) / 4;

        let cTL: RGB, cTR: RGB, cBL: RGB, cBR: RGB;

        if (groundBType && groundBType !== tileType) {
          // Split tile: flat solid color per triangle
          const noiseA = getNoiseExtra(tileType, x + 0.25, z + 0.25);
          const noiseB = getNoiseExtra(groundBType, x + 0.75, z + 0.75);
          const cA = groundColor(tileType, Math.max(slopeShade + noiseA, 0.5));
          const cB = groundColor(groundBType, Math.max(slopeShade + noiseB, 0.5));
          const avgAO = (this.getVertexAO(x, z) + this.getVertexAO(x + 1, z) + this.getVertexAO(x, z + 1) + this.getVertexAO(x + 1, z + 1)) / 4;
          cA.r *= avgAO; cA.g *= avgAO; cA.b *= avgAO;
          cB.r *= avgAO; cB.g *= avgAO; cB.b *= avgAO;

          if (splitDir === 'forward') {
            // Triangle A (CCW): TL, TR, BL
            positions.push(x, h.tl, z, x + 1, h.tr, z, x, h.bl, z + 1);
            colors.push(cA.r, cA.g, cA.b, 1, cA.r, cA.g, cA.b, 1, cA.r, cA.g, cA.b, 1);
            // Triangle B (CCW): TR, BR, BL
            positions.push(x + 1, h.tr, z, x + 1, h.br, z + 1, x, h.bl, z + 1);
            colors.push(cB.r, cB.g, cB.b, 1, cB.r, cB.g, cB.b, 1, cB.r, cB.g, cB.b, 1);
          } else {
            // Triangle A (CCW): TL, TR, BR
            positions.push(x, h.tl, z, x + 1, h.tr, z, x + 1, h.br, z + 1);
            colors.push(cA.r, cA.g, cA.b, 1, cA.r, cA.g, cA.b, 1, cA.r, cA.g, cA.b, 1);
            // Triangle B (CCW): TL, BR, BL
            positions.push(x, h.tl, z, x + 1, h.br, z + 1, x, h.bl, z + 1);
            colors.push(cB.r, cB.g, cB.b, 1, cB.r, cB.g, cB.b, 1, cB.r, cB.g, cB.b, 1);
          }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex + 3, vertexIndex + 4, vertexIndex + 5);
          vertexIndex += 6;
          continue;
        }

        // Normal tile: per-vertex blended colors
        if (tileType === 'road') {
          const noise = getNoiseExtra('road', x + 0.5, z + 0.5);
          cTL = groundColor('road', Math.max(shadeTL + noise, 0.5));
          cTR = groundColor('road', Math.max(shadeTR + noise, 0.5));
          cBL = groundColor('road', Math.max(shadeBL + noise, 0.5));
          cBR = groundColor('road', Math.max(shadeBR + noise, 0.5));
        } else {
          cTL = this.getCornerBlendedColor(x, z, shadeTL);
          cTR = this.getCornerBlendedColor(x + 1, z, shadeTR);
          cBL = this.getCornerBlendedColor(x, z + 1, shadeBL);
          cBR = this.getCornerBlendedColor(x + 1, z + 1, shadeBR);
        }

        const nearCliff = this.isCliffNearby(x, z);
        const wLevel = this.getChunkWaterLevel(x, z);

        if (tileType !== 'water') {
          // Water proximity mud tinting
          const proxTL = this.getVertexWaterProximity(x, z);
          const proxTR = this.getVertexWaterProximity(x + 1, z);
          const proxBL = this.getVertexWaterProximity(x, z + 1);
          const proxBR = this.getVertexWaterProximity(x + 1, z + 1);
          const applyMud = (c: RGB, t: number) => {
            if (t <= 0) return;
            c.r *= 1 + t * 0.18; c.g *= 1 - t * 0.22; c.b *= 1 - t * 0.28;
          };
          applyMud(cTL, proxTL); applyMud(cTR, proxTR); applyMud(cBL, proxBL); applyMud(cBR, proxBR);

          // Underwater darkening
          const applyDepth = (c: RGB, vertH: number) => {
            const depth = clamp((wLevel - vertH) / 2.5, 0, 1);
            if (depth <= 0) return;
            c.r *= 1 - depth * 0.60; c.g *= 1 - depth * 0.45; c.b *= 1 - depth * 0.20;
          };
          applyDepth(cTL, h.tl); applyDepth(cTR, h.tr); applyDepth(cBL, h.bl); applyDepth(cBR, h.br);
        }

        // Cliff saturation boost
        if (tileType !== 'water' && nearCliff) {
          for (const c of [cTL, cTR, cBL, cBR]) { c.r *= 1.04; c.g *= 0.92; c.b *= 0.84; }
        }

        // Vertex AO
        if (tileType !== 'water') {
          const aoTL = this.getVertexAO(x, z);
          const aoTR = this.getVertexAO(x + 1, z);
          const aoBL = this.getVertexAO(x, z + 1);
          const aoBR = this.getVertexAO(x + 1, z + 1);
          cTL.r *= aoTL; cTL.g *= aoTL; cTL.b *= aoTL;
          cTR.r *= aoTR; cTR.g *= aoTR; cTR.b *= aoTR;
          cBL.r *= aoBL; cBL.g *= aoBL; cBL.b *= aoBL;
          cBR.r *= aoBR; cBR.g *= aoBR; cBR.b *= aoBR;
        }

        // Emit quad (4 vertices)
        positions.push(x, h.tl, z, x + 1, h.tr, z, x, h.bl, z + 1, x + 1, h.br, z + 1);
        colors.push(
          cTL.r, cTL.g, cTL.b, 1,
          cTR.r, cTR.g, cTR.b, 1,
          cBL.r, cBL.g, cBL.b, 1,
          cBR.r, cBR.g, cBR.b, 1,
        );

        if (splitDir === 'forward') {
          // 0=TL, 1=TR, 2=BL, 3=BR; diagonal TL-BR; CCW winding for upward normals
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex + 1, vertexIndex + 3, vertexIndex + 2);
        } else {
          // diagonal TR-BL
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 3, vertexIndex, vertexIndex + 3, vertexIndex + 2);
        }
        vertexIndex += 4;
      }
    }

    const mesh = new Mesh(`chunk_${chunkX}_${chunkZ}`, this.scene);
    const vertexData = new VertexData();
    vertexData.positions = positions;
    vertexData.indices = indices;
    vertexData.colors = colors;
    const normals: number[] = [];
    VertexData.ComputeNormals(positions, indices, normals);
    vertexData.normals = normals;
    vertexData.applyToMesh(mesh);
    mesh.material = this.groundMat;
    mesh.hasVertexAlpha = false;
    mesh.isPickable = true;
    return mesh;
  }

  // --- Water mesh with per-chunk water levels ---

  private buildWaterMesh(chunkX: number, chunkZ: number, startX: number, startZ: number, endX: number, endZ: number): Mesh | null {
    const positions: number[] = [];
    const indices: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    let vertexIndex = 0;
    let hasWater = false;

    const WATER_UV_SCALE = 5;

    for (let x = startX; x < endX; x++) {
      for (let z = startZ; z < endZ; z++) {
        if (!this.shouldRenderWater(x, z)) continue;
        hasWater = true;

        const wY = this.getChunkWaterLevel(x, z) + 0.02;
        // CCW winding for RHS
        positions.push(x, wY, z, x + 1, wY, z, x + 1, wY, z + 1, x, wY, z + 1);
        // World-space UVs for seamless water tiling
        const u0 = x / WATER_UV_SCALE, u1 = (x + 1) / WATER_UV_SCALE;
        const v0 = z / WATER_UV_SCALE, v1 = (z + 1) / WATER_UV_SCALE;
        uvs.push(u0, v0, u1, v0, u1, v1, u0, v1);
        for (let i = 0; i < 4; i++) normals.push(0, 1, 0);
        indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3);
        vertexIndex += 4;
      }
    }

    if (!hasWater) return null;
    const mesh = new Mesh(`water_${chunkX}_${chunkZ}`, this.scene);
    const vertexData = new VertexData();
    vertexData.positions = positions;
    vertexData.indices = indices;
    vertexData.normals = normals;
    vertexData.uvs = uvs;
    vertexData.applyToMesh(mesh);
    mesh.material = this.waterMat;
    mesh.isPickable = false;
    mesh.renderingGroupId = 1; // Render before texture planes (group 2) so planes appear on top
    return mesh;
  }

  // --- Cliff mesh (vertical faces between height differences) ---

  private buildCliffMesh(chunkX: number, chunkZ: number, startX: number, startZ: number, endX: number, endZ: number): Mesh | null {
    const positions: number[] = [];
    const indices: number[] = [];
    const colors: number[] = [];
    let base = 0;
    let hasCliff = false;

    const cliffColor = (topY: number, bottomY: number): RGB => {
      const drop = Math.max(0, topY - bottomY);
      const shade = clamp(0.92 - drop * 0.12, 0.42, 0.92);
      return { r: 0.37 * shade, g: 0.29 * shade, b: 0.12 * shade };
    };

    const pushQuad = (a: number[], b: number[], c: number[], d: number[], color: RGB) => {
      positions.push(...a, ...b, ...c, ...d);
      for (let i = 0; i < 4; i++) colors.push(color.r, color.g, color.b, 1);
      indices.push(base, base + 2, base + 1, base + 2, base + 3, base + 1);
      base += 4;
    };

    for (let x = startX; x < endX; x++) {
      for (let z = startZ; z < endZ; z++) {
        const h = this.getTileCornerHeights(x, z);
        const wl = this.getChunkWaterLevel(x, z);

        // Check right neighbor
        if (x + 1 < this.mapWidth) {
          const rh = this.getTileCornerHeights(x + 1, z);
          const topR = h.tr, topBR = h.br;
          const botR = rh.tl, botBR = rh.bl;
          if (Math.abs(topR - botR) > 0.01 || Math.abs(topBR - botBR) > 0.01) {
            const maxTop = Math.max(topR, botR);
            const maxBot = Math.max(topBR, botBR);
            if (maxTop > wl || maxBot > wl) {
              hasCliff = true;
              const color = cliffColor((topR + topBR) / 2, (botR + botBR) / 2);
              pushQuad(
                [x + 1, topR, z],
                [x + 1, topBR, z + 1],
                [x + 1, botR, z],
                [x + 1, botBR, z + 1],
                color,
              );
            }
          }
        }

        // Check bottom neighbor
        if (z + 1 < this.mapHeight) {
          const bh = this.getTileCornerHeights(x, z + 1);
          const topB = h.bl, topBR = h.br;
          const botB = bh.tl, botBR = bh.tr;
          if (Math.abs(topB - botB) > 0.01 || Math.abs(topBR - botBR) > 0.01) {
            const maxTop = Math.max(topB, botB);
            const maxBot = Math.max(topBR, botBR);
            if (maxTop > wl || maxBot > wl) {
              hasCliff = true;
              const color = cliffColor((topB + topBR) / 2, (botB + botBR) / 2);
              pushQuad(
                [x, topB, z + 1],
                [x + 1, topBR, z + 1],
                [x, botB, z + 1],
                [x + 1, botBR, z + 1],
                color,
              );
            }
          }
        }
      }
    }

    if (!hasCliff) return null;
    const mesh = new Mesh(`cliff_${chunkX}_${chunkZ}`, this.scene);
    const vertexData = new VertexData();
    vertexData.positions = positions;
    vertexData.indices = indices;
    vertexData.colors = colors;
    const normals: number[] = [];
    VertexData.ComputeNormals(positions, indices, normals);
    vertexData.normals = normals;
    vertexData.applyToMesh(mesh);
    mesh.material = this.cliffMat;
    mesh.hasVertexAlpha = false;
    mesh.isPickable = false;
    return mesh;
  }

  // --- Tile texture overlays (painted textures on individual tiles) ---

  private buildTextureOverlays(chunkX: number, chunkZ: number, startX: number, startZ: number, endX: number, endZ: number): void {
    for (let x = startX; x < endX; x++) {
      for (let z = startZ; z < endZ; z++) {
        const tile = this.getTileRaw(x, z);
        if (!tile || (!tile.textureId && !tile.textureIdB)) continue;

        const h = this.getTileCornerHeights(x, z);
        const offset = 0.008;
        const splitFwd = tile.split === 'forward';

        const buildOverlay = (textureId: string, rotation: number, scale: number, worldUV: boolean, useFirst: boolean) => {
          const tex = this.getOrLoadTexture(textureId);
          if (!tex) return;

          const positions = [x, h.tl + offset, z, x + 1, h.tr + offset, z, x, h.bl + offset, z + 1, x + 1, h.br + offset, z + 1];
          const s = Math.max(0.1, scale);
          let uvs: number[];
          if (worldUV) {
            uvs = [x / s, z / s, (x + 1) / s, z / s, x / s, (z + 1) / s, (x + 1) / s, (z + 1) / s];
          } else {
            // Simple scaled UVs (rotation handled by UV transform)
            const base = [[0, 0], [1, 0], [0, 1], [1, 1]];
            const r = rotation % 4;
            uvs = [];
            for (const [u, v] of base) {
              const su = (u - 0.5) / s + 0.5, sv = (v - 0.5) / s + 0.5;
              let ru = su, rv = sv;
              if (r === 1) { ru = -(sv - 0.5) + 0.5; rv = (su - 0.5) + 0.5; }
              else if (r === 2) { ru = -(su - 0.5) + 0.5; rv = -(sv - 0.5) + 0.5; }
              else if (r === 3) { ru = (sv - 0.5) + 0.5; rv = -(su - 0.5) + 0.5; }
              uvs.push(ru, rv);
            }
          }

          let indices: number[];
          if (tile.textureHalfMode) {
            indices = useFirst
              ? (splitFwd ? [0, 2, 1] : [0, 2, 3])
              : (splitFwd ? [2, 3, 1] : [0, 3, 1]);
          } else {
            indices = splitFwd ? [0, 2, 1, 2, 3, 1] : [0, 2, 3, 0, 3, 1];
          }

          const mesh = new Mesh(`texoverlay_${x}_${z}`, this.scene);
          const vd = new VertexData();
          vd.positions = positions;
          vd.uvs = uvs;
          vd.indices = indices;
          const normals: number[] = [];
          VertexData.ComputeNormals(positions, indices, normals);
          vd.normals = normals;
          vd.applyToMesh(mesh);

          const mat = new StandardMaterial(`texoverlay_mat_${x}_${z}`, this.scene);
          mat.diffuseTexture = tex;
          mat.diffuseColor = new Color3(0.82, 0.82, 0.82);
          mat.specularColor = new Color3(0, 0, 0);
          mat.useAlphaFromDiffuseTexture = true;
          mat.backFaceCulling = false;
          mesh.material = mat;
          mesh.isPickable = false;
          this.texturePlaneMeshes.push(mesh); // reuse disposal list
        };

        if (tile.textureHalfMode) {
          if (tile.textureId) buildOverlay(tile.textureId, tile.textureRotation, tile.textureScale, tile.textureWorldUV, true);
          if (tile.textureIdB) buildOverlay(tile.textureIdB, tile.textureRotationB, tile.textureScaleB, false, false);
        } else if (tile.textureId) {
          buildOverlay(tile.textureId, tile.textureRotation, tile.textureScale, tile.textureWorldUV, true);
        }
      }
    }
  }

  // --- Wall, Roof, Floor, Stair mesh builders (same as before) ---

  private buildWallMesh(chunkX: number, chunkZ: number, startX: number, startZ: number, endX: number, endZ: number): Mesh | null {
    if (!this.walls) return null;
    const positions: number[] = [];
    const indices: number[] = [];
    const normals: number[] = [];
    const colors: number[] = [];
    let vertexIndex = 0;
    let hasWalls = false;
    const WALL_THICKNESS = 0.1;
    const cr = 0.35, cg = 0.30, cb = 0.30;

    for (let x = startX; x < endX; x++) {
      for (let z = startZ; z < endZ; z++) {
        const mask = this.getWallRaw(x, z);
        if (mask === 0) continue;
        hasWalls = true;
        const tileIdx = z * this.mapWidth + x;
        const wallH = this.wallHeights.get(tileIdx) ?? DEFAULT_WALL_HEIGHT;
        const floorH = this.floorHeights.get(tileIdx) ?? 0;
        const x0 = x * TILE_SIZE, x1 = (x + 1) * TILE_SIZE;
        const z0 = z * TILE_SIZE, z1 = (z + 1) * TILE_SIZE;

        if (mask & WallEdge.N) {
          const yL = this.getVertexHeight(x, z) + floorH, yR = this.getVertexHeight(x + 1, z) + floorH;
          const ytL = yL + wallH, ytR = yR + wallH;
          positions.push(x0, yL, z0, x0, ytL, z0, x1, ytR, z0, x1, yR, z0);
          for (let i = 0; i < 4; i++) { normals.push(0, 0, -1); colors.push(cr, cg, cb, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
          const zb = z0 + WALL_THICKNESS;
          positions.push(x1, yR, zb, x1, ytR, zb, x0, ytL, zb, x0, yL, zb);
          for (let i = 0; i < 4; i++) { normals.push(0, 0, 1); colors.push(cr - 0.05, cg - 0.05, cb - 0.05, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
          positions.push(x0, ytL, z0, x0, ytL, zb, x1, ytR, zb, x1, ytR, z0);
          for (let i = 0; i < 4; i++) { normals.push(0, 1, 0); colors.push(cr + 0.05, cg + 0.05, cb + 0.05, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
        }
        if (mask & WallEdge.S) {
          const yL = this.getVertexHeight(x, z + 1) + floorH, yR = this.getVertexHeight(x + 1, z + 1) + floorH;
          const ytL = yL + wallH, ytR = yR + wallH;
          const zf = z1 - WALL_THICKNESS;
          positions.push(x1, yR, z1, x1, ytR, z1, x0, ytL, z1, x0, yL, z1);
          for (let i = 0; i < 4; i++) { normals.push(0, 0, 1); colors.push(cr, cg, cb, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
          positions.push(x0, yL, zf, x0, ytL, zf, x1, ytR, zf, x1, yR, zf);
          for (let i = 0; i < 4; i++) { normals.push(0, 0, -1); colors.push(cr - 0.05, cg - 0.05, cb - 0.05, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
          positions.push(x0, ytL, zf, x0, ytL, z1, x1, ytR, z1, x1, ytR, zf);
          for (let i = 0; i < 4; i++) { normals.push(0, 1, 0); colors.push(cr + 0.05, cg + 0.05, cb + 0.05, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
        }
        if (mask & WallEdge.E) {
          const yT = this.getVertexHeight(x + 1, z) + floorH, yB = this.getVertexHeight(x + 1, z + 1) + floorH;
          const ytT = yT + wallH, ytB = yB + wallH;
          positions.push(x1, yT, z0, x1, ytT, z0, x1, ytB, z1, x1, yB, z1);
          for (let i = 0; i < 4; i++) { normals.push(1, 0, 0); colors.push(cr - 0.03, cg - 0.03, cb - 0.03, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
          const xb = x1 - WALL_THICKNESS;
          positions.push(xb, yB, z1, xb, ytB, z1, xb, ytT, z0, xb, yT, z0);
          for (let i = 0; i < 4; i++) { normals.push(-1, 0, 0); colors.push(cr - 0.05, cg - 0.05, cb - 0.05, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
          positions.push(xb, ytT, z0, x1, ytT, z0, x1, ytB, z1, xb, ytB, z1);
          for (let i = 0; i < 4; i++) { normals.push(0, 1, 0); colors.push(cr + 0.05, cg + 0.05, cb + 0.05, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
        }
        if (mask & WallEdge.W) {
          const yT = this.getVertexHeight(x, z) + floorH, yB = this.getVertexHeight(x, z + 1) + floorH;
          const ytT = yT + wallH, ytB = yB + wallH;
          positions.push(x0, yB, z1, x0, ytB, z1, x0, ytT, z0, x0, yT, z0);
          for (let i = 0; i < 4; i++) { normals.push(-1, 0, 0); colors.push(cr - 0.03, cg - 0.03, cb - 0.03, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
          const xb = x0 + WALL_THICKNESS;
          positions.push(xb, yT, z0, xb, ytT, z0, xb, ytB, z1, xb, yB, z1);
          for (let i = 0; i < 4; i++) { normals.push(1, 0, 0); colors.push(cr - 0.05, cg - 0.05, cb - 0.05, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
          positions.push(x0, ytT, z0, xb, ytT, z0, xb, ytB, z1, x0, ytB, z1);
          for (let i = 0; i < 4; i++) { normals.push(0, 1, 0); colors.push(cr + 0.05, cg + 0.05, cb + 0.05, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
        }
      }
    }
    if (!hasWalls) return null;
    const mesh = new Mesh(`wall_${chunkX}_${chunkZ}`, this.scene);
    const vertexData = new VertexData();
    vertexData.positions = positions; vertexData.indices = indices; vertexData.normals = normals; vertexData.colors = colors;
    vertexData.applyToMesh(mesh);
    mesh.material = this.wallMat; mesh.hasVertexAlpha = false; mesh.isPickable = false;
    return mesh;
  }

  private buildRoofMesh(chunkX: number, chunkZ: number, startX: number, startZ: number, endX: number, endZ: number): Mesh | null {
    const positions: number[] = []; const indices: number[] = []; const normals: number[] = []; const colors: number[] = [];
    let vertexIndex = 0; let hasRoof = false;
    const cr = 0.45, cg = 0.25, cb = 0.15;
    for (let x = startX; x < endX; x++) {
      for (let z = startZ; z < endZ; z++) {
        const tileIdx = z * this.mapWidth + x;
        const roof = this.roofData.get(tileIdx);
        if (!roof) continue;
        hasRoof = true;
        const x0 = x * TILE_SIZE, x1 = (x + 1) * TILE_SIZE, z0 = z * TILE_SIZE, z1 = (z + 1) * TILE_SIZE;
        const baseY = roof.height;
        if (roof.style === 'flat') {
          positions.push(x0, baseY, z0, x1, baseY, z0, x1, baseY, z1, x0, baseY, z1);
          for (let i = 0; i < 4; i++) { normals.push(0, 1, 0); colors.push(cr, cg, cb, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
          positions.push(x0, baseY, z1, x1, baseY, z1, x1, baseY, z0, x0, baseY, z0);
          for (let i = 0; i < 4; i++) { normals.push(0, -1, 0); colors.push(cr - 0.1, cg - 0.05, cb - 0.05, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
        } else {
          const peak = baseY + (roof.peakHeight ?? 0.6);
          const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
          if (roof.style === 'peaked_ew') {
            positions.push(x0, baseY, z0, x1, baseY, z0, x1, peak, mz, x0, peak, mz);
            for (let i = 0; i < 4; i++) { normals.push(0, 0.7, -0.7); colors.push(cr, cg, cb, 1); }
            indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
            positions.push(x0, peak, mz, x1, peak, mz, x1, baseY, z1, x0, baseY, z1);
            for (let i = 0; i < 4; i++) { normals.push(0, 0.7, 0.7); colors.push(cr - 0.05, cg - 0.03, cb - 0.03, 1); }
            indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
          } else {
            positions.push(x0, baseY, z0, x0, baseY, z1, mx, peak, z1, mx, peak, z0);
            for (let i = 0; i < 4; i++) { normals.push(-0.7, 0.7, 0); colors.push(cr, cg, cb, 1); }
            indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
            positions.push(mx, peak, z0, mx, peak, z1, x1, baseY, z1, x1, baseY, z0);
            for (let i = 0; i < 4; i++) { normals.push(0.7, 0.7, 0); colors.push(cr - 0.05, cg - 0.03, cb - 0.03, 1); }
            indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
          }
        }
      }
    }
    if (!hasRoof) return null;
    const mesh = new Mesh(`roof_${chunkX}_${chunkZ}`, this.scene);
    const vertexData = new VertexData();
    vertexData.positions = positions; vertexData.indices = indices; vertexData.normals = normals; vertexData.colors = colors;
    vertexData.applyToMesh(mesh); mesh.material = this.roofMat; mesh.hasVertexAlpha = false; mesh.isPickable = false;
    return mesh;
  }

  private buildFloorMesh(chunkX: number, chunkZ: number, startX: number, startZ: number, endX: number, endZ: number): Mesh | null {
    const positions: number[] = []; const indices: number[] = []; const normals: number[] = []; const colors: number[] = [];
    let vertexIndex = 0; let hasFloor = false;
    for (let x = startX; x < endX; x++) {
      for (let z = startZ; z < endZ; z++) {
        const tileIdx = z * this.mapWidth + x;
        const floorH = this.floorHeights.get(tileIdx);
        if (floorH === undefined) continue;
        if (this.texturePlaneFloorTiles.has(tileIdx)) continue; // texture plane IS the visual
        hasFloor = true;
        const x0 = x * TILE_SIZE, x1 = (x + 1) * TILE_SIZE, z0 = z * TILE_SIZE, z1 = (z + 1) * TILE_SIZE;
        const baseColor = { r: 0.45, g: 0.32, b: 0.18 }; // WOOD color
        positions.push(x0, floorH, z0, x1, floorH, z0, x1, floorH, z1, x0, floorH, z1);
        for (let i = 0; i < 4; i++) { normals.push(0, 1, 0); colors.push(baseColor.r, baseColor.g, baseColor.b, 1); }
        indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
        positions.push(x0, floorH, z1, x1, floorH, z1, x1, floorH, z0, x0, floorH, z0);
        for (let i = 0; i < 4; i++) { normals.push(0, -1, 0); colors.push(baseColor.r - 0.1, baseColor.g - 0.1, baseColor.b - 0.1, 1); }
        indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
        const edgeColor = { r: baseColor.r - 0.08, g: baseColor.g - 0.08, b: baseColor.b - 0.08 };
        const groundH = (this.getVertexHeight(x, z) + this.getVertexHeight(x + 1, z) + this.getVertexHeight(x, z + 1) + this.getVertexHeight(x + 1, z + 1)) / 4;
        const neighborFloor = (nx: number, nz: number) => this.floorHeights.get(nz * this.mapWidth + nx);
        if (neighborFloor(x, z - 1) !== floorH) { positions.push(x0, groundH, z0, x0, floorH, z0, x1, floorH, z0, x1, groundH, z0); for (let i = 0; i < 4; i++) { normals.push(0, 0, -1); colors.push(edgeColor.r, edgeColor.g, edgeColor.b, 1); } indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4; }
        if (neighborFloor(x, z + 1) !== floorH) { positions.push(x1, groundH, z1, x1, floorH, z1, x0, floorH, z1, x0, groundH, z1); for (let i = 0; i < 4; i++) { normals.push(0, 0, 1); colors.push(edgeColor.r, edgeColor.g, edgeColor.b, 1); } indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4; }
        if (neighborFloor(x + 1, z) !== floorH) { positions.push(x1, groundH, z0, x1, floorH, z0, x1, floorH, z1, x1, groundH, z1); for (let i = 0; i < 4; i++) { normals.push(1, 0, 0); colors.push(edgeColor.r, edgeColor.g, edgeColor.b, 1); } indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4; }
        if (neighborFloor(x - 1, z) !== floorH) { positions.push(x0, groundH, z1, x0, floorH, z1, x0, floorH, z0, x0, groundH, z0); for (let i = 0; i < 4; i++) { normals.push(-1, 0, 0); colors.push(edgeColor.r, edgeColor.g, edgeColor.b, 1); } indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4; }
      }
    }
    if (!hasFloor) return null;
    const mesh = new Mesh(`floor_${chunkX}_${chunkZ}`, this.scene);
    const vertexData = new VertexData();
    vertexData.positions = positions; vertexData.indices = indices; vertexData.normals = normals; vertexData.colors = colors;
    vertexData.applyToMesh(mesh); mesh.material = this.floorMat; mesh.hasVertexAlpha = false; mesh.isPickable = true;
    return mesh;
  }

  private buildStairMesh(chunkX: number, chunkZ: number, startX: number, startZ: number, endX: number, endZ: number): Mesh | null {
    const positions: number[] = []; const indices: number[] = []; const normals: number[] = []; const colors: number[] = [];
    let vertexIndex = 0; let hasStairs = false;
    const STEPS = 4; const cr = 0.50, cg = 0.48, cb = 0.45;
    for (let x = startX; x < endX; x++) {
      for (let z = startZ; z < endZ; z++) {
        const tileIdx = z * this.mapWidth + x;
        const stair = this.stairData.get(tileIdx);
        if (!stair) continue;
        hasStairs = true;
        const x0 = x * TILE_SIZE, x1 = (x + 1) * TILE_SIZE, z0 = z * TILE_SIZE, z1 = (z + 1) * TILE_SIZE;
        const stepH = (stair.topHeight - stair.baseHeight) / STEPS;
        for (let s = 0; s < STEPS; s++) {
          const t0 = s / STEPS, t1 = (s + 1) / STEPS;
          const y0 = stair.baseHeight + s * stepH, y1 = stair.baseHeight + (s + 1) * stepH;
          let sx0!: number, sx1!: number, sz0!: number, sz1!: number;
          let faceNormal!: [number, number, number];
          switch (stair.direction) {
            case 'N': sx0 = x0; sx1 = x1; sz0 = z1 - t1 * (z1 - z0); sz1 = z1 - t0 * (z1 - z0); faceNormal = [0, 0, 1]; break;
            case 'S': sx0 = x0; sx1 = x1; sz0 = z0 + t0 * (z1 - z0); sz1 = z0 + t1 * (z1 - z0); faceNormal = [0, 0, -1]; break;
            case 'E': sz0 = z0; sz1 = z1; sx0 = x0 + t0 * (x1 - x0); sx1 = x0 + t1 * (x1 - x0); faceNormal = [-1, 0, 0]; break;
            case 'W': sz0 = z0; sz1 = z1; sx0 = x1 - t1 * (x1 - x0); sx1 = x1 - t0 * (x1 - x0); faceNormal = [1, 0, 0]; break;
          }
          positions.push(sx0, y1, sz0, sx1, y1, sz0, sx1, y1, sz1, sx0, y1, sz1);
          for (let i = 0; i < 4; i++) { normals.push(0, 1, 0); colors.push(cr, cg, cb, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
          if (stair.direction === 'N' || stair.direction === 'S') {
            const fz = stair.direction === 'N' ? sz1 : sz0;
            positions.push(sx0, y0, fz, sx0, y1, fz, sx1, y1, fz, sx1, y0, fz);
          } else {
            const fx = stair.direction === 'W' ? sx1 : sx0;
            positions.push(fx, y0, sz0, fx, y1, sz0, fx, y1, sz1, fx, y0, sz1);
          }
          for (let i = 0; i < 4; i++) { normals.push(faceNormal[0], faceNormal[1], faceNormal[2]); colors.push(cr - 0.08, cg - 0.08, cb - 0.08, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
        }
      }
    }
    if (!hasStairs) return null;
    const mesh = new Mesh(`stairs_${chunkX}_${chunkZ}`, this.scene);
    const vertexData = new VertexData();
    vertexData.positions = positions; vertexData.indices = indices; vertexData.normals = normals; vertexData.colors = colors;
    vertexData.applyToMesh(mesh); mesh.material = this.stairMat; mesh.hasVertexAlpha = false; mesh.isPickable = true;
    return mesh;
  }

  // --- Upper floor layer mesh builders (identical logic as floor 0 but from layer data) ---

  private buildFloorLayerMeshes(chunkX: number, chunkZ: number, startX: number, startZ: number, endX: number, endZ: number, floorIdx: number, layer: FloorLayerClientData): FloorMeshSet | null {
    const wall = this.buildWallMeshForLayer(chunkX, chunkZ, startX, startZ, endX, endZ, floorIdx, layer);
    const roof = this.buildRoofMeshForLayer(chunkX, chunkZ, startX, startZ, endX, endZ, floorIdx, layer);
    const floor = this.buildFloorMeshForLayer(chunkX, chunkZ, startX, startZ, endX, endZ, floorIdx, layer);
    const stairs = this.buildStairMeshForLayer(chunkX, chunkZ, startX, startZ, endX, endZ, floorIdx, layer);
    if (!wall && !roof && !floor && !stairs) return null;
    return { wall, roof, floor, stairs };
  }

  private buildWallMeshForLayer(chunkX: number, chunkZ: number, startX: number, startZ: number, endX: number, endZ: number, floorIdx: number, layer: FloorLayerClientData): Mesh | null {
    const positions: number[] = []; const indices: number[] = []; const normals: number[] = []; const colors: number[] = [];
    let vertexIndex = 0; let hasWalls = false;
    const WALL_THICKNESS = 0.1; const cr = 0.35, cg = 0.30, cb = 0.30;
    for (let x = startX; x < endX; x++) {
      for (let z = startZ; z < endZ; z++) {
        const tileIdx = z * this.mapWidth + x;
        const mask = layer.walls.get(tileIdx) ?? 0;
        if (mask === 0) continue;
        hasWalls = true;
        const wallH = layer.wallHeights.get(tileIdx) ?? DEFAULT_WALL_HEIGHT;
        const floorH = layer.floors.get(tileIdx) ?? 0;
        const x0 = x * TILE_SIZE, x1 = (x + 1) * TILE_SIZE, z0 = z * TILE_SIZE, z1 = (z + 1) * TILE_SIZE;
        const baseY = floorH;
        if (mask & WallEdge.N) {
          positions.push(x0, baseY, z0, x0, baseY + wallH, z0, x1, baseY + wallH, z0, x1, baseY, z0);
          for (let i = 0; i < 4; i++) { normals.push(0, 0, -1); colors.push(cr, cg, cb, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
          const zb = z0 + WALL_THICKNESS;
          positions.push(x1, baseY, zb, x1, baseY + wallH, zb, x0, baseY + wallH, zb, x0, baseY, zb);
          for (let i = 0; i < 4; i++) { normals.push(0, 0, 1); colors.push(cr - 0.05, cg - 0.05, cb - 0.05, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
          positions.push(x0, baseY + wallH, z0, x0, baseY + wallH, zb, x1, baseY + wallH, zb, x1, baseY + wallH, z0);
          for (let i = 0; i < 4; i++) { normals.push(0, 1, 0); colors.push(cr + 0.05, cg + 0.05, cb + 0.05, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
        }
        if (mask & WallEdge.S) {
          const zf = z1 - WALL_THICKNESS;
          positions.push(x1, baseY, z1, x1, baseY + wallH, z1, x0, baseY + wallH, z1, x0, baseY, z1);
          for (let i = 0; i < 4; i++) { normals.push(0, 0, 1); colors.push(cr, cg, cb, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
          positions.push(x0, baseY, zf, x0, baseY + wallH, zf, x1, baseY + wallH, zf, x1, baseY, zf);
          for (let i = 0; i < 4; i++) { normals.push(0, 0, -1); colors.push(cr - 0.05, cg - 0.05, cb - 0.05, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
          positions.push(x0, baseY + wallH, zf, x0, baseY + wallH, z1, x1, baseY + wallH, z1, x1, baseY + wallH, zf);
          for (let i = 0; i < 4; i++) { normals.push(0, 1, 0); colors.push(cr + 0.05, cg + 0.05, cb + 0.05, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
        }
        if (mask & WallEdge.E) {
          positions.push(x1, baseY, z0, x1, baseY + wallH, z0, x1, baseY + wallH, z1, x1, baseY, z1);
          for (let i = 0; i < 4; i++) { normals.push(1, 0, 0); colors.push(cr - 0.03, cg - 0.03, cb - 0.03, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
          const xb = x1 - WALL_THICKNESS;
          positions.push(xb, baseY, z1, xb, baseY + wallH, z1, xb, baseY + wallH, z0, xb, baseY, z0);
          for (let i = 0; i < 4; i++) { normals.push(-1, 0, 0); colors.push(cr - 0.05, cg - 0.05, cb - 0.05, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
          positions.push(xb, baseY + wallH, z0, x1, baseY + wallH, z0, x1, baseY + wallH, z1, xb, baseY + wallH, z1);
          for (let i = 0; i < 4; i++) { normals.push(0, 1, 0); colors.push(cr + 0.05, cg + 0.05, cb + 0.05, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
        }
        if (mask & WallEdge.W) {
          positions.push(x0, baseY, z1, x0, baseY + wallH, z1, x0, baseY + wallH, z0, x0, baseY, z0);
          for (let i = 0; i < 4; i++) { normals.push(-1, 0, 0); colors.push(cr - 0.03, cg - 0.03, cb - 0.03, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
          const xb = x0 + WALL_THICKNESS;
          positions.push(xb, baseY, z0, xb, baseY + wallH, z0, xb, baseY + wallH, z1, xb, baseY, z1);
          for (let i = 0; i < 4; i++) { normals.push(1, 0, 0); colors.push(cr - 0.05, cg - 0.05, cb - 0.05, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
          positions.push(x0, baseY + wallH, z0, xb, baseY + wallH, z0, xb, baseY + wallH, z1, x0, baseY + wallH, z1);
          for (let i = 0; i < 4; i++) { normals.push(0, 1, 0); colors.push(cr + 0.05, cg + 0.05, cb + 0.05, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
        }
      }
    }
    if (!hasWalls) return null;
    const mesh = new Mesh(`wall_f${floorIdx}_${chunkX}_${chunkZ}`, this.scene);
    const vertexData = new VertexData();
    vertexData.positions = positions; vertexData.indices = indices; vertexData.normals = normals; vertexData.colors = colors;
    vertexData.applyToMesh(mesh); mesh.material = this.wallMat; mesh.hasVertexAlpha = false; mesh.isPickable = false;
    return mesh;
  }

  private buildFloorMeshForLayer(chunkX: number, chunkZ: number, startX: number, startZ: number, endX: number, endZ: number, floorIdx: number, layer: FloorLayerClientData): Mesh | null {
    const positions: number[] = []; const indices: number[] = []; const normals: number[] = []; const colors: number[] = [];
    let vertexIndex = 0; let hasFloor = false;
    for (let x = startX; x < endX; x++) {
      for (let z = startZ; z < endZ; z++) {
        const tileIdx = z * this.mapWidth + x;
        const floorH = layer.floors.get(tileIdx);
        if (floorH === undefined) continue;
        hasFloor = true;
        const x0 = x * TILE_SIZE, x1 = (x + 1) * TILE_SIZE, z0 = z * TILE_SIZE, z1 = (z + 1) * TILE_SIZE;
        const bc = { r: 0.45, g: 0.32, b: 0.18 };
        positions.push(x0, floorH, z0, x1, floorH, z0, x1, floorH, z1, x0, floorH, z1);
        for (let i = 0; i < 4; i++) { normals.push(0, 1, 0); colors.push(bc.r, bc.g, bc.b, 1); }
        indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
        positions.push(x0, floorH, z1, x1, floorH, z1, x1, floorH, z0, x0, floorH, z0);
        for (let i = 0; i < 4; i++) { normals.push(0, -1, 0); colors.push(bc.r - 0.1, bc.g - 0.1, bc.b - 0.1, 1); }
        indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
        const ec = { r: bc.r - 0.08, g: bc.g - 0.08, b: bc.b - 0.08 };
        const edgeBottom = floorH - 0.5;
        const neighborFloor = (nx: number, nz: number) => layer.floors.get(nz * this.mapWidth + nx);
        if (neighborFloor(x, z - 1) !== floorH) { positions.push(x0, edgeBottom, z0, x0, floorH, z0, x1, floorH, z0, x1, edgeBottom, z0); for (let i = 0; i < 4; i++) { normals.push(0, 0, -1); colors.push(ec.r, ec.g, ec.b, 1); } indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4; }
        if (neighborFloor(x, z + 1) !== floorH) { positions.push(x1, edgeBottom, z1, x1, floorH, z1, x0, floorH, z1, x0, edgeBottom, z1); for (let i = 0; i < 4; i++) { normals.push(0, 0, 1); colors.push(ec.r, ec.g, ec.b, 1); } indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4; }
        if (neighborFloor(x + 1, z) !== floorH) { positions.push(x1, edgeBottom, z0, x1, floorH, z0, x1, floorH, z1, x1, edgeBottom, z1); for (let i = 0; i < 4; i++) { normals.push(1, 0, 0); colors.push(ec.r, ec.g, ec.b, 1); } indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4; }
        if (neighborFloor(x - 1, z) !== floorH) { positions.push(x0, edgeBottom, z1, x0, floorH, z1, x0, floorH, z0, x0, edgeBottom, z0); for (let i = 0; i < 4; i++) { normals.push(-1, 0, 0); colors.push(ec.r, ec.g, ec.b, 1); } indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4; }
      }
    }
    if (!hasFloor) return null;
    const mesh = new Mesh(`floor_f${floorIdx}_${chunkX}_${chunkZ}`, this.scene);
    const vertexData = new VertexData();
    vertexData.positions = positions; vertexData.indices = indices; vertexData.normals = normals; vertexData.colors = colors;
    vertexData.applyToMesh(mesh); mesh.material = this.floorMat; mesh.hasVertexAlpha = false; mesh.isPickable = true;
    return mesh;
  }

  private buildStairMeshForLayer(chunkX: number, chunkZ: number, startX: number, startZ: number, endX: number, endZ: number, floorIdx: number, layer: FloorLayerClientData): Mesh | null {
    const positions: number[] = []; const indices: number[] = []; const normals: number[] = []; const colors: number[] = [];
    let vertexIndex = 0; let hasStairs = false;
    const STEPS = 4; const cr = 0.50, cg = 0.48, cb = 0.45;
    for (let x = startX; x < endX; x++) {
      for (let z = startZ; z < endZ; z++) {
        const tileIdx = z * this.mapWidth + x;
        const stair = layer.stairs.get(tileIdx);
        if (!stair) continue;
        hasStairs = true;
        const x0 = x * TILE_SIZE, x1 = (x + 1) * TILE_SIZE, z0 = z * TILE_SIZE, z1 = (z + 1) * TILE_SIZE;
        const stepH = (stair.topHeight - stair.baseHeight) / STEPS;
        for (let s = 0; s < STEPS; s++) {
          const t0 = s / STEPS, t1 = (s + 1) / STEPS;
          const y0 = stair.baseHeight + s * stepH, y1 = stair.baseHeight + (s + 1) * stepH;
          let sx0!: number, sx1!: number, sz0!: number, sz1!: number;
          let faceNormal!: [number, number, number];
          switch (stair.direction) {
            case 'N': sx0 = x0; sx1 = x1; sz0 = z1 - t1 * (z1 - z0); sz1 = z1 - t0 * (z1 - z0); faceNormal = [0, 0, 1]; break;
            case 'S': sx0 = x0; sx1 = x1; sz0 = z0 + t0 * (z1 - z0); sz1 = z0 + t1 * (z1 - z0); faceNormal = [0, 0, -1]; break;
            case 'E': sz0 = z0; sz1 = z1; sx0 = x0 + t0 * (x1 - x0); sx1 = x0 + t1 * (x1 - x0); faceNormal = [-1, 0, 0]; break;
            case 'W': sz0 = z0; sz1 = z1; sx0 = x1 - t1 * (x1 - x0); sx1 = x1 - t0 * (x1 - x0); faceNormal = [1, 0, 0]; break;
          }
          positions.push(sx0, y1, sz0, sx1, y1, sz0, sx1, y1, sz1, sx0, y1, sz1);
          for (let i = 0; i < 4; i++) { normals.push(0, 1, 0); colors.push(cr, cg, cb, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
          if (stair.direction === 'N' || stair.direction === 'S') {
            const fz = stair.direction === 'N' ? sz1 : sz0;
            positions.push(sx0, y0, fz, sx0, y1, fz, sx1, y1, fz, sx1, y0, fz);
          } else {
            const fx = stair.direction === 'W' ? sx1 : sx0;
            positions.push(fx, y0, sz0, fx, y1, sz0, fx, y1, sz1, fx, y0, sz1);
          }
          for (let i = 0; i < 4; i++) { normals.push(faceNormal[0], faceNormal[1], faceNormal[2]); colors.push(cr - 0.08, cg - 0.08, cb - 0.08, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
        }
      }
    }
    if (!hasStairs) return null;
    const mesh = new Mesh(`stairs_f${floorIdx}_${chunkX}_${chunkZ}`, this.scene);
    const vertexData = new VertexData();
    vertexData.positions = positions; vertexData.indices = indices; vertexData.normals = normals; vertexData.colors = colors;
    vertexData.applyToMesh(mesh); mesh.material = this.stairMat; mesh.hasVertexAlpha = false; mesh.isPickable = true;
    return mesh;
  }

  private buildRoofMeshForLayer(chunkX: number, chunkZ: number, startX: number, startZ: number, endX: number, endZ: number, floorIdx: number, layer: FloorLayerClientData): Mesh | null {
    const positions: number[] = []; const indices: number[] = []; const normals: number[] = []; const colors: number[] = [];
    let vertexIndex = 0; let hasRoof = false;
    const cr = 0.45, cg = 0.25, cb = 0.15;
    for (let x = startX; x < endX; x++) {
      for (let z = startZ; z < endZ; z++) {
        const tileIdx = z * this.mapWidth + x;
        const roof = layer.roofs.get(tileIdx);
        if (!roof) continue;
        hasRoof = true;
        const x0 = x * TILE_SIZE, x1 = (x + 1) * TILE_SIZE, z0 = z * TILE_SIZE, z1 = (z + 1) * TILE_SIZE;
        const baseY = roof.height;
        if (roof.style === 'flat') {
          positions.push(x0, baseY, z0, x1, baseY, z0, x1, baseY, z1, x0, baseY, z1);
          for (let i = 0; i < 4; i++) { normals.push(0, 1, 0); colors.push(cr, cg, cb, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
          positions.push(x0, baseY, z1, x1, baseY, z1, x1, baseY, z0, x0, baseY, z0);
          for (let i = 0; i < 4; i++) { normals.push(0, -1, 0); colors.push(cr - 0.1, cg - 0.05, cb - 0.05, 1); }
          indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
        } else {
          const peak = baseY + (roof.peakHeight ?? 0.6);
          const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
          if (roof.style === 'peaked_ew') {
            positions.push(x0, baseY, z0, x1, baseY, z0, x1, peak, mz, x0, peak, mz);
            for (let i = 0; i < 4; i++) { normals.push(0, 0.7, -0.7); colors.push(cr, cg, cb, 1); }
            indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
            positions.push(x0, peak, mz, x1, peak, mz, x1, baseY, z1, x0, baseY, z1);
            for (let i = 0; i < 4; i++) { normals.push(0, 0.7, 0.7); colors.push(cr - 0.05, cg - 0.03, cb - 0.03, 1); }
            indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
          } else {
            positions.push(x0, baseY, z0, x0, baseY, z1, mx, peak, z1, mx, peak, z0);
            for (let i = 0; i < 4; i++) { normals.push(-0.7, 0.7, 0); colors.push(cr, cg, cb, 1); }
            indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
            positions.push(mx, peak, z0, mx, peak, z1, x1, baseY, z1, x1, baseY, z0);
            for (let i = 0; i < 4; i++) { normals.push(0.7, 0.7, 0); colors.push(cr - 0.05, cg - 0.03, cb - 0.03, 1); }
            indices.push(vertexIndex, vertexIndex + 1, vertexIndex + 2, vertexIndex, vertexIndex + 2, vertexIndex + 3); vertexIndex += 4;
          }
        }
      }
    }
    if (!hasRoof) return null;
    const mesh = new Mesh(`roof_f${floorIdx}_${chunkX}_${chunkZ}`, this.scene);
    const vertexData = new VertexData();
    vertexData.positions = positions; vertexData.indices = indices; vertexData.normals = normals; vertexData.colors = colors;
    vertexData.applyToMesh(mesh); mesh.material = this.roofMat; mesh.hasVertexAlpha = false; mesh.isPickable = false;
    return mesh;
  }

  private setFloorMeshSetVisibility(set: FloorMeshSet, floorIdx: number): void {
    const visible = floorIdx <= this.currentFloor;
    if (set.wall) set.wall.setEnabled(visible);
    if (set.roof) set.roof.setEnabled(floorIdx > this.currentFloor);
    if (set.floor) set.floor.setEnabled(visible);
    if (set.stairs) set.stairs.setEnabled(visible);
  }

  // --- Public query methods ---

  getVertexHeight(vx: number, vz: number): number {
    if (!this.heights) return 0;
    const vw = this.mapWidth + 1;
    if (vx < 0 || vx >= vw || vz < 0 || vz >= this.mapHeight + 1) return 0;
    return this.heights[vz * vw + vx];
  }

  getInterpolatedHeight(x: number, z: number): number {
    if (!this.heights) return 0;
    const x0 = Math.floor(x), z0 = Math.floor(z);
    const fx = x - x0, fz = z - z0;
    const h00 = this.getVertexHeight(x0, z0);
    const h10 = this.getVertexHeight(x0 + 1, z0);
    const h01 = this.getVertexHeight(x0, z0 + 1);
    const h11 = this.getVertexHeight(x0 + 1, z0 + 1);
    return (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz;
  }

  getEffectiveHeight(x: number, z: number, floor?: number): number {
    const activeFloor = floor ?? this.currentFloor;
    const tx = Math.floor(x), tz = Math.floor(z);
    if (tx < 0 || tx >= this.mapWidth || tz < 0 || tz >= this.mapHeight) return 0;
    const tileIdx = tz * this.mapWidth + tx;
    if (activeFloor === 0) {
      const stair = this.stairData.get(tileIdx);
      if (stair) {
        const fx = x - tx, fz = z - tz;
        let t: number;
        switch (stair.direction) { case 'N': t = 1 - fz; break; case 'S': t = fz; break; case 'E': t = fx; break; case 'W': t = 1 - fx; break; }
        return stair.baseHeight + t * (stair.topHeight - stair.baseHeight);
      }
      const floorH = this.floorHeights.get(tileIdx);
      if (floorH !== undefined) return floorH;
      return this.getInterpolatedHeight(x, z);
    }
    const layer = this.floorLayerData.get(activeFloor);
    if (layer) {
      const stair = layer.stairs.get(tileIdx);
      if (stair) {
        const fx = x - tx, fz = z - tz;
        let t: number;
        switch (stair.direction) { case 'N': t = 1 - fz; break; case 'S': t = fz; break; case 'E': t = fx; break; case 'W': t = 1 - fx; break; }
        return stair.baseHeight + t * (stair.topHeight - stair.baseHeight);
      }
      const floorH = layer.floors.get(tileIdx);
      if (floorH !== undefined) return floorH;
    }
    return this.getInterpolatedHeight(x, z);
  }

  getFloorHeight(x: number, z: number): number | undefined {
    const tx = Math.floor(x), tz = Math.floor(z);
    if (tx < 0 || tx >= this.mapWidth || tz < 0 || tz >= this.mapHeight) return undefined;
    return this.floorHeights.get(tz * this.mapWidth + tx);
  }

  getStairAt(x: number, z: number): StairData | undefined {
    const tx = Math.floor(x), tz = Math.floor(z);
    if (tx < 0 || tx >= this.mapWidth || tz < 0 || tz >= this.mapHeight) return undefined;
    return this.stairData.get(tz * this.mapWidth + tx);
  }

  private getTileTypeRaw(x: number, z: number): TileType {
    if (!this.tileTypes) return TileType.WALL;
    if (x < 0 || x >= this.mapWidth || z < 0 || z >= this.mapHeight) return TileType.WALL;
    return this.tileTypes[z * this.mapWidth + x] as TileType;
  }

  getTileType(x: number, z: number): TileType {
    return this.getTileTypeRaw(Math.floor(x), Math.floor(z));
  }

  isBlocked(x: number, z: number): boolean {
    return BLOCKING_TILES.has(this.getTileType(x, z));
  }

  private getWallRaw(x: number, z: number): number {
    if (!this.walls) return 0;
    if (x < 0 || x >= this.mapWidth || z < 0 || z >= this.mapHeight) return 0;
    return this.walls[z * this.mapWidth + x];
  }

  isBlockedOnFloor(x: number, z: number, floor: number): boolean {
    if (floor === 0) return this.isBlocked(x, z);
    const layer = this.floorLayerData.get(floor);
    if (!layer) return true;
    const tx = Math.floor(x), tz = Math.floor(z);
    if (tx < 0 || tx >= this.mapWidth || tz < 0 || tz >= this.mapHeight) return true;
    const idx = tz * this.mapWidth + tx;
    return !layer.floors.has(idx) && !layer.stairs.has(idx);
  }

  isWallBlockedOnFloor(fromX: number, fromZ: number, toX: number, toZ: number, floor: number): boolean {
    if (floor === 0) return this.isWallBlocked(fromX, fromZ, toX, toZ);
    const layer = this.floorLayerData.get(floor);
    if (!layer) return false;
    const fx = Math.floor(fromX), fz = Math.floor(fromZ), tx = Math.floor(toX), tz = Math.floor(toZ);
    const dx = tx - fx, dz = tz - fz;
    const getW = (x: number, z: number) => layer.walls.get(z * this.mapWidth + x) ?? 0;
    if (dx === 0 && dz === -1) return (getW(fx, fz) & WallEdge.N) !== 0;
    if (dx === 1 && dz === 0) return (getW(fx, fz) & WallEdge.E) !== 0;
    if (dx === 0 && dz === 1) return (getW(fx, fz) & WallEdge.S) !== 0;
    if (dx === -1 && dz === 0) return (getW(fx, fz) & WallEdge.W) !== 0;
    if (dx === 1 && dz === -1) return (getW(fx, fz) & WallEdge.N) !== 0 || (getW(fx, fz) & WallEdge.E) !== 0 || (getW(tx, tz) & WallEdge.S) !== 0 || (getW(tx, tz) & WallEdge.W) !== 0;
    if (dx === -1 && dz === -1) return (getW(fx, fz) & WallEdge.N) !== 0 || (getW(fx, fz) & WallEdge.W) !== 0 || (getW(tx, tz) & WallEdge.S) !== 0 || (getW(tx, tz) & WallEdge.E) !== 0;
    if (dx === 1 && dz === 1) return (getW(fx, fz) & WallEdge.S) !== 0 || (getW(fx, fz) & WallEdge.E) !== 0 || (getW(tx, tz) & WallEdge.N) !== 0 || (getW(tx, tz) & WallEdge.W) !== 0;
    if (dx === -1 && dz === 1) return (getW(fx, fz) & WallEdge.S) !== 0 || (getW(fx, fz) & WallEdge.W) !== 0 || (getW(tx, tz) & WallEdge.N) !== 0 || (getW(tx, tz) & WallEdge.E) !== 0;
    return false;
  }

  isWallBlocked(fromX: number, fromZ: number, toX: number, toZ: number): boolean {
    const fx = Math.floor(fromX), fz = Math.floor(fromZ), tx = Math.floor(toX), tz = Math.floor(toZ);
    const dx = tx - fx, dz = tz - fz;
    if (dx === 0 && dz === -1) return (this.getWallRaw(fx, fz) & WallEdge.N) !== 0;
    if (dx === 1 && dz === 0) return (this.getWallRaw(fx, fz) & WallEdge.E) !== 0;
    if (dx === 0 && dz === 1) return (this.getWallRaw(fx, fz) & WallEdge.S) !== 0;
    if (dx === -1 && dz === 0) return (this.getWallRaw(fx, fz) & WallEdge.W) !== 0;
    if (dx === 1 && dz === -1) return (this.getWallRaw(fx, fz) & WallEdge.N) !== 0 || (this.getWallRaw(fx, fz) & WallEdge.E) !== 0 || (this.getWallRaw(tx, tz) & WallEdge.S) !== 0 || (this.getWallRaw(tx, tz) & WallEdge.W) !== 0;
    if (dx === -1 && dz === -1) return (this.getWallRaw(fx, fz) & WallEdge.N) !== 0 || (this.getWallRaw(fx, fz) & WallEdge.W) !== 0 || (this.getWallRaw(tx, tz) & WallEdge.S) !== 0 || (this.getWallRaw(tx, tz) & WallEdge.E) !== 0;
    if (dx === 1 && dz === 1) return (this.getWallRaw(fx, fz) & WallEdge.S) !== 0 || (this.getWallRaw(fx, fz) & WallEdge.E) !== 0 || (this.getWallRaw(tx, tz) & WallEdge.N) !== 0 || (this.getWallRaw(tx, tz) & WallEdge.W) !== 0;
    if (dx === -1 && dz === 1) return (this.getWallRaw(fx, fz) & WallEdge.S) !== 0 || (this.getWallRaw(fx, fz) & WallEdge.W) !== 0 || (this.getWallRaw(tx, tz) & WallEdge.N) !== 0 || (this.getWallRaw(tx, tz) & WallEdge.E) !== 0;
    return false;
  }

  getTilesForMinimap(centerX: number, centerZ: number, radius: number): { tiles: Uint8Array; size: number; startX: number; startZ: number } {
    const size = radius * 2;
    const startX = Math.floor(centerX) - radius;
    const startZ = Math.floor(centerZ) - radius;
    const result = new Uint8Array(size * size);
    for (let dz = 0; dz < size; dz++) {
      for (let dx = 0; dx < size; dx++) {
        result[dz * size + dx] = this.getTileTypeRaw(startX + dx, startZ + dz);
      }
    }
    return { tiles: result, size, startX, startZ };
  }

  isGroundMesh(meshName: string): boolean {
    return meshName.startsWith('chunk_') || meshName.startsWith('floor_') || meshName.startsWith('stairs_');
  }

  /** Check if a mesh is a walkable surface (ground chunks + bridge texture planes) */
  isWalkableMesh(meshName: string): boolean {
    return this.isGroundMesh(meshName) || meshName.startsWith('texplane_bridge_');
  }

  getGroundMeshes(): Mesh[] {
    const meshes: Mesh[] = [];
    for (const [, chunk] of this.chunks) meshes.push(chunk.ground);
    return meshes;
  }

  setCurrentFloor(floor: number): void {
    if (floor === this.currentFloor) return;
    this.currentFloor = floor;
    for (const [, chunk] of this.chunks) {
      if (chunk.roof) chunk.roof.setEnabled(floor === 0);
      for (const [floorIdx, meshSet] of chunk.upperFloors) this.setFloorMeshSetVisibility(meshSet, floorIdx);
    }
  }

  getCurrentFloor(): number { return this.currentFloor; }

  /** Call each frame to animate water texture */
  updateAnimations(): void {
    if (this.waterTexture) {
      const t = (performance.now() / 1000) - this.waterStartTime;
      this.waterTexture.uOffset = t * 0.18;
      this.waterTexture.vOffset = t * 0.09;
    }
  }

  /** Detect horizontal texture planes and register as walkable bridges/floors */
  private registerTexturePlaneFloors(): void {
    if (!this.mapData) return;
    const planes = this.mapData.texturePlanes || [];
    let count = 0;
    for (const plane of planes) {
      const rx = plane.rotation?.x ?? 0;
      const isFlat = Math.abs(Math.abs(rx) - Math.PI / 2) < 0.1;
      if (!isFlat) continue;

      const px = plane.position?.x ?? 0;
      const py = plane.position?.y ?? 0;
      const pz = plane.position?.z ?? 0;
      const sx = plane.scale?.x ?? 1;
      const sy = plane.scale?.y ?? 1;
      const ry = plane.rotation?.y ?? 0;

      const hw = (plane.width ?? 1) * sx / 2;
      const hd = (plane.height ?? 1) * sy / 2;
      const cosR = Math.cos(ry), sinR = Math.sin(ry);
      const corners = [
        { x: px + (-hw) * cosR - (-hd) * sinR, z: pz + (-hw) * sinR + (-hd) * cosR },
        { x: px + (hw) * cosR - (-hd) * sinR, z: pz + (hw) * sinR + (-hd) * cosR },
        { x: px + (hw) * cosR - (hd) * sinR, z: pz + (hw) * sinR + (hd) * cosR },
        { x: px + (-hw) * cosR - (hd) * sinR, z: pz + (-hw) * sinR + (hd) * cosR },
      ];

      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const c of corners) {
        if (c.x < minX) minX = c.x; if (c.x > maxX) maxX = c.x;
        if (c.z < minZ) minZ = c.z; if (c.z > maxZ) maxZ = c.z;
      }

      const tx0 = Math.max(0, Math.floor(minX));
      const tx1 = Math.min(this.mapWidth - 1, Math.floor(maxX));
      const tz0 = Math.max(0, Math.floor(minZ));
      const tz1 = Math.min(this.mapHeight - 1, Math.floor(maxZ));

      for (let tz = tz0; tz <= tz1; tz++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          const idx = tz * this.mapWidth + tx;
          // Only affect blocked tiles (water, wall) — don't touch walkable terrain
          if (!this.tileTypes || !BLOCKING_TILES.has(this.tileTypes[idx] as TileType)) continue;

          this.tileTypes[idx] = TileType.STONE;
          const existing = this.floorHeights.get(idx);
          if (existing === undefined || py < existing) {
            this.floorHeights.set(idx, py);
          }
          this.texturePlaneFloorTiles.add(idx);
          count++;
        }
      }
    }
    if (count > 0) {
      console.log(`[ChunkManager] Registered ${count} tiles as walkable from texture plane bridges`);
    }
  }

  // --- Placed objects and texture planes ---

  private async loadAssetRegistry(): Promise<void> {
    try {
      const res = await fetch('/assets/assets.json');
      const data = await res.json();
      for (const asset of data.assets || []) {
        this.assetRegistry.set(asset.id, { path: asset.path });
      }
      console.log(`[ChunkManager] Loaded ${this.assetRegistry.size} asset definitions`);
    } catch (e) {
      console.warn('[ChunkManager] Failed to load asset registry:', e);
    }
    try {
      const res = await fetch('/assets/textures/textures.json');
      const data = await res.json();
      for (const tex of data) {
        this.textureRegistry.set(tex.id, { path: tex.path });
      }
      console.log(`[ChunkManager] Loaded ${this.textureRegistry.size} texture definitions`);
    } catch (e) {
      console.warn('[ChunkManager] Failed to load texture registry:', e);
    }
  }

  private async loadGLBModel(assetId: string): Promise<TransformNode | null> {
    if (this.loadedModelCache.has(assetId)) {
      return this.loadedModelCache.get(assetId)!;
    }
    const assetDef = this.assetRegistry.get(assetId);
    if (!assetDef) {
      console.warn(`[ChunkManager] Unknown asset: ${assetId}`);
      this.loadedModelCache.set(assetId, null);
      return null;
    }
    try {
      const path = assetDef.path;
      const encodedPath = path.split('/').map(s => encodeURIComponent(s)).join('/');
      const lastSlash = encodedPath.lastIndexOf('/');
      const dir = encodedPath.substring(0, lastSlash + 1);
      const file = encodedPath.substring(lastSlash + 1);
      const result = await SceneLoader.ImportMeshAsync('', dir, file, this.scene);

      // Replicate KC editor's buildCenteredPivotGroup:
      // Compute bounding box, then offset children so pivot = bottom-center
      const root = result.meshes[0];

      // Compute world-space bounding box of all meshes
      let minX = Infinity, maxX = -Infinity;
      let minY = Infinity, maxY = -Infinity;
      let minZ = Infinity, maxZ = -Infinity;
      for (const mesh of result.meshes) {
        if (mesh.getTotalVertices() === 0) continue;
        mesh.computeWorldMatrix(true);
        const bb = mesh.getBoundingInfo().boundingBox;
        if (bb.minimumWorld.x < minX) minX = bb.minimumWorld.x;
        if (bb.maximumWorld.x > maxX) maxX = bb.maximumWorld.x;
        if (bb.minimumWorld.y < minY) minY = bb.minimumWorld.y;
        if (bb.maximumWorld.y > maxY) maxY = bb.maximumWorld.y;
        if (bb.minimumWorld.z < minZ) minZ = bb.minimumWorld.z;
        if (bb.maximumWorld.z > maxZ) maxZ = bb.maximumWorld.z;
      }
      const centerX = (minX + maxX) / 2;
      const centerZ = (minZ + maxZ) / 2;

      // Create pivot TransformNode at bottom-center
      const template = new TransformNode(`template_${assetId}`, this.scene);
      // Offset the root so model's bottom-center aligns with the template's origin
      root.parent = template;
      root.position.x -= centerX;
      root.position.y -= minY;
      root.position.z -= centerZ;

      template.setEnabled(false);
      this.loadedModelCache.set(assetId, template);
      return template;
    } catch (e) {
      console.warn(`[ChunkManager] Failed to load model ${assetId}:`, e);
      this.loadedModelCache.set(assetId, null);
      return null;
    }
  }

  private async loadPlacedObjects(objects: PlacedObject[]): Promise<void> {
    if (objects.length === 0) return;
    console.log(`[ChunkManager] Loading ${objects.length} placed objects...`);
    let loaded = 0;
    for (const obj of objects) {
      const template = await this.loadGLBModel(obj.assetId);
      if (!template) continue;

      const instance = template.instantiateHierarchy(null, undefined, (source, cloned) => {
        cloned.name = `placed_${loaded}_${source.name}`;
      });
      if (!instance) continue;
      instance.setEnabled(true);
      for (const child of instance.getChildMeshes()) {
        child.setEnabled(true);
        // Use alpha-test cutout — avoids depth-sorting bleed on foliage while
        // still discarding transparent (black) pixels in leaf textures.
        const mat = child.material as any;
        if (mat) {
          if (mat.transparencyMode !== undefined) mat.transparencyMode = 1; // ALPHATEST
          mat.alpha = 1;
        }
      }

      // Three.js saves Euler angles in XYZ order (intrinsic). Babylon's mesh.rotation uses YXZ.
      // Correct: Q = Qx * Qy * Qz (Babylon multiply: a.multiply(b) = a*b, rightmost applied first)
      instance.position = new Vector3(obj.position.x, obj.position.y, obj.position.z);
      const { x: orx, y: ory, z: orz } = obj.rotation;
      instance.rotationQuaternion = Quaternion.RotationAxis(new Vector3(1, 0, 0), orx)
        .multiply(Quaternion.RotationAxis(new Vector3(0, 1, 0), ory))
        .multiply(Quaternion.RotationAxis(new Vector3(0, 0, 1), orz));
      instance.scaling = new Vector3(obj.scale.x, obj.scale.y, obj.scale.z);
      this.placedObjectNodes.push(instance);
      loaded++;
    }
    console.log(`[ChunkManager] Loaded ${loaded}/${objects.length} placed objects`);
  }

  private getOrLoadTexture(textureId: string): Texture | null {
    if (this.textureCache.has(textureId)) {
      return this.textureCache.get(textureId)!;
    }
    const texDef = this.textureRegistry.get(textureId);
    if (!texDef) {
      console.warn(`[ChunkManager] Unknown texture: ${textureId}`);
      return null;
    }
    const tex = new Texture(texDef.path, this.scene);
    tex.hasAlpha = true;
    this.textureCache.set(textureId, tex);
    return tex;
  }

  private loadTexturePlanes(planes: TexturePlane[]): void {
    if (planes.length === 0) return;
    console.log(`[ChunkManager] Loading ${planes.length} texture planes...`);
    let loaded = 0;
    for (const plane of planes) {
      const tex = this.getOrLoadTexture(plane.textureId);
      if (!tex) continue;
      const mesh = MeshBuilder.CreatePlane(`texplane_${plane.id}`, {
        width: plane.width,
        height: plane.height,
        sideOrientation: plane.doubleSided ? Mesh.DOUBLESIDE : Mesh.FRONTANDBACKSIDE,
      }, this.scene);
      const mat = new StandardMaterial(`texplane_mat_${plane.id}`, this.scene);
      mat.diffuseTexture = tex;
      mat.specularColor = new Color3(0, 0, 0);
      mat.useAlphaFromDiffuseTexture = true;
      mat.backFaceCulling = !plane.doubleSided;
      mesh.material = mat;
      mesh.position = new Vector3(plane.position.x, plane.position.y, plane.position.z);
      // Three.js saves Euler angles in XYZ order (intrinsic). Babylon's mesh.rotation uses YXZ.
      // Correct: Q = Qx * Qy * Qz (Babylon multiply: a.multiply(b) = a*b, rightmost applied first)
      const { x: rx, y: ry, z: rz } = plane.rotation;
      mesh.rotationQuaternion = Quaternion.RotationAxis(new Vector3(1, 0, 0), rx)
        .multiply(Quaternion.RotationAxis(new Vector3(0, 1, 0), ry))
        .multiply(Quaternion.RotationAxis(new Vector3(0, 0, 1), rz));
      mesh.scaling = new Vector3(plane.scale.x, plane.scale.y, plane.scale.z);
      // Flat texture planes (bridges/floors) should be pickable for click-to-walk
      const isFlat = Math.abs(Math.abs(rx) - Math.PI / 2) < 0.1;
      if (isFlat) {
        mesh.name = `texplane_bridge_${plane.id}`;
        mesh.isPickable = true;
        // Group 0 so flat planes depth-sort with the character correctly.
        // needDepthPrePass forces a depth-only pre-pass so water (group 1) can test against this mesh.
        mesh.renderingGroupId = 0;
        mat.needDepthPrePass = true;
      } else {
        mesh.isPickable = false;
        mesh.renderingGroupId = 2; // Render after water (group 1) so vertical planes appear on top
      }
      this.texturePlaneMeshes.push(mesh);
      loaded++;
    }
    console.log(`[ChunkManager] Loaded ${loaded}/${planes.length} texture planes`);
  }

  disposeAll(): void {
    // Dispose placed objects and texture planes
    for (const n of this.placedObjectNodes) n.dispose();
    this.placedObjectNodes = [];
    for (const m of this.texturePlaneMeshes) m.dispose();
    this.texturePlaneMeshes = [];
    for (const [, m] of this.loadedModelCache) m?.dispose();
    this.loadedModelCache.clear();
    for (const [, t] of this.textureCache) t.dispose();
    this.textureCache.clear();

    for (const [, meshes] of this.chunks) {
      meshes.ground.dispose();
      meshes.water?.dispose();
      meshes.cliff?.dispose();
      meshes.wall?.dispose();
      meshes.roof?.dispose();
      meshes.floor?.dispose();
      meshes.stairs?.dispose();
      for (const [, floorSet] of meshes.upperFloors) {
        floorSet.wall?.dispose(); floorSet.roof?.dispose(); floorSet.floor?.dispose(); floorSet.stairs?.dispose();
      }
    }
    this.chunks.clear();
    this.heights = null;
    this.tileTypes = null;
    this.mapData = null;
    this.walls = null;
    this.wallHeights.clear();
    this.floorHeights.clear();
    this.texturePlaneFloorTiles.clear();
    this.stairData.clear();
    this.roofData.clear();
    this.floorLayerData.clear();
    this.currentFloor = 0;
    this.loaded = false;
    this.lastChunkX = -999;
    this.lastChunkZ = -999;
  }
}
