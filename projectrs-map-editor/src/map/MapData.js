export class MapData {
  constructor(width, height) {
    this.width = width
    this.height = height
    this.texturePlanes = []

    this.vertexHeights = new Array((width + 1) * (height + 1)).fill(0)

    this.tiles = new Array(width * height).fill(null).map(() => ({
      ground: 'grass',
      split: 'forward',
      textureId: null,
      textureRotation: 0,
      textureScale: 1
    }))
  }

  getTileIndex(x, z) {
    if (x < 0 || z < 0 || x >= this.width || z >= this.height) return -1
    return z * this.width + x
  }

  getTile(x, z) {
    const i = this.getTileIndex(x, z)
    return i === -1 ? null : this.tiles[i]
  }

  getVertexIndex(x, z) {
    if (x < 0 || z < 0 || x > this.width || z > this.height) return -1
    return z * (this.width + 1) + x
  }

  getVertexHeight(x, z) {
    const i = this.getVertexIndex(x, z)
    return i === -1 ? 0 : this.vertexHeights[i]
  }

  setVertexHeight(x, z, value) {
    const i = this.getVertexIndex(x, z)
    if (i === -1) return
    this.vertexHeights[i] = value
  }

  addVertexHeight(x, z, delta) {
    const i = this.getVertexIndex(x, z)
    if (i === -1) return
    this.vertexHeights[i] += delta
  }

  getTileCornerHeights(x, z) {
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

  paintTile(x, z, ground) {
    const tile = this.getTile(x, z)
    if (!tile) return
    tile.ground = ground
  }

  paintWaterTile(x, z) {
    const tile = this.getTile(x, z)
    if (!tile) return
    tile.ground = 'water'
  }

  paintTextureTile(x, z, textureId, rotation = 0, scale = 1) {
    const tile = this.getTile(x, z)
    if (!tile) return
    tile.textureId = textureId
    tile.textureRotation = rotation
    tile.textureScale = scale
  }

  clearTextureTile(x, z) {
    const tile = this.getTile(x, z)
    if (!tile) return
    tile.textureId = null
  }

  flipTileSplit(x, z) {
    const tile = this.getTile(x, z)
    if (!tile) return
    tile.split = tile.split === 'forward' ? 'back' : 'forward'
  }

  raiseTile(x, z, amount = 1) {
    this.addVertexHeight(x, z, amount)
    this.addVertexHeight(x + 1, z, amount)
    this.addVertexHeight(x, z + 1, amount)
    this.addVertexHeight(x + 1, z + 1, amount)
  }

  lowerTile(x, z, amount = 1) {
    this.raiseTile(x, z, -amount)
  }

  flattenTile(x, z) {
    const h = this.getTileCornerHeights(x, z)
    const avg = (h.tl + h.tr + h.bl + h.br) / 4

    this.setVertexHeight(x, z, avg)
    this.setVertexHeight(x + 1, z, avg)
    this.setVertexHeight(x, z + 1, avg)
    this.setVertexHeight(x + 1, z + 1, avg)
  }

  flattenTileToHeight(x, z, height) {
    this.setVertexHeight(x, z, height)
    this.setVertexHeight(x + 1, z, height)
    this.setVertexHeight(x, z + 1, height)
    this.setVertexHeight(x + 1, z + 1, height)
  }

  addTexturePlane(textureId, x, y, z, width = 1, height = 2, vertical = true) {
    const plane = {
      id: `plane_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
      textureId,
      position: { x, y, z },
      rotation: vertical
        ? { x: 0, y: 0, z: 0 }
        : { x: -Math.PI / 2, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
      width,
      height,
      vertical,
      doubleSided: true
    }

    this.texturePlanes.push(plane)
    return plane
  }

  toJSON() {
    return {
      width: this.width,
      height: this.height,
      vertexHeights: [...this.vertexHeights],
      tiles: this.tiles.map((tile) => ({
        ground: tile.ground,
        split: tile.split,
        textureId: tile.textureId,
        textureRotation: tile.textureRotation,
        textureScale: tile.textureScale
      })),
      texturePlanes: JSON.parse(JSON.stringify(this.texturePlanes || []))
    }
  }

  static fromJSON(data) {
    const map = new MapData(data.width, data.height)

    if (Array.isArray(data.vertexHeights)) {
      map.vertexHeights = [...data.vertexHeights]
    }

    if (Array.isArray(data.tiles)) {
      map.tiles = data.tiles.map((tile) => ({
        ground: tile.ground ?? 'grass',
        split: tile.split ?? 'forward',
        textureId: tile.textureId ?? null,
        textureRotation: tile.textureRotation ?? 0,
        textureScale: tile.textureScale ?? 1
      }))
    }

    if (Array.isArray(data.texturePlanes)) {
      map.texturePlanes = JSON.parse(JSON.stringify(data.texturePlanes))
    }

    return map
  }

  resize(newWidth, newHeight) {
    const resized = new MapData(newWidth, newHeight)

    const copyWidth = Math.min(this.width, newWidth)
    const copyHeight = Math.min(this.height, newHeight)

    for (let z = 0; z <= copyHeight; z++) {
      for (let x = 0; x <= copyWidth; x++) {
        const oldIndex = this.getVertexIndex(x, z)
        const newIndex = resized.getVertexIndex(x, z)

        if (oldIndex !== -1 && newIndex !== -1) {
          resized.vertexHeights[newIndex] = this.vertexHeights[oldIndex]
        }
      }
    }

    for (let z = 0; z < copyHeight; z++) {
      for (let x = 0; x < copyWidth; x++) {
        const oldTile = this.getTile(x, z)
        const newTile = resized.getTile(x, z)

        if (oldTile && newTile) {
          newTile.ground = oldTile.ground
          newTile.split = oldTile.split
          newTile.textureId = oldTile.textureId
          newTile.textureRotation = oldTile.textureRotation
          newTile.textureScale = oldTile.textureScale
        }
      }
    }

    resized.texturePlanes = JSON.parse(JSON.stringify(this.texturePlanes || []))
    return resized
  }
}