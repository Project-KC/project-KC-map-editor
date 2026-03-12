import * as THREE from 'three'

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function groundColor(type, shade) {
  if (type === 'dirt') {
    return new THREE.Color(0.43 * shade, 0.29 * shade, 0.11 * shade)
  }

  if (type === 'sand') {
    return new THREE.Color(0.58 * shade, 0.49 * shade, 0.18 * shade)
  }

  if (type === 'path') {
    return new THREE.Color(0.46 * shade, 0.43 * shade, 0.36 * shade)
  }

  if (type === 'water') {
    return new THREE.Color(0.42 * shade, 0.49 * shade, 0.68 * shade)
  }

  // grass
  return new THREE.Color(0.20 * shade, 0.44 * shade, 0.11 * shade)
}

function pushVertex(vertices, colors, uvs, x, y, z, color, u, v) {
  vertices.push(x, y, z)
  colors.push(color.r, color.g, color.b)
  uvs.push(u, v)
}

function getSlopeShade(h) {
  const dx = ((h.tr + h.br) - (h.tl + h.bl)) * 0.5
  const dz = ((h.bl + h.br) - (h.tl + h.tr)) * 0.5

  const steepness = Math.abs(dx) + Math.abs(dz)

  // stronger darkening for hills
  let shade = 1.0 - steepness * 0.18

  // fake directional light from upper-left
  const directional = (-dx * 0.18) + (-dz * 0.12)
  shade += directional

  return clamp(shade, 0.48, 1.10)
}

function isWaterNearby(map, x, z) {
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const tile = map.getTile(x + dx, z + dz)
      if (tile && tile.ground === 'water') return true
    }
  }
  return false
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
    const tile = map.getTile(nx, nz)
    if (tile && tile.ground === groundType) count++
  }

  return count
}

function isPathEdge(map, x, z) {
  const tile = map.getTile(x, z)
  if (!tile || tile.ground !== 'path') return false
  return countAdjacentGround(map, x, z, 'path') < 4
}

function isCliffNearby(map, x, z) {
  const h = map.getTileCornerHeights(x, z)
  const minH = Math.min(h.tl, h.tr, h.bl, h.br)
  const maxH = Math.max(h.tl, h.tr, h.bl, h.br)

  // strong slope inside this tile
  if ((maxH - minH) > 1.5) return true

  const centerAvg = (h.tl + h.tr + h.bl + h.br) / 4

  const neighbors = [
    [x - 1, z],
    [x + 1, z],
    [x, z - 1],
    [x, z + 1]
  ]

  for (const [nx, nz] of neighbors) {
    const n = map.getTile(nx, nz)
    if (!n) continue

    const nh = map.getTileCornerHeights(nx, nz)
    const nAvg = (nh.tl + nh.tr + nh.bl + nh.br) / 4

    if (Math.abs(centerAvg - nAvg) > 1.2) {
      return true
    }
  }

  return false
}

function addTileGeometry(vertices, colors, uvs, indices, base, tile, h, x, z, map) {
  const slopeShade = getSlopeShade(h)

  // subtle variation, not checkerboard
  const variation = (((x * 17 + z * 31) % 9) - 4) * 0.01

  const shadeTL = slopeShade + variation + 0.05
  const shadeTR = slopeShade + variation + 0.01
  const shadeBL = slopeShade + variation - 0.05
  const shadeBR = slopeShade + variation - 0.02

  const cTL = groundColor(tile.ground, shadeTL)
  const cTR = groundColor(tile.ground, shadeTR)
  const cBL = groundColor(tile.ground, shadeBL)
  const cBR = groundColor(tile.ground, shadeBR)

  const nearWater = isWaterNearby(map, x, z)
  const nearCliff = isCliffNearby(map, x, z)
  const pathEdge = isPathEdge(map, x, z)

  // muddier banks near water
  if (tile.ground !== 'water' && nearWater) {
    for (const c of [cTL, cTR, cBL, cBR]) {
      c.r *= 1.05
      c.g *= 0.96
      c.b *= 0.90
    }
  }

  // warmer, dirtier land near cliffs
  if (tile.ground !== 'water' && nearCliff) {
    for (const c of [cTL, cTR, cBL, cBR]) {
      c.r *= 1.06
      c.g *= 0.92
      c.b *= 0.82
    }
  }

  // soften path edges
  if (tile.ground === 'path' && pathEdge) {
    for (const c of [cTL, cTR, cBL, cBR]) {
      c.r *= 0.94
      c.g *= 0.95
      c.b *= 0.92
    }

    cBL.r *= 1.04
    cBL.g *= 0.98
    cBR.r *= 1.03
    cBR.g *= 0.99
  }

  // dirty grass near paths
  if (tile.ground === 'grass') {
    const adjacentPaths = countAdjacentGround(map, x, z, 'path')
    if (adjacentPaths > 0) {
      const pathInfluence = 1 + adjacentPaths * 0.02

      for (const c of [cTL, cTR, cBL, cBR]) {
        c.r *= 1.02 * pathInfluence
        c.g *= 0.96
        c.b *= 0.88
      }
    }
  }

  // warm lower corners a bit for old-school painted feel
  cBL.r *= 1.03
  cBL.g *= 0.98
  cBR.r *= 1.02
  cBR.g *= 0.99

  pushVertex(vertices, colors, uvs, x,     h.tl, z,     cTL, 0, 0)
  pushVertex(vertices, colors, uvs, x + 1, h.tr, z,     cTR, 1, 0)
  pushVertex(vertices, colors, uvs, x,     h.bl, z + 1, cBL, 0, 1)
  pushVertex(vertices, colors, uvs, x + 1, h.br, z + 1, cBR, 1, 1)

  if (tile.split === 'forward') {
    indices.push(
      base + 0, base + 2, base + 1,
      base + 2, base + 3, base + 1
    )
  } else {
    indices.push(
      base + 0, base + 2, base + 3,
      base + 0, base + 3, base + 1
    )
  }
}

export function buildTerrainMeshes(map, waterTexture) {
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

  for (let z = 0; z < map.height; z++) {
    for (let x = 0; x < map.width; x++) {
      const tile = map.getTile(x, z)
      const h = map.getTileCornerHeights(x, z)

      if (tile.ground === 'water') {
        addTileGeometry(
          waterVertices,
          waterColors,
          waterUVs,
          waterIndices,
          waterBase,
          tile,
          h,
          x,
          z,
          map
        )
        waterBase += 4
      } else {
        addTileGeometry(
          landVertices,
          landColors,
          landUVs,
          landIndices,
          landBase,
          tile,
          h,
          x,
          z,
          map
        )
        landBase += 4
      }
    }
  }

  const group = new THREE.Group()
  group.name = 'terrain-group'

  if (landVertices.length > 0) {
    const landGeometry = new THREE.BufferGeometry()
    landGeometry.setAttribute('position', new THREE.Float32BufferAttribute(landVertices, 3))
    landGeometry.setAttribute('color', new THREE.Float32BufferAttribute(landColors, 3))
    landGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(landUVs, 2))
    landGeometry.setIndex(landIndices)
    landGeometry.computeVertexNormals()

    const landMaterial = new THREE.MeshLambertMaterial({
      vertexColors: true,
      flatShading: true
    })

    const landMesh = new THREE.Mesh(landGeometry, landMaterial)
    landMesh.name = 'terrain-land'
    landMesh.receiveShadow = true
    group.add(landMesh)
  }

  if (waterVertices.length > 0) {
    const waterGeometry = new THREE.BufferGeometry()
    waterGeometry.setAttribute('position', new THREE.Float32BufferAttribute(waterVertices, 3))
    waterGeometry.setAttribute('color', new THREE.Float32BufferAttribute(waterColors, 3))
    waterGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(waterUVs, 2))
    waterGeometry.setIndex(waterIndices)
    waterGeometry.computeVertexNormals()

    if (waterTexture) {
      waterTexture.wrapS = THREE.RepeatWrapping
      waterTexture.wrapT = THREE.RepeatWrapping
      waterTexture.repeat.set(1, 1)
      waterTexture.colorSpace = THREE.SRGBColorSpace
    }

    const waterMaterial = new THREE.MeshLambertMaterial({
      map: waterTexture || null,
      color: waterTexture ? 0xd6e4ff : 0x6e86b6,
      flatShading: true
    })

    const waterMesh = new THREE.Mesh(waterGeometry, waterMaterial)
    waterMesh.name = 'terrain-water'
    waterMesh.receiveShadow = true
    group.add(waterMesh)
  }

  return group
}

export function buildCliffMeshes(map) {
  const vertices = []
  const indices = []
  let base = 0

  function addQuad(a, b, c, d) {
    vertices.push(...a, ...b, ...c, ...d)
    indices.push(
      base + 0, base + 2, base + 1,
      base + 2, base + 3, base + 1
    )
    base += 4
  }

  for (let z = 0; z < map.height; z++) {
    for (let x = 0; x < map.width; x++) {
      const h = map.getTileCornerHeights(x, z)

      const rightTile = map.getTile(x + 1, z)
      if (rightTile) {
        const rh = map.getTileCornerHeights(x + 1, z)

        const topA = h.tr
        const bottomA = h.br
        const topB = rh.tl
        const bottomB = rh.bl

        if ((topA - topB) > 0.01 || (bottomA - bottomB) > 0.01) {
          addQuad(
            [x + 1, topA, z],
            [x + 1, bottomA, z + 1],
            [x + 1, topB + 0.01, z],
            [x + 1, bottomB + 0.01, z + 1]
          )
        }
      }

      const downTile = map.getTile(x, z + 1)
      if (downTile) {
        const dh = map.getTileCornerHeights(x, z + 1)

        const leftA = h.bl
        const rightA = h.br
        const leftB = dh.tl
        const rightB = dh.tr

        if ((leftA - leftB) > 0.01 || (rightA - rightB) > 0.01) {
          addQuad(
            [x, leftA, z + 1],
            [x + 1, rightA, z + 1],
            [x, leftB + 0.01, z + 1],
            [x + 1, rightB + 0.01, z + 1]
          )
        }
      }
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()

  const material = new THREE.MeshLambertMaterial({
    color: 0x6a5320,
    flatShading: true
  })

  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'cliffs'
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

export function buildTextureOverlays(map, textureRegistry, textureCache) {
  const group = new THREE.Group()
  group.name = 'texture-overlays'

  for (let z = 0; z < map.height; z++) {
    for (let x = 0; x < map.width; x++) {
      const tile = map.getTile(x, z)
      if (!tile || !tile.textureId) continue

      const textureInfo = textureRegistry.find((t) => t.id === tile.textureId)
      if (!textureInfo) continue

      const texture = textureCache.get(textureInfo.id)
      if (!texture) continue

      const h = map.getTileCornerHeights(x, z)
      const uv = scaledRotatedUVs(tile.textureRotation, tile.textureScale)

      const overlayOffset = 0.008

      const vertices = [
        x,     h.tl + overlayOffset, z,
        x + 1, h.tr + overlayOffset, z,
        x,     h.bl + overlayOffset, z + 1,
        x + 1, h.br + overlayOffset, z + 1
      ]

      const uvs = [
        uv[0][0], uv[0][1],
        uv[1][0], uv[1][1],
        uv[2][0], uv[2][1],
        uv[3][0], uv[3][1]
      ]

      const indices = tile.split === 'forward'
        ? [0, 2, 1, 2, 3, 1]
        : [0, 2, 3, 0, 3, 1]

      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
      geometry.setIndex(indices)
      geometry.computeVertexNormals()

      texture.wrapS = THREE.RepeatWrapping
      texture.wrapT = THREE.RepeatWrapping
      texture.colorSpace = THREE.SRGBColorSpace

      const material = new THREE.MeshLambertMaterial({
        map: texture,
        transparent: true,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2
      })

      const mesh = new THREE.Mesh(geometry, material)
      group.add(mesh)
    }
  }

  return group
}

export function buildTexturePlanes(map, textureRegistry, textureCache) {
  const group = new THREE.Group()
  group.name = 'texture-planes'

  for (const plane of map.texturePlanes) {
    const textureInfo = textureRegistry.find((t) => t.id === plane.textureId)
    if (!textureInfo) continue

    const texture = textureCache.get(textureInfo.id)
    if (!texture) continue

    texture.wrapS = THREE.RepeatWrapping
    texture.wrapT = THREE.RepeatWrapping
    texture.colorSpace = THREE.SRGBColorSpace

    const geometry = new THREE.PlaneGeometry(plane.width, plane.height)
    const isSelected = map.selectedTexturePlaneId === plane.id

    const material = new THREE.MeshLambertMaterial({
      map: texture,
      transparent: true,
      side: plane.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      color: isSelected ? 0xd8ecff : 0xffffff
    })

    const mesh = new THREE.Mesh(geometry, material)
    mesh.position.set(plane.position.x, plane.position.y, plane.position.z)
    mesh.rotation.set(plane.rotation.x, plane.rotation.y, plane.rotation.z)
    mesh.scale.set(plane.scale.x, plane.scale.y, plane.scale.z)
    mesh.userData.texturePlane = plane

    group.add(mesh)
  }

  return group
}