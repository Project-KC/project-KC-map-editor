/**
 * Attach materials + seasonal textures to the retro_nature_pack GLBs (which
 * ship as geometry-only) and emit .gltf files with shared external textures.
 *
 * Produces the same texture-dedup layout as tools/split-glb.ts so browsers
 * share one GPU texture across every asset that references it.
 *
 * Usage: bun tools/texture-retro-nature-pack.ts
 */
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, basename, dirname, resolve } from 'node:path'
import { createHash } from 'node:crypto'

const PACK_ROOT =
  '/home/nick/projectnova-master/client/public/assets/models/Bought packs/retro_nature_pack'
const SRC_MODELS = join(PACK_ROOT, 'models/glTF')
const SRC_TEXTURES = join(PACK_ROOT, 'textures')
const OUT_ROOT =
  '/home/nick/projectnova-master/client/public/assets/bought-assets/retro_nature_pack'

const CATEGORIES = ['trees', 'bushes', 'grass']

function stripLeadingZeros(name: string): string {
  // bush01 -> bush1, tree01 -> tree1 (we'll try both padded & unpadded)
  return name.replace(/^(\D+?)0+(\d+)$/, '$1$2')
}

function pickTexture(
  glbFile: string,
  category: string,
  availableTextures: string[]
): string | null {
  const base = glbFile.replace(/\.glb$/i, '')
  const isWinter = /_winter$/i.test(base)
  const stem = isWinter ? base.replace(/_winter$/i, '') : base
  const stemNoPad = stripLeadingZeros(stem)

  const seasons = isWinter ? ['winter'] : ['summer', 'spring', 'fall']

  for (const season of seasons) {
    for (const s of [stem, stemNoPad]) {
      const candidate = `${s}_${season}.png`
      if (availableTextures.includes(candidate)) return candidate
    }
  }

  // Grass category falls back to the generic grass_<season> texture shared
  // across grass01..grass09.
  if (category === 'grass') {
    for (const season of seasons) {
      const generic = `grass_${season}.png`
      if (availableTextures.includes(generic)) return generic
    }
  }

  return null
}

async function main() {
  if (!existsSync(SRC_MODELS) || !existsSync(SRC_TEXTURES)) {
    console.error('Pack not found at', PACK_ROOT)
    process.exit(1)
  }

  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  // Dedup per category: the Khronos glTF validator rejects `..` in URIs, so
  // texture files must live beside (or below) each .gltf — shared textures
  // are copied into each category's own folder instead of a pack-level dir.
  let processed = 0
  let skipped = 0
  let totalOut = 0

  for (const cat of CATEGORIES) {
    const catOut = join(OUT_ROOT, cat)
    const glbDir = join(SRC_MODELS, cat)
    const texDir = join(SRC_TEXTURES, cat)
    if (!existsSync(glbDir) || !existsSync(texDir)) {
      console.log(`  (skip category ${cat} — missing)`)
      continue
    }
    await mkdir(catOut, { recursive: true })

    // Per-category dedup map: source texture path -> local hashed filename
    const writtenTextures = new Map<string, string>()

    const glbFiles = (await readdir(glbDir))
      .filter((f) => f.toLowerCase().endsWith('.glb'))
      .sort()
    const texFiles = (await readdir(texDir)).filter((f) =>
      f.toLowerCase().endsWith('.png')
    )

    for (const glbFile of glbFiles) {
      const texName = pickTexture(glbFile, cat, texFiles)
      if (!texName) {
        console.log(`  SKIP ${cat}/${glbFile} — no matching texture`)
        skipped++
        continue
      }

      const texPath = join(texDir, texName)

      // Dedup: hash texture content -> local filename (same folder as .gltf)
      if (!writtenTextures.has(texPath)) {
        const data = await readFile(texPath)
        const hash = createHash('md5').update(data).digest('hex').slice(0, 16)
        const sharedName = `${hash}.png`
        writtenTextures.set(texPath, sharedName)
        const sharedPath = join(catOut, sharedName)
        if (!existsSync(sharedPath)) await writeFile(sharedPath, data)
      }
      const sharedName = writtenTextures.get(texPath)!

      const glbPath = join(glbDir, glbFile)
      const doc = await io.read(glbPath)

      // Skip empty GLBs (the source pack includes some 0-mesh files like
      // tree02_winter.glb that would emit texture-only gltfs with no geometry).
      if (doc.getRoot().listMeshes().length === 0) {
        console.log(`  SKIP ${cat}/${glbFile} — source has no meshes`)
        skipped++
        continue
      }

      const texture = doc
        .createTexture(basename(texName, '.png'))
        .setMimeType('image/png')
        .setURI(sharedName)
      // gltf-transform's writer drops the URI unless image bytes are set.
      // An empty buffer is enough to signal "real" image data.
      texture.setImage(new Uint8Array(0))

      const material = doc
        .createMaterial(basename(glbFile, '.glb'))
        .setBaseColorTexture(texture)
        .setRoughnessFactor(1.0)
        .setMetallicFactor(0.0)
        .setDoubleSided(true) // foliage: avoid backface culling on flat planes

      for (const mesh of doc.getRoot().listMeshes()) {
        for (const prim of mesh.listPrimitives()) {
          prim.setMaterial(material)
        }
      }

      const outBase = basename(glbFile, '.glb')
      const outName = `${outBase}.gltf`
      const outPath = join(catOut, outName)
      // Unique .bin per asset so siblings don't overwrite each other.
      for (const buffer of doc.getRoot().listBuffers()) {
        buffer.setURI(`${outBase}.bin`)
      }
      // Write in-memory and emit only the .gltf + .bin. Skip image resources —
      // the writer would write empty files at our shared textures paths,
      // clobbering them.
      const jsonDoc = await io.writeJSON(doc)
      await writeFile(outPath, JSON.stringify(jsonDoc.json))
      for (const [uri, data] of Object.entries(jsonDoc.resources || {})) {
        const lower = uri.toLowerCase()
        if (lower.endsWith('.png') || lower.endsWith('.jpg') ||
            lower.endsWith('.jpeg') || lower.endsWith('.webp') ||
            lower.endsWith('.ktx2')) continue
        const resourcePath = resolve(dirname(outPath), uri)
        await mkdir(dirname(resourcePath), { recursive: true })
        await writeFile(resourcePath, data)
      }
      console.log(`  ${cat}/${outName} <- ${texName}`)
      processed++
      totalOut++
    }
  }

  console.log(
    `\nDone. Textured ${processed} GLBs, skipped ${skipped} -> ${OUT_ROOT}`
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
