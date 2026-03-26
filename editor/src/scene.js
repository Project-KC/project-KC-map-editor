import { Engine } from '@babylonjs/core/Engines/engine'
import { Scene } from '@babylonjs/core/scene'
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera'
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight'
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode'
import { Vector3, Matrix, Quaternion } from '@babylonjs/core/Maths/math.vector'
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color'
import { Texture } from '@babylonjs/core/Materials/Textures/texture'
import { ImageProcessingConfiguration } from '@babylonjs/core/Materials/imageProcessingConfiguration'
import '@babylonjs/core/Culling/ray'
import '@babylonjs/loaders/glTF'

import { MapData } from './map/MapData.js'
import { ToolMode, toolLabel } from './editor/Tools.js'
import { loadAssetRegistry } from './assets-system/AssetRegistry.js'
import { loadAssetModel, makeGhostMaterial, initAssetLoader } from './assets-system/AssetLoader.js'
import { loadTextureRegistry } from './assets-system/TextureRegistry.js'
import {
  buildTerrainMeshes,
  buildCliffMeshes,
  buildWaterMeshes,
  buildTextureOverlays,
  buildTexturePlanes,
  updateTerrainLandHeights
} from './map/TerrainMesh.js'

export function createEditorScene(container) {
  // --- Babylon.js engine & scene setup ---
  const canvas = document.createElement('canvas')
  canvas.style.position = 'absolute'
  canvas.style.inset = '0'
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  canvas.style.zIndex = '0'
  container.appendChild(canvas)

  const engine = new Engine(canvas, true, { antialias: true })
  const scene = new Scene(engine)
  scene.useRightHandedSystem = true

  // Prevent Babylon from consuming pointer events — we handle input manually
  scene.preventDefaultOnPointerDown = false
  scene.preventDefaultOnPointerUp = false

  scene.clearColor = new Color4(0.039, 0.071, 0.020, 1.0) // 0x0a1205
  scene.fogMode = Scene.FOGMODE_LINEAR
  scene.fogColor = new Color3(0.039, 0.071, 0.020)
  scene.fogStart = 22
  scene.fogEnd = 72

  // Disable image processing — vertex colors are pre-baked with shading
  scene.imageProcessingConfiguration.isEnabled = false

  // Single bright hemispheric light — vertex colors contain all shading already.
  // HemisphericLight with intensity 2.0 and white diffuse ensures vertex colors
  // render at approximately their raw values through StandardMaterial's diffuse path.
  const ambient = new HemisphericLight('ambient', new Vector3(0, 1, 0), scene)
  ambient.intensity = 2.0
  ambient.diffuse = new Color3(1.0, 1.0, 1.0)
  ambient.groundColor = new Color3(0.85, 0.85, 0.85)
  ambient.specular = new Color3(0, 0, 0)

  // Keep references for dungeon mode switching
  const sun = ambient   // alias for applyMapType compatibility
  const fill = ambient  // alias for applyMapType compatibility

  // Initialize asset loader with scene reference
  initAssetLoader(scene)

function tuneModelLighting(model, assetPath = '') {
  const pathLower = assetPath.toLowerCase()
  const isModular = pathLower.includes('modular assets')
  const isWoodModular = pathLower.includes('wood modular')
  const isWhiteModular = pathLower.includes('white')
  const isRock = pathLower.includes('rock')

  const WHITE_MODULAR_BRIGHTNESS = 0.55

  let brightness = 1.0
  if (isWhiteModular) brightness = WHITE_MODULAR_BRIGHTNESS
  else if (isWoodModular) brightness = 0.34
  else if (isModular) brightness = 1.0
  else if (isRock) brightness = 0.60

  const meshes = model.getChildMeshes ? model.getChildMeshes() : []
  for (const child of meshes) {
    const mat = child.material
    if (!mat) continue

    // Convert to unlit: move color to emissive, zero out diffuse
    const hasDiffuseTex = !!mat.diffuseTexture
    if (hasDiffuseTex) {
      mat.emissiveTexture = mat.diffuseTexture
      mat.diffuseTexture = null
      mat.emissiveColor = new Color3(brightness, brightness, brightness)
    } else {
      const dc = mat.diffuseColor || new Color3(1, 1, 1)
      mat.emissiveColor = new Color3(dc.r * brightness, dc.g * brightness, dc.b * brightness)
    }

    mat.diffuseColor = new Color3(0, 0, 0)
    mat.specularColor = new Color3(0, 0, 0)
    mat.ambientColor = new Color3(0, 0, 0)
    mat.backFaceCulling = false
    mat.disableLighting = true
  }
}

  // Camera — manual orbit (we clear built-in inputs and detach from canvas)
  const camera = new ArcRotateCamera('editorCam', 0.78, 1.02, 31, new Vector3(12, 2, 12), scene)
  camera.fov = 55 * Math.PI / 180
  camera.minZ = 0.1
  camera.maxZ = 1000
  camera.inputs.clear() // We handle camera manually
  camera.detachControl() // Don't let Babylon.js attach any pointer handlers

  // Water texture
  const waterTexture = new Texture('/assets/textures/1.png', scene)
  waterTexture.wrapU = Texture.WRAP_ADDRESSMODE
  waterTexture.wrapV = Texture.WRAP_ADDRESSMODE

  // Babylon.js animations auto-update — no mixer management needed
  // We keep a simple set of animation groups for cleanup
  const _animGroups = new Map() // model -> AnimationGroup[]

  function setupModelAnimations(model, path) {
    // Babylon.js GLB animations auto-play from loadAssetModel
    // Nothing to do here — animations are already running
  }

  function disposeMixer(model) {
    const groups = _animGroups.get(model)
    if (groups) {
      for (const ag of groups) { ag.stop(); ag.dispose() }
      _animGroups.delete(model)
    }
  }

  // Ensure Babylon.js nodes have .scale alias for .scaling and .userData
  function ensureNodeCompat(node) {
    if (!node.userData) node.userData = {}
    if (!node.scale && node.scaling) {
      Object.defineProperty(node, 'scale', { get() { return this.scaling }, set(v) { this.scaling.copyFrom(v) } })
    }
  }

  function addPlacedModel(model) {
    ensureNodeCompat(model)
    model.parent = placedGroup
    _spatialRegister(model)
    invalidateShadowCache()
    const asset = assetRegistry.find((a) => a.id === model.userData.assetId)
    if (asset) setupModelAnimations(model, asset.path)
  }

  function removePlacedModel(model) {
    _spatialUnregister(model)
    invalidateShadowCache()
    disposeMixer(model)
    model.dispose()
  }

  function clearPlacedModels() {
    for (const model of placedGroup.getChildren()) disposeMixer(model)
    _spatialGrid.clear()
    invalidateShadowCache()
    for (const child of [...placedGroup.getChildren()]) child.dispose()
  }

  let map = new MapData(64, 64)
  const placedGroup = new TransformNode('placedGroup', scene)

  let assetRegistry = []
  let filteredAssets = []
  let selectedAssetId = ''
  let previewObject = null
  let previewRotation = 0
  let hoverEdgeHelper = null

  let assetSectionFilter = 'all'
  let assetGroupFilter = 'all'
  let assetGroupsForCurrentSection = []

  let textureRegistry = []
  let filteredTextures = []
  const textureCache = new Map()
  const textureMeta = new Map()
  let selectedTextureId = null
  let paintTabTextureId = null   // texture selected in the paint tab (null = none, '__erase__' = erase)
  let paintTabTextureIdB = null  // secondary texture for slot B (half paint second triangle)
  let paintTextureSlot = 'A'     // which slot is active for palette selection
  let textureRotation = 0
  let textureScale = 1
  let textureWorldUV = false
  let paintTextureScale = 1

  let layers = [{ id: 'layer_0', name: 'Layer 1', visible: true }]
  let activeLayerId = 'layer_0'
  let _layerCount = 1

  let selectedPlacedObject = null
  let selectedPlacedObjects = []
  let selectedTexturePlane = null
  let selectedTexturePlanes = []
  let selectionHelper = null
  let saveFileHandle = null

  let isDragSelecting = false
  let dragSelectStart = null

  let transformMode = null
  let transformAxis = 'all'
  let lastRotateAxis = 'all'
  let transformStart = null
  let transformLift = 0
  let movePlaneStart = null

  let terrainGroup = null
  let cliffs = null
  let splitLines = null
  let tileGrid = null
  let textureOverlayGroup = null
  let texturePlaneGroup = null

  let texturePlaneVertical = true

  let _shadowInfluencesCache = null

  function invalidateShadowCache() { _shadowInfluencesCache = null }

  // --- Spatial index for placed objects ---
  // Divides world into SPATIAL_CELL-sized buckets so findObjectTopAt and
  // pickSurfacePoint only test objects near the cursor instead of all N objects.
  const SPATIAL_CELL = 8
  const _spatialGrid = new Map()

  function _spatialKey(cx, cz) { return cx * 65537 + cz }

  function _spatialRegister(obj) {
    const bounds = obj.userData.bounds
    if (!bounds) return
    const hw = bounds.width  * obj.scale.x * 0.5 + 1
    const hd = bounds.depth  * obj.scale.z * 0.5 + 1
    const x0 = Math.floor((obj.position.x - hw) / SPATIAL_CELL)
    const x1 = Math.floor((obj.position.x + hw) / SPATIAL_CELL)
    const z0 = Math.floor((obj.position.z - hd) / SPATIAL_CELL)
    const z1 = Math.floor((obj.position.z + hd) / SPATIAL_CELL)
    obj.userData._sc = [x0, x1, z0, z1]
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const k = _spatialKey(cx, cz)
        let cell = _spatialGrid.get(k)
        if (!cell) { cell = new Set(); _spatialGrid.set(k, cell) }
        cell.add(obj)
      }
    }
  }

  function _spatialUnregister(obj) {
    const sc = obj.userData._sc
    if (!sc) return
    const [x0, x1, z0, z1] = sc
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const cell = _spatialGrid.get(_spatialKey(cx, cz))
        if (cell) cell.delete(obj)
      }
    }
    delete obj.userData._sc
  }

  function _spatialNearby(worldX, worldZ, radius) {
    const cx0 = Math.floor((worldX - radius) / SPATIAL_CELL)
    const cx1 = Math.floor((worldX + radius) / SPATIAL_CELL)
    const cz0 = Math.floor((worldZ - radius) / SPATIAL_CELL)
    const cz1 = Math.floor((worldZ + radius) / SPATIAL_CELL)
    const seen = new Set()
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const cell = _spatialGrid.get(_spatialKey(cx, cz))
        if (!cell) continue
        for (const obj of cell) seen.add(obj)
      }
    }
    return seen
  }

  const undoStack = []
  const redoStack = []
  const MAX_HISTORY = 100

const state = {
  tool: ToolMode.TERRAIN,
  paintType: 'grass',
  halfPaint: false,
  hovered: { x: 0, z: 0 },
  showSplitLines: false,
  showTileGrid: false,
  isPainting: false,
  draggedTiles: new Set(),
  levelMode: false,
  levelHeight: null,
  smoothMode: false,
  historyCapturedThisStroke: false,
  lastTerrainEditTime: 0,
  terrainEditInterval: 110
}

let brushRadius = 3.2

  // RAF dirty-flag: terrain edits mark this dirty; the actual rebuild happens once per animation frame.
  let _terrainDirty = false
  let _terrainDirtyOpts = { skipTexturePlanes: true, skipShadows: true, skipTextureOverlays: true }
  let _terrainDirtyRegion = null  // {x1,z1,x2,z2} when only heights changed; null = full rebuild needed

  function markTerrainDirty({ skipTexturePlanes = false, skipShadows = false, skipTextureOverlays = false, heightsOnly = false, region = null } = {}) {
    _terrainDirty = true
    if (!skipTexturePlanes)   _terrainDirtyOpts.skipTexturePlanes   = false
    if (!skipShadows)         _terrainDirtyOpts.skipShadows         = false
    if (!skipTextureOverlays) _terrainDirtyOpts.skipTextureOverlays = false

    if (heightsOnly && region) {
      if (_terrainDirtyRegion) {
        _terrainDirtyRegion.x1 = Math.min(_terrainDirtyRegion.x1, region.x1)
        _terrainDirtyRegion.z1 = Math.min(_terrainDirtyRegion.z1, region.z1)
        _terrainDirtyRegion.x2 = Math.max(_terrainDirtyRegion.x2, region.x2)
        _terrainDirtyRegion.z2 = Math.max(_terrainDirtyRegion.z2, region.z2)
      } else {
        _terrainDirtyRegion = { ...region }
      }
    } else {
      _terrainDirtyRegion = null  // structural change — need full rebuild
    }
  }

  // Highlight mesh for hovered tile
  const highlight = MeshBuilder.CreatePlane('highlight', { size: 1 }, scene)
  highlight.rotation.x = Math.PI / 2 // Face up in RHS
  const highlightMat = new StandardMaterial('highlightMat', scene)
  highlightMat.emissiveColor = new Color3(1, 1, 0)
  highlightMat.diffuseColor = new Color3(0, 0, 0)
  highlightMat.specularColor = new Color3(0, 0, 0)
  highlightMat.disableLighting = true
  highlightMat.alpha = 0.18
  highlightMat.backFaceCulling = false
  highlight.material = highlightMat

  const uiRoot = document.createElement('div')
  uiRoot.style.position = 'absolute'
  uiRoot.style.inset = '0'
  uiRoot.style.pointerEvents = 'none'
  uiRoot.style.zIndex = '20'
  container.appendChild(uiRoot)

  // Top bar
  const topBar = document.createElement('div')
  topBar.id = 'topBar'
  topBar.innerHTML = `
    <span class="app-title">ProjectRS</span>
    <span class="top-sep"></span>
    <button id="saveMapBtn">Save</button>
    <label class="file-label">Load <input id="loadMapInput" type="file" accept=".json" /></label>
    <label class="file-label">Import Chunk <input id="importChunkInput" type="file" accept=".json" /></label>
    <button id="restoreAutoSaveBtn">Restore Auto-Save</button>
    <span class="top-sep"></span>
    <span class="top-label">W</span>
    <input id="mapWidthInput" type="number" min="4" value="64" />
    <span class="top-label">H</span>
    <input id="mapHeightInput" type="number" min="4" value="64" />
    <button id="resizeMapBtn">Resize</button>
    <span class="top-sep"></span>
    <span class="top-label">World X</span>
    <input id="worldOffsetX" type="number" value="0" style="width:60px;" />
    <span class="top-label">World Z</span>
    <input id="worldOffsetZ" type="number" value="0" style="width:60px;" />
    <span class="top-sep"></span>
    <button id="helpBtn" title="Keyboard shortcuts">?</button>
  `
  uiRoot.appendChild(topBar)

  // Compass
  const compass = document.createElement('div')
  compass.id = 'compass'
  compass.innerHTML = `
    <div id="compass-needle">
      <div id="compass-north">N</div>
      <div id="compass-arrow-n"></div>
      <div id="compass-arrow-s"></div>
    </div>
  `
  uiRoot.appendChild(compass)

  function updateCompass() {
    const angleDeg = (Math.PI / 2 - yaw) * (180 / Math.PI)
    document.getElementById('compass-needle').style.transform = `rotate(${angleDeg}deg)`
  }

  // Sidebar
  const sidebar = document.createElement('div')
  sidebar.id = 'sidebar'
  sidebar.innerHTML = `
    <div class="tool-row">
      <button id="toolTerrain" class="tool-btn" title="Terrain Tool (1)">Terrain</button>
      <button id="toolPaint" class="tool-btn" title="Paint Tool (2)">Paint</button>
      <button id="toolPlace" class="tool-btn" title="Place Asset (3)">Place</button>
      <button id="toolSelect" class="tool-btn" title="Select (4)">Select</button>
      <button id="toolTexturePlane" class="tool-btn" title="Texture Plane (5)">T.Plane</button>
      <button id="layersToggleBtn" class="tool-btn" title="Toggle Layers panel">Layers</button>
      <button id="heightCullBtn" class="tool-btn" title="Hide objects above camera height (H)">Height Cull</button>
    </div>
    <div class="ctx-divider"></div>

    <div class="ctx-panel" id="ctx-terrain">
      <label style="margin-top:0;font-size:11px;color:rgba(255,255,255,0.45);">Brush Size <span id="brushSizeLabel">3.2</span></label>
      <input id="brushSizeSlider" type="range" min="0.4" max="7" step="0.2" value="3.2" style="margin-top:3px;" />
      <button id="toggleSmoothMode" style="margin-top:8px;">Smooth Mode: Off</button>
      <button id="toggleLevelMode" style="margin-top:4px;">Level Mode: Off</button>
      <div id="levelHeightRow" style="display:none;margin-top:6px;">
        <div style="display:flex;gap:5px;align-items:center;">
          <input id="levelHeightInput" type="number" step="0.25" placeholder="Height" style="flex:1;margin-top:0;" />
          <button id="clearLevelHeight" style="width:auto;padding:7px 8px;margin-top:0;flex-shrink:0;">Clear</button>
        </div>
        <div class="hint" style="margin-top:4px;">Click a tile to sample · or type any value</div>
      </div>
      <div class="hint">Left drag raise · Shift lower · Ctrl smooth<br>Q/E raise/lower hovered · L level mode</div>
    </div>

    <div class="ctx-panel" id="ctx-paint" style="display:none">
      <div class="ground-swatches" id="groundSwatches"></div>
      <div class="row">
        <label><input id="toggleHalfPaint" type="checkbox" /> Half Tile Paint</label>
        <label><input id="toggleSplitLines" type="checkbox" /> Show Split Lines</label>
        <label><input id="toggleTileGrid" type="checkbox" /> Show Tile Grid</label>
      </div>
      <div style="font-size:11px;opacity:0.6;margin:8px 0 4px;border-top:1px solid #444;padding-top:8px;">Texture Brushes</div>
      <div style="display:flex;gap:4px;margin-bottom:5px;align-items:center;">
        <div style="font-size:11px;opacity:0.6;">Slot:</div>
        <div id="texSlotA" style="flex:1;height:28px;border-radius:3px;border:2px solid #2d6cdf;cursor:pointer;background-size:cover;background-position:center;display:flex;align-items:center;justify-content:center;font-size:10px;color:#fff;text-shadow:0 0 2px #000;">A</div>
        <div id="texSlotB" style="flex:1;height:28px;border-radius:3px;border:2px solid #444;cursor:pointer;background-size:cover;background-position:center;display:flex;align-items:center;justify-content:center;font-size:10px;color:#fff;text-shadow:0 0 2px #000;">B</div>
      </div>
      <button id="eraseTextureBrushBtn" style="width:100%;margin-bottom:5px;">Erase Texture</button>
      <div style="display:flex;gap:4px;margin-bottom:5px;">
        <button id="texCatAll" style="flex:1;font-size:11px;">All</button>
        <button id="texCatStretched" style="flex:1;font-size:11px;">Stretched</button>
      </div>
      <input id="paintTextureSearch" type="text" placeholder="Search textures..." style="width:100%;box-sizing:border-box;margin-bottom:5px;" />
      <div id="paintTexturePalette" style="display:grid;grid-template-columns:repeat(4,1fr);gap:4px;max-height:200px;overflow-y:auto;"></div>
      <div id="paintTextureScaleRow" style="display:none;margin-top:5px;">
        <label style="font-size:11px;color:rgba(255,255,255,0.45);">Scale <span id="paintTextureScaleVal">1</span></label>
        <input id="paintTextureScale" type="range" min="1" max="8" step="1" value="1" style="width:100%;" />
      </div>
    </div>

    <div class="ctx-panel" id="ctx-place" style="display:none">
      <div class="asset-tabs">
        <button class="asset-tab active" id="tabProps">Props</button>
        <button class="asset-tab" id="tabModular">Modular</button>
        <button class="asset-tab" id="tabWalls">Walls</button>
        <button class="asset-tab" id="tabRoofs">Roofs</button>
      </div>
      <select id="assetGroupSelect" style="display:none"></select>
      <input id="assetSearch" type="text" placeholder="Search assets..." />
      <div id="assetGrid" class="asset-grid"></div>
      <div style="margin-top:5px;">
        <button id="refreshPreviewBtn" style="width:100%">Refresh Preview</button>
      </div>
    </div>

    <div class="ctx-panel" id="ctx-select" style="display:none">
      <div class="hint">
        G move · R rotate · S scale<br>
        X Y Z axis lock · click confirm · Esc cancel<br>
        Q/E raise/lower while moving · Shift snap<br>
        Alt free move (bypass snap) · K snap to grid<br>
        Shift+D / Ctrl+Shift+D dup right · Ctrl+D left · Alt+D forward · Alt+A back<br>
        Shift+A stack upward<br>
        Delete / Backspace remove selected
      </div>
      <div id="layerAssignRow" style="display:none;margin-top:8px;border-top:1px solid #444;padding-top:8px;">
        <div style="font-size:11px;color:#aaa;margin-bottom:6px;">Layer</div>
        <div style="display:flex;gap:5px;align-items:center;">
          <select id="layerAssignSelect" style="flex:1;background:#2a2a2a;color:#fff;border:1px solid #555;border-radius:4px;padding:4px 6px;font-size:12px;"></select>
          <button id="layerAssignBtn" style="background:#1a4faf;color:#fff;border:none;border-radius:4px;padding:4px 8px;font-size:11px;cursor:pointer;white-space:nowrap;">Move</button>
        </div>
        <div id="layerCurrentLabel" style="font-size:10px;color:#888;margin-top:4px;"></div>
      </div>
      <div id="replaceRow" style="display:none;margin-top:8px;border-top:1px solid #444;padding-top:8px;">
        <button id="replaceBtn" style="width:100%">Replace Selected</button>
        <div id="replacePanel" style="display:none;margin-top:6px;">
          <input id="replaceSearch" type="text" placeholder="Search assets..." style="width:100%;box-sizing:border-box;margin-bottom:5px;" />
          <div id="replaceGrid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:4px;max-height:180px;overflow-y:auto;"></div>
        </div>
      </div>
      <div id="replaceTextureRow" style="display:none;margin-top:8px;border-top:1px solid #444;padding-top:8px;">
        <button id="replaceTextureBtn" style="width:100%">Replace Texture</button>
        <div id="replaceTexturePanel" style="display:none;margin-top:6px;">
          <input id="replaceTextureSearch" type="text" placeholder="Search textures..." style="width:100%;box-sizing:border-box;margin-bottom:5px;" />
          <div id="replaceTextureGrid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:4px;max-height:180px;overflow-y:auto;"></div>
        </div>
      </div>
      <div id="tileSizeRow" style="display:none;margin-top:8px;border-top:1px solid #444;padding-top:8px;">
        <div style="font-size:11px;opacity:0.6;margin-bottom:5px;">Scale to tiles (longest axis)</div>
        <div style="display:flex;gap:4px;flex-wrap:wrap;">
          <button class="tile-size-btn" data-tiles="1">1</button>
          <button class="tile-size-btn" data-tiles="2">2</button>
          <button class="tile-size-btn" data-tiles="3">3</button>
          <button class="tile-size-btn" data-tiles="4">4</button>
          <button class="tile-size-btn" data-tiles="5">5</button>
        </div>
        <div style="display:flex;gap:4px;margin-top:5px;align-items:center;">
          <input id="customTileSize" type="number" min="0.25" max="20" step="0.25" value="1" style="width:60px;" />
          <button id="applyCustomTileSize">Apply</button>
        </div>
      </div>
      <div id="triggerRow" style="display:none;margin-top:8px;border-top:1px solid #444;padding-top:8px;">
        <div style="font-size:11px;color:#aaa;margin-bottom:6px;">Trigger</div>
        <div style="display:flex;gap:5px;align-items:center;margin-bottom:5px;">
          <select id="triggerType" style="flex:1;background:#2a2a2a;color:#fff;border:1px solid #555;border-radius:4px;padding:4px 6px;font-size:12px;">
            <option value="">— none —</option>
            <option value="teleport">Teleport</option>
          </select>
        </div>
        <div id="triggerTeleportFields" style="display:none;">
          <div style="font-size:10px;color:#888;margin-bottom:3px;">Destination chunk file</div>
          <input id="triggerDestChunk" type="text" placeholder="e.g. dungeon_1" style="width:100%;box-sizing:border-box;margin-bottom:5px;font-size:11px;" />
          <div style="font-size:10px;color:#888;margin-bottom:3px;">Entry point (X / Y / Z)</div>
          <div style="display:flex;gap:3px;">
            <input id="triggerEntryX" type="number" step="0.5" placeholder="X" style="flex:1;min-width:0;" />
            <input id="triggerEntryY" type="number" step="0.5" placeholder="Y" style="flex:1;min-width:0;" />
            <input id="triggerEntryZ" type="number" step="0.5" placeholder="Z" style="flex:1;min-width:0;" />
          </div>
        </div>
      </div>
    </div>

    <div class="ctx-panel" id="ctx-texture" style="display:none">
      <input id="textureSearch" type="text" placeholder="Search textures..." />
      <div id="texturePalette" style="display:grid;grid-template-columns:repeat(3,1fr);gap:5px;max-height:200px;overflow:auto;margin-top:7px;"></div>
      <div style="margin-top:5px;">
        <button id="useTexturePlaneBtn" style="width:100%">Plane Mode</button>
      </div>
      <button id="rotateTextureBtn">Rotate Texture (R)</button>
      <label style="margin-top:6px;font-size:11px;color:rgba(255,255,255,0.45);">Scale <span id="textureScaleVal">1</span></label>
      <input id="textureScale" type="range" min="1" max="8" step="1" value="1" />
      <label style="margin-top:5px;"><input id="toggleTexturePlaneV" type="checkbox" checked /> Vertical plane (V)</label>
    </div>
  `
  uiRoot.appendChild(sidebar)

  // Status bar
  const statusBar = document.createElement('div')
  statusBar.id = 'statusBar'
  statusBar.innerHTML = `<span id="statusText">Terrain Tool</span><span id="hoverText" style="margin-left:auto;opacity:0.55;"></span>`
  uiRoot.appendChild(statusBar)

  // Keybinds overlay
  const keybindsPanel = document.createElement('div')
  keybindsPanel.id = 'keybindsPanel'
  keybindsPanel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
      <strong>Keyboard Shortcuts</strong>
      <button id="closeKeybinds">✕</button>
    </div>
    <div>
      <b>Tools:</b> 1 Terrain · 2 Paint · 3 Place · 4 Select · 5 Texture · 6 Texture Plane<br>
      <b>History:</b> Ctrl+Z undo · Ctrl+Shift+Z / Ctrl+Y redo<br>
      <b>Transform:</b> G move · R rotate · S scale · X/Y/Z axis · click confirm · Esc cancel<br>
      <b>While moving:</b> Q raise · E lower · Shift snap to grid · Alt disable edge snap<br>
      <b>Terrain:</b> Q/E raise/lower hovered · L level mode · F flip tile split<br>
      <b>Duplicate:</b> Shift+D / Ctrl+Shift+D right · Ctrl+D left · Alt+D forward · Alt+A back · Shift+A stack up<br>
      <b>Other:</b> K snap to grid · V toggle plane vertical/horizontal · Del remove selected
    </div>
  `
  uiRoot.appendChild(keybindsPanel)

  const layersPanel = document.createElement('div')
  layersPanel.id = 'layersPanel'
  uiRoot.appendChild(layersPanel)

  const toolButtons = {
    [ToolMode.TERRAIN]: sidebar.querySelector('#toolTerrain'),
    [ToolMode.PAINT]: sidebar.querySelector('#toolPaint'),
    [ToolMode.PLACE]: sidebar.querySelector('#toolPlace'),
    [ToolMode.SELECT]: sidebar.querySelector('#toolSelect'),
    [ToolMode.TEXTURE_PLANE]: sidebar.querySelector('#toolTexturePlane')
  }

  toolButtons[ToolMode.TERRAIN]?.addEventListener('click', () => setTool(ToolMode.TERRAIN))
  toolButtons[ToolMode.PAINT]?.addEventListener('click', () => setTool(ToolMode.PAINT))
  toolButtons[ToolMode.PLACE]?.addEventListener('click', () => setTool(ToolMode.PLACE))
  toolButtons[ToolMode.SELECT]?.addEventListener('click', () => setTool(ToolMode.SELECT))
  toolButtons[ToolMode.TEXTURE_PLANE]?.addEventListener('click', () => setTool(ToolMode.TEXTURE_PLANE))

  const smoothModeBtn = sidebar.querySelector('#toggleSmoothMode')
  const levelModeBtn = sidebar.querySelector('#toggleLevelMode')
  const saveMapBtn = topBar.querySelector('#saveMapBtn')
  const loadMapInput = topBar.querySelector('#loadMapInput')
  const mapWidthInput = topBar.querySelector('#mapWidthInput')
  const mapHeightInput = topBar.querySelector('#mapHeightInput')
  const resizeMapBtn = topBar.querySelector('#resizeMapBtn')
  const statusText = statusBar.querySelector('#statusText')
  const hoverText = statusBar.querySelector('#hoverText')

  const tabProps = sidebar.querySelector('#tabProps')
  const tabModular = sidebar.querySelector('#tabModular')
  const tabWalls = sidebar.querySelector('#tabWalls')
  const tabRoofs = sidebar.querySelector('#tabRoofs')
  const assetGroupSelect = sidebar.querySelector('#assetGroupSelect')
  const assetSearch = sidebar.querySelector('#assetSearch')
  const assetGrid = sidebar.querySelector('#assetGrid')
  const refreshPreviewBtn = sidebar.querySelector('#refreshPreviewBtn')

  const textureSearch = sidebar.querySelector('#textureSearch')
  const texturePalette = sidebar.querySelector('#texturePalette')
  const useTexturePlaneBtn = sidebar.querySelector('#useTexturePlaneBtn')
  const textureScaleSlider = sidebar.querySelector('#textureScale')
  const rotateTextureBtn = sidebar.querySelector('#rotateTextureBtn')

  // Tile-size preset buttons in select panel
  for (const btn of sidebar.querySelectorAll('.tile-size-btn')) {
    btn.addEventListener('click', () => {
      if (!selectedPlacedObject) return
      const tiles = parseFloat(btn.dataset.tiles)
      pushUndoState()
      scaleObjectToTiles(selectedPlacedObject, tiles)
      updateSelectionHelper()
      markTerrainDirty()
    })
  }
  const customTileSizeInput = sidebar.querySelector('#customTileSize')
  const applyCustomTileSizeBtn = sidebar.querySelector('#applyCustomTileSize')
  applyCustomTileSizeBtn?.addEventListener('click', () => {
    if (!selectedPlacedObject) return
    const tiles = parseFloat(customTileSizeInput.value)
    if (!isFinite(tiles) || tiles <= 0) return
    pushUndoState()
    scaleObjectToTiles(selectedPlacedObject, tiles)
    updateSelectionHelper()
    markTerrainDirty()
  })

  // Trigger metadata handlers
  function saveTriggerFromUI() {
    if (!selectedPlacedObject) return
    const type = sidebar.querySelector('#triggerType').value
    if (!type) {
      delete selectedPlacedObject.userData.trigger
      return
    }
    selectedPlacedObject.userData.trigger = {
      type,
      destChunk: sidebar.querySelector('#triggerDestChunk').value.trim(),
      entryX: parseFloat(sidebar.querySelector('#triggerEntryX').value) || 0,
      entryY: parseFloat(sidebar.querySelector('#triggerEntryY').value) || 0,
      entryZ: parseFloat(sidebar.querySelector('#triggerEntryZ').value) || 0
    }
  }

  sidebar.querySelector('#triggerType').addEventListener('change', () => {
    const isTP = sidebar.querySelector('#triggerType').value === 'teleport'
    sidebar.querySelector('#triggerTeleportFields').style.display = isTP ? 'block' : 'none'
    saveTriggerFromUI()
  })

  for (const id of ['#triggerDestChunk', '#triggerEntryX', '#triggerEntryY', '#triggerEntryZ']) {
    sidebar.querySelector(id).addEventListener('change', saveTriggerFromUI)
  }

  const replaceBtnEl = sidebar.querySelector('#replaceBtn')
  const replacePanel = sidebar.querySelector('#replacePanel')
  const replaceSearchEl = sidebar.querySelector('#replaceSearch')
  const replaceGridEl = sidebar.querySelector('#replaceGrid')

  function buildReplaceGrid() {
    const q = replaceSearchEl.value.trim().toLowerCase()
    const assets = assetRegistry.filter((a) => {
      if (!a.path?.toLowerCase().includes('modular assets')) return false
      return !q || (a.name || a.id).toLowerCase().includes(q)
    })
    replaceGridEl.innerHTML = ''
    for (const asset of assets) {
      const card = document.createElement('div')
      card.className = 'asset-card'
      const img = document.createElement('img')
      img.className = 'asset-thumb'
      img.alt = asset.name
      const label = document.createElement('div')
      label.className = 'asset-label'
      label.textContent = asset.name
      card.appendChild(img)
      card.appendChild(label)
      replaceGridEl.appendChild(card)
      card.addEventListener('click', async () => {
        await replaceSelectedWith(asset.id)
        replacePanel.style.display = 'none'
        replaceBtnEl.textContent = 'Replace Selected'
      })
      generateThumbnail(asset).then((url) => { if (url) img.src = url })
    }
  }

  replaceBtnEl?.addEventListener('click', () => {
    const isOpen = replacePanel.style.display !== 'none'
    replacePanel.style.display = isOpen ? 'none' : 'block'
    replaceBtnEl.textContent = isOpen ? 'Replace Selected' : 'Cancel'
    if (!isOpen) {
      replaceSearchEl.value = ''
      buildReplaceGrid()
    }
  })
  replaceSearchEl?.addEventListener('input', buildReplaceGrid)

  const replaceTextureBtnEl = sidebar.querySelector('#replaceTextureBtn')
  const replaceTexturePanel = sidebar.querySelector('#replaceTexturePanel')
  const replaceTextureSearchEl = sidebar.querySelector('#replaceTextureSearch')
  const replaceTextureGridEl = sidebar.querySelector('#replaceTextureGrid')

  function buildReplaceTextureGrid() {
    const q = replaceTextureSearchEl.value.trim().toLowerCase()
    const textures = textureRegistry.filter((t) =>
      !q || (t.name || t.id).toLowerCase().includes(q)
    )
    replaceTextureGridEl.innerHTML = ''
    for (const tex of textures) {
      const img = document.createElement('img')
      img.src = tex.path
      img.title = tex.name || tex.id
      img.style.cssText = 'width:56px;height:56px;object-fit:cover;border:2px solid transparent;border-radius:4px;cursor:pointer;display:block;'
      img.onerror = () => { img.style.border = '2px solid red' }
      img.addEventListener('click', () => {
        replaceSelectedTexturesWith(tex.id)
        replaceTexturePanel.style.display = 'none'
        replaceTextureBtnEl.textContent = 'Replace Texture'
      })
      replaceTextureGridEl.appendChild(img)
    }
  }

  replaceTextureBtnEl?.addEventListener('click', () => {
    const isOpen = replaceTexturePanel.style.display !== 'none'
    replaceTexturePanel.style.display = isOpen ? 'none' : 'block'
    replaceTextureBtnEl.textContent = isOpen ? 'Replace Texture' : 'Cancel'
    if (!isOpen) {
      replaceTextureSearchEl.value = ''
      buildReplaceTextureGrid()
    }
  })
  replaceTextureSearchEl?.addEventListener('input', buildReplaceTextureGrid)

  mapWidthInput.value = map.width
  mapHeightInput.value = map.height



  const GROUND_TYPES_OVERWORLD = [
    { id: 'grass', label: 'Grass', color: '#3d8a20' },
    { id: 'dirt',  label: 'Dirt',  color: '#7a5030' },
    { id: 'sand',  label: 'Sand',  color: '#c4a245' },
    { id: 'path',  label: 'Path',  color: '#8a7860' },
    { id: 'road',  label: 'Road',  color: '#7a7870' },
    { id: 'water', label: 'Mud', color: '#5a3d1a' },
    { id: 'surface-water', label: 'Paddy Water', color: '#7ab8c8' },
  ]

  const GROUND_TYPES_DUNGEON = [
    { id: 'dungeon-floor', label: 'Stone Floor', color: '#3a2e20' },
    { id: 'dungeon-rock',  label: 'Rock',        color: '#4a3828' },
    { id: 'dirt',          label: 'Dirt',         color: '#7a5030' },
    { id: 'water',         label: 'Mud',          color: '#5a3d1a' },
    { id: 'surface-water', label: 'Still Water',  color: '#7ab8c8' },
  ]

  let GROUND_TYPES = GROUND_TYPES_OVERWORLD

  function buildGroundSwatches() {
    const container = sidebar.querySelector('#groundSwatches')
    if (!container) return
    container.innerHTML = ''
    for (const gt of GROUND_TYPES) {
      const div = document.createElement('div')
      div.className = 'ground-swatch'
      div.dataset.type = gt.id
      div.innerHTML = `
        <div class="swatch-color" style="background:${gt.color}"></div>
        <div class="swatch-label">${gt.label}</div>
      `
      div.addEventListener('click', () => {
        state.paintType = gt.id
        paintTabTextureId = null
        setTool(ToolMode.PAINT)
        refreshPaintTexturePalette()
        updateToolUI()
      })
      container.appendChild(div)
    }
  }

  function updateSwatches() {
    for (const el of sidebar.querySelectorAll('.ground-swatch')) {
      el.classList.toggle('active', el.dataset.type === state.paintType)
    }
  }

  function applyLayerVisibility() {
    if (heightCullLevel > 0) { applyHeightCull(); return }
    for (const obj of placedGroup.getChildren()) {
      const layer = layers.find((l) => l.id === (obj.userData?.layerId || 'layer_0'))
      obj.setEnabled(layer ? layer.visible : true)
    }
    if (texturePlaneGroup) {
      for (const mesh of texturePlaneGroup.getChildMeshes()) {
        const plane = mesh.userData?.texturePlane
        if (!plane) continue
        const layer = layers.find((l) => l.id === (plane.layerId || 'layer_0'))
        mesh.isVisible = layer ? layer.visible : true
      }
    }
  }

  function refreshLayersPanel() {
    layersPanel.innerHTML = ''

    const header = document.createElement('div')
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;'
    const title = document.createElement('strong')
    title.style.cssText = 'color:#fff;font-size:12px;'
    title.textContent = 'Layers'
    const closeBtn = document.createElement('button')
    closeBtn.style.cssText = 'background:none;border:none;color:#888;cursor:pointer;font-size:14px;padding:0;'
    closeBtn.textContent = '✕'
    closeBtn.addEventListener('click', () => layersPanel.classList.remove('visible'))
    header.appendChild(title)
    header.appendChild(closeBtn)
    layersPanel.appendChild(header)

    const selCount = selectedPlacedObjects.length
    if (selCount > 0) {
      const assignHint = document.createElement('div')
      assignHint.style.cssText = 'font-size:10px;color:#ffcc66;margin-bottom:8px;padding:5px 6px;background:rgba(255,200,50,0.1);border-radius:4px;border:1px solid rgba(255,200,50,0.25);'
      assignHint.textContent = `${selCount} object${selCount > 1 ? 's' : ''} selected — click a layer name to move them there`
      layersPanel.appendChild(assignHint)
    }

    for (const layer of layers) {
      const objCount = placedGroup.getChildren().filter(
        (o) => (o.userData.layerId || 'layer_0') === layer.id
      ).length + map.texturePlanes.filter(
        (p) => (p.layerId || 'layer_0') === layer.id
      ).length

      const row = document.createElement('div')
      row.className = 'layer-row' + (layer.id === activeLayerId ? ' active' : '') + (!layer.visible ? ' layer-hidden' : '')

      const eyeBtn = document.createElement('button')
      eyeBtn.className = 'layer-eye'
      eyeBtn.textContent = layer.visible ? '👁' : '🚫'
      eyeBtn.title = layer.visible ? 'Hide layer' : 'Show layer'
      eyeBtn.style.cssText = `opacity:${layer.visible ? '1' : '0.4'};`
      eyeBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        layer.visible = !layer.visible
        applyLayerVisibility()
        refreshLayersPanel()
      })

      const soloBtn = document.createElement('button')
      soloBtn.className = 'layer-eye'
      soloBtn.textContent = 'S'
      soloBtn.title = 'Solo: show only this layer'
      soloBtn.style.cssText = 'font-size:9px;padding:0 3px;opacity:0.5;'
      soloBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        const allVisible = layers.every((l) => l.visible)
        const onlyThis = layers.every((l) => l.id === layer.id ? l.visible : !l.visible)
        // If already soloed, restore all; otherwise solo this one
        for (const l of layers) l.visible = (allVisible || onlyThis) ? true : l.id === layer.id
        if (!allVisible && !onlyThis) for (const l of layers) l.visible = l.id === layer.id
        applyLayerVisibility()
        refreshLayersPanel()
      })

      const nameEl = document.createElement('div')
      nameEl.className = 'layer-name'
      nameEl.style.cssText = `opacity:${layer.visible ? '1' : '0.4'};`
      const hasSelection = selectedPlacedObjects.length > 0 || selectedTexturePlane
      nameEl.title = hasSelection ? 'Click to move selected objects here & set active' : 'Click to set active'
      nameEl.addEventListener('click', () => {
        if (selectedPlacedObjects.length > 0 || selectedTexturePlane) {
          pushUndoState()
          for (const obj of selectedPlacedObjects) obj.userData.layerId = layer.id
          for (const plane of selectedTexturePlanes) plane.layerId = layer.id
          applyLayerVisibility()
        }
        activeLayerId = layer.id
        refreshLayersPanel()
        updateToolUI()
      })

      const nameText = document.createElement('span')
      nameText.textContent = layer.name
      const countBadge = document.createElement('span')
      countBadge.textContent = objCount
      countBadge.style.cssText = 'margin-left:5px;background:#444;border-radius:8px;padding:0 5px;font-size:9px;color:#aaa;'
      nameEl.appendChild(nameText)
      nameEl.appendChild(countBadge)

      const delBtn = document.createElement('button')
      delBtn.className = 'layer-del'
      delBtn.textContent = '✕'
      delBtn.title = 'Delete layer'
      delBtn.style.display = layers.length <= 1 ? 'none' : ''
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        const fallbackId = layers.find((l) => l.id !== layer.id)?.id || 'layer_0'
        for (const obj of placedGroup.getChildren()) {
          if (obj.userData.layerId === layer.id) obj.userData.layerId = fallbackId
        }
        layers = layers.filter((l) => l.id !== layer.id)
        if (activeLayerId === layer.id) activeLayerId = fallbackId
        applyLayerVisibility()
        refreshLayersPanel()
        updateToolUI()
      })

      row.appendChild(eyeBtn)
      row.appendChild(soloBtn)
      row.appendChild(nameEl)
      row.appendChild(delBtn)
      layersPanel.appendChild(row)
    }

    const addBtn = document.createElement('button')
    addBtn.className = 'layer-add-btn'
    addBtn.textContent = '+ New Layer'
    addBtn.addEventListener('click', () => {
      _layerCount++
      const id = 'layer_' + Date.now()
      layers.push({ id, name: 'Layer ' + _layerCount, visible: true })
      activeLayerId = id
      refreshLayersPanel()
      updateToolUI()
    })
    layersPanel.appendChild(addBtn)
  }

  function updateToolUI() {
    for (const [mode, button] of Object.entries(toolButtons)) {
      if (button) button.classList.toggle('active-tool', state.tool === mode)
    }

    if (layersPanel.classList.contains('visible')) refreshLayersPanel()

    // Show only the active context panel
    const ctxMap = {
      [ToolMode.TERRAIN]: 'ctx-terrain',
      [ToolMode.PAINT]: 'ctx-paint',
      [ToolMode.PLACE]: 'ctx-place',
      [ToolMode.SELECT]: 'ctx-select',
      [ToolMode.TEXTURE_PLANE]: 'ctx-texture',
    }
    for (const id of ['ctx-terrain', 'ctx-paint', 'ctx-place', 'ctx-select', 'ctx-texture']) {
      const el = sidebar.querySelector(`#${id}`)
      if (el) el.style.display = 'none'
    }
    const activeCtx = ctxMap[state.tool]
    if (activeCtx) {
      const el = sidebar.querySelector(`#${activeCtx}`)
      if (el) el.style.display = 'block'
    }

    updateSwatches()

    smoothModeBtn.textContent = `Smooth Mode: ${state.smoothMode ? 'On' : 'Off'}`
    smoothModeBtn.classList.toggle('active-tool', state.smoothMode)

    levelModeBtn.textContent = `Level Mode: ${state.levelMode ? 'On' : 'Off'}`
    levelModeBtn.classList.toggle('active-tool', state.levelMode)

    levelHeightRow.style.display = state.levelMode ? 'block' : 'none'
    if (state.levelMode && state.levelHeight !== null && document.activeElement !== levelHeightInput) {
      levelHeightInput.value = state.levelHeight.toFixed(2)
    }

    useTexturePlaneBtn.classList.toggle('active-tool', state.tool === ToolMode.TEXTURE_PLANE)


    const vpCheckbox = sidebar.querySelector('#toggleTexturePlaneV')
    if (vpCheckbox) vpCheckbox.checked = texturePlaneVertical

    // Status bar
    let status = toolLabel(state.tool)
    if (state.tool === ToolMode.PAINT) {
      if (paintTabTextureId === '__erase__') status += ' · Erase Texture'
      else if (paintTabTextureId) status += ` · Texture: ${paintTabTextureId}`
      else status += ` · ${state.paintType}`
    }
    if (state.tool === ToolMode.PLACE && selectedAssetId) {
      const asset = assetRegistry.find((a) => a.id === selectedAssetId)
      status += ` · ${asset?.name || selectedAssetId}`
    }
    if (state.tool === ToolMode.TEXTURE_PLANE) {
      status += ` · ${selectedTextureId || 'no texture'}`
    }

    const eraseBtn = sidebar.querySelector('#eraseTextureBrushBtn')
    if (eraseBtn) eraseBtn.classList.toggle('active-tool', state.tool === ToolMode.PAINT && paintTabTextureId === '__erase__')

    // Show scale slider for painted textures (non-stretched, non-erase)
    if (paintTextureScaleRow) {
      const showScale = state.tool === ToolMode.PAINT && paintTabTextureId && paintTabTextureId !== '__erase__' && textureWorldUV
      paintTextureScaleRow.style.display = showScale ? 'block' : 'none'
    }
    if (state.tool === ToolMode.TEXTURE_PLANE) {
      status += ` · ${texturePlaneVertical ? 'vertical' : 'horizontal'}`
    }
    if (state.tool === ToolMode.TERRAIN && state.smoothMode) status += ' · Smooth Mode'
    if (state.tool === ToolMode.TERRAIN && state.levelMode) {
      status += ' · Level Mode'
      if (state.levelHeight !== null) status += ` @ ${state.levelHeight.toFixed(2)}`
    }
    if (selectedTexturePlane) status += ` · Plane: ${selectedTexturePlane.textureId}`
    if (selectedPlacedObject) status += ' · Object selected'

    const tileSizeRow = sidebar.querySelector('#tileSizeRow')
    if (tileSizeRow) {
      tileSizeRow.style.display = (state.tool === ToolMode.SELECT && selectedPlacedObject) ? 'block' : 'none'
    }
    const triggerRow = sidebar.querySelector('#triggerRow')
    if (triggerRow) {
      const showTrigger = state.tool === ToolMode.SELECT && selectedPlacedObject
      triggerRow.style.display = showTrigger ? 'block' : 'none'
      if (showTrigger) {
        const t = selectedPlacedObject.userData.trigger
        sidebar.querySelector('#triggerType').value = t?.type || ''
        const isTP = t?.type === 'teleport'
        sidebar.querySelector('#triggerTeleportFields').style.display = isTP ? 'block' : 'none'
        if (isTP) {
          sidebar.querySelector('#triggerDestChunk').value = t.destChunk || ''
          sidebar.querySelector('#triggerEntryX').value = t.entryX ?? ''
          sidebar.querySelector('#triggerEntryY').value = t.entryY ?? ''
          sidebar.querySelector('#triggerEntryZ').value = t.entryZ ?? ''
        }
      }
    }
    const layerAssignRow = sidebar.querySelector('#layerAssignRow')
    if (layerAssignRow) {
      const showAssign = state.tool === ToolMode.SELECT &&
        (selectedPlacedObjects.length > 0 || selectedTexturePlane)
      layerAssignRow.style.display = showAssign ? 'block' : 'none'
      if (showAssign) {
        const sel = sidebar.querySelector('#layerAssignSelect')
        const lbl = sidebar.querySelector('#layerCurrentLabel')
        if (sel) {
          let currentId, allSame
          if (selectedTexturePlane) {
            currentId = selectedTexturePlane.layerId || 'layer_0'
            allSame = selectedTexturePlanes.every((p) => (p.layerId || 'layer_0') === currentId)
          } else {
            currentId = selectedPlacedObject?.userData?.layerId || 'layer_0'
            allSame = selectedPlacedObjects.every(
              (o) => (o.userData.layerId || 'layer_0') === currentId
            )
          }
          const currentLayer = layers.find((l) => l.id === currentId)
          sel.innerHTML = layers.map((l) =>
            `<option value="${l.id}"${l.id === currentId ? ' selected' : ''}>${l.name}</option>`
          ).join('')
          if (lbl) {
            lbl.textContent = allSame
              ? `Currently on: ${currentLayer?.name ?? 'Layer 1'}`
              : 'Multiple layers selected'
          }
        }
      }
    }
    const replaceRowEl = sidebar.querySelector('#replaceRow')
    if (replaceRowEl) {
      const showReplace = state.tool === ToolMode.SELECT && selectedPlacedObjects.length > 0
      replaceRowEl.style.display = showReplace ? 'block' : 'none'
      if (!showReplace) {
        const rp = sidebar.querySelector('#replacePanel')
        const rb = sidebar.querySelector('#replaceBtn')
        if (rp) rp.style.display = 'none'
        if (rb) rb.textContent = 'Replace Selected'
      }
    }
    const replaceTextureRowEl = sidebar.querySelector('#replaceTextureRow')
    if (replaceTextureRowEl) {
      const showReplaceTexture = state.tool === ToolMode.SELECT && selectedTexturePlanes.length > 0
      replaceTextureRowEl.style.display = showReplaceTexture ? 'block' : 'none'
      if (!showReplaceTexture) {
        const rp = sidebar.querySelector('#replaceTexturePanel')
        const rb = sidebar.querySelector('#replaceTextureBtn')
        if (rp) rp.style.display = 'none'
        if (rb) rb.textContent = 'Replace Texture'
      }
    }
    if (transformMode) {
      let axisLabel = 'ALL'
      if (transformAxis === 'x') axisLabel = 'X'
      else if (transformAxis === 'ground-z') axisLabel = 'Y'
      else if (transformAxis === 'height') axisLabel = 'Z'
      else if (transformAxis !== 'all') axisLabel = transformAxis.toUpperCase()
      status += ` · ${transformMode.toUpperCase()} (${axisLabel})`
    }
    statusText.textContent = status
  }

  function setTool(mode) {
    state.tool = mode
    if (hoverEdgeHelper) { hoverEdgeHelper.dispose(); hoverEdgeHelper = null }
    updateToolUI()
    updatePreviewObject().catch(console.error)
  }

  function createBoundingBoxHelper(target, color) {
    try {
      const bounds = target.getHierarchyBoundingVectors(true)
      const min = bounds.min, max = bounds.max
      if (!min || !max || (min.x === max.x && min.y === max.y && min.z === max.z)) return null
      const lines = [
        [new Vector3(min.x, min.y, min.z), new Vector3(max.x, min.y, min.z)],
        [new Vector3(max.x, min.y, min.z), new Vector3(max.x, min.y, max.z)],
        [new Vector3(max.x, min.y, max.z), new Vector3(min.x, min.y, max.z)],
        [new Vector3(min.x, min.y, max.z), new Vector3(min.x, min.y, min.z)],
        [new Vector3(min.x, max.y, min.z), new Vector3(max.x, max.y, min.z)],
        [new Vector3(max.x, max.y, min.z), new Vector3(max.x, max.y, max.z)],
        [new Vector3(max.x, max.y, max.z), new Vector3(min.x, max.y, max.z)],
        [new Vector3(min.x, max.y, max.z), new Vector3(min.x, max.y, min.z)],
        [new Vector3(min.x, min.y, min.z), new Vector3(min.x, max.y, min.z)],
        [new Vector3(max.x, min.y, min.z), new Vector3(max.x, max.y, min.z)],
        [new Vector3(max.x, min.y, max.z), new Vector3(max.x, max.y, max.z)],
        [new Vector3(min.x, min.y, max.z), new Vector3(min.x, max.y, max.z)],
      ]
      const linesMesh = MeshBuilder.CreateLineSystem('selBox', { lines }, scene)
      linesMesh.color = color
      return linesMesh
    } catch { return null }
  }

  function clearSelectionHelper() {
    if (Array.isArray(selectionHelper)) {
      for (const h of selectionHelper) { if (h) h.dispose() }
    } else if (selectionHelper) {
      selectionHelper.dispose()
    }
    selectionHelper = null
  }

  function updateSelectionHelper() {
    clearSelectionHelper()

    if (selectedPlacedObjects.length === 1) {
      selectionHelper = createBoundingBoxHelper(selectedPlacedObjects[0], new Color3(0.4, 0.8, 1.0))
      return
    }

    if (selectedPlacedObjects.length > 1) {
      selectionHelper = selectedPlacedObjects.map((obj) => {
        return createBoundingBoxHelper(obj, new Color3(1.0, 0.67, 0.27))
      }).filter(Boolean)
      return
    }

    if (selectedTexturePlane && texturePlaneGroup) {
      const color = selectedTexturePlanes.length > 1 ? new Color3(1.0, 0.67, 0.27) : new Color3(0.4, 0.8, 1.0)
      selectionHelper = selectedTexturePlanes.map((plane) => {
        const mesh = texturePlaneGroup.getChildMeshes().find((c) => c.userData?.texturePlane?.id === plane.id)
        if (!mesh) return null
        return createBoundingBoxHelper(mesh, color)
      }).filter(Boolean)
    }
  }

  function clearSelection() {
    selectedPlacedObject = null
    selectedPlacedObjects = []
    selectedTexturePlane = null
    selectedTexturePlanes = []
    transformMode = null
    transformStart = null
    transformLift = 0
    movePlaneStart = null
    updateSelectionHelper()
    updateToolUI()
  }

  function serializePlacedObjects() {
    return placedGroup.getChildren().map((obj) => {
      const out = {
        assetId: obj.userData.assetId || null,
        layerId: obj.userData.layerId || 'layer_0',
        position: { x: obj.position.x, y: obj.position.y, z: obj.position.z },
        rotation: { x: obj.rotation.x, y: obj.rotation.y, z: obj.rotation.z },
        scale: { x: obj.scale.x, y: obj.scale.y, z: obj.scale.z }
      }
      if (obj.userData.trigger) out.trigger = { ...obj.userData.trigger }
      return out
    })
  }

  async function rebuildPlacedObjectsFromData(placedObjectsData) {
    clearPlacedModels()

    // Pre-load all unique models in parallel so cache is warm before sequential cloning
    const uniquePaths = [...new Set(
      (placedObjectsData || [])
        .map((p) => assetRegistry.find((a) => a.id === p.assetId)?.path)
        .filter(Boolean)
    )]
    await Promise.all(uniquePaths.map((path) => loadAssetModel(path).catch(() => {})))

    for (const placed of placedObjectsData || []) {
      const asset = assetRegistry.find((a) => a.id === placed.assetId)
      if (!asset) continue

      const model = await loadAssetModel(asset.path)
      tuneModelLighting(model, asset.path)

      model.position.set(placed.position.x, placed.position.y, placed.position.z)
      model.rotation.set(placed.rotation.x, placed.rotation.y, placed.rotation.z)
      model.scale.set(placed.scale.x, placed.scale.y, placed.scale.z)
      model.userData.assetId = asset.id
      model.userData.type = 'asset'
      model.userData.layerId = placed.layerId || 'layer_0'
      if (placed.trigger) model.userData.trigger = { ...placed.trigger }
      const layer = layers.find((l) => l.id === model.userData.layerId)
      model.setEnabled(layer ? layer.visible : true)
      addPlacedModel(model)
    }
  }

  function buildSaveData() {
    return {
      map: map.toJSON(),
      placedObjects: serializePlacedObjects(),
      layers: JSON.parse(JSON.stringify(layers)),
      activeLayerId
    }
  }

  function autoSave() {
    try {
      localStorage.setItem('projectrs-autosave', JSON.stringify(buildSaveData()))
      const prev = statusText.textContent
      statusText.textContent = 'Auto-saved'
      setTimeout(() => { statusText.textContent = prev }, 2000)
    } catch (e) {
      console.warn('Auto-save failed:', e)
    }
  }

  setInterval(autoSave, 15 * 60 * 1000)

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

    saveFileHandle = null

    map = MapData.fromJSON(data.map)
    selectedPlacedObject = null
    selectedPlacedObjects = []
    selectedTexturePlane = null
      selectedTexturePlanes = []
    transformMode = null
    transformStart = null
    transformLift = 0
    movePlaneStart = null
    state.levelHeight = null

    if (data.layers?.length) {
      layers = data.layers
      activeLayerId = data.activeLayerId || layers[0].id
      _layerCount = layers.length
    } else {
      layers = [{ id: 'layer_0', name: 'Layer 1', visible: true }]
      activeLayerId = 'layer_0'
      _layerCount = 1
    }
    refreshLayersPanel()

    await rebuildPlacedObjectsFromData(data.placedObjects || [])

    mapWidthInput.value = map.width
    mapHeightInput.value = map.height
    worldOffsetX.value = map.worldOffset.x
    worldOffsetZ.value = map.worldOffset.z
    applyMapType()
    markTerrainDirty()
    updateSelectionHelper()
    updateToolUI()
  }

  async function importChunk(data, offsetX, offsetZ) {
    if (!data?.map) return
    pushUndoState()

    const src = MapData.fromJSON(data.map)

    // Merge tiles
    for (let z = 0; z < src.height; z++) {
      for (let x = 0; x < src.width; x++) {
        const dx = x + offsetX, dz = z + offsetZ
        if (dx >= 0 && dx < map.width && dz >= 0 && dz < map.height) {
          map.tiles[dz][dx] = JSON.parse(JSON.stringify(src.tiles[z][x]))
        }
      }
    }

    // Merge height vertices
    for (let z = 0; z <= src.height; z++) {
      for (let x = 0; x <= src.width; x++) {
        const dx = x + offsetX, dz = z + offsetZ
        if (dx >= 0 && dx <= map.width && dz >= 0 && dz <= map.height) {
          map.setVertexHeight(dx, dz, src.getVertexHeight(x, z))
        }
      }
    }

    // Add placed objects shifted by offset
    const _importPaths = [...new Set(
      (data.placedObjects || [])
        .map((p) => assetRegistry.find((a) => a.id === p.assetId)?.path)
        .filter(Boolean)
    )]
    await Promise.all(_importPaths.map((path) => loadAssetModel(path).catch(() => {})))

    for (const placed of data.placedObjects || []) {
      const asset = assetRegistry.find((a) => a.id === placed.assetId)
      if (!asset) continue
      const model = await loadAssetModel(asset.path)
      tuneModelLighting(model, asset.path)
      model.position.set(placed.position.x + offsetX, placed.position.y, placed.position.z + offsetZ)
      model.rotation.set(placed.rotation.x, placed.rotation.y, placed.rotation.z)
      model.scale.set(placed.scale.x, placed.scale.y, placed.scale.z)
      model.userData.assetId = asset.id
      model.userData.type = 'asset'
      model.userData.layerId = placed.layerId || activeLayerId
      if (placed.trigger) model.userData.trigger = { ...placed.trigger }
      const _layer = layers.find((l) => l.id === model.userData.layerId)
      model.setEnabled(_layer ? _layer.visible : true)
      addPlacedModel(model)
    }

    markTerrainDirty()
    updateToolUI()
  }

  function captureSnapshot() {
    return {
      map: JSON.parse(JSON.stringify(map.toJSON())),
      placedObjects: serializePlacedObjects()
    }
  }

  async function applySnapshot(snapshot) {
    map = MapData.fromJSON(snapshot.map)
    selectedPlacedObject = null
    selectedPlacedObjects = []
    selectedTexturePlane = null
      selectedTexturePlanes = []
    transformMode = null
    transformStart = null
    transformLift = 0
    movePlaneStart = null
    state.levelHeight = null

    await rebuildPlacedObjectsFromData(snapshot.placedObjects || [])

    mapWidthInput.value = map.width
    mapHeightInput.value = map.height
    markTerrainDirty()
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
            new Vector3(x, h.tl + 0.03, z),
            new Vector3(x + 1, h.br + 0.03, z + 1)
          )
        } else {
          points.push(
            new Vector3(x + 1, h.tr + 0.03, z),
            new Vector3(x, h.bl + 0.03, z + 1)
          )
        }
      }
    }

    // Convert pairs of points to line system segments
    const segments = []
    for (let i = 0; i < points.length; i += 2) {
      segments.push([points[i], points[i + 1]])
    }
    const lines = MeshBuilder.CreateLineSystem('splitLines', { lines: segments }, scene)
    lines.color = new Color3(0, 0, 0)
    lines.alpha = 0.15
    lines.isVisible = state.showSplitLines
    return lines
  }

  function buildTileGrid() {
    const points = []
    const LIFT = 0.04

    for (let z = 0; z < map.height; z++) {
      for (let x = 0; x < map.width; x++) {
        const h = map.getTileCornerHeights(x, z)

        // top edge
        points.push(
          new Vector3(x,     h.tl + LIFT, z),
          new Vector3(x + 1, h.tr + LIFT, z)
        )
        // left edge
        points.push(
          new Vector3(x, h.tl + LIFT, z),
          new Vector3(x, h.bl + LIFT, z + 1)
        )
        // close the bottom and right borders
        if (z === map.height - 1) {
          points.push(
            new Vector3(x,     h.bl + LIFT, z + 1),
            new Vector3(x + 1, h.br + LIFT, z + 1)
          )
        }
        if (x === map.width - 1) {
          points.push(
            new Vector3(x + 1, h.tr + LIFT, z),
            new Vector3(x + 1, h.br + LIFT, z + 1)
          )
        }
      }
    }

    const segments = []
    for (let i = 0; i < points.length; i += 2) {
      segments.push([points[i], points[i + 1]])
    }
    const lines = MeshBuilder.CreateLineSystem('tileGrid', { lines: segments }, scene)
    lines.color = new Color3(1, 1, 1)
    lines.alpha = 0.18
    lines.isVisible = state.showTileGrid
    return lines
  }

  function buildObjectShadowInfluences() {
    // Per-vertex darkening [0..1] driven by proximity to placed objects
    const rows = map.height + 1
    const cols = map.width + 1
    const inf = []
    for (let i = 0; i < rows; i++) inf.push(new Float32Array(cols).fill(1.0))

    for (const obj of placedGroup.getChildren()) {
      let _size
      try {
        const bounds = obj.getHierarchyBoundingVectors(true)
        _size = { x: bounds.max.x - bounds.min.x, y: bounds.max.y - bounds.min.y, z: bounds.max.z - bounds.min.z }
        if (_size.x === 0 && _size.y === 0 && _size.z === 0) continue
      } catch { continue }

      const asset = assetRegistry.find((a) => a.id === obj.userData?.assetId)
      const isModular = asset?.path?.toLowerCase().includes('modular assets') ?? false
      const isTree = asset?.name?.toLowerCase().includes('tree') ?? false

      const footprint = Math.max(_size.x, _size.z) * 0.5
      const shadowR   = footprint + (isTree || isModular ? 2.8 : 1.0)
      const maxDark   = isTree || isModular ? 0.82 : 0.42

      const cx = obj.position.x
      const cz = obj.position.z

      const x0 = Math.max(0,        Math.floor(cx - shadowR))
      const x1 = Math.min(cols - 1, Math.ceil (cx + shadowR))
      const z0 = Math.max(0,        Math.floor(cz - shadowR))
      const z1 = Math.min(rows - 1, Math.ceil (cz + shadowR))

      for (let vz = z0; vz <= z1; vz++) {
        for (let vx = x0; vx <= x1; vx++) {
          const dx   = vx - cx
          const dz   = vz - cz
          const dist = Math.sqrt(dx * dx + dz * dz)
          if (dist >= shadowR) continue

          const t      = 1.0 - dist / shadowR
          const dark   = t * t * maxDark
          const factor = 1.0 - dark
          if (factor < inf[vz][vx]) inf[vz][vx] = factor
        }
      }
    }

    return inf
  }

  function disposeGroup(group) {
    if (!group) return
    group.dispose()
  }

  function rebuildTerrain({ skipTexturePlanes = false, skipShadows = false, skipTextureOverlays = false, _heightsOnlyRegion = null } = {}) {
    // Fast path: only heights changed in a known tile region — update land mesh in-place.
    if (_heightsOnlyRegion) {
      const shadowInf = _shadowInfluencesCache ?? buildObjectShadowInfluences()
      _shadowInfluencesCache = shadowInf
      if (updateTerrainLandHeights(map, shadowInf, _heightsOnlyRegion.x1, _heightsOnlyRegion.z1, _heightsOnlyRegion.x2, _heightsOnlyRegion.z2)) {
        disposeGroup(cliffs)
        cliffs = buildCliffMeshes(map, scene)
        // Rebuild water meshes so water appears immediately during sculpting
        if (terrainGroup) {
          for (const child of [...terrainGroup.getChildMeshes()]) {
            if (child.name === 'terrain-water' || child.name === 'terrain-surface-water') {
              child.dispose()
            }
          }
          const wg = buildWaterMeshes(map, waterTexture, scene)
          for (const child of [...wg.getChildren()]) { child.parent = terrainGroup }
          wg.dispose() // dispose empty group shell
        }
        if (state.showSplitLines) {
          if (splitLines) splitLines.dispose()
          splitLines = buildSplitLines()
        }
        if (state.showTileGrid) {
          if (tileGrid) tileGrid.dispose()
          tileGrid = buildTileGrid()
        }
        applyLayerVisibility()
        return
      }
      // Partial update not available — fall through to full rebuild.
    }

    disposeGroup(terrainGroup)
    disposeGroup(cliffs)
    if (splitLines) splitLines.dispose()
    if (tileGrid) tileGrid.dispose()
    if (!skipTextureOverlays && textureOverlayGroup) { textureOverlayGroup.dispose(); textureOverlayGroup = null }
    if (!skipTexturePlanes && texturePlaneGroup) { texturePlaneGroup.dispose(); texturePlaneGroup = null }

    map.selectedTexturePlaneId = selectedTexturePlane ? selectedTexturePlane.id : null

    if (!skipShadows) _shadowInfluencesCache = null
    const shadowInf = _shadowInfluencesCache ?? buildObjectShadowInfluences()
    _shadowInfluencesCache = shadowInf

    terrainGroup = buildTerrainMeshes(map, waterTexture, shadowInf, scene)
    cliffs = buildCliffMeshes(map, scene)
    splitLines = buildSplitLines()
    tileGrid = buildTileGrid()
    if (!skipTextureOverlays) textureOverlayGroup = buildTextureOverlays(map, textureRegistry, textureCache, scene)

    if (!skipTexturePlanes) {
      texturePlaneGroup = buildTexturePlanes(map, textureRegistry, textureCache, scene)
    }

    updateSelectionHelper()
    applyLayerVisibility()
  }

  function updateTexturePlaneMeshTransform(plane) {
    if (!texturePlaneGroup) return
    const mesh = texturePlaneGroup.getChildMeshes().find((m) => m.userData?.texturePlane === plane)
    if (!mesh) return
    mesh.position.set(plane.position.x, plane.position.y, plane.position.z)
    mesh.rotation.set(plane.rotation?.x ?? 0, plane.rotation?.y ?? 0, plane.rotation?.z ?? 0)
    mesh.scale.set(plane.scale?.x ?? 1, plane.scale?.y ?? 1, plane.scale?.z ?? 1)

  }

  function updateMouse(event) {
    // Update Babylon.js pointer position from the event
    const rect = canvas.getBoundingClientRect()
    scene.pointerX = event.clientX - rect.left
    scene.pointerY = event.clientY - rect.top
  }

  function getTerrainMeshes() {
    const meshes = []
    if (!terrainGroup) return meshes
    for (const child of terrainGroup.getChildMeshes()) meshes.push(child)
    return meshes
  }

  function isTerrainMesh(mesh) {
    return terrainGroup && mesh.isDescendantOf(terrainGroup)
  }

  function pickTerrainPoint(event) {
    updateMouse(event)
    const pick = scene.pick(scene.pointerX, scene.pointerY, (mesh) => isTerrainMesh(mesh))
    if (!pick.hit) return null
    return pick.pickedPoint.clone()
  }

  function pickHorizontalPlane(event, y = 0) {
    updateMouse(event)
    const ray = scene.createPickingRay(scene.pointerX, scene.pointerY, Matrix.Identity(), camera)
    if (Math.abs(ray.direction.y) < 0.0001) return null
    const t = -(ray.origin.y - y) / ray.direction.y
    if (t < 0) return null
    return new Vector3(
      ray.origin.x + ray.direction.x * t,
      y,
      ray.origin.z + ray.direction.z * t
    )
  }

  function pickSurfacePoint(event, excludeObjects = []) {
    updateMouse(event)
    const ray = scene.createPickingRay(scene.pointerX, scene.pointerY, Matrix.Identity(), camera)

    // Pick terrain
    const terrainPick = scene.pickWithRay(ray, (mesh) => isTerrainMesh(mesh))

    // Pick placed objects (filter upward-facing)
    const placedPick = scene.pickWithRay(ray, (mesh) => {
      if (!mesh.isDescendantOf(placedGroup)) return false
      if (!mesh.isVisible) return false
      // Walk up to find root placed object
      let node = mesh
      while (node.parent && node.parent !== placedGroup) node = node.parent
      return !excludeObjects.includes(node)
    })

    // Pick texture planes
    const planePick = texturePlaneGroup ? scene.pickWithRay(ray, (mesh) => {
      return mesh.isDescendantOf(texturePlaneGroup) && mesh.isVisible
    }) : null

    // Find closest hit with upward-facing normal
    const candidates = []
    if (terrainPick?.hit) candidates.push(terrainPick)
    if (placedPick?.hit) {
      const n = placedPick.getNormal(true)
      if (n && n.y > 0.5) candidates.push(placedPick)
    }
    if (planePick?.hit) {
      const n = planePick.getNormal(true)
      if (n && n.y > 0.5) candidates.push(planePick)
    }

    candidates.sort((a, b) => a.distance - b.distance)
    return candidates.length > 0 ? candidates[0].pickedPoint.clone() : null
  }

  function pickTile(event) {
    const p = pickTerrainPoint(event)
    if (!p) return null

    const x = Math.floor(p.x)
    const z = Math.floor(p.z)

    if (x < 0 || z < 0 || x >= map.width || z >= map.height) return null
    return { x, z, u: p.x - x, v: p.z - z }
  }

  function pickPlacedObject(event) {
    updateMouse(event)
    const pick = scene.pick(scene.pointerX, scene.pointerY, (mesh) => {
      return mesh.isDescendantOf(placedGroup) && mesh.isVisible
    })
    if (!pick.hit) return null

    let obj = pick.pickedMesh
    while (obj.parent && obj.parent !== placedGroup) obj = obj.parent
    return obj
  }

  async function importMapAtOffset(data, offsetX, offsetZ) {
  const imported = MapData.fromJSON(data)
  pushUndoState()

  // copy tiles
  for (let z = 0; z < imported.height; z++) {
    for (let x = 0; x < imported.width; x++) {
      const dstTile = map.getTile(x + offsetX, z + offsetZ)
      const srcTile = imported.getTile(x, z)
      if (!dstTile || !srcTile) continue

      map.tiles[z + offsetZ][x + offsetX] = JSON.parse(JSON.stringify(srcTile))
    }
  }

  // copy height vertices
  for (let z = 0; z <= imported.height; z++) {
    for (let x = 0; x <= imported.width; x++) {
      const dstX = x + offsetX
      const dstZ = z + offsetZ

      if (dstX < 0 || dstZ < 0 || dstX > map.width || dstZ > map.height) continue
      map.heights[dstZ][dstX] = imported.heights[z][x]
    }
  }

  // import texture planes
  for (const plane of imported.texturePlanes || []) {
    const clone = JSON.parse(JSON.stringify(plane))
    clone.id = `plane_${Date.now()}_${Math.floor(Math.random() * 100000)}`
    clone.position.x += offsetX
    clone.position.z += offsetZ
    map.texturePlanes.push(clone)
  }

  // import placed objects — pre-load unique models in parallel first
  const _mergeUniquePaths = [...new Set(
    (data.placedObjects || [])
      .map((p) => assetRegistry.find((a) => a.id === p.assetId)?.path)
      .filter(Boolean)
  )]
  await Promise.all(_mergeUniquePaths.map((path) => loadAssetModel(path).catch(() => {})))

  for (const placed of data.placedObjects || []) {
    const asset = assetRegistry.find((a) => a.id === placed.assetId)
    if (!asset) continue

    const model = await loadAssetModel(asset.path)
    tuneModelLighting(model, asset.path)

    model.position.set(
      placed.position.x + offsetX,
      placed.position.y,
      placed.position.z + offsetZ
    )
    model.rotation.set(placed.rotation.x, placed.rotation.y, placed.rotation.z)
    model.scale.set(placed.scale.x, placed.scale.y, placed.scale.z)
    model.userData.assetId = asset.id
    model.userData.type = 'asset'
    model.userData.layerId = placed.layerId || activeLayerId
    const _importLayer = layers.find((l) => l.id === model.userData.layerId)
    model.setEnabled(_importLayer ? _importLayer.visible : true)
    addPlacedModel(model)
  }

  markTerrainDirty()
  updateSelectionHelper()
  updateToolUI()
}

  function pickTexturePlane(event) {
    if (!texturePlaneGroup) return null
    updateMouse(event)
    const pick = scene.pick(scene.pointerX, scene.pointerY, (mesh) => {
      return mesh.isDescendantOf(texturePlaneGroup) && mesh.isVisible
    })
    return pick.hit ? pick.pickedMesh : null
  }

  // Returns { type: 'placed'|'plane', object, distance } for whichever is closest to camera
  function pickClosestSelectTarget(event) {
    updateMouse(event)
    const ray = scene.createPickingRay(scene.pointerX, scene.pointerY, Matrix.Identity(), camera)

    const placedPick = scene.pickWithRay(ray, (mesh) => {
      return mesh.isDescendantOf(placedGroup) && mesh.isVisible
    })

    const planePick = texturePlaneGroup ? scene.pickWithRay(ray, (mesh) => {
      return mesh.isDescendantOf(texturePlaneGroup) && mesh.isVisible
    }) : null

    const bestPlaced = placedPick?.hit ? placedPick : null
    const bestPlane = planePick?.hit ? planePick : null

    if (!bestPlaced && !bestPlane) return null

    if (bestPlaced && (!bestPlane || bestPlaced.distance <= bestPlane.distance)) {
      let obj = bestPlaced.pickedMesh
      while (obj.parent && obj.parent !== placedGroup) obj = obj.parent
      return { type: 'placed', object: obj, distance: bestPlaced.distance }
    }

    return { type: 'plane', object: bestPlane.pickedMesh, distance: bestPlane.distance }
  }

  function tileWorldPosition(x, z) {
    return new Vector3(
      x + 0.5,
      map.getAverageTileHeight(x, z),
      z + 0.5
    )
  }

  function getTexturePlaneSize(textureId) {
    return { width: 1, height: 1 }
  }

  function getPlaneFootprint(plane) {
    return {
      width: (plane.width || 1) * (plane.scale?.x ?? 1),
      depth: Math.max(0.1, plane.scale?.z ?? 0.1),
      height: (plane.height || 1) * (plane.scale?.y ?? 1)
    }
  }

  function getObjectFootprint(object) {
    const bounds = object.getHierarchyBoundingVectors(true)
    const sizeX = bounds.max.x - bounds.min.x
    const sizeY = bounds.max.y - bounds.min.y
    const sizeZ = bounds.max.z - bounds.min.z
    return {
      width: Math.max(sizeX, 0.1),
      depth: Math.max(sizeZ, 0.1),
      height: Math.max(sizeY, 0.1)
    }
  }

  function scaleObjectToTiles(obj, tiles) {
    const prevYScale = obj.scaling?.y ?? obj.scale?.y ?? 1
    if (obj.scaling) obj.scaling.set(1, 1, 1)
    else if (obj.scale) obj.scale.set(1, 1, 1)
    obj.computeWorldMatrix?.(true)
    try {
      const bounds = obj.getHierarchyBoundingVectors(true)
      const naturalLength = Math.max(bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z)
      if (naturalLength < 0.001) {
        if (obj.scaling) obj.scaling.set(1, prevYScale, 1)
        else if (obj.scale) obj.scale.set(1, prevYScale, 1)
        return
      }
      const s = tiles / naturalLength
      if (obj.scaling) obj.scaling.set(s, prevYScale, s)
      else if (obj.scale) obj.scale.set(s, prevYScale, s)
      obj.computeWorldMatrix?.(true)
    } catch {
      if (obj.scaling) obj.scaling.set(1, prevYScale, 1)
      else if (obj.scale) obj.scale.set(1, prevYScale, 1)
    }
  }

  function snapValue(value, step = 0.5) {
    return Math.round(value / step) * step
  }

  function snapThingPositionToGrid(position, step = 0.5) {
    position.x = snapValue(position.x, step)
    position.z = snapValue(position.z, step)
  }

  function isStoneModularAsset(asset) {
    const p = asset?.path?.toLowerCase() ?? ''
    return p.includes('stone modular') || p.includes('dark stone modular') || p.includes('wood modular')
  }

  function isModularAsset(assetId) {
    const asset = assetRegistry.find((a) => a.id === assetId)
    return asset?.path?.toLowerCase().includes('modular assets') ?? false
  }

  function findModularEdgeSnap(movingObj, targetX, targetZ) {
    const THRESHOLD = 0.65

    // Local extents relative to the object's position (constant while translating)
    const movingBounds = movingObj.getHierarchyBoundingVectors(true)
    const lMinX = movingBounds.min.x - movingObj.position.x
    const lMaxX = movingBounds.max.x - movingObj.position.x
    const lMinZ = movingBounds.min.z - movingObj.position.z
    const lMaxZ = movingBounds.max.z - movingObj.position.z

    // Predicted bbox at target position
    const tMinX = targetX + lMinX
    const tMaxX = targetX + lMaxX
    const tMinZ = targetZ + lMinZ
    const tMaxZ = targetZ + lMaxZ

    let bestX = null, bestZ = null
    let bestDX = THRESHOLD, bestDZ = THRESHOLD

    for (const other of placedGroup.getChildren()) {
      if (selectedPlacedObjects.includes(other)) continue
      if (!isModularAsset(other.userData?.assetId)) continue

      let ob
      try { const b = other.getHierarchyBoundingVectors(true); ob = { min: b.min, max: b.max } } catch { continue }

      // X: my left→other right, my right→other left, center align
      for (const [d, snap] of [
        [Math.abs(tMinX - ob.max.x), ob.max.x - lMinX],
        [Math.abs(tMaxX - ob.min.x), ob.min.x - lMaxX],
        [Math.abs(targetX - other.position.x), other.position.x],
      ]) {
        if (d < bestDX) { bestDX = d; bestX = snap }
      }

      // Z: my front→other back, my back→other front, center align
      for (const [d, snap] of [
        [Math.abs(tMinZ - ob.max.z), ob.max.z - lMinZ],
        [Math.abs(tMaxZ - ob.min.z), ob.min.z - lMaxZ],
        [Math.abs(targetZ - other.position.z), other.position.z],
      ]) {
        if (d < bestDZ) { bestDZ = d; bestZ = snap }
      }
    }

    // Fall back to 1-unit grid if no nearby object edge found
    return {
      x: bestX ?? snapValue(targetX, 1.0),
      z: bestZ ?? snapValue(targetZ, 1.0)
    }
  }

  function getRightVector(rotY) {
    return {
      x: Math.cos(rotY),
      z: -Math.sin(rotY)
    }
  }

  function getForwardVector(rotY) {
    return {
      x: Math.sin(rotY),
      z: Math.cos(rotY)
    }
  }

  function snapSelectedThingNow() {
    if (selectedTexturePlane) {
      snapThingPositionToGrid(selectedTexturePlane.position, 0.5)
      markTerrainDirty()
      updateSelectionHelper()
      updateToolUI()
      return
    }

    if (selectedPlacedObject) {
      const step = isModularAsset(selectedPlacedObject.userData.assetId) ? 1.0 : 0.5
      selectedPlacedObject.position.x = snapValue(selectedPlacedObject.position.x, step)
      selectedPlacedObject.position.z = snapValue(selectedPlacedObject.position.z, step)
      updateSelectionHelper()
      updateToolUI()
    }
  }

  function snapPlaneFlushAlong(sourcePlane, targetPlane, direction = 'right') {
    const source = getPlaneFootprint(sourcePlane)
    const target = getPlaneFootprint(targetPlane)
    const rotY = targetPlane.rotation.y || 0

    const isForward = direction === 'forward' || direction === 'back'
    const sign = (direction === 'left' || direction === 'back') ? -1 : 1
    const vec = isForward ? getForwardVector(rotY) : getRightVector(rotY)
    const spacing = isForward
      ? (source.depth + target.depth) * 0.5
      : (source.width + target.width) * 0.5

    sourcePlane.position.x = targetPlane.position.x + vec.x * spacing * sign
    sourcePlane.position.z = targetPlane.position.z + vec.z * spacing * sign
    sourcePlane.position.y = targetPlane.position.y
  }

  function stackPlaneAbove(sourcePlane, targetPlane) {
    const source = getPlaneFootprint(sourcePlane)
    const target = getPlaneFootprint(targetPlane)
    sourcePlane.position.x = targetPlane.position.x
    sourcePlane.position.z = targetPlane.position.z
    sourcePlane.position.y = targetPlane.position.y + (target.height + source.height) * 0.5
  }


  function findTexturePlaneTopAt(event) {
    if (!texturePlaneGroup) return null
    updateMouse(event)
    const pick = scene.pick(scene.pointerX, scene.pointerY, (mesh) => {
      return mesh.isDescendantOf(texturePlaneGroup) && mesh.isVisible
    })
    if (pick.hit) {
      const n = pick.getNormal(true)
      if (n && n.y > 0.5) return pick.pickedPoint.y
    }
    return null
  }

  function findObjectTopAt(worldX, worldZ, excludeObjects = []) {
    const MARGIN = 0.4
    let bestTop = null
    const candidates = _spatialNearby(worldX, worldZ, SPATIAL_CELL * 2)
    for (const obj of candidates) {
      if (excludeObjects.includes(obj)) continue
      if (obj.isEnabled && !obj.isEnabled()) continue

      // Use static bounds from load time to avoid animated sub-meshes inflating the box
      const bounds = obj.userData.bounds
      if (bounds) {
        const halfW = (bounds.width  * obj.scale.x) * 0.5 + MARGIN
        const halfD = (bounds.depth  * obj.scale.z) * 0.5 + MARGIN
        const top   =  obj.position.y + bounds.height * obj.scale.y
        if (
          worldX >= obj.position.x - halfW && worldX <= obj.position.x + halfW &&
          worldZ >= obj.position.z - halfD && worldZ <= obj.position.z + halfD &&
          (bestTop === null || top > bestTop)
        ) {
          bestTop = top
        }
      } else {
        obj.computeWorldMatrix(true)
        const _b = obj.getHierarchyBoundingVectors(true)
        const box = { min: _b.min, max: _b.max }
        if (box.min.x === box.max.x && box.min.y === box.max.y) continue
        if (
          worldX >= box.min.x - MARGIN && worldX <= box.max.x + MARGIN &&
          worldZ >= box.min.z - MARGIN && worldZ <= box.max.z + MARGIN &&
          (bestTop === null || box.max.y > bestTop)
        ) {
          bestTop = box.max.y
        }
      }
    }
    return bestTop
  }

  function findNearbyPlaneSnap(movingPlane, worldX, worldZ) {
    const SNAP_DIST = 0.5
    const movingFP = getPlaneFootprint(movingPlane)
    const movingRotY = movingPlane.rotation?.y || 0

    let best = null
    let bestDist = SNAP_DIST

    for (const plane of map.texturePlanes) {
      if (plane === movingPlane) continue
      if (!plane.vertical || !movingPlane.vertical) continue

      const targetFP = getPlaneFootprint(plane)
      const rotY = plane.rotation?.y || 0

      const rotDiff = ((movingRotY - rotY) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2)
      const aligned = rotDiff < 0.26 || rotDiff > (Math.PI * 2 - 0.26)
      if (!aligned) continue

      const right = getRightVector(rotY)
      const halfSpan = (targetFP.width + movingFP.width) * 0.5

      const candidates = [
        { x: plane.position.x + right.x * halfSpan, z: plane.position.z + right.z * halfSpan, y: plane.position.y },
        { x: plane.position.x - right.x * halfSpan, z: plane.position.z - right.z * halfSpan, y: plane.position.y }
      ]

      for (const c of candidates) {
        const dist = Math.sqrt((worldX - c.x) ** 2 + (worldZ - c.z) ** 2)
        if (dist < bestDist) {
          bestDist = dist
          best = c
        }
      }
    }

    return best
  }

  function snapObjectFlushAlongPosition(basePosition, baseRotationY, targetFootprint, sourceFootprint, direction = 'right') {
    const isForward = direction === 'forward' || direction === 'back'
    const sign = (direction === 'left' || direction === 'back') ? -1 : 1
    const vec = isForward ? getForwardVector(baseRotationY) : getRightVector(baseRotationY)

    // Project AABB extents onto the movement direction so spacing is correct at any rotation
    const ax = Math.abs(vec.x), az = Math.abs(vec.z)
    const targetExtent = ax * targetFootprint.width + az * targetFootprint.depth
    const sourceExtent = ax * sourceFootprint.width + az * sourceFootprint.depth
    const spacing = (targetExtent + sourceExtent) * 0.5

    return new Vector3(
      basePosition.x + vec.x * spacing * sign,
      basePosition.y,
      basePosition.z + vec.z * spacing * sign
    )
  }

  function snapAngleToQuarterIfClose(angle, threshold = 0.12) {
    const quarterTurn = Math.PI / 2
    const nearestQuarter = Math.round(angle / quarterTurn) * quarterTurn
    return Math.abs(angle - nearestQuarter) < threshold ? nearestQuarter : angle
  }

  function applyRotationSnapOnConfirm() {
    if (selectedTexturePlane) {
      selectedTexturePlane.rotation.x = snapAngleToQuarterIfClose(selectedTexturePlane.rotation.x)
      selectedTexturePlane.rotation.y = snapAngleToQuarterIfClose(selectedTexturePlane.rotation.y)
      selectedTexturePlane.rotation.z = snapAngleToQuarterIfClose(selectedTexturePlane.rotation.z)
      markTerrainDirty()
    }

    if (selectedPlacedObject) {
      for (const obj of selectedPlacedObjects) {
        obj.rotation.x = snapAngleToQuarterIfClose(obj.rotation.x)
        obj.rotation.y = snapAngleToQuarterIfClose(obj.rotation.y)
        obj.rotation.z = snapAngleToQuarterIfClose(obj.rotation.z)
      }
      updateSelectionHelper()
    }
  }

// Gaussian vertex brush — operates on individual height vertices for smooth hills
function applyGaussianBrush(centerX, centerZ, delta, radius, sigma) {
  radius = radius ?? brushRadius
  sigma = sigma ?? radius * 0.47

  const minX = Math.max(0, Math.floor(centerX - radius))
  const maxX = Math.min(map.width, Math.ceil(centerX + radius))
  const minZ = Math.max(0, Math.floor(centerZ - radius))
  const maxZ = Math.min(map.height, Math.ceil(centerZ + radius))

  for (let vz = minZ; vz <= maxZ; vz++) {
    for (let vx = minX; vx <= maxX; vx++) {
      const dx = vx - centerX
      const dz = vz - centerZ
      const weight = Math.exp(-(dx * dx + dz * dz) / (2 * sigma * sigma))
      if (weight > 0.005) {
        map.adjustVertexHeight(vx, vz, delta * weight)
      }
    }
  }
}

// Laplacian smooth — blends each vertex toward the average of its neighbours
function applySmoothBrush(centerX, centerZ, strength = 0.55) {
  const radius = brushRadius
  const sigma = radius * 0.47

  const minX = Math.max(0, Math.floor(centerX - radius))
  const maxX = Math.min(map.width, Math.ceil(centerX + radius))
  const minZ = Math.max(0, Math.floor(centerZ - radius))
  const maxZ = Math.min(map.height, Math.ceil(centerZ + radius))

  // First pass: compute Laplacian target for each vertex in range
  const targets = new Map()
  for (let vz = minZ; vz <= maxZ; vz++) {
    for (let vx = minX; vx <= maxX; vx++) {
      let sum = 0, count = 0
      for (const [dx, dz] of [[-1,0],[1,0],[0,-1],[0,1]]) {
        const nx = vx + dx, nz = vz + dz
        if (nx < 0 || nx > map.width || nz < 0 || nz > map.height) continue
        sum += map.getVertexHeight(nx, nz)
        count++
      }
      targets.set(`${vx},${vz}`, count > 0 ? sum / count : map.getVertexHeight(vx, vz))
    }
  }

  // Second pass: blend toward target weighted by Gaussian distance from center
  for (let vz = minZ; vz <= maxZ; vz++) {
    for (let vx = minX; vx <= maxX; vx++) {
      const dx = vx - centerX
      const dz = vz - centerZ
      const weight = Math.exp(-(dx * dx + dz * dz) / (2 * sigma * sigma))
      if (weight < 0.005) continue
      const current = map.getVertexHeight(vx, vz)
      const target = targets.get(`${vx},${vz}`)
      map.setVertexHeight(vx, vz, current + (target - current) * weight * strength)
    }
  }
}

function captureStrokeHistoryOnce() {
  if (!state.historyCapturedThisStroke) {
    pushUndoState()
    state.historyCapturedThisStroke = true
  }
}


function applyToolAtTile(tile, eventLike = null) {
  if (!tile) return

  if (state.tool === ToolMode.TERRAIN) {
    captureStrokeHistoryOnce()

    if (state.smoothMode) {
      applySmoothBrush(tile.x + 0.5, tile.z + 0.5, 0.3)
      const _r = Math.ceil(brushRadius)
      markTerrainDirty({ skipTexturePlanes: true, skipShadows: true, skipTextureOverlays: true, heightsOnly: true, region: { x1: tile.x - _r, z1: tile.z - _r, x2: tile.x + _r, z2: tile.z + _r } })
      return
    }

    if (state.levelMode) {
      if (state.levelHeight === null) {
        state.levelHeight = map.getAverageTileHeight(tile.x, tile.z)
        updateToolUI()
      }

      map.flattenTileToHeight(tile.x, tile.z, state.levelHeight)
      markTerrainDirty({ skipTexturePlanes: true, skipShadows: true, skipTextureOverlays: true, heightsOnly: true, region: { x1: tile.x, z1: tile.z, x2: tile.x, z2: tile.z } })
      return
    }

    if (brushRadius < 0.6) {
      // Minimum brush: affect only the 4 corners of the exact tile
      const delta = eventLike?.shiftKey ? -0.20 : 0.20
      if (eventLike?.ctrlKey) {
        map.flattenTile(tile.x, tile.z)
      } else {
        map.adjustVertexHeight(tile.x,     tile.z,     delta)
        map.adjustVertexHeight(tile.x + 1, tile.z,     delta)
        map.adjustVertexHeight(tile.x,     tile.z + 1, delta)
        map.adjustVertexHeight(tile.x + 1, tile.z + 1, delta)
      }
    } else if (eventLike?.ctrlKey) {
      applySmoothBrush(tile.x + 0.5, tile.z + 0.5)
    } else if (eventLike?.shiftKey) {
      applyGaussianBrush(tile.x + 0.5, tile.z + 0.5, -0.20)
    } else {
      applyGaussianBrush(tile.x + 0.5, tile.z + 0.5, 0.20)
    }

    const _r = Math.ceil(brushRadius)
    markTerrainDirty({ skipTexturePlanes: true, skipShadows: true, skipTextureOverlays: true, heightsOnly: true, region: { x1: tile.x - _r, z1: tile.z - _r, x2: tile.x + _r, z2: tile.z + _r } })
    return
  }

  if (state.tool === ToolMode.PAINT) {
    captureStrokeHistoryOnce()

    if (state.paintType === 'surface-water') {
      if (eventLike?.shiftKey) {
        map.clearWaterSurface(tile.x, tile.z)
      } else {
        map.paintWaterSurface(tile.x, tile.z)
      }
      markTerrainDirty({ skipTexturePlanes: true, skipShadows: true, skipTextureOverlays: true })
      return
    }

    if (eventLike?.shiftKey || paintTabTextureId) {
      const isErase = eventLike?.shiftKey || paintTabTextureId === '__erase__'
      if (state.halfPaint && paintTabTextureIdB && !isErase) {
        // Both slots set: one click paints A on first half, B on second half
        map.paintTextureTileFirst(tile.x, tile.z, paintTabTextureId, textureRotation, textureScale)
        map.paintTextureTileSecond(tile.x, tile.z, paintTabTextureIdB, textureRotation, textureScale)
      } else if (state.halfPaint) {
        // Single slot or erase: paint/erase whichever half the cursor is on
        const tileData = map.getTile(tile.x, tile.z)
        const splitDir = tileData?.split || 'forward'
        const u = tile.u ?? 0.5
        const v = tile.v ?? 0.5
        const isFirst = splitDir === 'forward' ? (u + v < 1) : (v >= u)
        if (isFirst) {
          if (isErase) map.clearTextureTileFirst(tile.x, tile.z)
          else map.paintTextureTileFirst(tile.x, tile.z, paintTabTextureId, textureRotation, textureScale)
        } else {
          if (isErase) map.clearTextureTileSecond(tile.x, tile.z)
          else map.paintTextureTileSecond(tile.x, tile.z, paintTabTextureId, textureRotation, textureScale)
        }
      } else {
        if (isErase) map.clearTextureTile(tile.x, tile.z)
        else map.paintTextureTile(tile.x, tile.z, paintTabTextureId, textureRotation, textureScale, textureWorldUV)
      }
      markTerrainDirty({ skipTexturePlanes: true, skipShadows: true })
      return
    }

    if (state.paintType === 'water') {
      map.paintWaterTile(tile.x, tile.z)
    } else if (state.halfPaint) {
      const tileData = map.getTile(tile.x, tile.z)
      const splitDir = tileData?.split || 'forward'
      const u = tile.u ?? 0.5
      const v = tile.v ?? 0.5
      const isFirst = splitDir === 'forward' ? (u + v < 1) : (v >= u)
      if (isFirst) map.paintTileFirst(tile.x, tile.z, state.paintType)
      else map.paintTileSecond(tile.x, tile.z, state.paintType)
    } else {
      map.paintTile(tile.x, tile.z, state.paintType)
    }

    markTerrainDirty({ skipTexturePlanes: true, skipShadows: true, skipTextureOverlays: true })
    return
  }

}

  // Returns the nearest tile-edge center {x, z} for wall placement based on cursor u/v
  // Walls snap 0.25 tiles inward from the chosen edge so the wall body sits inside
  // the tile with its outer face roughly flush at the tile boundary.
  function getWallEdgeSnap(hovered) {
    if (!hovered) return null
    const { x, z, u = 0.5, v = 0.5 } = hovered
    const dL = u, dR = 1 - u, dT = v, dB = 1 - v
    const min = Math.min(dL, dR, dT, dB)
    if (min === dL) return { x: x + 0.25, z: z + 0.5 }
    if (min === dR) return { x: x + 0.75, z: z + 0.5 }
    if (min === dT) return { x: x + 0.5,  z: z + 0.25 }
    return                 { x: x + 0.5,  z: z + 0.75 }
  }

  function updateHoverEdgeHelper() {
    if (hoverEdgeHelper) { hoverEdgeHelper.dispose(); hoverEdgeHelper = null }

    if (state.tool !== ToolMode.PLACE) return
    const asset = assetRegistry.find((a) => a.id === selectedAssetId)
    if (!asset?.name?.toLowerCase().includes('wall')) return

    const hovered = state.hovered
    if (hovered == null) return
    const { x, z, u = 0.5, v = 0.5 } = hovered
    const h = map.getTileCornerHeights(x, z)

    // Marker positions match the inset snap positions
    const edges = [
      { px: x + 0.25, pz: z + 0.5,  ht: (h.tl * 0.75 + h.tr * 0.25 + h.bl * 0.75 + h.br * 0.25) * 0.5 },
      { px: x + 0.75, pz: z + 0.5,  ht: (h.tl * 0.25 + h.tr * 0.75 + h.bl * 0.25 + h.br * 0.75) * 0.5 },
      { px: x + 0.5,  pz: z + 0.25, ht: (h.tl * 0.75 + h.tr * 0.75 + h.bl * 0.25 + h.br * 0.25) * 0.5 },
      { px: x + 0.5,  pz: z + 0.75, ht: (h.tl * 0.25 + h.tr * 0.25 + h.bl * 0.75 + h.br * 0.75) * 0.5 },
    ]
    const dists = [u, 1 - u, v, 1 - v]
    const nearestIdx = dists.indexOf(Math.min(...dists))

    const group = new TransformNode('hoverEdge', scene)
    const S = 0.22

    for (let i = 0; i < 4; i++) {
      const { px, pz, ht } = edges[i]
      const y = ht + 0.06
      const active = i === nearestIdx
      const c = active ? new Color3(0.33, 0.67, 1.0) : new Color3(0.13, 0.33, 0.67)
      const alpha = active ? 1.0 : 0.45
      const segs = [
        [new Vector3(px - S, y, pz), new Vector3(px + S, y, pz)],
        [new Vector3(px, y, pz - S), new Vector3(px, y, pz + S)],
      ]
      const linesMesh = MeshBuilder.CreateLineSystem(`edgeLine_${i}`, { lines: segs }, scene)
      linesMesh.color = c
      linesMesh.alpha = alpha
      linesMesh.parent = group
    }

    hoverEdgeHelper = group
  }

  async function updatePreviewObject() {
    if (previewObject) {
      previewObject.dispose()
      previewObject = null
    }

    if (state.tool !== ToolMode.PLACE || !selectedAssetId) return

    const asset = assetRegistry.find((a) => a.id === selectedAssetId)
    if (!asset) return

    const model = await loadAssetModel(asset.path)
    tuneModelLighting(model, asset.path)

    if (isStoneModularAsset(asset)) {
      model.scale.y = 1
    }

    previewObject = makeGhostMaterial(model)
    previewObject.rotation.y = previewRotation
    previewObject.userData.assetId = asset.id
    // previewObject is already in the scene from makeGhostMaterial

    const pos = tileWorldPosition(state.hovered.x, state.hovered.z)
    if (asset.name?.toLowerCase().includes('wall')) {
      const snap = getWallEdgeSnap(state.hovered)
      if (snap) { pos.x = snap.x; pos.z = snap.z }
    }
    previewObject.position.copyFrom(pos)
  }

  async function placeSelectedAsset(tile, event) {
    if (!selectedAssetId) return

    const asset = assetRegistry.find((a) => a.id === selectedAssetId)
    if (!asset) return

    const model = await loadAssetModel(asset.path)
    tuneModelLighting(model, asset.path)

    if (isStoneModularAsset(asset)) {
      model.scale.y = 1
    }

    pushUndoState()

    const pos = tileWorldPosition(tile.x, tile.z)
    if (asset.name?.toLowerCase().includes('wall')) {
      const snap = getWallEdgeSnap(tile)
      if (snap) { pos.x = snap.x; pos.z = snap.z }
    }
    if (event) {
      const sp = pickSurfacePoint(event)
      if (sp) {
        pos.y = sp.y
        if (asset.path?.toLowerCase().includes('tree')) {
          pos.x = Math.round(sp.x)
          pos.z = Math.round(sp.z)
        }
      }
    }
    if (asset.path?.toLowerCase().includes('tree')) {
      pos.x = Math.round(pos.x)
      pos.z = Math.round(pos.z)
    }
    model.position.copyFrom(pos)
    model.rotation.y = previewRotation
    model.userData.assetId = asset.id
    model.userData.type = 'asset'
    model.userData.layerId = activeLayerId
    addPlacedModel(model)
    markTerrainDirty({ skipTexturePlanes: true })
  }

  function replaceSelectedTexturesWith(textureId) {
    if (!selectedTexturePlanes.length) return
    pushUndoState()
    for (const plane of selectedTexturePlanes) {
      plane.textureId = textureId
    }
    markTerrainDirty()
    updateSelectionHelper()
    updateToolUI()
  }

  async function replaceSelectedWith(assetId) {
    if (!selectedPlacedObjects.length) return
    const newAsset = assetRegistry.find((a) => a.id === assetId)
    if (!newAsset) return
    pushUndoState()
    const replacements = []
    for (const obj of [...selectedPlacedObjects]) {
      const model = await loadAssetModel(newAsset.path)
      tuneModelLighting(model, newAsset.path)
      model.position.copyFrom(obj.position)
      model.rotation.copyFrom(obj.rotation)
      model.scale.copyFrom(obj.scale)
      model.userData.assetId = newAsset.id
      model.userData.type = 'asset'
      model.userData.layerId = obj.userData.layerId || activeLayerId
      const _rLayer = layers.find((l) => l.id === model.userData.layerId)
      model.setEnabled(_rLayer ? _rLayer.visible : true)
      removePlacedModel(obj)
      addPlacedModel(model)
      replacements.push(model)
    }
    selectedPlacedObjects = replacements
    selectedPlacedObject = replacements[replacements.length - 1] || null
    markTerrainDirty()
    updateSelectionHelper()
    updateToolUI()
  }

  async function duplicateSelected(mode = 'right') {
    pushUndoState()

    if (selectedTexturePlane) {
      if (selectedTexturePlanes.length > 1) {
        // Compute offset from primary plane then apply it to all
        let offsetX = 0, offsetZ = 0, offsetY = 0
        if (mode !== 'stack') {
          const primaryClone = JSON.parse(JSON.stringify(selectedTexturePlane))
          if (mode === 'forward' || mode === 'back') {
            snapPlaneFlushAlong(primaryClone, selectedTexturePlane, mode)
          } else {
            snapPlaneFlushAlong(primaryClone, selectedTexturePlane, mode === 'left' ? 'left' : 'right')
          }
          offsetX = primaryClone.position.x - selectedTexturePlane.position.x
          offsetZ = primaryClone.position.z - selectedTexturePlane.position.z
          offsetY = primaryClone.position.y - selectedTexturePlane.position.y
        }

        const newPlanes = []
        for (const src of selectedTexturePlanes) {
          const clone = JSON.parse(JSON.stringify(src))
          clone.id = `plane_${Date.now()}_${Math.floor(Math.random() * 100000)}`
          if (mode === 'stack') {
            stackPlaneAbove(clone, src)
          } else {
            clone.position.x = src.position.x + offsetX
            clone.position.z = src.position.z + offsetZ
            clone.position.y = src.position.y + offsetY
          }
          map.texturePlanes.push(clone)
          newPlanes.push(clone)
        }

        selectedTexturePlanes = newPlanes
        selectedTexturePlane = newPlanes[newPlanes.length - 1]
        selectedPlacedObject = null
        markTerrainDirty()
        updateSelectionHelper()
        updateToolUI()
        return
      }

      const clone = JSON.parse(JSON.stringify(selectedTexturePlane))
      clone.id = `plane_${Date.now()}_${Math.floor(Math.random() * 100000)}`

      if (mode === 'stack') {
        stackPlaneAbove(clone, selectedTexturePlane)
      } else {
        snapPlaneFlushAlong(clone, selectedTexturePlane, mode === 'forward' || mode === 'back' ? mode : (mode === 'left' ? 'left' : 'right'))
      }

      map.texturePlanes.push(clone)
      selectedTexturePlane = clone
      selectedTexturePlanes = [clone]
      selectedPlacedObject = null
      markTerrainDirty()
      updateSelectionHelper()
      updateToolUI()
      return
    }

    if (selectedPlacedObjects.length > 1) {
      let offsetVec = new Vector3()

      if (mode !== 'stack') {
        const primaryFootprint = getObjectFootprint(selectedPlacedObject)
        const newPos = snapObjectFlushAlongPosition(
          selectedPlacedObject.position,
          selectedPlacedObject.rotation.y,
          primaryFootprint,
          primaryFootprint,
          ['forward','back'].includes(mode) ? mode : (mode === 'left' ? 'left' : 'right')
        )
        offsetVec = newPos.subtract(selectedPlacedObject.position)
      }

      const newModels = []
      for (const src of selectedPlacedObjects) {
        if (!src.userData?.assetId) continue
        const asset = assetRegistry.find((a) => a.id === src.userData.assetId)
        if (!asset) continue

        const model = await loadAssetModel(asset.path)
        tuneModelLighting(model, asset.path)
        model.rotation.copyFrom(src.rotation)
        model.scale.copyFrom(src.scale)
        model.userData.assetId = asset.id
        model.userData.type = 'asset'
        model.userData.layerId = src.userData.layerId || activeLayerId
        addPlacedModel(model)
        model.computeWorldMatrix(true)

        if (mode === 'stack') {
          const srcFootprint = getObjectFootprint(src)
          const cloneFootprint = getObjectFootprint(model)
          model.position.copyFrom(src.position)
          model.position.y += (srcFootprint.height + cloneFootprint.height) * 0.5
        } else {
          model.position.copyFrom(src.position.add(offsetVec))
        }

        newModels.push(model)
      }

      if (newModels.length > 0) {
        selectedPlacedObject = newModels[0]
        selectedPlacedObjects = [...newModels]
        selectedTexturePlane = null
      selectedTexturePlanes = []
        markTerrainDirty()
        updateSelectionHelper()
        updateToolUI()
      }
      return
    }

    if (selectedPlacedObject?.userData?.assetId) {
      const asset = assetRegistry.find((a) => a.id === selectedPlacedObject.userData.assetId)
      if (!asset) return

      const model = await loadAssetModel(asset.path)
      tuneModelLighting(model, asset.path)

      const targetFootprint = getObjectFootprint(selectedPlacedObject)

      model.rotation.copyFrom(selectedPlacedObject.rotation)
      model.scale.copyFrom(selectedPlacedObject.scale)
      model.userData.assetId = asset.id
      model.userData.type = 'asset'
      model.userData.layerId = selectedPlacedObject.userData.layerId || activeLayerId

      addPlacedModel(model)
      model.computeWorldMatrix(true)

      const sourceFootprint = getObjectFootprint(model)

      if (mode === 'stack') {
        model.position.copyFrom(selectedPlacedObject.position)
        model.position.y += (targetFootprint.height + sourceFootprint.height) * 0.5
      } else {
        model.position.copyFrom(
          snapObjectFlushAlongPosition(
            selectedPlacedObject.position,
            selectedPlacedObject.rotation.y,
            targetFootprint,
            sourceFootprint,
            ['forward','back'].includes(mode) ? mode : (mode === 'left' ? 'left' : 'right')
          )
        )
      }

      selectedPlacedObject = model
      selectedPlacedObjects = [model]
      selectedTexturePlane = null
      selectedTexturePlanes = []
      markTerrainDirty()
      updateSelectionHelper()
      updateToolUI()
    }
  }

  function beginTransform(mode) {
    if (!selectedTexturePlane && !selectedPlacedObject) return

    pushUndoState()
    transformMode = mode
    transformLift = 0
    movePlaneStart = null

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
        scale: selectedPlacedObject.scale.clone(),
        groupStarts: selectedPlacedObjects
          .filter((o) => o !== selectedPlacedObject)
          .map((o) => ({
            obj: o,
            position: o.position.clone(),
            rotation: { x: o.rotation.x, y: o.rotation.y, z: o.rotation.z }
          }))
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
      markTerrainDirty()
    }

    if (selectedPlacedObject) {
      selectedPlacedObject.position.copyFrom(transformStart.position)
      selectedPlacedObject.rotation.set(
        transformStart.rotation.x,
        transformStart.rotation.y,
        transformStart.rotation.z
      )
      selectedPlacedObject.scale.copyFrom(transformStart.scale)

      if (transformStart.groupStarts?.length) {
        for (const { obj, position, rotation } of transformStart.groupStarts) {
          obj.position.copyFrom(position)
          if (rotation) obj.rotation.set(rotation.x, rotation.y, rotation.z)
        }
      }

      // Re-register moved objects at their restored positions
      if (transformMode === 'move') {
        for (const obj of selectedPlacedObjects) {
          _spatialUnregister(obj)
          _spatialRegister(obj)
        }
        invalidateShadowCache()
      }

      updateSelectionHelper()
    }

    if (transformMode === 'rotate') lastRotateAxis = transformAxis
    transformMode = null
    transformStart = null
    transformLift = 0
    movePlaneStart = null
    updateToolUI()
  }

  function confirmTransform() {
    if (transformMode === 'move') {
      for (const obj of selectedPlacedObjects) {
        _spatialUnregister(obj)
        _spatialRegister(obj)
      }
      invalidateShadowCache()
    }

    if (transformMode === 'rotate') {
      applyRotationSnapOnConfirm()
      lastRotateAxis = transformAxis
    }

    transformMode = null
    transformStart = null
    transformLift = 0
    movePlaneStart = null
    updateToolUI()
  }

  function countAssetsByGroup(section) {
    const counts = new Map()
    for (const asset of assetRegistry) {
      if (section !== 'all' && asset.section !== section) continue
      counts.set(asset.group, (counts.get(asset.group) || 0) + 1)
    }
    return counts
  }

  function refreshAssetGroupOptions() {
    const counts = countAssetsByGroup(assetSectionFilter)
    assetGroupsForCurrentSection = ['all', ...Array.from(counts.keys()).sort((a, b) => a.localeCompare(b))]

    assetGroupSelect.innerHTML = ''
    for (const group of assetGroupsForCurrentSection) {
      const option = document.createElement('option')
      option.value = group
      option.textContent =
        group === 'all'
          ? `All (${Array.from(counts.values()).reduce((a, b) => a + b, 0)})`
          : `${group} (${counts.get(group) || 0})`
      assetGroupSelect.appendChild(option)
    }

    if (!assetGroupsForCurrentSection.includes(assetGroupFilter)) assetGroupFilter = 'all'
    assetGroupSelect.value = assetGroupFilter
  }

  // --- Thumbnail system ---
  const thumbnailCache = new Map()
  let thumbRenderer = null
  let thumbScene = null
  let thumbCamera = null

  function initThumbRenderer() {
    if (thumbRenderer) return
    const thumbCanvas = document.createElement('canvas')
    thumbCanvas.width = 80
    thumbCanvas.height = 80
    thumbRenderer = new Engine(thumbCanvas, true, { antialias: true })

    thumbScene = new Scene(thumbRenderer)
    thumbScene.useRightHandedSystem = true
    thumbScene.clearColor = new Color4(0.118, 0.133, 0.188, 1.0) // 0x1e2230
    new HemisphericLight('thumbAmbient', new Vector3(0, 1, 0), thumbScene).intensity = 0.75
    const dirLight = new DirectionalLight('thumbDir', new Vector3(-0.5, -1, -0.65), thumbScene)
    dirLight.intensity = 1.3

    thumbCamera = new ArcRotateCamera('thumbCam', 0.78, 0.9, 5, Vector3.Zero(), thumbScene)
    thumbCamera.fov = 40 * Math.PI / 180
    thumbCamera.minZ = 0.001
    thumbCamera.maxZ = 10000
    thumbCamera.inputs.clear()
  }

  async function generateThumbnail(asset) {
    if (thumbnailCache.has(asset.id)) return thumbnailCache.get(asset.id)

    initThumbRenderer()

    let model
    try {
      model = await loadAssetModel(asset.path)
    } catch {
      return null
    }

    // Generate a simple colored placeholder thumbnail via canvas
    if (model) model.dispose()
    const thumbCanvas = document.createElement('canvas')
    thumbCanvas.width = 80
    thumbCanvas.height = 80
    const ctx = thumbCanvas.getContext('2d')
    // Color based on asset category
    const pathLower = asset.path?.toLowerCase() || ''
    if (pathLower.includes('white')) ctx.fillStyle = '#889'
    else if (pathLower.includes('wood')) ctx.fillStyle = '#654'
    else if (pathLower.includes('dark stone')) ctx.fillStyle = '#433'
    else if (pathLower.includes('stone')) ctx.fillStyle = '#776'
    else if (pathLower.includes('tree')) ctx.fillStyle = '#264'
    else if (pathLower.includes('rock')) ctx.fillStyle = '#554'
    else ctx.fillStyle = '#445'
    ctx.fillRect(0, 0, 80, 80)
    ctx.fillStyle = '#fff'
    ctx.font = '10px sans-serif'
    ctx.textAlign = 'center'
    const name = asset.name || asset.id || '?'
    const words = name.split(/\s+/)
    for (let i = 0; i < words.length && i < 4; i++) {
      ctx.fillText(words[i], 40, 30 + i * 14)
    }
    const dataUrl = thumbCanvas.toDataURL()
    thumbnailCache.set(asset.id, dataUrl)
    return dataUrl
  }

  function refreshAssetList() {
    const q = assetSearch.value.trim().toLowerCase()

    const WALL_FILES = ['stone wall.glb', 'dark stone wall.glb', 'white wall.glb', 'wood wall.glb']

    filteredAssets = assetRegistry.filter((asset) => {
      if (assetSectionFilter === '__walls__') {
        const fileName = asset.path.split('/').pop().toLowerCase()
        return WALL_FILES.includes(fileName)
      }
      if (assetSectionFilter !== 'all' && asset.section !== assetSectionFilter) return false
      if (assetGroupFilter !== 'all' && asset.group !== assetGroupFilter) return false

      if (!q) return true

      const haystack = [
        asset.name,
        asset.section,
        asset.group,
        asset.folderPath,
        ...(asset.tags || [])
      ]
        .join(' ')
        .toLowerCase()

      return haystack.includes(q)
    })

    if (filteredAssets.length && !filteredAssets.find((a) => a.id === selectedAssetId)) {
      selectedAssetId = filteredAssets[0].id
    }

    assetGrid.innerHTML = ''

    if (!filteredAssets.length) {
      assetGrid.innerHTML = '<div class="asset-grid-empty">No assets found</div>'
      updateToolUI()
      return
    }

    for (const asset of filteredAssets) {
      const card = document.createElement('div')
      card.className = 'asset-card' + (asset.id === selectedAssetId ? ' selected' : '')
      card.dataset.assetId = asset.id

      const img = document.createElement('img')
      img.className = 'asset-thumb'
      img.alt = asset.name

      const label = document.createElement('div')
      label.className = 'asset-label'
      label.textContent = asset.name

      card.appendChild(img)
      card.appendChild(label)
      assetGrid.appendChild(card)

      card.addEventListener('click', async () => {
        selectedAssetId = asset.id
        assetGrid.querySelectorAll('.asset-card').forEach((c) => c.classList.remove('selected'))
        card.classList.add('selected')
        updateToolUI()
        await updatePreviewObject()
      })

      generateThumbnail(asset).then((url) => {
        if (url) img.src = url
      })
    }

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
      img.style.border = tex.id === selectedTextureId ? '2px solid #2d6cdf' : '2px solid transparent'
      img.style.cursor = 'pointer'
      img.style.borderRadius = '4px'
      img.style.display = 'block'

      img.onerror = () => {
        img.style.border = '2px solid red'
        img.title = `Failed to load: ${tex.path}`
      }

      img.addEventListener('click', () => {
        selectedTextureId = tex.id
        refreshTexturePalette()
        updateToolUI()
      })

      img.addEventListener('dblclick', () => {
        selectedTextureId = tex.id
        setTool(ToolMode.TEXTURE_PLANE)
        refreshTexturePalette()
        updateToolUI()
      })

      const label = document.createElement('div')
      label.textContent = tex.name
      label.style.fontSize = '10px'
      label.style.textAlign = 'center'
      label.style.wordBreak = 'break-word'

      wrap.appendChild(img)
      wrap.appendChild(label)
      texturePalette.appendChild(wrap)
    }
  }

  const paintTexturePalette = sidebar.querySelector('#paintTexturePalette')
  const paintTextureSearch = sidebar.querySelector('#paintTextureSearch')
  const texSlotA = sidebar.querySelector('#texSlotA')
  const texSlotB = sidebar.querySelector('#texSlotB')
  let paintTextureCat = 'all'

  function refreshSlotUI() {
    const activeId = paintTextureSlot === 'A' ? paintTabTextureId : paintTabTextureIdB
    const inactiveId = paintTextureSlot === 'A' ? paintTabTextureIdB : paintTabTextureId
    const activeTex = textureRegistry.find(t => t.id === activeId)
    const inactiveTex = textureRegistry.find(t => t.id === inactiveId)

    if (texSlotA) {
      const isA = paintTextureSlot === 'A'
      texSlotA.style.border = `2px solid ${isA ? '#2d6cdf' : '#444'}`
      const aId = paintTabTextureId
      const aTex = textureRegistry.find(t => t.id === aId)
      texSlotA.style.backgroundImage = aTex ? `url(${aTex.path})` : 'none'
      texSlotA.textContent = aTex ? '' : 'A'
    }
    if (texSlotB) {
      const isB = paintTextureSlot === 'B'
      texSlotB.style.border = `2px solid ${isB ? '#2d6cdf' : '#444'}`
      const bTex = textureRegistry.find(t => t.id === paintTabTextureIdB)
      texSlotB.style.backgroundImage = bTex ? `url(${bTex.path})` : 'none'
      texSlotB.textContent = bTex ? '' : 'B'
    }
  }

  texSlotA?.addEventListener('click', () => { paintTextureSlot = 'A'; refreshSlotUI(); refreshPaintTexturePalette() })
  texSlotB?.addEventListener('click', () => { paintTextureSlot = 'B'; refreshSlotUI(); refreshPaintTexturePalette() })

  const texCatAll = sidebar.querySelector('#texCatAll')
  const texCatStretched = sidebar.querySelector('#texCatStretched')
  texCatAll?.addEventListener('click', () => { paintTextureCat = 'all'; refreshPaintTexturePalette() })
  texCatStretched?.addEventListener('click', () => { paintTextureCat = 'stretched'; refreshPaintTexturePalette() })

  function refreshPaintTexturePalette() {
    if (!paintTexturePalette) return
    const q = (paintTextureSearch?.value || '').trim().toLowerCase()
    const list = textureRegistry.filter((tex) => {
      if (paintTextureCat === 'stretched' && !tex.defaultScale) return false
      if (paintTextureCat === 'all' && tex.defaultScale) return false
      const name = (tex.name || '').toLowerCase()
      return !q || name.includes(q) || String(tex.id).toLowerCase().includes(q)
    })
    const activeSlotId = paintTextureSlot === 'A' ? paintTabTextureId : paintTabTextureIdB
    paintTexturePalette.innerHTML = ''
    for (const tex of list) {
      const img = document.createElement('img')
      img.src = tex.path
      img.title = tex.name || tex.id
      img.style.cssText = `width:100%;aspect-ratio:1;object-fit:cover;cursor:pointer;border-radius:3px;border:2px solid ${tex.id === activeSlotId ? '#2d6cdf' : 'transparent'};`
      img.addEventListener('click', () => {
        if (paintTextureSlot === 'B') {
          paintTabTextureIdB = tex.id
        } else {
          paintTabTextureId = tex.id
          textureWorldUV = !!tex.defaultScale
          if (tex.defaultScale) {
            textureScale = tex.defaultScale
            if (paintTextureScaleSlider) {
              paintTextureScaleSlider.value = tex.defaultScale
              if (paintTextureScaleVal) paintTextureScaleVal.textContent = tex.defaultScale
            }
          } else {
            textureWorldUV = false
          }
        }
        setTool(ToolMode.PAINT)
        refreshSlotUI()
        refreshPaintTexturePalette()
        updateToolUI()
      })
      paintTexturePalette.appendChild(img)
    }
  }

  paintTextureSearch?.addEventListener('input', refreshPaintTexturePalette)

  const paintTextureScaleRow = sidebar.querySelector('#paintTextureScaleRow')
  const paintTextureScaleSlider = sidebar.querySelector('#paintTextureScale')
  const paintTextureScaleVal = sidebar.querySelector('#paintTextureScaleVal')
  paintTextureScaleSlider?.addEventListener('input', (e) => {
    textureScale = Number(e.target.value)
    if (paintTextureScaleVal) paintTextureScaleVal.textContent = textureScale
  })

  const eraseTextureBrushBtn = sidebar.querySelector('#eraseTextureBrushBtn')
  eraseTextureBrushBtn?.addEventListener('click', () => {
    paintTabTextureId = '__erase__'
    setTool(ToolMode.PAINT)
    refreshPaintTexturePalette()
    updateToolUI()
  })

  const allTabs = [tabProps, tabModular, tabWalls, tabRoofs]
  const clearTabs = () => allTabs.forEach(t => t.classList.remove('active'))

  tabProps.addEventListener('click', async () => {
    assetSectionFilter = 'Models'
    assetGroupFilter = 'all'
    clearTabs(); tabProps.classList.add('active')
    assetGroupSelect.style.display = 'none'
    refreshAssetList()
    await updatePreviewObject()
  })

  tabModular.addEventListener('click', async () => {
    assetSectionFilter = 'Modular Assets'
    assetGroupFilter = 'all'
    clearTabs(); tabModular.classList.add('active')
    assetGroupSelect.style.display = ''
    refreshAssetGroupOptions()
    refreshAssetList()
    await updatePreviewObject()
  })

  tabWalls.addEventListener('click', async () => {
    assetSectionFilter = '__walls__'
    assetGroupFilter = 'all'
    clearTabs(); tabWalls.classList.add('active')
    assetGroupSelect.style.display = 'none'
    refreshAssetList()
    await updatePreviewObject()
  })

  tabRoofs.addEventListener('click', async () => {
    assetSectionFilter = 'Roofs'
    assetGroupFilter = 'all'
    clearTabs(); tabRoofs.classList.add('active')
    assetGroupSelect.style.display = 'none'
    refreshAssetList()
    await updatePreviewObject()
  })

  assetGroupSelect.addEventListener('change', async (e) => {
    assetGroupFilter = e.target.value
    refreshAssetList()
    await updatePreviewObject()
  })

  assetSearch.addEventListener('input', refreshAssetList)

  refreshPreviewBtn.addEventListener('click', async () => {
    await updatePreviewObject()
  })

  textureSearch.addEventListener('input', refreshTexturePalette)

  useTexturePlaneBtn.addEventListener('click', () => {
    setTool(ToolMode.TEXTURE_PLANE)
  })

  smoothModeBtn.addEventListener('click', () => {
    state.smoothMode = !state.smoothMode
    if (state.smoothMode) { state.levelMode = false; state.levelHeight = null }
    updateToolUI()
  })

  levelModeBtn.addEventListener('click', () => {
    state.levelMode = !state.levelMode
    state.levelHeight = null
    if (state.levelMode) state.smoothMode = false
    updateToolUI()
  })

  const brushSizeSlider = sidebar.querySelector('#brushSizeSlider')
  const brushSizeLabel = sidebar.querySelector('#brushSizeLabel')

  brushSizeSlider.addEventListener('input', (e) => {
    brushRadius = parseFloat(e.target.value)
    brushSizeLabel.textContent = brushRadius.toFixed(1)
  })


  const levelHeightRow = sidebar.querySelector('#levelHeightRow')
  const levelHeightInput = sidebar.querySelector('#levelHeightInput')

  levelHeightInput.addEventListener('change', (e) => {
    const val = parseFloat(e.target.value)
    if (Number.isFinite(val)) state.levelHeight = val
  })

  sidebar.querySelector('#clearLevelHeight').addEventListener('click', () => {
    state.levelHeight = null
    levelHeightInput.value = ''
  })

  async function getSaveHandle() {
    if (saveFileHandle) return saveFileHandle
    return null
  }

  async function idbGet(key) {
    return new Promise((resolve) => {
      const req = indexedDB.open('projectrs', 1)
      req.onupgradeneeded = () => req.result.createObjectStore('kv')
      req.onsuccess = () => {
        const tx = req.result.transaction('kv', 'readonly')
        const r = tx.objectStore('kv').get(key)
        r.onsuccess = () => resolve(r.result)
        r.onerror = () => resolve(null)
      }
      req.onerror = () => resolve(null)
    })
  }

  async function idbSet(key, value) {
    return new Promise((resolve) => {
      const req = indexedDB.open('projectrs', 1)
      req.onupgradeneeded = () => req.result.createObjectStore('kv')
      req.onsuccess = () => {
        const tx = req.result.transaction('kv', 'readwrite')
        tx.objectStore('kv').put(value, key)
        tx.oncomplete = resolve
        tx.onerror = resolve
      }
      req.onerror = resolve
    })
  }

  saveMapBtn.addEventListener('click', async () => {
    const suggestedName = map.mapType === 'dungeon' ? 'dungeon.json' : 'main.json'
    if (!window.showSaveFilePicker) { downloadJSON(suggestedName, buildSaveData()); return }
    try {
      let handle = await getSaveHandle()
      if (!handle) {
        handle = await window.showSaveFilePicker({
          suggestedName,
          types: [{ description: 'JSON Map', accept: { 'application/json': ['.json'] } }]
        })
        saveFileHandle = handle
      }
      const writable = await handle.createWritable()
      await writable.write(JSON.stringify(buildSaveData(), null, 2))
      await writable.close()
      const prev = statusText.textContent
      statusText.textContent = 'Saved'
      setTimeout(() => { statusText.textContent = prev }, 1500)
    } catch (e) {
      if (e.name !== 'AbortError') { console.warn('Save failed:', e); downloadJSON('main.json', buildSaveData()) }
    }
  })

  const restoreAutoSaveBtn = topBar.querySelector('#restoreAutoSaveBtn')
  restoreAutoSaveBtn.addEventListener('click', async () => {
    const raw = localStorage.getItem('projectrs-autosave')
    if (!raw) { alert('No auto-save found.'); return }
    await loadSaveData(JSON.parse(raw))
  })

  loadMapInput.addEventListener('change', async (event) => {
    const file = event.target.files?.[0]
    if (!file) return

    const text = await file.text()
    const data = JSON.parse(text)
    await loadSaveData(data)
    loadMapInput.value = ''
  })

  const importChunkInput = topBar.querySelector('#importChunkInput')
  importChunkInput.addEventListener('change', async (event) => {
    const file = event.target.files?.[0]
    if (!file) return

    const text = await file.text()
    const data = JSON.parse(text)
    importChunkInput.value = ''

    const rawX = prompt('Import at tile X offset:', '0')
    if (rawX === null) return
    const rawZ = prompt('Import at tile Z offset:', '0')
    if (rawZ === null) return

    const offsetX = parseInt(rawX, 10) || 0
    const offsetZ = parseInt(rawZ, 10) || 0

    await importChunk(data, offsetX, offsetZ)

    const prev = statusText.textContent
    statusText.textContent = `Chunk imported at (${offsetX}, ${offsetZ})`
    setTimeout(() => { statusText.textContent = prev }, 2500)
  })

  const DUNGEON_THRESHOLD = 2000

  function applyMapType() {
    const isDungeon = map.worldOffset.x >= DUNGEON_THRESHOLD
    map.mapType = isDungeon ? 'dungeon' : 'overworld'

    if (isDungeon) {
      scene.clearColor = new Color4(0, 0, 0, 1)
      scene.fogColor = new Color3(0, 0, 0)
      scene.fogStart = 18
      scene.fogEnd = 48
      sun.intensity = 0.3
      sun.diffuse = new Color3(0.42, 0.29, 0.13)
      fill.intensity = 0.25
      fill.diffuse = new Color3(0.29, 0.19, 0.06)
      ambient.diffuse = new Color3(0.48, 0.38, 0.25)
      ambient.intensity = 0.85
    } else {
      scene.clearColor = new Color4(0.039, 0.071, 0.020, 1)
      scene.fogColor = new Color3(0.039, 0.071, 0.020)
      scene.fogStart = 22
      scene.fogEnd = 72
      sun.intensity = 1.1
      sun.diffuse = new Color3(1.0, 0.84, 0.54)
      fill.intensity = 0.65
      fill.diffuse = new Color3(0.67, 0.73, 0.80)
      ambient.diffuse = new Color3(0.54, 0.54, 0.54)
      ambient.intensity = 0.9
    }

    GROUND_TYPES = isDungeon ? GROUND_TYPES_DUNGEON : GROUND_TYPES_OVERWORLD
    buildGroundSwatches()
  }

  const worldOffsetX = topBar.querySelector('#worldOffsetX')
  const worldOffsetZ = topBar.querySelector('#worldOffsetZ')

  worldOffsetX.addEventListener('change', () => {
    const v = Number(worldOffsetX.value)
    if (Number.isFinite(v)) { map.worldOffset.x = v; applyMapType() }
  })

  worldOffsetZ.addEventListener('change', () => {
    const v = Number(worldOffsetZ.value)
    if (Number.isFinite(v)) map.worldOffset.z = v
  })

  resizeMapBtn.addEventListener('click', () => {
    const newWidth = Number(mapWidthInput.value)
    const newHeight = Number(mapHeightInput.value)
    if (!Number.isFinite(newWidth) || !Number.isFinite(newHeight)) return
    if (newWidth < 4 || newHeight < 4) return

    pushUndoState()
    map = map.resize(newWidth, newHeight)
    selectedPlacedObject = null
    selectedPlacedObjects = []
    selectedTexturePlane = null
      selectedTexturePlanes = []
    transformMode = null
    transformStart = null
    transformLift = 0
    movePlaneStart = null

    markTerrainDirty()
    updateSelectionHelper()
    updateToolUI()
  })

  sidebar.querySelector('#toggleSplitLines').addEventListener('change', (e) => {
    state.showSplitLines = e.target.checked
    if (splitLines) splitLines.isVisible = state.showSplitLines
  })

  sidebar.querySelector('#toggleTileGrid').addEventListener('change', (e) => {
    state.showTileGrid = e.target.checked
    if (tileGrid) tileGrid.isVisible = state.showTileGrid
  })

  sidebar.querySelector('#toggleHalfPaint').addEventListener('change', (e) => {
    state.halfPaint = e.target.checked
  })

  sidebar.querySelector('#toggleTexturePlaneV').addEventListener('change', (e) => {
    texturePlaneVertical = e.target.checked
    updateToolUI()
  })

  topBar.querySelector('#helpBtn').addEventListener('click', () => {
    keybindsPanel.classList.toggle('visible')
  })

  keybindsPanel.querySelector('#closeKeybinds').addEventListener('click', () => {
    keybindsPanel.classList.remove('visible')
  })

  sidebar.querySelector('#layersToggleBtn').addEventListener('click', () => {
    layersPanel.classList.toggle('visible')
    if (layersPanel.classList.contains('visible')) refreshLayersPanel()
  })

  function toggleHeightCull() {
    heightCullLevel = (heightCullLevel + 1) % 3
    const btn = sidebar.querySelector('#heightCullBtn')
    if (btn) {
      btn.classList.toggle('active-tool', heightCullLevel > 0)
      btn.title = heightCullLevel === 0 ? 'Hide objects above camera height (H)'
        : heightCullLevel === 1 ? 'Height Cull: level 1 (H to go higher)'
        : 'Height Cull: level 2 (H to disable)'
    }
    if (heightCullLevel > 0) applyHeightCull()
    else applyLayerVisibility()
  }

  sidebar.querySelector('#heightCullBtn')?.addEventListener('click', toggleHeightCull)

  function assignSelectedToLayer(layerId) {
    if (!selectedPlacedObjects.length && !selectedTexturePlane) return
    pushUndoState()
    for (const obj of selectedPlacedObjects) obj.userData.layerId = layerId
    for (const plane of selectedTexturePlanes) plane.layerId = layerId
    applyLayerVisibility()
    updateToolUI()
  }

  sidebar.querySelector('#layerAssignSelect')?.addEventListener('change', (e) => {
    assignSelectedToLayer(e.target.value)
  })

  sidebar.querySelector('#layerAssignBtn')?.addEventListener('click', () => {
    const sel = sidebar.querySelector('#layerAssignSelect')
    if (sel) assignSelectedToLayer(sel.value)
  })

  rotateTextureBtn.addEventListener('click', () => {
    textureRotation = (textureRotation + 1) % 4
    markTerrainDirty()
    updateToolUI()
  })

  const textureScaleVal = sidebar.querySelector('#textureScaleVal')
  textureScaleSlider.addEventListener('input', (e) => {
    textureScale = Number(e.target.value)
    if (textureScaleVal) textureScaleVal.textContent = textureScale
    if (selectedTexturePlane) {
      selectedTexturePlane.uvRepeat = textureScale
      markTerrainDirty()
    }
  })

  canvas.addEventListener('mousemove', (event) => {
    const tile = pickTile(event)
    if (!tile) return

    state.hovered = tile

    const y = map.getAverageTileHeight(tile.x, tile.z) + 0.04
    highlight.position.set(tile.x + 0.5, y, tile.z + 0.5)
    hoverText.textContent = `tile (${tile.x}, ${tile.z})  elev ${y.toFixed(2)}`

    if (previewObject) {
      const sp = pickSurfacePoint(event)
      const pos = tileWorldPosition(tile.x, tile.z)
      if (sp) pos.y = sp.y
      const _prevAsset = assetRegistry.find((a) => a.id === previewObject.userData.assetId)
      if (_prevAsset?.name?.toLowerCase().includes('wall')) {
        const snap = getWallEdgeSnap(tile)
        if (snap) { pos.x = snap.x; pos.z = snap.z }
      }
      if (_prevAsset?.path?.toLowerCase().includes('tree')) {
        if (sp) { pos.x = Math.round(sp.x); pos.z = Math.round(sp.z) }
        else { pos.x = Math.round(tile.x + 0.5); pos.z = Math.round(tile.z + 0.5) }
      }
      previewObject.position.copyFrom(pos)
    }
    updateHoverEdgeHelper()

    const terrainPoint = transformMode === 'move' ? pickTerrainPoint(event) : null

    if (transformMode === 'move' && selectedTexturePlane) {
      // For vertical planes, fall back to a virtual horizontal plane at the plane's current Y
      // so movement isn't blocked when the cursor passes over a wall model
      const cursorPoint = terrainPoint
        ?? (selectedTexturePlane.vertical ? pickHorizontalPlane(event, selectedTexturePlane.position.y) : null)
      if (!cursorPoint) {
        updateTexturePlaneMeshTransform(selectedTexturePlane)
        updateSelectionHelper()
        return
      }

      const snappedX = event.shiftKey ? snapValue(cursorPoint.x, 0.5) : cursorPoint.x
      const snappedZ = event.shiftKey ? snapValue(cursorPoint.z, 0.5) : cursorPoint.z

      const planeHalfHeight =
        ((selectedTexturePlane.height || 1) * (selectedTexturePlane.scale?.y ?? 1)) / 2

      if (transformAxis === 'x') {
        selectedTexturePlane.position.x = snappedX
      } else if (transformAxis === 'ground-z') {
        selectedTexturePlane.position.z = snappedZ
      } else if (transformAxis === 'height') {
        if (!movePlaneStart) {
          movePlaneStart = {
            mouseY: event.clientY,
            value: selectedTexturePlane.position.y
          }
        }

        const deltaY = (movePlaneStart.mouseY - event.clientY) * 0.02
        selectedTexturePlane.position.y = movePlaneStart.value + deltaY
      } else {
        if (selectedTexturePlane.vertical) {
          const planeSnap = !event.altKey && findNearbyPlaneSnap(selectedTexturePlane, snappedX, snappedZ)
          if (planeSnap) {
            selectedTexturePlane.position.x = planeSnap.x
            selectedTexturePlane.position.z = planeSnap.z
            selectedTexturePlane.position.y = planeSnap.y + transformLift
          } else {
            selectedTexturePlane.position.x = snappedX
            selectedTexturePlane.position.z = snappedZ
            selectedTexturePlane.position.y = (transformStart?.position.y ?? (terrainPoint ? terrainPoint.y + planeHalfHeight : selectedTexturePlane.position.y)) + transformLift
          }
        } else {
          selectedTexturePlane.position.x = snappedX
          selectedTexturePlane.position.z = snappedZ
          if (terrainPoint) selectedTexturePlane.position.y = terrainPoint.y + 0.05 + transformLift
        }
      }

      updateTexturePlaneMeshTransform(selectedTexturePlane)
      updateSelectionHelper()
      return
    }

    if (transformMode === 'move' && selectedPlacedObject) {
      const movePoint = pickHorizontalPlane(event, selectedPlacedObject.position.y)
      if (!movePoint) return

      const _movingAsset = assetRegistry.find((a) => a.id === selectedPlacedObject.userData.assetId)
      const movingIsWallModular = isModularAsset(selectedPlacedObject.userData.assetId)
        && _movingAsset?.name?.toLowerCase().includes('wall')

      let snappedX, snappedZ
      if (movingIsWallModular && !event.altKey) {
        const snap = findModularEdgeSnap(selectedPlacedObject, movePoint.x, movePoint.z)
        snappedX = snap.x
        snappedZ = snap.z
      } else {
        snappedX = event.shiftKey ? snapValue(movePoint.x, 0.5) : movePoint.x
        snappedZ = event.shiftKey ? snapValue(movePoint.z, 0.5) : movePoint.z
      }

      if (transformAxis === 'x') {
        selectedPlacedObject.position.x = snappedX
      } else if (transformAxis === 'ground-z') {
        selectedPlacedObject.position.z = snappedZ
      } else if (transformAxis === 'height') {
        if (!movePlaneStart) {
          movePlaneStart = {
            mouseY: event.clientY,
            value: selectedPlacedObject.position.y
          }
        }

        const deltaY = (movePlaneStart.mouseY - event.clientY) * 0.02
        selectedPlacedObject.position.y = movePlaneStart.value + deltaY
      } else {
        let targetY
        if (transformLift !== 0) {
          targetY = selectedPlacedObject.position.y
        } else if (!event.altKey) {
          const sp = pickSurfacePoint(event, selectedPlacedObjects)
          targetY = sp?.y ?? terrainPoint?.y ?? selectedPlacedObject.position.y
        } else {
          targetY = terrainPoint?.y ?? selectedPlacedObject.position.y
        }
        selectedPlacedObject.position.set(snappedX, targetY, snappedZ)
      }

      // Move group members by the same delta as the primary
      if (transformStart?.groupStarts?.length) {
        const dx = selectedPlacedObject.position.x - transformStart.position.x
        const dy = selectedPlacedObject.position.y - transformStart.position.y
        const dz = selectedPlacedObject.position.z - transformStart.position.z
        for (const { obj, position } of transformStart.groupStarts) {
          obj.position.set(position.x + dx, position.y + dy, position.z + dz)
        }
      }

      return
    }

    if (isDragSelecting && dragSelectStart) {
      const dx = event.clientX - dragSelectStart.x
      const dy = event.clientY - dragSelectStart.y
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
        dragSelectBox.style.display = 'block'
      }
      updateDragSelectBox(dragSelectStart.x, dragSelectStart.y, event.clientX, event.clientY)
      return
    }

if (state.isPainting && state.tool !== ToolMode.PLACE && state.tool !== ToolMode.SELECT) {
  const key = `${tile.x},${tile.z}`

  if (
    state.tool === ToolMode.TERRAIN ||
    state.tool === ToolMode.PAINT
  ) {
    if (state.tool === ToolMode.TERRAIN) {
      const now = performance.now()

      if (!state.draggedTiles.has(key) && now - state.lastTerrainEditTime >= state.terrainEditInterval) {
        state.draggedTiles.add(key)
        state.lastTerrainEditTime = now
        applyToolAtTile(tile, event)
      }
    } else {
      if (!state.draggedTiles.has(key)) {
        state.draggedTiles.add(key)
        applyToolAtTile(tile, event)
      }
    }
  }
}
  })

  const dragSelectBox = document.createElement('div')
  dragSelectBox.style.cssText = 'position:fixed;border:1px solid rgba(102,204,255,0.9);background:rgba(102,204,255,0.07);pointer-events:none;display:none;z-index:9999;'
  document.body.appendChild(dragSelectBox)

  function updateDragSelectBox(x1, y1, x2, y2) {
    dragSelectBox.style.left = Math.min(x1, x2) + 'px'
    dragSelectBox.style.top = Math.min(y1, y2) + 'px'
    dragSelectBox.style.width = Math.abs(x2 - x1) + 'px'
    dragSelectBox.style.height = Math.abs(y2 - y1) + 'px'
  }

  function worldToScreen(worldPos) {
    const projected = Vector3.Project(
      worldPos,
      Matrix.Identity(),
      scene.getTransformMatrix(),
      camera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight())
    )
    const rect = canvas.getBoundingClientRect()
    return {
      x: projected.x + rect.left,
      y: projected.y + rect.top
    }
  }

  canvas.addEventListener('mousedown', async (event) => {
    if (event.button !== 0) return

    // SELECT tool drag-select starts before tile check so it works anywhere on canvas
    if (state.tool === ToolMode.SELECT && !transformMode) {
      const picked = pickClosestSelectTarget(event)
      if (picked?.type === 'plane') {
        const plane = picked.object.userData.texturePlane
        if (plane) {
          if (event.shiftKey) {
            const idx = selectedTexturePlanes.indexOf(plane)
            if (idx >= 0) {
              selectedTexturePlanes.splice(idx, 1)
              selectedTexturePlane = selectedTexturePlanes[selectedTexturePlanes.length - 1] ?? null
            } else {
              selectedTexturePlanes.push(plane)
              selectedTexturePlane = plane
            }
          } else {
            selectedTexturePlane = plane
            selectedTexturePlanes = [plane]
          }
          selectedPlacedObject = null
          selectedPlacedObjects = []
          updateSelectionHelper()
          updateToolUI()
          return
        }
      }

      if (picked?.type === 'placed') {
        const pickedObject = picked.object
        if (event.shiftKey) {
          const idx = selectedPlacedObjects.indexOf(pickedObject)
          if (idx >= 0) {
            selectedPlacedObjects.splice(idx, 1)
            selectedPlacedObject = selectedPlacedObjects[selectedPlacedObjects.length - 1] ?? null
          } else {
            selectedPlacedObjects.push(pickedObject)
            selectedPlacedObject = pickedObject
          }
        } else {
          selectedPlacedObjects = [pickedObject]
          selectedPlacedObject = pickedObject
        }
        selectedTexturePlane = null
        selectedTexturePlanes = []
        updateSelectionHelper()
        updateToolUI()
        return
      }

      // No object hit — deselect immediately; show drag box only if mouse moves
      if (!event.shiftKey) clearSelection()
      isDragSelecting = true
      dragSelectStart = { x: event.clientX, y: event.clientY }
      return
    }

    const tile = pickTile(event)
    if (!tile) return

    if (transformMode) {
      confirmTransform()
      markTerrainDirty({ skipTexturePlanes: !selectedTexturePlane })
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

      plane.uvRepeat = textureScale
      selectedTexturePlane = plane
      selectedPlacedObject = null
      markTerrainDirty()
      updateSelectionHelper()
      updateToolUI()
      return
    }


    if (state.tool === ToolMode.PLACE) {
      await placeSelectedAsset(tile, event)
      return
    }

    state.isPainting = true
    state.historyCapturedThisStroke = false
    state.draggedTiles.clear()
    state.lastTerrainEditTime = 0



    const key = `${tile.x},${tile.z}`
    state.draggedTiles.add(key)
    applyToolAtTile(tile, event)
  })

  window.addEventListener('mouseup', (event) => {
    if (event.button === 0) {
      const wasPainting = state.isPainting
      const paintingTool = state.tool === ToolMode.TERRAIN || state.tool === ToolMode.PAINT
      state.isPainting = false
      state.draggedTiles.clear()
      state.historyCapturedThisStroke = false

      if (wasPainting && paintingTool) {
        markTerrainDirty({ skipTexturePlanes: true, skipShadows: false })
      }

      if (isDragSelecting && dragSelectStart) {
        isDragSelecting = false
        dragSelectBox.style.display = 'none'

        const dx = event.clientX - dragSelectStart.x
        const dy = event.clientY - dragSelectStart.y

        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
          const left = Math.min(dragSelectStart.x, event.clientX)
          const right = Math.max(dragSelectStart.x, event.clientX)
          const top = Math.min(dragSelectStart.y, event.clientY)
          const bottom = Math.max(dragSelectStart.y, event.clientY)

          if (!event.shiftKey) {
            selectedPlacedObjects = []
            selectedPlacedObject = null
          }

          for (const obj of placedGroup.getChildren()) {
            const s = worldToScreen(obj.position)
            if (s.x >= left && s.x <= right && s.y >= top && s.y <= bottom) {
              if (!selectedPlacedObjects.includes(obj)) selectedPlacedObjects.push(obj)
            }
          }

          selectedPlacedObject = selectedPlacedObjects[selectedPlacedObjects.length - 1] ?? null
          selectedTexturePlane = null
      selectedTexturePlanes = []
          updateSelectionHelper()
          updateToolUI()
        }

        dragSelectStart = null
      }
    }
  })

  let isRightDragging = false
  let isMiddleDragging = false
  let isMiddlePanning = false

  let yaw = 0.78
  let pitch = 1.02
  let distance = 31
  const target = new Vector3(12, 2, 12)
  let heightCullLevel = 0 // 0=off, 1=at camera height, 2=one level higher
  const HEIGHT_CULL_STEP = 3

  function applyHeightCull() {
    const cullThreshold = heightCullLevel === 0 ? Infinity
      : heightCullLevel === 1 ? target.y
      : target.y + HEIGHT_CULL_STEP
    for (const obj of placedGroup.getChildren()) {
      const layer = layers.find((l) => l.id === (obj.userData.layerId || 'layer_0'))
      const layerVisible = layer ? layer.visible : true
      obj.setEnabled(layerVisible && obj.position.y <= cullThreshold)
    }
    if (texturePlaneGroup) {
      for (const mesh of texturePlaneGroup.getChildMeshes()) {
        const plane = mesh.userData.texturePlane
        if (!plane) continue
        const layer = layers.find((l) => l.id === (plane.layerId || 'layer_0'))
        const layerVisible = layer ? layer.visible : true
        mesh.isVisible = layerVisible && plane.position.y <= cullThreshold
      }
    }
  }

  function updateCamera() {
    // Three.js convention: yaw=0 faces +X, pitch=PI/4 is 45deg down
    // Babylon ArcRotateCamera (RHS): alpha=horizontal angle, beta=vertical (0=top, PI/2=horizon)
    // The original Three.js computed position as:
    //   x = cos(yaw)*sin(pitch)*dist, y = cos(pitch)*dist, z = sin(yaw)*sin(pitch)*dist
    // Babylon alpha rotates around Y axis, beta tilts from pole
    camera.alpha = yaw + Math.PI / 2
    camera.beta = pitch
    camera.radius = distance
    camera.target.copyFrom(target)
    updateCompass()
    if (heightCullLevel > 0) applyHeightCull()
  }

  function panCamera(deltaX, deltaY) {
    // Compute forward/right from yaw
    const fx = Math.sin(yaw), fz = Math.cos(yaw)
    const rx = Math.cos(yaw), rz = -Math.sin(yaw)

    const panScale = distance * 0.0025
    target.x += -deltaX * panScale * rx + deltaY * panScale * fx
    target.z += -deltaX * panScale * rz + deltaY * panScale * fz
    updateCamera()
  }

  updateCamera()

  canvas.addEventListener('contextmenu', (e) => e.preventDefault())

  canvas.addEventListener('mousedown', (e) => {
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

  canvas.addEventListener('wheel', (e) => {
    if (transformMode === 'rotate') {
      e.preventDefault()

      // Translate unified axis convention → Three.js axis
      // X=east-west(X), Y=north-south(Z), Z=vertical(Y), all=vertical(Y)
      const threeAxis = (transformAxis === 'height' || transformAxis === 'all') ? 'y'
        : transformAxis === 'ground-z' ? 'z'
        : 'x'

      if (selectedTexturePlane) {
        if (e.shiftKey) {
          selectedTexturePlane.rotation[threeAxis] += (e.deltaY > 0 ? 1 : -1) * 0.1
        } else {
          const step = Math.PI / 12
          selectedTexturePlane.rotation[threeAxis] += e.deltaY > 0 ? step : -step
          selectedTexturePlane.rotation[threeAxis] = snapAngleToQuarterIfClose(selectedTexturePlane.rotation[threeAxis], 0.08)
        }

        updateTexturePlaneMeshTransform(selectedTexturePlane)
        updateSelectionHelper()
        return
      }

      if (selectedPlacedObject) {
        const delta = e.shiftKey ? (e.deltaY > 0 ? 1 : -1) * 0.1 : (e.deltaY > 0 ? 1 : -1) * (Math.PI / 12)

        const applyRotation = (obj) => {
          if (threeAxis === 'y') {
            // Vertical spin: Euler is fine, no gimbal issue, snap supported
            obj.rotation.y += delta
            if (!e.shiftKey) obj.rotation.y = snapAngleToQuarterIfClose(obj.rotation.y, 0.08)
          } else {
            // X/Z: rotate around absolute world axis to avoid gimbal lock from GLTF baked rotations
            const worldAxis = threeAxis === 'x' ? new Vector3(1, 0, 0) : new Vector3(0, 0, 1)
            { // rotateOnWorldAxis equivalent
              const q = Quaternion.RotationAxis(worldAxis, delta)
              if (!obj.rotationQuaternion) obj.rotationQuaternion = Quaternion.FromEulerAngles(obj.rotation.x, obj.rotation.y, obj.rotation.z)
              obj.rotationQuaternion = q.multiply(obj.rotationQuaternion)
            }
          }
        }

        applyRotation(selectedPlacedObject)
        for (const obj of selectedPlacedObjects) {
          if (obj === selectedPlacedObject) continue
          applyRotation(obj)
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
          selectedTexturePlane.width  = Math.max(0.1, selectedTexturePlane.width  + delta)
          selectedTexturePlane.height = Math.max(0.1, selectedTexturePlane.height + delta)
        } else if (transformAxis === 'x') {
          selectedTexturePlane.width  = Math.max(0.1, selectedTexturePlane.width  + delta)
        } else if (transformAxis === 'height') {   // Z key = vertical = plane height
          selectedTexturePlane.height = Math.max(0.1, selectedTexturePlane.height + delta)
        } else if (transformAxis === 'ground-z') { // Y key = depth scale
          selectedTexturePlane.scale.z = Math.max(0.1, selectedTexturePlane.scale.z + delta)
        }

        markTerrainDirty()
        return
      }

      if (selectedPlacedObject) {
        // Translate unified axis → Three.js scale axis
        const scaleAxis = transformAxis === 'height' ? 'y' : transformAxis === 'ground-z' ? 'z' : transformAxis
        if (transformAxis === 'all') {
          const nextX = Math.max(0.1, selectedPlacedObject.scale.x + delta)
          const nextY = Math.max(0.1, selectedPlacedObject.scale.y + delta)
          const nextZ = Math.max(0.1, selectedPlacedObject.scale.z + delta)
          selectedPlacedObject.scale.set(nextX, nextY, nextZ)
        } else {
          selectedPlacedObject.scale[scaleAxis] = Math.max(
            0.1,
            selectedPlacedObject.scale[scaleAxis] + delta
          )
        }

        updateSelectionHelper()
        return
      }
    }

    distance += e.deltaY * 0.01
    distance = Math.max(2, Math.min(120, distance))
    updateCamera()
  })

  window.addEventListener('resize', () => {
    engine.resize()
  })

  window.addEventListener('keydown', async (event) => {
    const tag = document.activeElement?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

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
      selectedTexturePlanes = []
        markTerrainDirty()
        updateSelectionHelper()
        updateToolUI()
        return
      }

      if (selectedPlacedObjects.length > 0) {
        pushUndoState()
        for (const obj of selectedPlacedObjects) removePlacedModel(obj)
        selectedPlacedObject = null
        selectedPlacedObjects = []
        markTerrainDirty()
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

    if (key === 'h') {
      toggleHeightCull()
      return
    }

    if (transformMode === 'move') {
      if (key === 'q' || key === 'e') {
        const delta = key === 'q' ? 0.1 : -0.1
        transformLift += delta
        if (selectedPlacedObject) {
          selectedPlacedObject.position.y += delta
          if (transformStart?.groupStarts?.length) {
            for (const { obj } of transformStart.groupStarts) obj.position.y += delta
          }
        }
        return
      }
    }

if (key === 'q') {
  if (!event.repeat) pushUndoState()
  if (brushRadius < 0.6) {
    map.adjustVertexHeight(x,     z,     0.18)
    map.adjustVertexHeight(x + 1, z,     0.18)
    map.adjustVertexHeight(x,     z + 1, 0.18)
    map.adjustVertexHeight(x + 1, z + 1, 0.18)
  } else {
    applyGaussianBrush(x + 0.5, z + 0.5, 0.18)
  }
  const _qr = Math.ceil(brushRadius)
  markTerrainDirty({ skipTexturePlanes: true, skipShadows: true, skipTextureOverlays: true, heightsOnly: true, region: { x1: x - _qr, z1: z - _qr, x2: x + _qr, z2: z + _qr } })
  return
}

if (key === 'e') {
  if (!event.repeat) pushUndoState()
  if (brushRadius < 0.6) {
    map.adjustVertexHeight(x,     z,     -0.18)
    map.adjustVertexHeight(x + 1, z,     -0.18)
    map.adjustVertexHeight(x,     z + 1, -0.18)
    map.adjustVertexHeight(x + 1, z + 1, -0.18)
  } else {
    applyGaussianBrush(x + 0.5, z + 0.5, -0.18)
  }
  const _er = Math.ceil(brushRadius)
  markTerrainDirty({ skipTexturePlanes: true, skipShadows: true, skipTextureOverlays: true, heightsOnly: true, region: { x1: x - _er, z1: z - _er, x2: x + _er, z2: z + _er } })
  return
}

    if (key === 'k') {
      snapSelectedThingNow()
      return
    }

    if (key === 'f') {
      pushUndoState()
      map.flipTileSplit(x, z)
      markTerrainDirty()
      return
    }

    if (key === '1') return setTool(ToolMode.TERRAIN)
    if (key === '2') return setTool(ToolMode.PAINT)
    if (key === '3') return setTool(ToolMode.PLACE)
    if (key === '4') return setTool(ToolMode.SELECT)
    if (key === '5') return setTool(ToolMode.TEXTURE_PLANE)

    if (key === 'v') {
      texturePlaneVertical = !texturePlaneVertical
      updateToolUI()
      return
    }

    if (key === 'x' || key === 'y' || key === 'z') {
      // Consistent convention across all modes:
      // X = east-west, Y = north-south (Three.js Z), Z = vertical (Three.js Y)
      if (key === 'x') transformAxis = 'x'
      else if (key === 'y') transformAxis = 'ground-z'
      else if (key === 'z') transformAxis = 'height'

      updateToolUI()
      return
    }

    if (key === 'g') {
      // If nothing is selected, try to pick whatever is under the cursor
      if (!selectedTexturePlane && !selectedPlacedObject) {
        if (texturePlaneGroup) {
          const pick = scene.pick(scene.pointerX, scene.pointerY, (m) => m.isDescendantOf(texturePlaneGroup))
          if (pick.hit && pick.pickedMesh?.userData?.texturePlane) {
            selectedTexturePlane = pick.pickedMesh.userData.texturePlane
            selectedPlacedObject = null
            const rep = selectedTexturePlane.uvRepeat || 1
            textureScale = rep
            textureScaleSlider.value = rep
            if (textureScaleVal) textureScaleVal.textContent = rep
            setTool(ToolMode.SELECT)
            updateSelectionHelper()
          }
        }

        if (!selectedTexturePlane) {
          const pick = scene.pick(scene.pointerX, scene.pointerY, (m) => m.isDescendantOf(placedGroup))
          if (pick.hit) {
            let obj = pick.pickedMesh
            while (obj.parent && obj.parent !== placedGroup) obj = obj.parent
            selectedPlacedObject = obj
            selectedTexturePlane = null
            selectedTexturePlanes = []
            setTool(ToolMode.SELECT)
            updateSelectionHelper()
          }
        }
      }

      transformAxis = 'all'
      beginTransform('move')
      return
    }

    if (key === 'r') {
      if (selectedTexturePlane || selectedPlacedObject) {
        transformAxis = lastRotateAxis
        beginTransform('rotate')
        return
      }

      if (state.tool === ToolMode.TEXTURE_PLANE || (state.tool === ToolMode.PAINT && paintTabTextureId && paintTabTextureId !== '__erase__')) {
        textureRotation = (textureRotation + 1) % 4
        markTerrainDirty()
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

    if (key === 'a' && event.shiftKey) {
      await duplicateSelected('stack')
      return
    }

    if (key === 'a' && event.altKey) {
      await duplicateSelected('back')
      return
    }

    if (key === 'd' && event.ctrlKey && event.shiftKey) {
      await duplicateSelected('right')
      return
    }

    if (key === 'd' && event.ctrlKey) {
      await duplicateSelected('left')
      return
    }

    if (key === 'd' && event.altKey) {
      await duplicateSelected('forward')
      return
    }

    if (key === 'd' && event.shiftKey) {
      await duplicateSelected('right')
      return
    }
  })

  async function initAssets() {
    try {
      assetRegistry = await loadAssetRegistry()

      // Default to Props tab
      assetSectionFilter = 'Models'
      assetGroupFilter = 'all'
      clearTabs(); tabProps.classList.add('active')
      assetGroupSelect.style.display = 'none'

      filteredAssets = [...assetRegistry]
      selectedAssetId = filteredAssets.find((a) => a.section === 'Models')?.id || filteredAssets[0]?.id || ''

      refreshAssetList()

      await updatePreviewObject()
    } catch (err) {
      assetGrid.innerHTML = '<div class="asset-grid-empty">Failed to load assets</div>'
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

      for (const tex of textureRegistry) {
        const loadedTexture = new Texture(tex.path, scene)
        loadedTexture.wrapU = Texture.CLAMP_ADDRESSMODE
        loadedTexture.wrapV = Texture.CLAMP_ADDRESSMODE
        textureCache.set(tex.id, loadedTexture)

        // Get image dimensions via onload
        const meta = await loadImageMeta(tex.path)
        textureMeta.set(tex.id, meta)
      }

      selectedTextureId = filteredTextures[0]?.id || null
      refreshTexturePalette()
      refreshPaintTexturePalette()
      markTerrainDirty()
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

  markTerrainDirty()
  buildGroundSwatches()
  refreshLayersPanel()
  updateToolUI()
  pushUndoState()

  async function initDefaultSave() {
    const params = new URLSearchParams(window.location.search)
    const mapParam = params.get('map')
    if (!mapParam) return

    try {
      const res = await fetch(`/worldsave/${encodeURIComponent(mapParam)}.json`)
      if (!res.ok) return
      const data = await res.json()
      await loadSaveData(data)
    } catch (e) {
      console.warn('Could not load default save:', e)
    }
  }

  Promise.all([initAssets(), initTextures()]).then(() => initDefaultSave())

  engine.runRenderLoop(() => {
    if (_terrainDirty) {
      rebuildTerrain({ ..._terrainDirtyOpts, _heightsOnlyRegion: _terrainDirtyRegion })
      _terrainDirty = false
      _terrainDirtyRegion = null
      _terrainDirtyOpts = { skipTexturePlanes: true, skipShadows: true, skipTextureOverlays: true }
    }
    // Selection helpers are recreated on change, no per-frame update needed
    const t = performance.now() * 0.0003
    waterTexture.uOffset = t * 0.18
    waterTexture.vOffset = t * 0.09
    scene.render()
  })
}