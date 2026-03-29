import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder'
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData'
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { Color3 } from '@babylonjs/core/Maths/math.color'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode'
import { Texture } from '@babylonjs/core/Materials/Textures/texture'

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function sampleNoise(x, z, scaleA = 1, scaleB = 1) {
  return (
    Math.sin(x * scaleA + z * scaleB) +
    Math.cos(x * (scaleB * 0.73) - z * (scaleA * 0.81))
  ) * 0.5
}

// Returns plain {r, g, b} object (no engine dependency)
function groundColor(type, shade) {
  if (type === 'dirt')         return { r: 0.45 * shade, g: 0.31 * shade, b: 0.14 * shade }
  if (type === 'sand')         return { r: 0.72 * shade, g: 0.60 * shade, b: 0.24 * shade }
  if (type === 'path')         return { r: 0.42 * shade, g: 0.30 * shade, b: 0.13 * shade }
  if (type === 'road')         return { r: 0.47 * shade, g: 0.46 * shade, b: 0.43 * shade }
  if (type === 'water')        return { r: 0.40 * shade, g: 0.47 * shade, b: 0.66 * shade }
  if (type === 'desert')        return { r: 0.82 * shade, g: 0.72 * shade, b: 0.50 * shade }
  if (type === 'sandstone')     return { r: 0.68 * shade, g: 0.48 * shade, b: 0.28 * shade }
  if (type === 'rock')          return { r: 0.42 * shade, g: 0.40 * shade, b: 0.36 * shade }
  if (type === 'drysand')       return { r: 0.62 * shade, g: 0.42 * shade, b: 0.22 * shade }
  if (type === 'dungeon-floor') return { r: 0.22 * shade, g: 0.17 * shade, b: 0.11 * shade }
  if (type === 'dungeon-rock')  return { r: 0.28 * shade, g: 0.20 * shade, b: 0.12 * shade }
  return { r: 0.13 * shade, g: 0.43 * shade, b: 0.07 * shade } // grass
}

function colorMultiplyScalar(c, s) {
  c.r *= s; c.g *= s; c.b *= s
}

function pushVertex(vertices, colors, uvs, x, y, z, color, u, v) {
  vertices.push(x, y, z)
  colors.push(color.r, color.g, color.b, 1.0) // RGBA for Babylon.js
  uvs.push(u, v)
}

function getSlopeShade(h) {
  const dx = ((h.tr + h.br) - (h.tl + h.bl)) * 0.5
  const dz = ((h.bl + h.br) - (h.tl + h.tr)) * 0.5
  const steepness = Math.abs(dx) + Math.abs(dz)

  let shade = 1.0 - steepness * 0.22
  const directional = (-dx * 0.18) + (-dz * 0.12)
  shade += directional

  return clamp(shade, 0.46, 1.04)
}

function getTileAverageHeight(h) {
  return (h.tl + h.tr + h.bl + h.br) / 4
}

function countAdjacentGround(map, x, z, groundType) {
  let count = 0
  const neighbors = [
    [x - 1, z],
    [x + 1, z],
    [x, z - 1],
    [x, z + 1]
  ]

  for (const [nx, nz] of neighbors) {
    if (map.getBaseGroundType(nx, nz) === groundType) count++
  }

  return count
}

function shouldRenderWater(map, x, z) {
  if (typeof map.shouldRenderWaterTile === 'function') {
    return map.shouldRenderWaterTile(x, z)
  }
  return map.isWaterTile(x, z)
}

function getVertexWaterProximity(map, vx, vz) {
  let maxProx = 0
  for (let dz = -2; dz <= 2; dz++) {
    for (let dx = -2; dx <= 2; dx++) {
      const tx = vx + dx
      const tz = vz + dz
      if (!shouldRenderWater(map, tx, tz)) continue
      const cx = clamp(vx, tx, tx + 1)
      const cz = clamp(vz, tz, tz + 1)
      const dist = Math.sqrt((vx - cx) * (vx - cx) + (vz - cz) * (vz - cz))
      const prox = Math.max(0, 1 - dist / 2.5)
      if (prox > maxProx) maxProx = prox
    }
  }
  return maxProx
}

function getVertexCliffStrength(map, vx, vz) {
  const h = map.getVertexHeight(vx, vz)
  let maxDiff = 0
  for (const [dx, dz] of [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[1,-1],[-1,1],[1,1]]) {
    const nx = vx + dx, nz = vz + dz
    if (nx < 0 || nx > map.width || nz < 0 || nz > map.height) continue
    const diff = Math.abs(h - map.getVertexHeight(nx, nz))
    if (diff > maxDiff) maxDiff = diff
  }
  return clamp((maxDiff - 0.9) / 1.1, 0, 1)
}

function getNoiseExtra(type, vx, vz) {
  if (type === 'grass') {
    const bigPatch = sampleNoise(vx * 0.18, vz * 0.18, 1.0, 1.2) * 0.10
    const midPatch = sampleNoise(vx * 0.42, vz * 0.42, 0.8, 1.0) * 0.038
    const tinyDither = sampleNoise(vx * 2.4, vz * 2.4, 1.5, 1.9) * 0.014
    return bigPatch + midPatch + tinyDither
  } else if (type === 'path') {
    const bigPatch = sampleNoise(vx * 0.22, vz * 0.22, 1.0, 1.1) * 0.04
    const tinyDither = sampleNoise(vx * 1.8, vz * 1.8, 1.3, 1.7) * 0.012
    return bigPatch + tinyDither
  } else if (type === 'road') {
    const smallVar = sampleNoise(vx * 1.2, vz * 1.2, 1.5, 0.9) * 0.025
    const tiny = sampleNoise(vx * 3.0, vz * 3.0, 2.0, 1.5) * 0.01
    return smallVar + tiny
  } else if (type === 'dirt' || type === 'sand') {
    return sampleNoise(vx * 0.5, vz * 0.5, 0.8, 1.1) * 0.02
  }
  return 0
}

function getVertexSlopeShade(map, vx, vz) {
  const sharingTiles = [
    [vx - 1, vz - 1],
    [vx,     vz - 1],
    [vx - 1, vz    ],
    [vx,     vz    ]
  ]

  let total = 0
  let count = 0
  for (const [tx, tz] of sharingTiles) {
    if (!map.getTile(tx, tz)) continue
    total += getSlopeShade(map.getTileCornerHeights(tx, tz))
    count++
  }

  return count > 0 ? total / count : 1.0
}

function getVertexAO(map, vx, vz) {
  const h = map.getVertexHeight(vx, vz)
  let sum = 0, count = 0
  for (const [dx, dz] of [[-1,0],[1,0],[0,-1],[0,1]]) {
    const nx = vx + dx, nz = vz + dz
    if (nx < 0 || nx > map.width || nz < 0 || nz > map.height) continue
    sum += map.getVertexHeight(nx, nz)
    count++
  }
  if (count === 0) return 1.0
  const depression = (sum / count) - h
  return 1.0 - clamp(depression * 0.16, 0, 0.40)
}

function getCornerBlendedColor(map, cornerX, cornerZ, shade) {
  const sharingTiles = [
    [cornerX - 1, cornerZ - 1],
    [cornerX,     cornerZ - 1],
    [cornerX - 1, cornerZ    ],
    [cornerX,     cornerZ    ]
  ]

  let r = 0, g = 0, b = 0, noise = 0, totalWeight = 0
  for (const [nx, nz] of sharingTiles) {
    if (!map.getTile(nx, nz)) continue
    const type = map.getBaseGroundType(nx, nz)
    if (type === 'road') continue
    const w = 1.0
    const c = groundColor(type, 1.0)
    r += c.r * w; g += c.g * w; b += c.b * w
    noise += getNoiseExtra(type, cornerX, cornerZ) * w
    totalWeight += w
  }

  if (totalWeight === 0) return groundColor('grass', shade)
  const s = shade + noise / totalWeight
  return { r: (r / totalWeight) * s, g: (g / totalWeight) * s, b: (b / totalWeight) * s }
}

function avgColor(a, b, c) {
  return { r: (a.r + b.r + c.r) / 3, g: (a.g + b.g + c.g) / 3, b: (a.b + b.b + c.b) / 3 }
}

// --- Per-rebuild vertex cache ---
let _vcCols = 0
let _vcWaterProx  = null
let _vcCliffStr   = null
let _vcAO         = null
let _vcSlopeShade = null

function _initVertexCache(map) {
  const size = (map.width + 1) * (map.height + 1)
  _vcCols       = map.width + 1
  _vcWaterProx  = new Float32Array(size).fill(-1)
  _vcCliffStr   = new Float32Array(size).fill(-1)
  _vcAO         = new Float32Array(size).fill(-1)
  _vcSlopeShade = new Float32Array(size).fill(-1)
}

function _cvWaterProx(map, vx, vz) {
  const i = vz * _vcCols + vx
  if (_vcWaterProx[i] < 0) _vcWaterProx[i] = getVertexWaterProximity(map, vx, vz)
  return _vcWaterProx[i]
}
function _cvCliffStr(map, vx, vz) {
  const i = vz * _vcCols + vx
  if (_vcCliffStr[i] < 0) _vcCliffStr[i] = getVertexCliffStrength(map, vx, vz)
  return _vcCliffStr[i]
}
function _cvAO(map, vx, vz) {
  const i = vz * _vcCols + vx
  if (_vcAO[i] < 0) _vcAO[i] = getVertexAO(map, vx, vz)
  return _vcAO[i]
}
function _cvSlopeShade(map, vx, vz) {
  const i = vz * _vcCols + vx
  if (_vcSlopeShade[i] < 0) _vcSlopeShade[i] = getVertexSlopeShade(map, vx, vz)
  return _vcSlopeShade[i]
}

// --- Persistent land mesh for partial height-only updates ---
let _landMesh = null
let _landPosBuf = null
let _landColBuf = null
let _landTileOff = null
let _landMapW = 0
let _landMapH = 0

function addTileGeometry(vertices, colors, uvs, indices, base, tileType, h, x, z, map, shadowInf) {
  const shadeTL = _cvSlopeShade(map, x,     z    )
  const shadeTR = _cvSlopeShade(map, x + 1, z    )
  const shadeBL = _cvSlopeShade(map, x,     z + 1)
  const shadeBR = _cvSlopeShade(map, x + 1, z + 1)
  const slopeShade = (shadeTL + shadeTR + shadeBL + shadeBR) / 4

  const tile = map.getTile(x, z)
  const groundBType = tile?.groundB || null
  const splitDir = tile?.split || 'forward'

  let cTL, cTR, cBL, cBR
  if (tileType === 'road') {
    const noise = getNoiseExtra('road', x + 0.5, z + 0.5)
    cTL = groundColor('road', Math.max(shadeTL + noise, 0.5))
    cTR = groundColor('road', Math.max(shadeTR + noise, 0.5))
    cBL = groundColor('road', Math.max(shadeBL + noise, 0.5))
    cBR = groundColor('road', Math.max(shadeBR + noise, 0.5))
  } else {
    cTL = getCornerBlendedColor(map, x,     z,     shadeTL)
    cTR = getCornerBlendedColor(map, x + 1, z,     shadeTR)
    cBL = getCornerBlendedColor(map, x,     z + 1, shadeBL)
    cBR = getCornerBlendedColor(map, x + 1, z + 1, shadeBR)
  }

  if (tileType !== 'water') {
    const wLevel = map.getTileWaterLevel(x, z)

    const proxTL = _cvWaterProx(map, x,     z    )
    const proxTR = _cvWaterProx(map, x + 1, z    )
    const proxBL = _cvWaterProx(map, x,     z + 1)
    const proxBR = _cvWaterProx(map, x + 1, z + 1)

    const applyMud = (c, t) => {
      if (t <= 0) return
      c.r *= 1 + t * 0.18
      c.g *= 1 - t * 0.22
      c.b *= 1 - t * 0.28
    }
    applyMud(cTL, proxTL)
    applyMud(cTR, proxTR)
    applyMud(cBL, proxBL)
    applyMud(cBR, proxBR)

    const applyDepth = (c, vertH) => {
      const depth = clamp((wLevel - vertH) / 2.5, 0, 1)
      if (depth <= 0) return
      c.r *= 1 - depth * 0.60
      c.g *= 1 - depth * 0.45
      c.b *= 1 - depth * 0.20
    }
    applyDepth(cTL, h.tl)
    applyDepth(cTR, h.tr)
    applyDepth(cBL, h.bl)
    applyDepth(cBR, h.br)
  }

  if (tileType !== 'water') {
    const applyCliffTint = (c, t) => {
      if (t <= 0) return
      c.r *= 1 + t * 0.04
      c.g *= 1 - t * 0.08
      c.b *= 1 - t * 0.16
    }
    applyCliffTint(cTL, _cvCliffStr(map, x,     z    ))
    applyCliffTint(cTR, _cvCliffStr(map, x + 1, z    ))
    applyCliffTint(cBL, _cvCliffStr(map, x,     z + 1))
    applyCliffTint(cBR, _cvCliffStr(map, x + 1, z + 1))
  }

  if (tileType !== 'water') {
    colorMultiplyScalar(cTL, _cvAO(map, x,     z    ))
    colorMultiplyScalar(cTR, _cvAO(map, x + 1, z    ))
    colorMultiplyScalar(cBL, _cvAO(map, x,     z + 1))
    colorMultiplyScalar(cBR, _cvAO(map, x + 1, z + 1))
  }

  const shadowableType = tileType === 'grass' || tileType === 'dirt' || tileType === 'path'
  if (shadowableType && shadowInf) {
    colorMultiplyScalar(cTL, shadowInf[z    ][x    ])
    colorMultiplyScalar(cTR, shadowInf[z    ][x + 1])
    colorMultiplyScalar(cBL, shadowInf[z + 1][x    ])
    colorMultiplyScalar(cBR, shadowInf[z + 1][x + 1])
  }

  if (groundBType && groundBType !== tileType) {
    const noiseA = getNoiseExtra(tileType, x + 0.25, z + 0.25)
    const noiseB = getNoiseExtra(groundBType, x + 0.75, z + 0.75)
    const cA = groundColor(tileType, Math.max(slopeShade + noiseA, 0.5))
    const cB = groundColor(groundBType, Math.max(slopeShade + noiseB, 0.5))
    const avgAO = (_cvAO(map, x, z) + _cvAO(map, x+1, z) + _cvAO(map, x, z+1) + _cvAO(map, x+1, z+1)) / 4
    const shadowableA = tileType === 'grass' || tileType === 'dirt' || tileType === 'path'
    const shadowableB = groundBType === 'grass' || groundBType === 'dirt' || groundBType === 'path'
    const avgShadow = shadowInf
      ? (shadowInf[z][x] + shadowInf[z][x+1] + shadowInf[z+1][x] + shadowInf[z+1][x+1]) / 4
      : 1.0
    colorMultiplyScalar(cA, avgAO * (shadowableA && shadowInf ? avgShadow : 1.0))
    colorMultiplyScalar(cB, avgAO * (shadowableB && shadowInf ? avgShadow : 1.0))

    if (splitDir === 'forward') {
      // Triangle A (matches game CW winding for RHS): TL, TR, BL
      pushVertex(vertices, colors, uvs, x,     h.tl, z,     cA, 0, 0)
      pushVertex(vertices, colors, uvs, x + 1, h.tr, z,     cA, 1, 0)
      pushVertex(vertices, colors, uvs, x,     h.bl, z + 1, cA, 0, 1)
      // Triangle B: TR, BR, BL
      pushVertex(vertices, colors, uvs, x + 1, h.tr, z,     cB, 1, 0)
      pushVertex(vertices, colors, uvs, x + 1, h.br, z + 1, cB, 1, 1)
      pushVertex(vertices, colors, uvs, x,     h.bl, z + 1, cB, 0, 1)
    } else {
      // Triangle A: TL, TR, BR
      pushVertex(vertices, colors, uvs, x,     h.tl, z,     cA, 0, 0)
      pushVertex(vertices, colors, uvs, x + 1, h.tr, z,     cA, 1, 0)
      pushVertex(vertices, colors, uvs, x + 1, h.br, z + 1, cA, 1, 1)
      // Triangle B: TL, BR, BL
      pushVertex(vertices, colors, uvs, x,     h.tl, z,     cB, 0, 0)
      pushVertex(vertices, colors, uvs, x + 1, h.br, z + 1, cB, 1, 1)
      pushVertex(vertices, colors, uvs, x,     h.bl, z + 1, cB, 0, 1)
    }

    indices.push(base + 0, base + 1, base + 2, base + 3, base + 4, base + 5)
    return 6
  }

  pushVertex(vertices, colors, uvs, x,     h.tl, z,     cTL, 0, 0)
  pushVertex(vertices, colors, uvs, x + 1, h.tr, z,     cTR, 1, 0)
  pushVertex(vertices, colors, uvs, x,     h.bl, z + 1, cBL, 0, 1)
  pushVertex(vertices, colors, uvs, x + 1, h.br, z + 1, cBR, 1, 1)

  if (splitDir === 'forward') {
    // 0=TL, 1=TR, 2=BL, 3=BR; matches game CW winding for RHS (upward normals)
    indices.push(base + 0, base + 1, base + 2, base + 1, base + 3, base + 2)
  } else {
    // diagonal TR-BL
    indices.push(base + 0, base + 1, base + 3, base + 0, base + 3, base + 2)
  }
  return 4
}

// Helper: create a Babylon.js mesh from raw vertex data arrays
function createMeshFromArrays(name, positions, colors4, uvs, indices, scene, updatable = false) {
  const mesh = new Mesh(name, scene)
  const vertexData = new VertexData()
  vertexData.positions = positions
  vertexData.indices = indices
  if (colors4 && colors4.length > 0) vertexData.colors = colors4
  if (uvs && uvs.length > 0) vertexData.uvs = uvs
  const normals = []
  VertexData.ComputeNormals(positions, indices, normals)
  vertexData.normals = normals
  vertexData.applyToMesh(mesh, updatable)
  mesh.hasVertexAlpha = false
  return mesh
}

function createLambertMaterial(name, scene, opts = {}) {
  const mat = new StandardMaterial(name, scene)
  mat.specularColor = new Color3(0, 0, 0)
  mat.backFaceCulling = opts.backFaceCulling !== undefined ? opts.backFaceCulling : true
  if (opts.alpha !== undefined) mat.alpha = opts.alpha
  if (opts.zOffset !== undefined) mat.zOffset = opts.zOffset
  if (opts.diffuseColor) mat.diffuseColor = opts.diffuseColor
  if (opts.diffuseTexture) mat.diffuseTexture = opts.diffuseTexture
  return mat
}

export function buildTerrainMeshes(map, waterTexture, shadowInf = null, scene) {
  _initVertexCache(map)

  const landVertices = []
  const landColors = []
  const landUVs = []
  const landIndices = []

  const waterVertices = []
  const waterColors = []
  const waterUVs = []
  const waterIndices = []

  let landBase = 0
  let waterBase = 0

  const newTileOff = new Int32Array(map.width * map.height)

  for (let z = 0; z < map.height; z++) {
    for (let x = 0; x < map.width; x++) {
      newTileOff[z * map.width + x] = landBase
      const h = map.getTileCornerHeights(x, z)
      const landType = map.getBaseGroundType(x, z)

      landBase += addTileGeometry(
        landVertices, landColors, landUVs, landIndices,
        landBase, landType, h, x, z, map, shadowInf
      )

      if (shouldRenderWater(map, x, z)) {
        const wY = map.getTileWaterLevel(x, z) + 0.02
        const WATER_UV_SCALE = 5
        const u0 = x / WATER_UV_SCALE
        const u1 = (x + 1) / WATER_UV_SCALE
        const v0 = z / WATER_UV_SCALE
        const v1 = (z + 1) / WATER_UV_SCALE
        const wc = groundColor('water', 1.0)
        waterVertices.push(x, wY, z,  x+1, wY, z,  x, wY, z+1,  x+1, wY, z+1)
        waterColors.push(wc.r, wc.g, wc.b, 1, wc.r, wc.g, wc.b, 1, wc.r, wc.g, wc.b, 1, wc.r, wc.g, wc.b, 1)
        waterUVs.push(u0, v0,  u1, v0,  u0, v1,  u1, v1)
        waterIndices.push(waterBase, waterBase+2, waterBase+1, waterBase+2, waterBase+3, waterBase+1)
        waterBase += 4
      }
    }
  }

  // Surface water pass (rice paddies, flooded fields)
  const swVertices = []
  const swColors = []
  const swUVs = []
  const swIndices = []
  let swBase = 0

  const _swColor = { r: 0.55, g: 0.72, b: 0.78 }
  for (let z = 0; z < map.height; z++) {
    for (let x = 0; x < map.width; x++) {
      const tile = map.getTile(x, z)
      if (!tile?.waterSurface) continue

      const h = map.getTileCornerHeights(x, z)
      const LIFT = 0.05
      const WATER_UV_SCALE = 5
      const u0 = x / WATER_UV_SCALE, u1 = (x + 1) / WATER_UV_SCALE
      const v0 = z / WATER_UV_SCALE, v1 = (z + 1) / WATER_UV_SCALE
      const wc = _swColor
      swVertices.push(x, h.tl+LIFT, z,  x+1, h.tr+LIFT, z,  x, h.bl+LIFT, z+1,  x+1, h.br+LIFT, z+1)
      swColors.push(wc.r, wc.g, wc.b, 1, wc.r, wc.g, wc.b, 1, wc.r, wc.g, wc.b, 1, wc.r, wc.g, wc.b, 1)
      swUVs.push(u0, v0,  u1, v0,  u0, v1,  u1, v1)
      swIndices.push(swBase, swBase+2, swBase+1, swBase+2, swBase+3, swBase+1)
      swBase += 4
    }
  }

  const group = new TransformNode('terrain-group', scene)
  group.setEnabled(false)  // start hidden — caller enables after swap

  // Store persistent land geometry for partial height-only updates
  _landTileOff = newTileOff
  _landMapW    = map.width
  _landMapH    = map.height
  _landPosBuf  = new Float32Array(landVertices)
  _landColBuf  = new Float32Array(landColors)

  if (landVertices.length > 0) {
    const landMesh = createMeshFromArrays('terrain-land', landVertices, landColors, landUVs, landIndices, scene, true)
    const landMat = createLambertMaterial('terrain-land-mat', scene, { backFaceCulling: false })
    landMesh.material = landMat
    landMesh.parent = group
    _landMesh = landMesh
  }

  if (waterVertices.length > 0) {
    const waterMesh = createMeshFromArrays('terrain-water', waterVertices, waterColors, waterUVs, waterIndices, scene)
    const waterMat = createLambertMaterial('terrain-water-mat', scene, {
      backFaceCulling: false,
      alpha: 0.88,
      zOffset: -1,
      diffuseColor: waterTexture ? new Color3(0.83, 0.91, 1.0) : new Color3(0.42, 0.52, 0.70),
    })
    if (waterTexture) {
      waterTexture.wrapU = Texture.WRAP_ADDRESSMODE
      waterTexture.wrapV = Texture.WRAP_ADDRESSMODE
      waterMat.diffuseTexture = waterTexture
    }
    waterMesh.material = waterMat
    waterMesh.hasVertexAlpha = true
    waterMesh.parent = group
  }

  if (swVertices.length > 0) {
    const swMesh = createMeshFromArrays('terrain-surface-water', swVertices, swColors, swUVs, swIndices, scene)
    let swTex = null
    if (waterTexture) {
      swTex = waterTexture.clone()
      swTex.wrapU = Texture.WRAP_ADDRESSMODE
      swTex.wrapV = Texture.WRAP_ADDRESSMODE
    }
    const swMat = createLambertMaterial('terrain-sw-mat', scene, {
      backFaceCulling: false,
      alpha: 0.25,
      zOffset: -2,
      diffuseColor: swTex ? new Color3(0.88, 0.96, 0.97) : new Color3(0.54, 0.78, 0.85),
    })
    if (swTex) swMat.diffuseTexture = swTex
    swMesh.material = swMat
    swMesh.hasVertexAlpha = true
    swMesh.parent = group
  }

  return group
}

export function buildWaterMeshes(map, waterTexture, scene) {
  const group = new TransformNode('terrain-water-group', scene)
  group.setEnabled(false)

  const waterVertices = []
  const waterColors   = []
  const waterUVs      = []
  const waterIndices  = []
  let waterBase = 0

  for (let z = 0; z < map.height; z++) {
    for (let x = 0; x < map.width; x++) {
      if (!shouldRenderWater(map, x, z)) continue
      const wY = map.getTileWaterLevel(x, z) + 0.02
      const WATER_UV_SCALE = 5
      const u0 = x / WATER_UV_SCALE, u1 = (x + 1) / WATER_UV_SCALE
      const v0 = z / WATER_UV_SCALE, v1 = (z + 1) / WATER_UV_SCALE
      const wc = groundColor('water', 1.0)
      waterVertices.push(x, wY, z,  x+1, wY, z,  x, wY, z+1,  x+1, wY, z+1)
      waterColors.push(wc.r, wc.g, wc.b, 1, wc.r, wc.g, wc.b, 1, wc.r, wc.g, wc.b, 1, wc.r, wc.g, wc.b, 1)
      waterUVs.push(u0, v0,  u1, v0,  u0, v1,  u1, v1)
      waterIndices.push(waterBase, waterBase+2, waterBase+1, waterBase+2, waterBase+3, waterBase+1)
      waterBase += 4
    }
  }

  if (waterVertices.length > 0) {
    const mesh = createMeshFromArrays('terrain-water', waterVertices, waterColors, waterUVs, waterIndices, scene)
    if (waterTexture) {
      waterTexture.wrapU = Texture.WRAP_ADDRESSMODE
      waterTexture.wrapV = Texture.WRAP_ADDRESSMODE
    }
    const mat = createLambertMaterial('terrain-water-mat', scene, {
      backFaceCulling: false,
      alpha: 0.88,
      zOffset: -1,
      diffuseColor: waterTexture ? new Color3(0.83, 0.91, 1.0) : new Color3(0.42, 0.52, 0.70),
    })
    if (waterTexture) mat.diffuseTexture = waterTexture
    mesh.material = mat
    mesh.hasVertexAlpha = false
    mesh.parent = group
  }

  const swVertices = [], swColors = [], swUVs = [], swIndices = []
  let swBase = 0
  const _swColor = { r: 0.55, g: 0.72, b: 0.78 }
  for (let z = 0; z < map.height; z++) {
    for (let x = 0; x < map.width; x++) {
      const tile = map.getTile(x, z)
      if (!tile?.waterSurface) continue
      const h = map.getTileCornerHeights(x, z)
      const LIFT = 0.05, WATER_UV_SCALE = 5
      const u0 = x / WATER_UV_SCALE, u1 = (x + 1) / WATER_UV_SCALE
      const v0 = z / WATER_UV_SCALE, v1 = (z + 1) / WATER_UV_SCALE
      const wc = _swColor
      swVertices.push(x, h.tl+LIFT, z,  x+1, h.tr+LIFT, z,  x, h.bl+LIFT, z+1,  x+1, h.br+LIFT, z+1)
      swColors.push(wc.r, wc.g, wc.b, 1, wc.r, wc.g, wc.b, 1, wc.r, wc.g, wc.b, 1, wc.r, wc.g, wc.b, 1)
      swUVs.push(u0, v0,  u1, v0,  u0, v1,  u1, v1)
      swIndices.push(swBase, swBase+2, swBase+1, swBase+2, swBase+3, swBase+1)
      swBase += 4
    }
  }

  if (swVertices.length > 0) {
    const mesh = createMeshFromArrays('terrain-surface-water', swVertices, swColors, swUVs, swIndices, scene)
    let swTex = null
    if (waterTexture) {
      swTex = waterTexture.clone()
      swTex.wrapU = Texture.WRAP_ADDRESSMODE
      swTex.wrapV = Texture.WRAP_ADDRESSMODE
    }
    const mat = createLambertMaterial('terrain-sw-mat', scene, {
      backFaceCulling: false,
      alpha: 0.25,
      zOffset: -2,
      diffuseColor: swTex ? new Color3(0.88, 0.96, 0.97) : new Color3(0.54, 0.78, 0.85),
    })
    if (swTex) mat.diffuseTexture = swTex
    mesh.material = mat
    mesh.hasVertexAlpha = false
    mesh.parent = group
  }

  return group
}

export function buildCliffMeshes(map, scene) {
  const vertices = []
  const indices = []
  const colors = []
  let base = 0

  function cliffColor(topY, bottomY) {
    const drop = Math.max(0, topY - bottomY)
    const shade = clamp(0.92 - drop * 0.12, 0.42, 0.92)
    return { r: 0.37 * shade, g: 0.29 * shade, b: 0.12 * shade }
  }

  function pushColoredQuad(a, b, c, d, color) {
    vertices.push(...a, ...b, ...c, ...d)
    for (let i = 0; i < 4; i++) {
      colors.push(color.r, color.g, color.b, 1.0)
    }
    indices.push(
      base + 0, base + 2, base + 1,
      base + 2, base + 3, base + 1
    )
    base += 4
  }

  function addVerticalFace(x1, z1, top1, top2, bottom1, bottom2, isXAxisFace) {
    const eps = 0.01
    const color = cliffColor((top1 + top2) * 0.5, (bottom1 + bottom2) * 0.5)

    if (isXAxisFace) {
      pushColoredQuad(
        [x1, top1, z1],
        [x1, top2, z1 + 1],
        [x1, bottom1 + eps, z1],
        [x1, bottom2 + eps, z1 + 1],
        color
      )
    } else {
      pushColoredQuad(
        [x1, top1, z1],
        [x1 + 1, top2, z1],
        [x1, bottom1 + eps, z1],
        [x1 + 1, bottom2 + eps, z1],
        color
      )
    }
  }

  for (let z = 0; z < map.height; z++) {
    for (let x = 0; x < map.width; x++) {
      const h = map.getTileCornerHeights(x, z)
      const wLevel = map.getTileWaterLevel(x, z)

      const rightTile = map.getTile(x + 1, z)
      if (rightTile) {
        const rh = map.getTileCornerHeights(x + 1, z)
        const aTop1 = h.tr, aTop2 = h.br
        const bTop1 = rh.tl, bTop2 = rh.bl
        const avgA = (aTop1 + aTop2) * 0.5
        const avgB = (bTop1 + bTop2) * 0.5
        if (Math.abs(avgA - avgB) > 0.01 && Math.max(avgA, avgB) > wLevel) {
          if (avgA > avgB) {
            addVerticalFace(x + 1, z, aTop1, aTop2, bTop1, bTop2, true)
          } else {
            addVerticalFace(x + 1, z, bTop1, bTop2, aTop1, aTop2, true)
          }
        }
      }

      const downTile = map.getTile(x, z + 1)
      if (downTile) {
        const dh = map.getTileCornerHeights(x, z + 1)
        const aTop1 = h.bl, aTop2 = h.br
        const bTop1 = dh.tl, bTop2 = dh.tr
        const avgA = (aTop1 + aTop2) * 0.5
        const avgB = (bTop1 + bTop2) * 0.5
        if (Math.abs(avgA - avgB) > 0.01 && Math.max(avgA, avgB) > wLevel) {
          if (avgA > avgB) {
            addVerticalFace(x, z + 1, aTop1, aTop2, bTop1, bTop2, false)
          } else {
            addVerticalFace(x, z + 1, bTop1, bTop2, aTop1, aTop2, false)
          }
        }
      }
    }
  }

  if (vertices.length === 0) return null

  const mesh = createMeshFromArrays('cliffs', vertices, colors, null, indices, scene)
  const mat = createLambertMaterial('cliffs-mat', scene, { backFaceCulling: false })
  mesh.material = mat
  mesh.hasVertexAlpha = true
  mesh.setEnabled(false)  // start hidden — caller enables after swap
  return mesh
}

function rotateUV(u, v, rotation) {
  const cx = 0.5
  const cy = 0.5
  const x = u - cx
  const y = v - cy

  const r = rotation % 4
  if (r === 1) return [-y + cx, x + cy]
  if (r === 2) return [-x + cx, -y + cy]
  if (r === 3) return [y + cx, -x + cy]
  return [u, v]
}

function scaledRotatedUVs(rotation, scale) {
  const s = Math.max(0.1, scale)
  const base = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1]
  ]

  return base.map(([u, v]) => {
    const su = (u - 0.5) / s + 0.5
    const sv = (v - 0.5) / s + 0.5
    return rotateUV(su, sv, rotation)
  })
}

export function updateTerrainLandHeights(map, shadowInf, x1, z1, x2, z2) {
  if (!_landMesh || !_landTileOff || _landMapW !== map.width || _landMapH !== map.height) return false

  _initVertexCache(map)

  const margin = 3
  const rx1 = Math.max(0, x1 - margin)
  const rz1 = Math.max(0, z1 - margin)
  const rx2 = Math.min(map.width - 1, x2 + margin)
  const rz2 = Math.min(map.height - 1, z2 + margin)

  const tmpV = [], tmpC = [], tmpU = [], tmpI = []

  for (let z = rz1; z <= rz2; z++) {
    for (let x = rx1; x <= rx2; x++) {
      const off = _landTileOff[z * map.width + x]
      const h = map.getTileCornerHeights(x, z)
      const landType = map.getBaseGroundType(x, z)

      // Determine how many vertices were allocated for this tile at build time
      const tileIdx = z * map.width + x
      const nextOff = (tileIdx + 1 < map.width * map.height) ? _landTileOff[tileIdx + 1] : (_landPosBuf.length / 3)
      const allocatedVerts = nextOff - off

      tmpV.length = 0; tmpC.length = 0; tmpU.length = 0; tmpI.length = 0
      const vertCount = addTileGeometry(tmpV, tmpC, tmpU, tmpI, 0, landType, h, x, z, map, shadowInf)

      // If vertex count changed (e.g. single→split ground), need full rebuild
      if (vertCount !== allocatedVerts) return false

      // Update position buffer (3 components per vertex)
      const posBase = off * 3
      for (let i = 0; i < vertCount * 3; i++) {
        _landPosBuf[posBase + i] = tmpV[i]
      }
      // Update color buffer (4 components per vertex — RGBA)
      const colBase = off * 4
      for (let i = 0; i < vertCount * 4; i++) {
        _landColBuf[colBase + i] = tmpC[i]
      }
    }
  }

  _landMesh.updateVerticesData(VertexBuffer.PositionKind, _landPosBuf)
  _landMesh.updateVerticesData(VertexBuffer.ColorKind, _landColBuf)
  return true
}

export function buildTextureOverlays(map, textureRegistry, textureCache, scene) {
  const group = new TransformNode('texture-overlays', scene)
  group.setEnabled(false)

  for (let z = 0; z < map.height; z++) {
    for (let x = 0; x < map.width; x++) {
      const tile = map.getTile(x, z)
      if (!tile || (!tile.textureId && !tile.textureIdB)) continue

      const h = map.getTileCornerHeights(x, z)
      const overlayOffset = 0.008

      const positions = [
        x,     h.tl + overlayOffset, z,
        x + 1, h.tr + overlayOffset, z,
        x,     h.bl + overlayOffset, z + 1,
        x + 1, h.br + overlayOffset, z + 1
      ]

      const fwd = tile.split === 'forward'
      const firstIndices  = fwd ? [0, 2, 1]       : [0, 2, 3]
      const secondIndices = fwd ? [2, 3, 1]       : [0, 3, 1]
      const fullIndices   = fwd ? [0, 2, 1, 2, 3, 1] : [0, 2, 3, 0, 3, 1]

      const makeUVs = (rotation, scale, worldUV) => {
        if (worldUV) {
          const s = Math.max(0.1, scale)
          return [x/s, z/s, (x+1)/s, z/s, x/s, (z+1)/s, (x+1)/s, (z+1)/s]
        }
        const uv = scaledRotatedUVs(rotation, scale)
        return [uv[0][0], uv[0][1], uv[1][0], uv[1][1], uv[2][0], uv[2][1], uv[3][0], uv[3][1]]
      }

      const addMesh = (textureId, rotation, scale, worldUV, idxs) => {
        const textureInfo = textureRegistry.find((t) => t.id === textureId)
        if (!textureInfo) return
        const texture = textureCache.get(textureInfo.id)
        if (!texture) return

        texture.wrapU = Texture.WRAP_ADDRESSMODE
        texture.wrapV = Texture.WRAP_ADDRESSMODE

        const mesh = createMeshFromArrays(`texoverlay_${x}_${z}`, positions, null, makeUVs(rotation, scale, worldUV), idxs, scene)
        const mat = new StandardMaterial(`texoverlay_mat_${x}_${z}`, scene)
        mat.diffuseTexture = texture
        mat.diffuseColor = new Color3(0.82, 0.82, 0.82)
        mat.emissiveTexture = texture
        mat.emissiveColor = new Color3(0.18, 0.18, 0.18)
        mat.specularColor = new Color3(0, 0, 0)
        mat.useAlphaFromDiffuseTexture = true
        mat.transparencyMode = 1 // ALPHATEST
        mat.backFaceCulling = false
        mat.zOffset = -2
        mesh.material = mat
        mesh.parent = group
      }

      if (tile.textureHalfMode) {
        if (tile.textureId) addMesh(tile.textureId, tile.textureRotation, tile.textureScale, tile.textureWorldUV, firstIndices)
        if (tile.textureIdB) addMesh(tile.textureIdB, tile.textureRotationB, tile.textureScaleB, false, secondIndices)
      } else if (tile.textureId) {
        addMesh(tile.textureId, tile.textureRotation, tile.textureScale, tile.textureWorldUV, fullIndices)
      }
    }
  }

  return group
}

export function buildSingleTexturePlane(plane, textureRegistry, textureCache, scene, isSelected) {
  const textureInfo = textureRegistry.find((t) => t.id === plane.textureId)
  if (!textureInfo) return null

  const textureSrc = textureCache.get(textureInfo.id)
  if (!textureSrc) return null

  const texture = textureSrc.clone()
  const scale = plane.uvRepeat || 1

  texture.wrapU = Texture.WRAP_ADDRESSMODE
  texture.wrapV = Texture.WRAP_ADDRESSMODE
  texture.uScale = 1 / scale
  texture.vScale = 1 / scale
  texture.wAng = (plane.texRotation || 0) * Math.PI / 2

  const mesh = MeshBuilder.CreatePlane(`texplane_${plane.id}`, {
    width: Math.max(0.01, plane.width || 1),
    height: Math.max(0.01, plane.height || 1),
    sideOrientation: Mesh.DOUBLESIDE
  }, scene)

  texture.hasAlpha = true
  const mat = new StandardMaterial(`texplane_mat_${plane.id}`, scene)
  mat.diffuseTexture = texture
  mat.emissiveTexture = texture
  mat.useAlphaFromDiffuseTexture = true
  mat.diffuseColor = new Color3(0, 0, 0)
  mat.emissiveColor = isSelected ? new Color3(0.2, 0.4, 0.8) : new Color3(1, 1, 1)
  mat.specularColor = new Color3(0, 0, 0)
  mat.transparencyMode = 1
  mat.alphaCutOff = 0.05
  mat.zOffset = -1
  mesh.material = mat

  mesh.position.set(plane.position?.x ?? 0, plane.position?.y ?? 0, plane.position?.z ?? 0)
  mesh.rotation.set(plane.rotation?.x ?? 0, plane.rotation?.y ?? 0, plane.rotation?.z ?? 0)
  mesh.scaling.set(plane.scale?.x ?? 1, plane.scale?.y ?? 1, plane.scale?.z ?? 1)
  mesh.renderingGroupId = 0
  mesh.metadata = { texturePlane: plane }

  return mesh
}

export function buildTexturePlanes(map, textureRegistry, textureCache, scene) {
  const group = new TransformNode('texture-planes', scene)
  group.setEnabled(false)

  for (const plane of map.texturePlanes) {
    const isSelected = map.selectedTexturePlaneId === plane.id
    const mesh = buildSingleTexturePlane(plane, textureRegistry, textureCache, scene, isSelected)
    if (mesh) mesh.parent = group
  }

  return group
}
