/**
 * add-stretched-textures.js
 *
 * Adds all PNGs from /public/assets/stretched textures/ to textures.json
 * with a defaultScale so the editor auto-applies the right scale when selected.
 *
 * Usage:
 *   node scripts/add-stretched-textures.js
 *
 * To change the default scale, edit DEFAULT_SCALE below.
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TEXTURES_JSON = path.join(__dirname, '..', 'public', 'assets', 'textures', 'textures.json')
const STRETCHED_DIR = path.join(__dirname, '..', 'public', 'assets', 'stretched textures')

const DEFAULT_SCALE = 4

const textures = JSON.parse(fs.readFileSync(TEXTURES_JSON, 'utf8'))
const files = fs.readdirSync(STRETCHED_DIR).filter(f => f.endsWith('.png')).sort()

let added = 0

for (const file of files) {
  const name = path.basename(file, '.png')
  const id = `tex-stretched-${name}`

  if (textures.find(t => t.id === id)) {
    console.log(`Skipping ${id} (already exists)`)
    continue
  }

  textures.push({
    id,
    name: `Stretched ${name}`,
    path: `/assets/stretched textures/${file}`,
    defaultScale: DEFAULT_SCALE
  })

  added++
  console.log(`Added ${id}`)
}

fs.writeFileSync(TEXTURES_JSON, JSON.stringify(textures, null, 2))
console.log(`\nDone. Added ${added} texture(s).`)
