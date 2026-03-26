import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const filePath = path.join(__dirname, 'aitest.json');
const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

const map = data.map;
const tiles = map.tiles;   // tiles[z][x], 64x64
const heights = map.heights; // heights[z][x], 65x65

// ─── 1. Hill centered at vertex (33, 30) ────────────────────────────────────
const hillCX = 33, hillCZ = 30, hillR = 10, hillMax = 3.2;
for (let z = 0; z <= 64; z++) {
  for (let x = 0; x <= 64; x++) {
    const dist = Math.sqrt((x - hillCX) ** 2 + (z - hillCZ) ** 2);
    if (dist < hillR) {
      const h = hillMax * (1 - dist / hillR) ** 2;
      heights[z][x] = (heights[z][x] || 0) + h;
    }
  }
}

// ─── 2. Lake depression centered at vertex (10, 10) ─────────────────────────
const lakeCX = 10, lakeCZ = 10, lakeR = 7;
for (let z = 0; z <= 64; z++) {
  for (let x = 0; x <= 64; x++) {
    const dist = Math.sqrt((x - lakeCX) ** 2 + (z - lakeCZ) ** 2);
    if (dist < lakeR) {
      const depression = -3.5 * (1 - dist / lakeR);
      heights[z][x] = Math.min(heights[z][x] || 0, depression);
    }
  }
}

// ─── 3. Paint lake and sand tiles ───────────────────────────────────────────
// Tile (tx, tz) has center at (tx + 0.5, tz + 0.5) in vertex space
for (let tz = 0; tz < 64; tz++) {
  for (let tx = 0; tx < 64; tx++) {
    const cx = tx + 0.5, cz = tz + 0.5;
    const dist = Math.sqrt((cx - lakeCX) ** 2 + (cz - lakeCZ) ** 2);
    if (dist < 5) {
      tiles[tz][tx].waterPainted = true;
    } else if (dist >= 5 && dist < 8.5) {
      tiles[tz][tx].ground = 'sand';
      tiles[tz][tx].waterPainted = false;
    }
  }
}

// ─── 4. Winding dirt path from z=58 down to z=40, 2 tiles wide ───────────────
// step goes from 0 (z=58) to 18 (z=40)
for (let step = 0; step <= 18; step++) {
  const tz = 58 - step;
  const px = 33 + Math.round(Math.sin((step / 19) * Math.PI * 2.5) * 2);
  for (let dx = -1; dx <= 0; dx++) {
    const tx = px + dx;
    if (tx >= 0 && tx < 64 && tz >= 0 && tz < 64) {
      tiles[tz][tx].ground = 'path';
      tiles[tz][tx].waterPainted = false;
    }
  }
}

// ─── 5. Dirt patches ─────────────────────────────────────────────────────────
const dirtCenters = [
  [20, 20], [45, 40], [15, 50], [50, 55], [38, 52], [25, 35]
];
for (const [cx, cz] of dirtCenters) {
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const tx = cx + dx, tz = cz + dz;
      if (tx >= 0 && tx < 64 && tz >= 0 && tz < 64) {
        // Don't overwrite water or sand tiles
        if (!tiles[tz][tx].waterPainted && tiles[tz][tx].ground === 'grass') {
          tiles[tz][tx].ground = 'dirt';
        }
      }
    }
  }
}

// ─── Helper: interpolated terrain Y ──────────────────────────────────────────
function getY(wx, wz) {
  const vx = Math.floor(wx), vz = Math.floor(wz);
  const fx = wx - vx, fz = wz - vz;
  function vh(x, z) { return (x >= 0 && x <= 64 && z >= 0 && z <= 64) ? (heights[z][x] || 0) : 0; }
  return vh(vx, vz) * (1 - fx) * (1 - fz)
       + vh(vx + 1, vz) * fx * (1 - fz)
       + vh(vx, vz + 1) * (1 - fx) * fz
       + vh(vx + 1, vz + 1) * fx * fz;
}

// ─── Placed objects ───────────────────────────────────────────────────────────
const placed = [];

function obj(assetId, wx, wz, rotY = 0, scale = 1) {
  placed.push({
    assetId,
    position: { x: wx, y: getY(wx, wz), z: wz },
    rotation: { x: 0, y: rotY, z: 0 },
    scale: { x: scale, y: scale, z: scale }
  });
}

// Well on the hilltop
obj('well', 33, 29);

// Stone walls – partial ruined enclosure
// North wall row
obj('stone wall', 31, 26, 0);
obj('stone wall', 32, 26, 0);
obj('stone wall', 33, 26, 0);
// East wall column
obj('stone wall', 36, 28, 1.5708);
obj('stone wall', 36, 29, 1.5708);
// West wall column
obj('stone wall', 30, 28, 1.5708);
obj('stone wall', 30, 29, 1.5708);
// Lone southern wall piece (ruined)
obj('stone wall', 35, 33, 0);

// Stone pillars at northern corners
obj('stone pillar', 30, 26);
obj('stone pillar', 36, 26);

// Chest near well
obj('chest', 34, 29, 2.4);

// Trees
obj('tree', 22, 22, 0.5);
obj('tree', 45, 18, 2.1, 0.9);
obj('tree', 40, 45, 1.7);
obj('tree', 35, 27, 0.7, 0.8);

// Tree2
obj('tree2', 20, 28, 1.2, 1.2);
obj('tree2', 48, 30, 0.3, 1.1);
obj('tree2', 28, 48, 0.9, 1.3);

// Willow trees near the lake
obj('willow tree', 16, 12, 0.5);
obj('willow tree', 13, 16, 1.8, 0.9);

// Wood poles as path markers
obj('wood pole', 33, 40, 0);
obj('wood pole', 33, 36, 0);

data.placedObjects = placed;

fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

console.log('Scene generated successfully!');
console.log(`Placed objects (${placed.length} total):`);
for (const o of placed) {
  console.log(`  ${o.assetId.padEnd(14)} @ (${o.position.x.toFixed(2)}, ${o.position.y.toFixed(3)}, ${o.position.z.toFixed(2)})  rotY=${o.rotation.y}  scale=${o.scale.x}`);
}

// Sanity checks
let waterCount = 0, sandCount = 0, pathCount = 0, dirtCount = 0;
for (let z = 0; z < 64; z++) {
  for (let x = 0; x < 64; x++) {
    if (tiles[z][x].waterPainted) waterCount++;
    if (tiles[z][x].ground === 'sand') sandCount++;
    if (tiles[z][x].ground === 'path') pathCount++;
    if (tiles[z][x].ground === 'dirt') dirtCount++;
  }
}
console.log(`\nTile summary:`);
console.log(`  waterPainted tiles : ${waterCount}`);
console.log(`  sand tiles         : ${sandCount}`);
console.log(`  path tiles         : ${pathCount}`);
console.log(`  dirt tiles         : ${dirtCount}`);

const maxH = Math.max(...heights.flat());
const minH = Math.min(...heights.flat());
console.log(`\nHeight range: ${minH.toFixed(3)} .. ${maxH.toFixed(3)}`);
