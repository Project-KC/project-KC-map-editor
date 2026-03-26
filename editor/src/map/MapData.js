export class MapData {
  constructor(width, height) {
    this.width = width
    this.height = height

    this.mapType = 'overworld'   // 'overworld' | 'dungeon'
    this.worldOffset = { x: 0, z: 0 }  // world-space origin of this chunk
    this.waterLevel = -2.5
    this.chunkWaterLevels = {}   // keyed "chunkX,chunkZ", overrides waterLevel per 64x64 chunk
    this.texturePlanes = []
    this.selectedTexturePlaneId = null

    this.tiles = []
    for (let z = 0; z < height; z++) {
      const row = []
      for (let x = 0; x < width; x++) {
        row.push({
          ground: 'grass',
          groundB: null,
          split: 'forward',
          textureId: null,
          textureRotation: 0,
          textureScale: 1,
          textureWorldUV: false,
          textureHalfMode: false,
          textureIdB: null,
          textureRotationB: 0,
          textureScaleB: 1,
          waterPainted: false,
          waterSurface: false
        })
      }
      this.tiles.push(row)
    }

    this.heights = []
    for (let z = 0; z <= height; z++) {
      const row = []
      for (let x = 0; x <= width; x++) {
        row.push(0)
      }
      this.heights.push(row)
    }
  }

  getTile(x, z) {
    if (x < 0 || z < 0 || x >= this.width || z >= this.height) return null
    return this.tiles[z][x]
  }

  getVertexHeight(x, z) {
    if (x < 0 || z < 0 || x > this.width || z > this.height) return 0
    return this.heights[z][x]
  }

  setVertexHeight(x, z, value) {
    if (x < 0 || z < 0 || x > this.width || z > this.height) return
    this.heights[z][x] = value
  }

  adjustVertexHeight(x, z, delta) {
    if (x < 0 || z < 0 || x > this.width || z > this.height) return
    this.heights[z][x] += delta
  }

  getTileCornerHeights(x, z) {
    if (!this.getTile(x, z)) {
      return { tl: 0, tr: 0, bl: 0, br: 0 }
    }

    return {
      tl: this.getVertexHeight(x, z),
      tr: this.getVertexHeight(x + 1, z),
      bl: this.getVertexHeight(x, z + 1),
      br: this.getVertexHeight(x + 1, z + 1)
    }
  }

  getAverageTileHeight(x, z) {
    const h = this.getTileCornerHeights(x, z)
    return (h.tl + h.tr + h.bl + h.br) / 4
  }

  getBaseGroundType(x, z) {
    const tile = this.getTile(x, z)
    if (!tile) return 'grass'
    return tile.ground || 'grass'
  }

  getChunkWaterLevel(chunkX, chunkZ) {
    const key = `${chunkX},${chunkZ}`
    return Object.prototype.hasOwnProperty.call(this.chunkWaterLevels, key)
      ? this.chunkWaterLevels[key]
      : this.waterLevel
  }

  setChunkWaterLevel(chunkX, chunkZ, level) {
    this.chunkWaterLevels[`${chunkX},${chunkZ}`] = level
  }

  clearChunkWaterLevel(chunkX, chunkZ) {
    delete this.chunkWaterLevels[`${chunkX},${chunkZ}`]
  }

  getTileWaterLevel(x, z) {
    const chunkX = Math.floor(x / 64)
    const chunkZ = Math.floor(z / 64)
    return this.getChunkWaterLevel(chunkX, chunkZ)
  }

  shouldRenderWaterTile(x, z) {
    const tile = this.getTile(x, z)
    if (!tile) return false

    if (tile.waterPainted) return true

    const h = this.getTileCornerHeights(x, z)
    const minH = Math.min(h.tl, h.tr, h.bl, h.br)

    return minH <= this.getTileWaterLevel(x, z)
  }

  getEffectiveGroundType(x, z) {
    const tile = this.getTile(x, z)
    if (!tile) return 'grass'
    return this.shouldRenderWaterTile(x, z) ? 'water' : tile.ground
  }

  isWaterTile(x, z) {
    return this.shouldRenderWaterTile(x, z)
  }

  raiseTile(x, z, amount = 0.25) {
    if (!this.getTile(x, z)) return
    this.adjustVertexHeight(x, z, amount)
    this.adjustVertexHeight(x + 1, z, amount)
    this.adjustVertexHeight(x, z + 1, amount)
    this.adjustVertexHeight(x + 1, z + 1, amount)
  }

  lowerTile(x, z, amount = 0.25) {
    if (!this.getTile(x, z)) return
    this.adjustVertexHeight(x, z, -amount)
    this.adjustVertexHeight(x + 1, z, -amount)
    this.adjustVertexHeight(x, z + 1, -amount)
    this.adjustVertexHeight(x + 1, z + 1, -amount)
  }

  flattenTile(x, z) {
    if (!this.getTile(x, z)) return

    const avg = this.getAverageTileHeight(x, z)
    this.setVertexHeight(x, z, avg)
    this.setVertexHeight(x + 1, z, avg)
    this.setVertexHeight(x, z + 1, avg)
    this.setVertexHeight(x + 1, z + 1, avg)
  }

  flattenTileToHeight(x, z, height) {
    if (!this.getTile(x, z)) return

    this.setVertexHeight(x, z, height)
    this.setVertexHeight(x + 1, z, height)
    this.setVertexHeight(x, z + 1, height)
    this.setVertexHeight(x + 1, z + 1, height)
  }

  paintTile(x, z, groundType) {
    const tile = this.getTile(x, z)
    if (!tile) return

    tile.ground = groundType
    tile.groundB = null
    if (groundType !== 'water') tile.waterPainted = false
  }

  paintTileFirst(x, z, groundType) {
    const tile = this.getTile(x, z)
    if (!tile) return
    if (tile.groundB === null) tile.groundB = tile.ground
    tile.ground = groundType
    if (groundType !== 'water') tile.waterPainted = false
  }

  paintTileSecond(x, z, groundType) {
    const tile = this.getTile(x, z)
    if (!tile) return
    tile.groundB = groundType
  }

  paintWaterTile(x, z) {
    const tile = this.getTile(x, z)
    if (!tile) return
    tile.waterPainted = true
  }

  clearWaterPaint(x, z) {
    const tile = this.getTile(x, z)
    if (!tile) return
    tile.waterPainted = false
  }

  paintWaterSurface(x, z) {
    const tile = this.getTile(x, z)
    if (!tile) return
    tile.waterSurface = true
  }

  clearWaterSurface(x, z) {
    const tile = this.getTile(x, z)
    if (!tile) return
    tile.waterSurface = false
  }

  paintTextureTile(x, z, textureId, rotation = 0, scale = 1, worldUV = false) {
    const tile = this.getTile(x, z)
    if (!tile) return

    tile.textureId = textureId
    tile.textureRotation = rotation
    tile.textureScale = scale
    tile.textureWorldUV = worldUV
    tile.textureHalfMode = false
    tile.textureIdB = null
    tile.textureRotationB = 0
    tile.textureScaleB = 1
  }

  paintTextureTileFirst(x, z, textureId, rotation = 0, scale = 1) {
    const tile = this.getTile(x, z)
    if (!tile) return

    tile.textureId = textureId
    tile.textureRotation = rotation
    tile.textureScale = scale
    tile.textureHalfMode = true
  }

  paintTextureTileSecond(x, z, textureId, rotation = 0, scale = 1) {
    const tile = this.getTile(x, z)
    if (!tile) return

    tile.textureIdB = textureId
    tile.textureRotationB = rotation
    tile.textureScaleB = scale
    tile.textureHalfMode = true
  }

  clearTextureTile(x, z) {
    const tile = this.getTile(x, z)
    if (!tile) return

    tile.textureId = null
    tile.textureRotation = 0
    tile.textureScale = 1
    tile.textureHalfMode = false
    tile.textureIdB = null
    tile.textureRotationB = 0
    tile.textureScaleB = 1
  }

  clearTextureTileFirst(x, z) {
    const tile = this.getTile(x, z)
    if (!tile) return

    tile.textureId = null
    tile.textureRotation = 0
    tile.textureScale = 1
  }

  clearTextureTileSecond(x, z) {
    const tile = this.getTile(x, z)
    if (!tile) return

    tile.textureIdB = null
    tile.textureRotationB = 0
    tile.textureScaleB = 1
  }

  flipTileSplit(x, z) {
    const tile = this.getTile(x, z)
    if (!tile) return
    tile.split = tile.split === 'forward' ? 'back' : 'forward'
  }

  addTexturePlane(textureId, x, y, z, width = 1, height = 1, vertical = true) {
    const plane = {
      id: `plane_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
      textureId,
      width,
      height,
      vertical,
      doubleSided: true,
      position: { x, y, z },
      rotation: vertical
        ? { x: 0, y: 0, z: 0 }
        : { x: -Math.PI / 2, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
      uvRepeat: 1
    }

    this.texturePlanes.push(plane)
    return plane
  }

  resize(newWidth, newHeight) {
    const next = new MapData(newWidth, newHeight)
    next.mapType = this.mapType
    next.worldOffset = { ...this.worldOffset }
    next.waterLevel = this.waterLevel
    next.chunkWaterLevels = { ...this.chunkWaterLevels }
    next.texturePlanes = JSON.parse(JSON.stringify(this.texturePlanes))
    next.selectedTexturePlaneId = this.selectedTexturePlaneId

    for (let z = 0; z < Math.min(this.height, newHeight); z++) {
      for (let x = 0; x < Math.min(this.width, newWidth); x++) {
        next.tiles[z][x] = JSON.parse(JSON.stringify(this.tiles[z][x]))
      }
    }

    for (let z = 0; z <= Math.min(this.height, newHeight); z++) {
      for (let x = 0; x <= Math.min(this.width, newWidth); x++) {
        next.heights[z][x] = this.heights[z][x]
      }
    }

    return next
  }

  toJSON() {
    return {
      width: this.width,
      height: this.height,
      mapType: this.mapType,
      worldOffset: { ...this.worldOffset },
      waterLevel: this.waterLevel,
      chunkWaterLevels: { ...this.chunkWaterLevels },
      selectedTexturePlaneId: this.selectedTexturePlaneId,
      texturePlanes: this.texturePlanes,
      tiles: this.tiles,
      heights: this.heights
    }
  }

  static fromJSON(data) {
    const map = new MapData(data.width, data.height)

    map.mapType = data.mapType === 'dungeon' ? 'dungeon' : 'overworld'
    map.worldOffset = {
      x: typeof data.worldOffset?.x === 'number' ? data.worldOffset.x : 0,
      z: typeof data.worldOffset?.z === 'number' ? data.worldOffset.z : 0
    }
    map.waterLevel = typeof data.waterLevel === 'number' ? data.waterLevel : -2.5
    map.chunkWaterLevels = (data.chunkWaterLevels && typeof data.chunkWaterLevels === 'object')
      ? { ...data.chunkWaterLevels }
      : {}
    map.selectedTexturePlaneId = data.selectedTexturePlaneId || null
    map.texturePlanes = Array.isArray(data.texturePlanes)
      ? JSON.parse(JSON.stringify(data.texturePlanes))
      : []

    if (Array.isArray(data.tiles)) {
      for (let z = 0; z < map.height; z++) {
        for (let x = 0; x < map.width; x++) {
          const src = data.tiles?.[z]?.[x]
          if (!src) continue

          map.tiles[z][x] = {
            ground: src.ground || 'grass',
            groundB: src.groundB || null,
            split: src.split || 'forward',
            textureId: src.textureId || null,
            textureRotation: src.textureRotation || 0,
            textureScale: src.textureScale || 1,
            textureWorldUV: !!src.textureWorldUV,
            textureHalfMode: !!src.textureHalfMode,
            textureIdB: src.textureIdB || null,
            textureRotationB: src.textureRotationB || 0,
            textureScaleB: src.textureScaleB || 1,
            waterPainted: !!src.waterPainted || src.ground === 'water',
            waterSurface: !!src.waterSurface
          }
        }
      }
    }

    if (Array.isArray(data.heights)) {
      for (let z = 0; z <= map.height; z++) {
        for (let x = 0; x <= map.width; x++) {
          map.heights[z][x] = data.heights?.[z]?.[x] ?? 0
        }
      }
    } else {
      for (let z = 0; z < map.height; z++) {
        for (let x = 0; x < map.width; x++) {
          const src = data.tiles?.[z]?.[x]
          if (!src?.corners) continue

          map.heights[z][x] = src.corners.tl ?? map.heights[z][x]
          map.heights[z][x + 1] = src.corners.tr ?? map.heights[z][x + 1]
          map.heights[z + 1][x] = src.corners.bl ?? map.heights[z + 1][x]
          map.heights[z + 1][x + 1] = src.corners.br ?? map.heights[z + 1][x + 1]
        }
      }
    }

    return map
  }
}