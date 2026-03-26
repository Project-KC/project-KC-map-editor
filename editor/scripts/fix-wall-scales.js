/**
 * fix-wall-scales.js
 *
 * Resets scale.x and scale.z to 1 for all placed stone/dark stone modular
 * wall objects in the save file. Run this AFTER replacing the GLBs with
 * correctly-sized 200cm versions.
 *
 * Usage:
 *   node scripts/fix-wall-scales.js
 *
 * A backup is written to worldsave/main.backup.json before any changes.
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAVE_PATH = path.join(__dirname, '..', 'worldsave', 'main.json')
const BACKUP_PATH = path.join(__dirname, '..', 'worldsave', 'main.backup.json')
const ASSETS_PATH = path.join(__dirname, '..', 'public', 'assets', 'assets.json')

const save = JSON.parse(fs.readFileSync(SAVE_PATH, 'utf8'))
const { assets } = JSON.parse(fs.readFileSync(ASSETS_PATH, 'utf8'))

// Mirror the isStoneModularAsset + wall check from scene.js
function isStoneModularWall(assetId) {
  const asset = assets.find(a => a.id === assetId)
  if (!asset) return false
  const p = asset.path.toLowerCase()
  const isStoneModular = p.includes('stone modular') || p.includes('dark stone modular')
  const isWall = asset.name.toLowerCase().includes('wall')
  return isStoneModular && isWall
}

// Write backup before touching anything
fs.writeFileSync(BACKUP_PATH, JSON.stringify(save, null, 2))
console.log(`Backup written to ${BACKUP_PATH}`)

let fixed = 0

for (const obj of save.placedObjects || []) {
  if (isStoneModularWall(obj.assetId)) {
    obj.scale.x = 1
    obj.scale.z = 1
    fixed++
  }
}

fs.writeFileSync(SAVE_PATH, JSON.stringify(save, null, 2))
console.log(`Done. Fixed ${fixed} wall object(s).`)
