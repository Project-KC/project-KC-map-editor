#!/usr/bin/env bun

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

const args = process.argv.slice(2);

if (args.length < 2) {
  console.error("Usage: bun tools/import-kc-map.ts <save-file> <map-id>");
  console.error("Example: bun tools/import-kc-map.ts /path/to/main.json overworld");
  process.exit(1);
}

const [saveFilePath, mapId] = args;

// Read KC save file
if (!existsSync(saveFilePath)) {
  console.error(`Error: Save file not found: ${saveFilePath}`);
  process.exit(1);
}

console.log(`Reading KC save file: ${saveFilePath}`);
const saveData = JSON.parse(readFileSync(saveFilePath, "utf-8"));

if (!saveData.map) {
  console.error("Error: Invalid KC save file - missing 'map' property");
  process.exit(1);
}

const { width, height, waterLevel } = saveData.map;

if (width == null || height == null) {
  console.error("Error: Invalid KC save file - missing width or height");
  process.exit(1);
}

console.log(`Map dimensions: ${width}x${height}, water level: ${waterLevel}`);

// Create map directory
const mapDir = join(import.meta.dir, "..", "server", "data", "maps", mapId);

if (existsSync(mapDir)) {
  console.warn(`Warning: Map directory already exists: ${mapDir}`);
}

mkdirSync(mapDir, { recursive: true });
console.log(`Created directory: ${mapDir}`);

// Write map.json - direct copy of KC save data
const mapJsonPath = join(mapDir, "map.json");
writeFileSync(mapJsonPath, JSON.stringify(saveData, null, 2));
console.log(`Wrote ${mapJsonPath}`);

// Write meta.json
const meta = {
  id: mapId,
  name: mapId,
  width,
  height,
  waterLevel: waterLevel ?? 0,
  spawnPoint: { x: Math.floor(width / 2), z: Math.floor(height / 2) },
  fogColor: [0.4, 0.6, 0.9],
  fogStart: 30,
  fogEnd: 50,
  transitions: [],
};

const metaJsonPath = join(mapDir, "meta.json");
writeFileSync(metaJsonPath, JSON.stringify(meta, null, 2));
console.log(`Wrote ${metaJsonPath}`);

// Write spawns.json
const spawnsJsonPath = join(mapDir, "spawns.json");
writeFileSync(spawnsJsonPath, JSON.stringify({ npcs: [], objects: [] }, null, 2));
console.log(`Wrote ${spawnsJsonPath}`);

// Write walls.json
const wallsJsonPath = join(mapDir, "walls.json");
writeFileSync(wallsJsonPath, JSON.stringify({ walls: {} }, null, 2));
console.log(`Wrote ${wallsJsonPath}`);

console.log(`\nMap "${mapId}" imported successfully!`);
