import * as THREE from 'three'
import { MapData } from './map/MapData.js'
import { ToolMode, toolLabel } from './editor/Tools.js'
import { loadAssetRegistry } from './assets-system/AssetRegistry.js'
import { loadAssetModel, makeGhostMaterial } from './assets-system/AssetLoader.js'
import { loadTextureRegistry } from './assets-system/TextureRegistry.js'
import {
  buildTerrainMeshes,
  buildCliffMeshes,
  buildTextureOverlays,
  buildTexturePlanes
} from './map/TerrainMesh.js'

export function createEditorScene(container) {
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x7392cc)
  scene.fog = new THREE.Fog(0x7392cc, 26, 76)

  const camera = new THREE.PerspectiveCamera(
    55,
    window.innerWidth / window.innerHeight,
    0.1,
    1000
  )

  const renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  container.appendChild(renderer.domElement)
  renderer.domElement.style.position = 'absolute'
renderer.domElement.style.inset = '0'
renderer.domElement.style.zIndex = '0'

  const textureLoader = new THREE.TextureLoader()
  const waterTexture = textureLoader.load('/assets/textures/1.png')

  const sun = new THREE.DirectionalLight(0xffe3a3, 1.15)
  sun.position.set(20, 30, 12)
  scene.add(sun)

  scene.add(new THREE.AmbientLight(0xd8dec8, 0.5))
  scene.add(new THREE.HemisphereLight(0xbfd3ff, 0x5a4a24, 0.3))

  let map = new MapData(24, 24)
  const placedGroup = new THREE.Group()
  scene.add(placedGroup)

  let assetRegistry = []
  let filteredAssets = []
  let selectedAssetId = ''
  let previewObject = null
  let previewRotation = 0

  let textureRegistry = []
  let filteredTextures = []
  const textureCache = new Map()
  const textureMeta = new Map()
  let selectedTextureId = null
  let textureRotation = 0
  let textureScale = 1

  let selectedPlacedObject = null
  let selectedTexturePlane = null
  let selectionHelper = null

  let transformMode = null
  let transformAxis = 'all'
  let transformStart = null
  let transformLift = 0

  let terrainGroup = null
  let cliffs = null
  let splitLines = null
  let textureOverlayGroup = null
  let texturePlaneGroup = null

  let texturePlaneVertical = true

  const undoStack = []
  const redoStack = []
  const MAX_HISTORY = 100

  const state = {
    tool: ToolMode.TERRAIN,
    paintType: 'grass',
    hovered: { x: 0, z: 0 },
    showSplitLines: false,
    isPainting: false,
    draggedTiles: new Set(),
    levelMode: false,
    levelHeight: null,
    historyCapturedThisStroke: false
  }

  for (let z = 8; z < 16; z++) {
    for (let x = 8; x < 16; x++) {
      map.raiseTile(x, z, 1)
    }
  }

  const raycaster = new THREE.Raycaster()
  const mouse = new THREE.Vector2()

  const highlightGeo = new THREE.PlaneGeometry(1, 1)
  const highlightMat = new THREE.MeshBasicMaterial({
    color: 0xffff00,
    transparent: true,
    opacity: 0.18,
    side: THREE.DoubleSide
  })
  const highlight = new THREE.Mesh(highlightGeo, highlightMat)
  highlight.rotation.x = -Math.PI / 2
  scene.add(highlight)

  const ui = document.createElement('div')
  ui.className = 'ui'
  ui.innerHTML = `
    <h3>ProjectRS Map Editor</h3>

    <button id="toolTerrain">Terrain Tool</button>
    <button id="toggleLevelMode">Level Mode: Off</button>
    <button id="toolPaint">Paint Tool</button>
    <button id="toolPlace">Place Asset</button>
    <button id="toolSelect">Select</button>
    <button id="toolTexture">Texture Paint</button>
    <button id="toolTexturePlane">Texture Plane</button>

    <div class="row">
      <button id="saveMapBtn">Save Map</button>
    </div>

    <div class="row">
      <input id="loadMapInput" type="file" accept=".json" style="width:100%;" />
    </div>

    <div class="row" style="display:flex; gap:8px;">
      <input id="mapWidthInput" type="number" min="4" value="24" style="width:50%;" />
      <input id="mapHeightInput" type="number" min="4" value="24" style="width:50%;" />
    </div>

    <div class="row">
      <button id="resizeMapBtn">Resize / Extend Map</button>
    </div>

    <div class="row">
      <select id="groundType">
        <option value="grass">Grass</option>
        <option value="dirt">Dirt</option>
        <option value="sand">Sand</option>
        <option value="path">Path</option>
        <option value="water">Water</option>
      </select>
    </div>

    <div class="row">
      <input id="assetSearch" type="text" placeholder="Search assets..." style="width:100%;" />
    </div>

    <div class="row">
      <select id="assetSelect" size="8" style="width:100%;"></select>
    </div>

    <div class="row">
      <input id="textureSearch" type="text" placeholder="Search textures..." style="width:100%;" />
    </div>

    <div class="row">
      <div id="texturePalette" style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;max-height:260px;overflow:auto;"></div>
    </div>

    <div class="row">
      <button id="rotateTextureBtn">Rotate Paint Texture</button>
    </div>

    <div class="row">
      <label>Texture Scale</label>
      <input id="textureScale" type="range" min="1" max="8" step="1" value="1" style="width:100%;" />
    </div>

    <div class="row">
      <label style="display:flex; gap:8px; align-items:center;">
        <input id="toggleSplitLines" type="checkbox" />
        Show split lines
      </label>
    </div>

    <div id="toolStatus" class="status"></div>

    <div class="small">
      1 Terrain / 2 Paint / 3 Place / 4 Select / 5 Texture Paint / 6 Texture Plane<br>
      Ctrl+Z undo / Ctrl+Shift+Z redo<br>
      G move / R rotate / S scale / X Y Z axis / click confirm / Esc cancel<br>
      Q/E while moving = raise/lower selected thing<br>
      Shift+D duplicate snap<br>
      V toggles new texture plane vertical/horizontal
    </div>
  `
  container.appendChild(ui)
  ui.style.position = 'absolute'
ui.style.zIndex = '20'
ui.style.pointerEvents = 'auto'

  const toolButtons = {
    [ToolMode.TERRAIN]: ui.querySelector('#toolTerrain'),
    [ToolMode.PAINT]: ui.querySelector('#toolPaint'),
    [ToolMode.PLACE]: ui.querySelector('#toolPlace'),
    [ToolMode.SELECT]: ui.querySelector('#toolSelect'),
    [ToolMode.TEXTURE]: ui.querySelector('#toolTexture'),
    [ToolMode.TEXTURE_PLANE]: ui.querySelector('#toolTexturePlane')
  }

  toolButtons[ToolMode.TERRAIN]?.addEventListener('click', () => setTool(ToolMode.TERRAIN))
toolButtons[ToolMode.PAINT]?.addEventListener('click', () => setTool(ToolMode.PAINT))
toolButtons[ToolMode.PLACE]?.addEventListener('click', () => setTool(ToolMode.PLACE))
toolButtons[ToolMode.SELECT]?.addEventListener('click', () => setTool(ToolMode.SELECT))
toolButtons[ToolMode.TEXTURE]?.addEventListener('click', () => setTool(ToolMode.TEXTURE))
toolButtons[ToolMode.TEXTURE_PLANE]?.addEventListener('click', () => setTool(ToolMode.TEXTURE_PLANE))

  const groundTypeSelect = ui.querySelector('#groundType')
  const assetSearch = ui.querySelector('#assetSearch')
  const assetSelect = ui.querySelector('#assetSelect')
  const textureSearch = ui.querySelector('#textureSearch')
  const texturePalette = ui.querySelector('#texturePalette')
  const toolStatus = ui.querySelector('#toolStatus')
  const textureScaleSlider = ui.querySelector('#textureScale')
  const levelModeBtn = ui.querySelector('#toggleLevelMode')
  const saveMapBtn = ui.querySelector('#saveMapBtn')
  const loadMapInput = ui.querySelector('#loadMapInput')
  const mapWidthInput = ui.querySelector('#mapWidthInput')
  const mapHeightInput = ui.querySelector('#mapHeightInput')
  const resizeMapBtn = ui.querySelector('#resizeMapBtn')

  mapWidthInput.value = map.width
  mapHeightInput.value = map.height

  function tuneModelLighting(model) {
    model.traverse((child) => {
      if (!child.isMesh || !child.material) return
      const mats = Array.isArray(child.material) ? child.material : [child.material]
      const tuned = mats.map((sourceMat) => {
        const mat = sourceMat.clone()
        if ('roughness' in mat) mat.roughness = 1.0
        if ('metalness' in mat) mat.metalness = 0.0
        if ('envMapIntensity' in mat) mat.envMapIntensity = 0.0
        if ('emissive' in mat && mat.emissive?.isColor) mat.emissive.setRGB(0.06, 0.06, 0.06)
        if ('emissiveIntensity' in mat) mat.emissiveIntensity = 0.18
        mat.needsUpdate = true
        return mat
      })
      child.material = Array.isArray(child.material) ? tuned : tuned[0]
      child.castShadow = false
      child.receiveShadow = false
    })
  }

  function updateToolUI() {
    for (const [mode, button] of Object.entries(toolButtons)) {
      if (button) button.classList.toggle('active-tool', state.tool === mode)
    }

    let extra = ''
    if (state.tool === ToolMode.PAINT) extra += ` | Paint: ${state.paintType}`
    if (state.tool === ToolMode.PLACE) extra += ` | Asset: ${selectedAssetId || 'none'}`
    if (state.tool === ToolMode.TEXTURE) extra += ` | Texture: ${selectedTextureId || 'none'}`
    if (state.tool === ToolMode.TEXTURE_PLANE) extra += ` | Plane texture: ${selectedTextureId || 'none'}`
    if (state.tool === ToolMode.TERRAIN && state.levelMode) {
      extra += ` | Level Mode`
      if (state.levelHeight !== null) extra += ` @ ${state.levelHeight.toFixed(2)}`
    }
    if (selectedTexturePlane) extra += ` | Selected plane: ${selectedTexturePlane.textureId}`
    if (selectedPlacedObject) extra += ` | Selected object`
    if (transformMode) {
      const axisLabel = transformAxis === 'all' ? 'ALL' : transformAxis.toUpperCase()
      extra += ` | Transform: ${transformMode.toUpperCase()} (${axisLabel})`
    }

    levelModeBtn.textContent = `Level Mode: ${state.levelMode ? 'On' : 'Off'}`
    toolStatus.textContent = `Mode: ${toolLabel(state.tool)}${extra}`
  }

  function setTool(mode) {
    state.tool = mode
    updateToolUI()
    updatePreviewObject().catch(console.error)
  }

  function clearSelectionHelper() {
    if (selectionHelper) {
      scene.remove(selectionHelper)
      selectionHelper = null
    }
  }

  function updateSelectionHelper() {
    clearSelectionHelper()

    if (selectedPlacedObject) {
      selectionHelper = new THREE.BoxHelper(selectedPlacedObject, 0x66ccff)
      scene.add(selectionHelper)
      return
    }

    if (selectedTexturePlane && texturePlaneGroup) {
      const planeMesh = texturePlaneGroup.children.find(
        (child) => child.userData.texturePlane?.id === selectedTexturePlane.id
      )
      if (planeMesh) {
        selectionHelper = new THREE.BoxHelper(planeMesh, 0x66ccff)
        scene.add(selectionHelper)
      }
    }
  }

  function clearSelection() {
    selectedPlacedObject = null
    selectedTexturePlane = null
    transformMode = null
    transformStart = null
    transformLift = 0
    updateSelectionHelper()
    updateToolUI()
  }

  function serializePlacedObjects() {
    return placedGroup.children.map((obj) => ({
      assetId: obj.userData.assetId || null,
      position: { x: obj.position.x, y: obj.position.y, z: obj.position.z },
      rotation: { x: obj.rotation.x, y: obj.rotation.y, z: obj.rotation.z },
      scale: { x: obj.scale.x, y: obj.scale.y, z: obj.scale.z }
    }))
  }

  async function rebuildPlacedObjectsFromData(placedObjectsData) {
    placedGroup.clear()

    for (const placed of placedObjectsData || []) {
      const asset = assetRegistry.find((a) => a.id === placed.assetId)
      if (!asset) continue
      const model = await loadAssetModel(asset.path)
      tuneModelLighting(model)
      model.position.set(placed.position.x, placed.position.y, placed.position.z)
      model.rotation.set(placed.rotation.x, placed.rotation.y, placed.rotation.z)
      model.scale.set(placed.scale.x, placed.scale.y, placed.scale.z)
      model.userData.assetId = asset.id
      model.userData.type = 'asset'
      placedGroup.add(model)
    }
  }

  function buildSaveData() {
    return {
      map: map.toJSON(),
      placedObjects: serializePlacedObjects()
    }
  }

  function downloadJSON(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  async function loadSaveData(data) {
    if (!data?.map) return
    pushUndoState()
    map = MapData.fromJSON(data.map)
    selectedPlacedObject = null
    selectedTexturePlane = null
    transformMode = null
    transformStart = null
    transformLift = 0
    state.levelHeight = null
    await rebuildPlacedObjectsFromData(data.placedObjects || [])
    mapWidthInput.value = map.width
    mapHeightInput.value = map.height
    rebuildTerrain()
    updateSelectionHelper()
    updateToolUI()
  }

  function captureSnapshot() {
    return {
      map: map.toJSON(),
      placedObjects: serializePlacedObjects()
    }
  }

  async function applySnapshot(snapshot) {
    map = MapData.fromJSON(snapshot.map)
    selectedPlacedObject = null
    selectedTexturePlane = null
    transformMode = null
    transformStart = null
    transformLift = 0
    state.levelHeight = null
    await rebuildPlacedObjectsFromData(snapshot.placedObjects || [])
    mapWidthInput.value = map.width
    mapHeightInput.value = map.height
    rebuildTerrain()
    updateSelectionHelper()
    updateToolUI()
  }

  function pushUndoState() {
    undoStack.push(captureSnapshot())
    if (undoStack.length > MAX_HISTORY) undoStack.shift()
    redoStack.length = 0
  }

  async function undo() {
    if (!undoStack.length) return
    redoStack.push(captureSnapshot())
    const snapshot = undoStack.pop()
    await applySnapshot(snapshot)
  }

  async function redo() {
    if (!redoStack.length) return
    undoStack.push(captureSnapshot())
    const snapshot = redoStack.pop()
    await applySnapshot(snapshot)
  }

  function buildSplitLines() {
    const points = []

    for (let z = 0; z < map.height; z++) {
      for (let x = 0; x < map.width; x++) {
        const tile = map.getTile(x, z)
        const h = map.getTileCornerHeights(x, z)

        if (tile.split === 'forward') {
          points.push(
            new THREE.Vector3(x, h.tl + 0.03, z),
            new THREE.Vector3(x + 1, h.br + 0.03, z + 1)
          )
        } else {
          points.push(
            new THREE.Vector3(x + 1, h.tr + 0.03, z),
            new THREE.Vector3(x, h.bl + 0.03, z + 1)
          )
        }
      }
    }

    const geometry = new THREE.BufferGeometry().setFromPoints(points)
    const material = new THREE.LineBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.15
    })

    const lines = new THREE.LineSegments(geometry, material)
    lines.visible = state.showSplitLines
    return lines
  }

  function rebuildTerrain() {
    if (terrainGroup) scene.remove(terrainGroup)
    if (cliffs) scene.remove(cliffs)
    if (splitLines) scene.remove(splitLines)
    if (textureOverlayGroup) scene.remove(textureOverlayGroup)
    if (texturePlaneGroup) scene.remove(texturePlaneGroup)

    map.selectedTexturePlaneId = selectedTexturePlane ? selectedTexturePlane.id : null

    terrainGroup = buildTerrainMeshes(map, waterTexture)
    cliffs = buildCliffMeshes(map)
    splitLines = buildSplitLines()
    textureOverlayGroup = buildTextureOverlays(map, textureRegistry, textureCache)
    texturePlaneGroup = buildTexturePlanes(map, textureRegistry, textureCache)

    scene.add(terrainGroup)
    scene.add(cliffs)
    scene.add(splitLines)
    scene.add(textureOverlayGroup)
    scene.add(texturePlaneGroup)

    updateSelectionHelper()
  }

  function updateMouse(event) {
    const rect = renderer.domElement.getBoundingClientRect()
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
  }

  function getTerrainMeshes() {
    const meshes = []
    if (!terrainGroup) return meshes
    terrainGroup.traverse((obj) => {
      if (obj.isMesh) meshes.push(obj)
    })
    return meshes
  }

  function pickTerrainPoint(event) {
    updateMouse(event)
    raycaster.setFromCamera(mouse, camera)
    const hits = raycaster.intersectObjects(getTerrainMeshes())
    if (!hits.length) return null
    return hits[0].point.clone()
  }

  function pickTile(event) {
    const p = pickTerrainPoint(event)
    if (!p) return null
    const x = Math.floor(p.x)
    const z = Math.floor(p.z)
    if (x < 0 || z < 0 || x >= map.width || z >= map.height) return null
    return { x, z }
  }

  function pickPlacedObject(event) {
    updateMouse(event)
    raycaster.setFromCamera(mouse, camera)
    const hits = raycaster.intersectObjects(placedGroup.children, true)
    if (!hits.length) return null
    let obj = hits[0].object
    while (obj.parent && obj.parent !== placedGroup) obj = obj.parent
    return obj
  }

  function pickTexturePlane(event) {
    if (!texturePlaneGroup) return null
    updateMouse(event)
    raycaster.setFromCamera(mouse, camera)
    const hits = raycaster.intersectObjects(texturePlaneGroup.children, true)
    if (!hits.length) return null
    return hits[0].object
  }

  function tileWorldPosition(x, z) {
    return new THREE.Vector3(
      x + 0.5,
      map.getAverageTileHeight(x, z),
      z + 0.5
    )
  }

  function getTexturePlaneSize(textureId) {
    const meta = textureMeta.get(textureId)
    if (!meta) return { width: 1, height: 1 }
    return {
      width: Math.max(0.25, meta.width / 64),
      height: Math.max(0.25, meta.height / 64)
    }
  }

  function getPlaneFootprint(plane) {
  const width = (plane.width || 1) * (plane.scale?.x ?? 1)
  const depth = Math.max(0.1, plane.scale?.z ?? 0.1)
  const height = (plane.height || 1) * (plane.scale?.y ?? 1)
  return { width, depth, height }
}

function getObjectFootprint(object) {
  const box = new THREE.Box3().setFromObject(object)
  const size = new THREE.Vector3()
  box.getSize(size)
  return {
    width: Math.max(size.x, 0.1),
    depth: Math.max(size.z, 0.1),
    height: Math.max(size.y, 0.1)
  }
}

function snapValue(value, step = 0.5) {
  return Math.round(value / step) * step
}

function snapThingPositionToGrid(position, step = 0.5) {
  position.x = snapValue(position.x, step)
  position.z = snapValue(position.z, step)
}

function snapSelectedThingNow() {
  if (selectedTexturePlane) {
    snapThingPositionToGrid(selectedTexturePlane.position, 0.5)
    rebuildTerrain()
    updateSelectionHelper()
    updateToolUI()
    return
  }

  if (selectedPlacedObject) {
    selectedPlacedObject.position.x = snapValue(selectedPlacedObject.position.x, 0.5)
    selectedPlacedObject.position.z = snapValue(selectedPlacedObject.position.z, 0.5)
    updateSelectionHelper()
    updateToolUI()
  }
}

function snapPlaneFlushToPlaneBackwards(sourcePlane, targetPlane) {
  const sourceWidth = (sourcePlane.width || 1) * (sourcePlane.scale?.x ?? 1)
  const targetWidth = (targetPlane.width || 1) * (targetPlane.scale?.x ?? 1)

  const rotY = targetPlane.rotation.y || 0
  const rightX = Math.cos(rotY)
  const rightZ = -Math.sin(rotY)

  const spacing = (sourceWidth + targetWidth) * 0.5

  sourcePlane.position.x = targetPlane.position.x - rightX * spacing
  sourcePlane.position.z = targetPlane.position.z - rightZ * spacing
}

function snapDuplicateOffsetForPlane(plane) {
  const rotY = plane.rotation.y || 0
  const width = (plane.width || 1) * (plane.scale?.x ?? 1)

  const rightX = Math.cos(rotY)
  const rightZ = -Math.sin(rotY)

  return {
    dx: rightX * width,
    dz: rightZ * width
  }
}
function snapPlaneFlushToPlane(sourcePlane, targetPlane) {
  const sourceWidth = (sourcePlane.width || 1) * (sourcePlane.scale?.x ?? 1)
  const targetWidth = (targetPlane.width || 1) * (targetPlane.scale?.x ?? 1)

  const rotY = targetPlane.rotation.y || 0
  const rightX = Math.cos(rotY)
  const rightZ = -Math.sin(rotY)

  const spacing = (sourceWidth + targetWidth) * 0.5

  sourcePlane.position.x = targetPlane.position.x + rightX * spacing
  sourcePlane.position.z = targetPlane.position.z + rightZ * spacing
}

 function snapDuplicateOffsetForObject(object) {
  const size = getObjectFootprint(object)
  const rotY = object.rotation.y || 0

  const forwardX = Math.sin(rotY)
  const forwardZ = Math.cos(rotY)

  const step = Math.max(size.width, size.depth, 0.5)

  return {
    dx: forwardX * step,
    dz: forwardZ * step
  }
}

  function applyToolAtTile(tile, eventLike = null) {
    if (!tile) return

    if (state.tool === ToolMode.TERRAIN) {
      if (state.levelMode) {
        if (state.levelHeight === null) {
          state.levelHeight = map.getAverageTileHeight(tile.x, tile.z)
        }
        map.flattenTileToHeight(tile.x, tile.z, state.levelHeight)
        rebuildTerrain()
        return
      }

      if (eventLike?.ctrlKey) {
        map.flattenTile(tile.x, tile.z)
      } else if (eventLike?.shiftKey) {
        map.lowerTile(tile.x, tile.z, 0.25)
      } else {
        map.raiseTile(tile.x, tile.z, 0.25)
      }

      rebuildTerrain()
      return
    }

    if (state.tool === ToolMode.PAINT) {
      if (state.paintType === 'water') map.paintWaterTile(tile.x, tile.z)
      else map.paintTile(tile.x, tile.z, state.paintType)
      rebuildTerrain()
      return
    }

    if (state.tool === ToolMode.TEXTURE) {
      if (selectedTextureId) {
        map.paintTextureTile(tile.x, tile.z, selectedTextureId, textureRotation, textureScale)
        rebuildTerrain()
      }
    }
  }

  async function updatePreviewObject() {
    if (previewObject) {
      scene.remove(previewObject)
      previewObject = null
    }

    if (state.tool !== ToolMode.PLACE || !selectedAssetId) return

    const asset = assetRegistry.find((a) => a.id === selectedAssetId)
    if (!asset) return

    const model = await loadAssetModel(asset.path)
    tuneModelLighting(model)

    previewObject = makeGhostMaterial(model)
    previewObject.rotation.y = previewRotation
    previewObject.userData.assetId = asset.id
    scene.add(previewObject)

    const pos = tileWorldPosition(state.hovered.x, state.hovered.z)
    previewObject.position.copy(pos)
  }

  async function placeSelectedAsset(tile) {
    if (!selectedAssetId) return
    const asset = assetRegistry.find((a) => a.id === selectedAssetId)
    if (!asset) return

    const model = await loadAssetModel(asset.path)
    tuneModelLighting(model)

    pushUndoState()

    const pos = tileWorldPosition(tile.x, tile.z)
    model.position.copy(pos)
    model.rotation.y = previewRotation
    model.userData.assetId = asset.id
    model.userData.type = 'asset'
    placedGroup.add(model)
  }

  async function duplicateSelected() {
    pushUndoState()

if (selectedTexturePlane) {
  const clone = JSON.parse(JSON.stringify(selectedTexturePlane))
  clone.id = `plane_${Date.now()}_${Math.floor(Math.random() * 100000)}`

  snapPlaneFlushToPlane(clone, selectedTexturePlane)

  map.texturePlanes.push(clone)
  selectedTexturePlane = clone
  selectedPlacedObject = null

  rebuildTerrain()
  updateSelectionHelper()
  updateToolUI()
  return
}

    if (selectedPlacedObject?.userData?.assetId) {
      const asset = assetRegistry.find((a) => a.id === selectedPlacedObject.userData.assetId)
      if (!asset) return

      const model = await loadAssetModel(asset.path)
      tuneModelLighting(model)

      model.position.copy(selectedPlacedObject.position)
      const { dx, dz } = snapDuplicateOffsetForObject(selectedPlacedObject)
      model.position.x += dx
      model.position.z += dz
      model.rotation.copy(selectedPlacedObject.rotation)
      model.scale.copy(selectedPlacedObject.scale)
      model.userData.assetId = asset.id
      model.userData.type = 'asset'

      placedGroup.add(model)
      selectedPlacedObject = model
      selectedTexturePlane = null
      updateSelectionHelper()
      updateToolUI()
    }
  }

  function beginTransform(mode) {
    if (!selectedTexturePlane && !selectedPlacedObject) return
    pushUndoState()
    transformMode = mode
    transformLift = 0

    if (mode === 'scale') transformAxis = 'all'

    if (selectedTexturePlane) {
      transformStart = JSON.parse(JSON.stringify({
        position: selectedTexturePlane.position,
        rotation: selectedTexturePlane.rotation,
        scale: selectedTexturePlane.scale,
        width: selectedTexturePlane.width,
        height: selectedTexturePlane.height
      }))
    } else if (selectedPlacedObject) {
      transformStart = {
        position: selectedPlacedObject.position.clone(),
        rotation: {
          x: selectedPlacedObject.rotation.x,
          y: selectedPlacedObject.rotation.y,
          z: selectedPlacedObject.rotation.z
        },
        scale: selectedPlacedObject.scale.clone()
      }
    }

    updateToolUI()
  }

  function cancelTransform() {
    if (!transformMode || !transformStart) return

    if (selectedTexturePlane) {
      selectedTexturePlane.position = { ...transformStart.position }
      selectedTexturePlane.rotation = { ...transformStart.rotation }
      selectedTexturePlane.scale = { ...transformStart.scale }
      selectedTexturePlane.width = transformStart.width
      selectedTexturePlane.height = transformStart.height
      rebuildTerrain()
    }

    if (selectedPlacedObject) {
      selectedPlacedObject.position.copy(transformStart.position)
      selectedPlacedObject.rotation.set(
        transformStart.rotation.x,
        transformStart.rotation.y,
        transformStart.rotation.z
      )
      selectedPlacedObject.scale.copy(transformStart.scale)
      updateSelectionHelper()
    }

    transformMode = null
    transformStart = null
    transformLift = 0
    updateToolUI()
  }

  function confirmTransform() {
    transformMode = null
    transformStart = null
    transformLift = 0
    updateToolUI()
  }

  function refreshAssetList() {
    const q = assetSearch.value.trim().toLowerCase()
    filteredAssets = assetRegistry.filter((asset) => asset.name.toLowerCase().includes(q))

    assetSelect.innerHTML = ''
    for (const asset of filteredAssets) {
      const option = document.createElement('option')
      option.value = asset.id
      option.textContent = asset.name
      assetSelect.appendChild(option)
    }

    if (filteredAssets.length && !filteredAssets.find((a) => a.id === selectedAssetId)) {
      selectedAssetId = filteredAssets[0].id
    }

    assetSelect.value = selectedAssetId || ''
    updateToolUI()
  }

 function refreshTexturePalette() {
  const q = textureSearch.value.trim().toLowerCase()

  filteredTextures = textureRegistry.filter((tex) => {
    const name = (tex.name || '').toLowerCase()
    const id = String(tex.id || '').toLowerCase()
    return name.includes(q) || id.includes(q)
  })

  if (
    filteredTextures.length &&
    !filteredTextures.find((tex) => tex.id === selectedTextureId)
  ) {
    selectedTextureId = filteredTextures[0].id
  }

  texturePalette.innerHTML = ''

  if (!filteredTextures.length) {
    texturePalette.innerHTML = `
      <div style="grid-column:1 / -1; font-size:12px; opacity:0.8; padding:8px 0;">
        No textures found
      </div>
    `
    return
  }

  for (const tex of filteredTextures) {
    const wrap = document.createElement('div')
    wrap.style.display = 'flex'
    wrap.style.flexDirection = 'column'
    wrap.style.alignItems = 'center'
    wrap.style.gap = '4px'

    const img = document.createElement('img')
    img.src = tex.path
    img.title = tex.name || tex.id
    img.style.width = '56px'
    img.style.height = '56px'
    img.style.objectFit = 'cover'
    img.style.border = tex.id === selectedTextureId
      ? '2px solid #2d6cdf'
      : '2px solid transparent'
    img.style.cursor = 'pointer'
    img.style.borderRadius = '4px'
    img.style.display = 'block'

    img.onerror = () => {
      img.style.border = '2px solid red'
      img.title = `Failed to load: ${tex.path}`
    }

    const label = document.createElement('div')
    label.textContent = tex.name
    label.style.fontSize = '10px'
    label.style.textAlign = 'center'
    label.style.wordBreak = 'break-word'

    img.addEventListener('click', () => {
      selectedTextureId = tex.id
      setTool(ToolMode.TEXTURE)
      refreshTexturePalette()
      updateToolUI()
    })

    wrap.appendChild(img)
    wrap.appendChild(label)
    texturePalette.appendChild(wrap)
  }
}

  groundTypeSelect.addEventListener('change', (e) => {
    state.paintType = e.target.value
    updateToolUI()
  })

  assetSearch.addEventListener('input', refreshAssetList)

  assetSelect.addEventListener('change', async (e) => {
    selectedAssetId = e.target.value
    updateToolUI()
  
  })

  textureSearch.addEventListener('input', refreshTexturePalette)

  levelModeBtn.addEventListener('click', () => {
    state.levelMode = !state.levelMode
    state.levelHeight = null
    updateToolUI()
  })

  saveMapBtn.addEventListener('click', () => {
    downloadJSON('projectrs-map.json', buildSaveData())
  })

  loadMapInput.addEventListener('change', async (event) => {
    const file = event.target.files?.[0]
    if (!file) return
    const text = await file.text()
    const data = JSON.parse(text)
    await loadSaveData(data)
    loadMapInput.value = ''
  })

  resizeMapBtn.addEventListener('click', () => {
    const newWidth = Number(mapWidthInput.value)
    const newHeight = Number(mapHeightInput.value)
    if (!Number.isFinite(newWidth) || !Number.isFinite(newHeight)) return
    if (newWidth < 4 || newHeight < 4) return

    pushUndoState()
    map = map.resize(newWidth, newHeight)
    selectedPlacedObject = null
    selectedTexturePlane = null
    transformMode = null
    transformStart = null
    transformLift = 0
    rebuildTerrain()
    updateSelectionHelper()
    updateToolUI()
  })

  ui.querySelector('#toggleSplitLines').addEventListener('change', (e) => {
    state.showSplitLines = e.target.checked
    if (splitLines) splitLines.visible = state.showSplitLines
  })

  ui.querySelector('#rotateTextureBtn').addEventListener('click', () => {
    textureRotation = (textureRotation + 1) % 4
    rebuildTerrain()
    updateToolUI()
  })

  textureScaleSlider.addEventListener('input', (e) => {
    textureScale = Number(e.target.value)
  })

  renderer.domElement.addEventListener('mousemove', async (event) => {
    const tile = pickTile(event)
    if (!tile) return

    state.hovered = tile

    const y = map.getAverageTileHeight(tile.x, tile.z) + 0.04
    highlight.position.set(tile.x + 0.5, y, tile.z + 0.5)

    if (previewObject) {
      const pos = tileWorldPosition(tile.x, tile.z)
      previewObject.position.copy(pos)
    }

    const terrainPoint = pickTerrainPoint(event)

    if (transformMode === 'move' && selectedTexturePlane && terrainPoint) {
selectedTexturePlane.position.x = event.shiftKey ? snapValue(terrainPoint.x, 0.5) : terrainPoint.x
selectedTexturePlane.position.z = event.shiftKey ? snapValue(terrainPoint.z, 0.5) : terrainPoint.z

      if (selectedTexturePlane.vertical) {
        selectedTexturePlane.position.y =
          terrainPoint.y + (selectedTexturePlane.height * selectedTexturePlane.scale.y) / 2 + transformLift
      } else {
        selectedTexturePlane.position.y = terrainPoint.y + 0.05 + transformLift
      }

      rebuildTerrain()
      return
    }

    if (transformMode === 'move' && selectedPlacedObject && terrainPoint) {
     selectedPlacedObject.position.set(
  event.shiftKey ? snapValue(terrainPoint.x, 0.5) : terrainPoint.x,
  terrainPoint.y + transformLift,
  event.shiftKey ? snapValue(terrainPoint.z, 0.5) : terrainPoint.z
)
      updateSelectionHelper()
      return
    }

    if (state.isPainting && state.tool !== ToolMode.PLACE && state.tool !== ToolMode.SELECT) {
      const key = `${tile.x},${tile.z}`

      if (state.tool === ToolMode.TERRAIN || state.tool === ToolMode.PAINT || state.tool === ToolMode.TEXTURE) {
        if (!state.draggedTiles.has(key)) {
          state.draggedTiles.add(key)
          applyToolAtTile(tile, event)
        }
      }
    }
  })

  renderer.domElement.addEventListener('mousedown', async (event) => {
    if (event.button !== 0) return

    const tile = pickTile(event)
    if (!tile) return

    if (transformMode) {
      confirmTransform()
      rebuildTerrain()
      updateSelectionHelper()
      return
    }

    if (state.tool === ToolMode.TEXTURE_PLANE) {
      if (!selectedTextureId || typeof map.addTexturePlane !== 'function') return

      const planeSize = getTexturePlaneSize(selectedTextureId)
      const y = map.getAverageTileHeight(tile.x, tile.z) + (texturePlaneVertical ? planeSize.height / 2 : 0.05)

      pushUndoState()

      const plane = map.addTexturePlane(
        selectedTextureId,
        tile.x + 0.5,
        y,
        tile.z + 0.5,
        planeSize.width,
        planeSize.height,
        texturePlaneVertical
      )

      selectedTexturePlane = plane
      selectedPlacedObject = null
      rebuildTerrain()
      updateSelectionHelper()
      updateToolUI()
      return
    }

    if (state.tool === ToolMode.SELECT) {
      const pickedPlane = pickTexturePlane(event)
      if (pickedPlane?.userData?.texturePlane) {
        selectedTexturePlane = pickedPlane.userData.texturePlane
        selectedPlacedObject = null
        updateSelectionHelper()
        updateToolUI()
        return
      }

      const pickedObject = pickPlacedObject(event)
      if (pickedObject) {
        selectedPlacedObject = pickedObject
        selectedTexturePlane = null
        updateSelectionHelper()
        updateToolUI()
        return
      }

      clearSelection()
      return
    }

    if (state.tool === ToolMode.PLACE) {
      await placeSelectedAsset(tile)
      return
    }

    state.isPainting = true
    state.historyCapturedThisStroke = false
    state.draggedTiles.clear()

    if (!state.historyCapturedThisStroke) {
      pushUndoState()
      state.historyCapturedThisStroke = true
    }

    const key = `${tile.x},${tile.z}`
    state.draggedTiles.add(key)
    applyToolAtTile(tile, event)
  })

  window.addEventListener('mouseup', (event) => {
    if (event.button === 0) {
      state.isPainting = false
      state.draggedTiles.clear()
      state.historyCapturedThisStroke = false
    }
  })

  let isRightDragging = false
  let isMiddleDragging = false
  let isMiddlePanning = false

  let yaw = 0.78
  let pitch = 1.02
  let distance = 31
  const target = new THREE.Vector3(12, 2, 12)

  function updateCamera() {
    camera.position.x = target.x + Math.cos(yaw) * Math.sin(pitch) * distance
    camera.position.y = target.y + Math.cos(pitch) * distance
    camera.position.z = target.z + Math.sin(yaw) * Math.sin(pitch) * distance
    camera.lookAt(target)
  }

  function panCamera(deltaX, deltaY) {
    const forward = new THREE.Vector3()
    camera.getWorldDirection(forward)
    forward.y = 0
    forward.normalize()

    const right = new THREE.Vector3()
    right.crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize()

    const panScale = distance * 0.0025
    target.addScaledVector(right, -deltaX * panScale)
    target.addScaledVector(forward, deltaY * panScale)
    updateCamera()
  }

  updateCamera()

  renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault())

  renderer.domElement.addEventListener('mousedown', (e) => {
    if (e.button === 2) isRightDragging = true
    if (e.button === 1) {
      if (e.shiftKey) isMiddlePanning = true
      else isMiddleDragging = true
    }
  })

  window.addEventListener('mouseup', (e) => {
    if (e.button === 2) isRightDragging = false
    if (e.button === 1) {
      isMiddleDragging = false
      isMiddlePanning = false
    }
  })

  window.addEventListener('mousemove', (e) => {
    if (isRightDragging || isMiddleDragging) {
      yaw -= e.movementX * 0.005
      pitch -= e.movementY * 0.005
      pitch = Math.max(0.45, Math.min(Math.PI / 2 - 0.08, pitch))
      updateCamera()
    }

    if (isMiddlePanning) {
      panCamera(e.movementX, e.movementY)
    }
  })

  renderer.domElement.addEventListener('wheel', (e) => {
if (transformMode === 'rotate') {
  e.preventDefault()

  const axis = transformAxis === 'all' ? 'y' : transformAxis

  if (selectedTexturePlane) {
    if (e.shiftKey) {
      selectedTexturePlane.rotation[axis] += (e.deltaY > 0 ? 1 : -1) * 0.1
    } else {
      const step = Math.PI / 12 // 15 degrees
      const next =
        selectedTexturePlane.rotation[axis] + (e.deltaY > 0 ? step : -step)

      const quarterTurn = Math.PI / 2
      const snapThreshold = 0.12

      const nearestQuarter = Math.round(next / quarterTurn) * quarterTurn
      selectedTexturePlane.rotation[axis] =
        Math.abs(next - nearestQuarter) < snapThreshold ? nearestQuarter : next
    }

    rebuildTerrain()
    return
  }

  if (selectedPlacedObject) {
    if (e.shiftKey) {
      selectedPlacedObject.rotation[axis] += (e.deltaY > 0 ? 1 : -1) * 0.1
    } else {
      const step = Math.PI / 12 // 15 degrees
      const next =
        selectedPlacedObject.rotation[axis] + (e.deltaY > 0 ? step : -step)

      const quarterTurn = Math.PI / 2
      const snapThreshold = 0.12

      const nearestQuarter = Math.round(next / quarterTurn) * quarterTurn
      selectedPlacedObject.rotation[axis] =
        Math.abs(next - nearestQuarter) < snapThreshold ? nearestQuarter : next
    }

    updateSelectionHelper()
    return
  }
}

    if (transformMode === 'scale') {
      e.preventDefault()
      const step = e.shiftKey ? 0.05 : 0.15
      const delta = e.deltaY > 0 ? -step : step

      if (selectedTexturePlane) {
        if (transformAxis === 'all') {
          selectedTexturePlane.width = Math.max(0.1, selectedTexturePlane.width + delta)
          selectedTexturePlane.height = Math.max(0.1, selectedTexturePlane.height + delta)
        } else if (transformAxis === 'x') {
          selectedTexturePlane.width = Math.max(0.1, selectedTexturePlane.width + delta)
        } else if (transformAxis === 'y') {
          selectedTexturePlane.height = Math.max(0.1, selectedTexturePlane.height + delta)
        } else if (transformAxis === 'z') {
          selectedTexturePlane.scale.z = Math.max(0.1, selectedTexturePlane.scale.z + delta)
        }

        rebuildTerrain()
        return
      }

      if (selectedPlacedObject) {
        if (transformAxis === 'all') {
          const nextX = Math.max(0.1, selectedPlacedObject.scale.x + delta)
          const nextY = Math.max(0.1, selectedPlacedObject.scale.y + delta)
          const nextZ = Math.max(0.1, selectedPlacedObject.scale.z + delta)
          selectedPlacedObject.scale.set(nextX, nextY, nextZ)
        } else {
          selectedPlacedObject.scale[transformAxis] = Math.max(
            0.1,
            selectedPlacedObject.scale[transformAxis] + delta
          )
        }

        updateSelectionHelper()
        return
      }
    }

    distance += e.deltaY * 0.01
    distance = Math.max(10, Math.min(70, distance))
    updateCamera()
  })

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(window.innerWidth, window.innerHeight)
  })

  window.addEventListener('keydown', async (event) => {
    const key = event.key.toLowerCase()
    const { x, z } = state.hovered

    if (event.ctrlKey && key === 'z' && !event.shiftKey) {
      event.preventDefault()
      await undo()
      return
    }

    if ((event.ctrlKey && key === 'y') || (event.ctrlKey && event.shiftKey && key === 'z')) {
      event.preventDefault()
      await redo()
      return
    }

    if (key === 'delete' || key === 'backspace') {
      if (selectedTexturePlane) {
        pushUndoState()
        map.texturePlanes = map.texturePlanes.filter((p) => p.id !== selectedTexturePlane.id)
        selectedTexturePlane = null
        rebuildTerrain()
        updateSelectionHelper()
        updateToolUI()
        return
      }

      if (selectedPlacedObject) {
        pushUndoState()
        placedGroup.remove(selectedPlacedObject)
        selectedPlacedObject = null
        updateSelectionHelper()
        updateToolUI()
        return
      }
    }

    if (key === 'escape') {
      cancelTransform()
      return
    }

    if (key === 'l') {
      state.levelMode = !state.levelMode
      state.levelHeight = null
      updateToolUI()
      return
    }

    if (transformMode === 'move') {
      if (key === 'q') {
        transformLift += 0.1
        return
      }
      if (key === 'e') {
        transformLift -= 0.1
        return
      }
    }

    if (key === 'q') {
      pushUndoState()
      map.raiseTile(x, z, 0.25)
      rebuildTerrain()
      return
    }
    if (key === 'k') {
  snapSelectedThingNow()
  return
}

    if (key === 'e') {
      pushUndoState()
      map.lowerTile(x, z, 0.25)
      rebuildTerrain()
      return
    }

    if (key === 'f') {
      pushUndoState()
      map.flipTileSplit(x, z)
      rebuildTerrain()
      return
    }

    if (key === '1') return setTool(ToolMode.TERRAIN)
    if (key === '2') return setTool(ToolMode.PAINT)
    if (key === '3') return setTool(ToolMode.PLACE)
    if (key === '4') return setTool(ToolMode.SELECT)
    if (key === '5') return setTool(ToolMode.TEXTURE)
    if (key === '6') return setTool(ToolMode.TEXTURE_PLANE)

    if (key === 'v') {
      texturePlaneVertical = !texturePlaneVertical
      updateToolUI()
      return
    }

    if (key === 'x' || key === 'y' || key === 'z') {
      transformAxis = key
      updateToolUI()
      return
    }

    if (key === 'g') {
      beginTransform('move')
      return
    }

    if (key === 'r') {
      if (selectedTexturePlane || selectedPlacedObject) {
        beginTransform('rotate')
        return
      }

      if (state.tool === ToolMode.TEXTURE || state.tool === ToolMode.TEXTURE_PLANE) {
        textureRotation = (textureRotation + 1) % 4
        rebuildTerrain()
        updateToolUI()
        return
      }

      previewRotation += Math.PI / 2
      if (previewObject) previewObject.rotation.y = previewRotation
      return
    }

    if (key === 's') {
      transformAxis = 'all'
      beginTransform('scale')
      return
    }

    if (key === 'd' && event.shiftKey) {
      await duplicateSelected()
    }
  })

  async function initAssets() {
    try {
      assetRegistry = await loadAssetRegistry()
      filteredAssets = [...assetRegistry].sort((a, b) => a.name.localeCompare(b.name))
      selectedAssetId = filteredAssets[0]?.id || ''
      refreshAssetList()
      await updatePreviewObject()
    } catch (err) {
      assetSelect.innerHTML = '<option value="">Failed to load assets</option>'
      console.error(err)
    }
  }

  async function loadImageMeta(path) {
    return new Promise((resolve) => {
      const img = new Image()
      img.onload = () => resolve({
        width: img.naturalWidth || 64,
        height: img.naturalHeight || 64
      })
      img.onerror = () => resolve({ width: 64, height: 64 })
      img.src = path
    })
  }

async function initTextures() {
  try {
    textureRegistry = await loadTextureRegistry()
    filteredTextures = [...textureRegistry].sort((a, b) => a.name.localeCompare(b.name))

    console.log('Loaded textures:', textureRegistry)

    for (const tex of textureRegistry) {
      const loadedTexture = textureLoader.load(tex.path)
      loadedTexture.wrapS = THREE.ClampToEdgeWrapping
loadedTexture.wrapT = THREE.ClampToEdgeWrapping
loadedTexture.needsUpdate = true
      textureCache.set(tex.id, loadedTexture)

      const meta = await loadImageMeta(tex.path)
      textureMeta.set(tex.id, meta)
    }

    selectedTextureId = filteredTextures[0]?.id || null

    refreshTexturePalette()
    rebuildTerrain()
    updateToolUI()
  } catch (err) {
    console.error('initTextures failed:', err)
    texturePalette.innerHTML = `
      <div style="grid-column:1 / -1; font-size:12px; color:#ff8080; padding:8px 0;">
        Failed to load textures
      </div>
    `
    selectedTextureId = null
    updateToolUI()
  }
}

  rebuildTerrain()
  updateToolUI()
  initAssets()
  initTextures()
  pushUndoState()

  function animate() {
    requestAnimationFrame(animate)
    if (selectionHelper) selectionHelper.update()
    renderer.render(scene, camera)
  }

  animate()
}