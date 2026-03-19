/**
 * restore-manual-scales.js
 *
 * Restores manually applied scales from the backup, adjusted for the new
 * 200cm model size. The old default baked scale was 0.7291 (2 / 2.74m).
 * Any object that differed from that had a manual adjustment applied.
 * We carry that ratio over to the new scale where default = 1.
 *
 * Usage:
 *   node scripts/restore-manual-scales.js
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAVE_PATH   = path.join(__dirname, '..', 'worldsave', 'main.json')
const BACKUP_PATH = path.join(__dirname, '..', 'worldsave', 'main.backup.json')
const ASSETS_PATH = path.join(__dirname, '..', 'public', 'assets', 'assets.json')

const save   = JSON.parse(fs.readFileSync(SAVE_PATH,   'utf8'))
const backup = JSON.parse(fs.readFileSync(BACKUP_PATH, 'utf8'))
const { assets } = JSON.parse(fs.readFileSync(ASSETS_PATH, 'utf8'))

const DEFAULT_OLD_SCALE = 0.7291

function isStoneModularWall(assetId) {
  const asset = assets.find(a => a.id === assetId)
  if (!asset) return false
  const p = asset.path.toLowerCase()
  return (p.includes('stone modular') || p.includes('dark stone modular')) &&
         asset.name.toLowerCase().includes('wall')
}

let restored = 0

for (let i = 0; i < save.placedObjects.length; i++) {
  const obj = save.placedObjects[i]
  const bak = backup.placedObjects[i]

  if (!isStoneModularWall(obj.assetId)) continue

  const manualFactor = bak.scale.x / DEFAULT_OLD_SCALE
  obj.scale.x = manualFactor
  obj.scale.z = manualFactor

  if (Math.abs(manualFactor - 1) > 0.01) restored++
}

fs.writeFileSync(SAVE_PATH, JSON.stringify(save, null, 2))
console.log(`Done. Restored manual scaling on ${restored} object(s).`)
