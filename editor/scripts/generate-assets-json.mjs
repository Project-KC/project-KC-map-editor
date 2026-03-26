import fs from 'fs'
import path from 'path'

const projectRoot = process.cwd()
const assetsRoot = path.join(projectRoot, 'public', 'assets')

function walk(dir) {
  const results = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...walk(fullPath))
    } else {
      results.push(fullPath)
    }
  }
  return results
}

function toWebPath(fullPath) {
  const rel = path.relative(path.join(projectRoot, 'public'), fullPath)
  return '/' + rel.replace(/\\/g, '/')
}

function toName(fileName) {
  return fileName
    .replace(/\.glb$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (m) => m.toUpperCase())
}

const files = walk(assetsRoot)
  .filter((file) => file.toLowerCase().endsWith('.glb'))
  .sort((a, b) => a.localeCompare(b))

const assets = files.map((file) => {
  const webPath = toWebPath(file)
  const base = path.basename(file, '.glb')
  return {
    id: base,
    name: toName(path.basename(file)),
    path: webPath
  }
})

const output = { assets }

fs.writeFileSync(
  path.join(assetsRoot, 'assets.json'),
  JSON.stringify(output, null, 2),
  'utf8'
)

console.log(`Wrote ${assets.length} assets to public/assets/assets.json`)