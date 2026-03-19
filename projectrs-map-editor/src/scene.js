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

scene.background = new THREE.Color(0x0a1205)
scene.fog = new THREE.Fog(0x0a1205, 22, 72)

const sun = new THREE.DirectionalLight(0xffd78a, 1.1)
sun.position.set(16, 30, 16)
scene.add(sun)

const fillLight = new THREE.DirectionalLight(0xaabbcc, 0.65)
fillLight.position.set(-10, 6, 10)
scene.add(fillLight)

scene.add(new THREE.AmbientLight(0x8a8a8a, 0.62))

scene.add(new THREE.AmbientLight(0x5c6448, 0.08))
scene.add(new THREE.HemisphereLight(0x181818, 0x2f2410, 0.18))

function tuneModelLighting(model, assetPath = '') {
  const isModular = assetPath.toLowerCase().includes('modular assets')

  model.traverse((child) => {
    if (!child.isMesh || !child.material) return

    const materials = Array.isArray(child.material) ? child.material : [child.material]

    const tuned = materials.map((src) => {
      if (src.map) src.map.colorSpace = THREE.SRGBColorSpace

      const alphaTest = src.alphaTest ?? 0
      const isAlphaCutout = alphaTest > 0

      let mat

      if (isModular) {
        // Flat unlit — consistent face colours, good for RS Classic architecture
        mat = new THREE.MeshBasicMaterial({
          map: src.map || null,
          color: src.color ? src.color.clone() : 0xffffff,
          alphaMap: src.alphaMap || null,
          alphaTest,
          side: THREE.DoubleSide,
          transparent: isAlphaCutout ? false : !!src.transparent,
          depthWrite: true
        })
      } else {
        // Phong with zero shininess — responds to scene light so props don't look blown out
        mat = new THREE.MeshPhongMaterial({
          map: src.map || null,
          normalMap: src.normalMap || null,
          color: src.color ? src.color.clone() : 0xffffff,
          emissive: src.emissive ? src.emissive.clone() : 0x000000,
          emissiveMap: src.emissiveMap || null,
          alphaMap: src.alphaMap || null,
          alphaTest,
          shininess: 0,
          specular: 0x000000,
          side: THREE.DoubleSide,
          transparent: isAlphaCutout ? false : !!src.transparent,
          depthWrite: true
        })
        mat.aoMap = src.aoMap || null
        mat.opacity = src.opacity ?? 1
      }

      mat.needsUpdate = true
      return mat
    })

    child.material = Array.isArray(child.material) ? tuned : tuned[0]
    child.castShadow = false
    child.receiveShadow = false
  })
}

  const camera = new THREE.PerspectiveCamera(
    55,
    window.innerWidth / window.innerHeight,
    0.1,
    1000
  )

  const renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.domElement.style.position = 'absolute'
  renderer.domElement.style.inset = '0'
  renderer.domElement.style.zIndex = '0'
  container.appendChild(renderer.domElement)

  const textureLoader = new THREE.TextureLoader()
  const waterTexture = textureLoader.load('/assets/textures/1.png')
  waterTexture.wrapS = THREE.RepeatWrapping
  waterTexture.wrapT = THREE.RepeatWrapping

  let map = new MapData(64, 64)
  const placedGroup = new THREE.Group()
  scene.add(placedGroup)

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
  let textureRotation = 0
  let textureScale = 1

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
  historyCapturedThisStroke: false,
  lastTerrainEditTime: 0,
  terrainEditInterval: 110
}

let brushRadius = 3.2

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
      <input id="brushSizeSlider" type="range" min="0.8" max="7" step="0.2" value="3.2" style="margin-top:3px;" />
      <button id="toggleLevelMode" style="margin-top:8px;">Level Mode: Off</button>
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
      <button id="eraseTextureBrushBtn" style="width:100%;margin-bottom:5px;">Erase Texture</button>
      <input id="paintTextureSearch" type="text" placeholder="Search textures..." style="width:100%;box-sizing:border-box;margin-bottom:5px;" />
      <div id="paintTexturePalette" style="display:grid;grid-template-columns:repeat(4,1fr);gap:4px;max-height:200px;overflow-y:auto;"></div>
    </div>

    <div class="ctx-panel" id="ctx-place" style="display:none">
      <div class="asset-tabs">
        <button class="asset-tab active" id="tabProps">Props</button>
        <button class="asset-tab" id="tabModular">Modular</button>
        <button class="asset-tab" id="tabWalls">Walls</button>
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
        Shift+D duplicate right · Alt+D forward<br>
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
    </div>

    <div class="ctx-panel" id="ctx-texture" style="display:none">
      <input id="textureSearch" type="text" placeholder="Search textures..." />
      <div id="texturePalette" style="display:grid;grid-template-columns:repeat(3,1fr);gap:5px;max-height:200px;overflow:auto;margin-top:7px;"></div>
      <div style="margin-top:5px;">
        <button id="useTexturePlaneBtn" style="width:100%">Plane Mode</button>
      </div>
      <button id="rotateTextureBtn">Rotate Texture (R)</button>
      <label style="margin-top:6px;font-size:11px;color:rgba(255,255,255,0.45);">Scale</label>
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
      <b>Duplicate:</b> Shift+D right · Alt+D forward · Shift+A stack up<br>
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
      rebuildTerrain()
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
    rebuildTerrain()
  })

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

 

  const GROUND_TYPES = [
    { id: 'grass', label: 'Grass', color: '#3d8a20' },
    { id: 'dirt',  label: 'Dirt',  color: '#7a5030' },
    { id: 'sand',  label: 'Sand',  color: '#c4a245' },
    { id: 'path',  label: 'Path',  color: '#8a7860' },
    { id: 'road',  label: 'Road',  color: '#7a7870' },
    { id: 'water', label: 'Mud', color: '#5a3d1a' },
  ]

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
    if (heightCullEnabled) { applyHeightCull(); return }
    for (const obj of placedGroup.children) {
      const layer = layers.find((l) => l.id === (obj.userData.layerId || 'layer_0'))
      obj.visible = layer ? layer.visible : true
    }
    if (texturePlaneGroup) {
      for (const mesh of texturePlaneGroup.children) {
        const plane = mesh.userData.texturePlane
        if (!plane) continue
        const layer = layers.find((l) => l.id === (plane.layerId || 'layer_0'))
        mesh.visible = layer ? layer.visible : true
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
      const objCount = placedGroup.children.filter(
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
        for (const obj of placedGroup.children) {
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
    if (state.tool === ToolMode.TEXTURE_PLANE) {
      status += ` · ${texturePlaneVertical ? 'vertical' : 'horizontal'}`
    }
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
    if (hoverEdgeHelper) { scene.remove(hoverEdgeHelper); hoverEdgeHelper = null }
    updateToolUI()
    updatePreviewObject().catch(console.error)
  }

  function clearSelectionHelper() {
    if (Array.isArray(selectionHelper)) {
      for (const h of selectionHelper) scene.remove(h)
    } else if (selectionHelper) {
      scene.remove(selectionHelper)
    }
    selectionHelper = null
  }

  function updateSelectionHelper() {
    clearSelectionHelper()

    if (selectedPlacedObjects.length === 1) {
      selectionHelper = new THREE.BoxHelper(selectedPlacedObjects[0], 0x66ccff)
      scene.add(selectionHelper)
      return
    }

    if (selectedPlacedObjects.length > 1) {
      selectionHelper = selectedPlacedObjects.map((obj) => {
        const h = new THREE.BoxHelper(obj, 0xffaa44)
        scene.add(h)
        return h
      })
      return
    }

    if (selectedTexturePlane && texturePlaneGroup) {
      const color = selectedTexturePlanes.length > 1 ? 0xffaa44 : 0x66ccff
      selectionHelper = selectedTexturePlanes.map((plane) => {
        const mesh = texturePlaneGroup.children.find((c) => c.userData.texturePlane?.id === plane.id)
        if (!mesh) return null
        const h = new THREE.BoxHelper(mesh, color)
        scene.add(h)
        return h
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
    return placedGroup.children.map((obj) => ({
      assetId: obj.userData.assetId || null,
      layerId: obj.userData.layerId || 'layer_0',
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
      tuneModelLighting(model, asset.path)

      model.position.set(placed.position.x, placed.position.y, placed.position.z)
      model.rotation.set(placed.rotation.x, placed.rotation.y, placed.rotation.z)
      model.scale.set(placed.scale.x, placed.scale.y, placed.scale.z)
      model.userData.assetId = asset.id
      model.userData.type = 'asset'
      model.userData.layerId = placed.layerId || 'layer_0'
      const layer = layers.find((l) => l.id === model.userData.layerId)
      model.visible = layer ? layer.visible : true
      placedGroup.add(model)
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
    rebuildTerrain()
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
      const _layer = layers.find((l) => l.id === model.userData.layerId)
      model.visible = _layer ? _layer.visible : true
      placedGroup.add(model)
    }

    rebuildTerrain()
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

  function buildTileGrid() {
    const points = []
    const LIFT = 0.04

    for (let z = 0; z < map.height; z++) {
      for (let x = 0; x < map.width; x++) {
        const h = map.getTileCornerHeights(x, z)

        // top edge
        points.push(
          new THREE.Vector3(x,     h.tl + LIFT, z),
          new THREE.Vector3(x + 1, h.tr + LIFT, z)
        )
        // left edge
        points.push(
          new THREE.Vector3(x, h.tl + LIFT, z),
          new THREE.Vector3(x, h.bl + LIFT, z + 1)
        )
        // close the bottom and right borders
        if (z === map.height - 1) {
          points.push(
            new THREE.Vector3(x,     h.bl + LIFT, z + 1),
            new THREE.Vector3(x + 1, h.br + LIFT, z + 1)
          )
        }
        if (x === map.width - 1) {
          points.push(
            new THREE.Vector3(x + 1, h.tr + LIFT, z),
            new THREE.Vector3(x + 1, h.br + LIFT, z + 1)
          )
        }
      }
    }

    const geometry = new THREE.BufferGeometry().setFromPoints(points)
    const material = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.18 })
    const lines = new THREE.LineSegments(geometry, material)
    lines.visible = state.showTileGrid
    return lines
  }

  function buildObjectShadowInfluences() {
    // Per-vertex darkening [0..1] driven by proximity to placed objects
    const rows = map.height + 1
    const cols = map.width + 1
    const inf = []
    for (let i = 0; i < rows; i++) inf.push(new Float32Array(cols).fill(1.0))

    // Force world matrices to be current before computing bounds
    scene.updateMatrixWorld(true)

    const _box  = new THREE.Box3()
    const _size = new THREE.Vector3()

    for (const obj of placedGroup.children) {
      _box.setFromObject(obj)
      if (_box.isEmpty()) continue
      _box.getSize(_size)

      const asset = assetRegistry.find((a) => a.id === obj.userData.assetId)
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

  function rebuildTerrain({ skipTexturePlanes = false, skipShadows = false } = {}) {
    if (terrainGroup) scene.remove(terrainGroup)
    if (cliffs) scene.remove(cliffs)
    if (splitLines) scene.remove(splitLines)
    if (tileGrid) scene.remove(tileGrid)
    if (textureOverlayGroup) scene.remove(textureOverlayGroup)
    if (!skipTexturePlanes && texturePlaneGroup) scene.remove(texturePlaneGroup)

    map.selectedTexturePlaneId = selectedTexturePlane ? selectedTexturePlane.id : null

    if (!skipShadows) _shadowInfluencesCache = null
    const shadowInf = _shadowInfluencesCache ?? buildObjectShadowInfluences()
    _shadowInfluencesCache = shadowInf

    terrainGroup = buildTerrainMeshes(map, waterTexture, shadowInf)
    cliffs = buildCliffMeshes(map)
    splitLines = buildSplitLines()
    tileGrid = buildTileGrid()
    textureOverlayGroup = buildTextureOverlays(map, textureRegistry, textureCache)

    scene.add(terrainGroup)
    scene.add(cliffs)
    scene.add(splitLines)
    scene.add(tileGrid)
    scene.add(textureOverlayGroup)

    if (!skipTexturePlanes) {
      texturePlaneGroup = buildTexturePlanes(map, textureRegistry, textureCache)
      scene.add(texturePlaneGroup)
    } else if (texturePlaneGroup) {
      scene.add(texturePlaneGroup)
    }

    updateSelectionHelper()
  }

  function updateTexturePlaneMeshTransform(plane) {
    if (!texturePlaneGroup) return
    const mesh = texturePlaneGroup.children.find((m) => m.userData.texturePlane === plane)
    if (!mesh) return
    mesh.position.set(plane.position.x, plane.position.y, plane.position.z)
    mesh.rotation.set(plane.rotation?.x ?? 0, plane.rotation?.y ?? 0, plane.rotation?.z ?? 0)
    mesh.scale.set(plane.scale?.x ?? 1, plane.scale?.y ?? 1, plane.scale?.z ?? 1)
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

  const _hPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
  const _hPlaneTarget = new THREE.Vector3()
  function pickHorizontalPlane(event, y = 0) {
    updateMouse(event)
    raycaster.setFromCamera(mouse, camera)
    _hPlane.constant = -y
    raycaster.ray.intersectPlane(_hPlane, _hPlaneTarget)
    return _hPlaneTarget.length() > 0.001 ? _hPlaneTarget.clone() : null
  }

  const _surfaceQuat = new THREE.Quaternion()

  function pickSurfacePoint(event, excludeObjects = []) {
    updateMouse(event)
    raycaster.setFromCamera(mouse, camera)

    const terrainHits = raycaster.intersectObjects(getTerrainMeshes(), false)

    const eligible = placedGroup.children.filter(o => !excludeObjects.includes(o))
    const placedHits = raycaster.intersectObjects(eligible, true).filter(hit => {
      if (!hit.face) return false
      hit.object.getWorldQuaternion(_surfaceQuat)
      const worldNormalY = hit.face.normal.clone().applyQuaternion(_surfaceQuat).y
      return worldNormalY > 0.5  // only upward-facing surfaces (roofs, floors)
    })

    const planeHits = texturePlaneGroup
      ? raycaster.intersectObjects(texturePlaneGroup.children, true).filter(hit => {
          if (!hit.face) return false
          hit.object.getWorldQuaternion(_surfaceQuat)
          const worldNormalY = hit.face.normal.clone().applyQuaternion(_surfaceQuat).y
          return worldNormalY > 0.5  // only horizontal texture planes
        })
      : []

    const best = [...terrainHits, ...placedHits, ...planeHits].sort((a, b) => a.distance - b.distance)[0]
    return best ? best.point.clone() : null
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
    raycaster.setFromCamera(mouse, camera)
    const hits = raycaster.intersectObjects(placedGroup.children, true)
    if (!hits.length) return null

    let obj = hits[0].object
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

  // import placed objects
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
    model.visible = _importLayer ? _importLayer.visible : true
    placedGroup.add(model)
  }

  rebuildTerrain()
  updateSelectionHelper()
  updateToolUI()
}

  function pickTexturePlane(event) {
    if (!texturePlaneGroup) return null

    updateMouse(event)
    raycaster.setFromCamera(mouse, camera)
    const hits = raycaster.intersectObjects(texturePlaneGroup.children, true)
    if (!hits.length) return null
    return hits[0].object
  }

  // Returns { type: 'placed'|'plane', object, distance } for whichever is closest to camera
  function pickClosestSelectTarget(event) {
    updateMouse(event)
    raycaster.setFromCamera(mouse, camera)

    const placedHits = raycaster.intersectObjects(placedGroup.children, true)
    const planeHits = texturePlaneGroup
      ? raycaster.intersectObjects(texturePlaneGroup.children, true)
      : []

    const bestPlaced = placedHits[0] ?? null
    const bestPlane = planeHits[0] ?? null

    if (!bestPlaced && !bestPlane) return null

    if (bestPlaced && (!bestPlane || bestPlaced.distance <= bestPlane.distance)) {
      let obj = bestPlaced.object
      while (obj.parent && obj.parent !== placedGroup) obj = obj.parent
      return { type: 'placed', object: obj, distance: bestPlaced.distance }
    }

    return { type: 'plane', object: bestPlane.object, distance: bestPlane.distance }
  }

  function tileWorldPosition(x, z) {
    return new THREE.Vector3(
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
    const box = new THREE.Box3().setFromObject(object)
    const size = new THREE.Vector3()
    box.getSize(size)

    return {
      width: Math.max(size.x, 0.1),
      depth: Math.max(size.z, 0.1),
      height: Math.max(size.y, 0.1)
    }
  }

  function scaleObjectToTiles(obj, tiles) {
    // Preserve Y (height) scale — only change horizontal (X/Z)
    const prevYScale = obj.scale.y
    obj.scale.set(1, 1, 1)
    obj.updateWorldMatrix(true, true)
    const box = new THREE.Box3().setFromObject(obj)
    const size = new THREE.Vector3()
    box.getSize(size)
    const naturalLength = Math.max(size.x, size.z)
    if (naturalLength < 0.001) {
      obj.scale.set(1, prevYScale, 1)
      return
    }
    const s = tiles / naturalLength
    obj.scale.set(s, prevYScale, s)
    obj.updateWorldMatrix(true, true)
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
    return p.includes('stone modular') || p.includes('dark stone modular')
  }

  function isModularAsset(assetId) {
    const asset = assetRegistry.find((a) => a.id === assetId)
    return asset?.path?.toLowerCase().includes('modular assets') ?? false
  }

  function findModularEdgeSnap(movingObj, targetX, targetZ) {
    const THRESHOLD = 0.65

    // Local extents relative to the object's position (constant while translating)
    const movingBox = new THREE.Box3().setFromObject(movingObj)
    const lMinX = movingBox.min.x - movingObj.position.x
    const lMaxX = movingBox.max.x - movingObj.position.x
    const lMinZ = movingBox.min.z - movingObj.position.z
    const lMaxZ = movingBox.max.z - movingObj.position.z

    // Predicted bbox at target position
    const tMinX = targetX + lMinX
    const tMaxX = targetX + lMaxX
    const tMinZ = targetZ + lMinZ
    const tMaxZ = targetZ + lMaxZ

    let bestX = null, bestZ = null
    let bestDX = THRESHOLD, bestDZ = THRESHOLD

    for (const other of placedGroup.children) {
      if (selectedPlacedObjects.includes(other)) continue
      if (!isModularAsset(other.userData.assetId)) continue

      const ob = new THREE.Box3().setFromObject(other)

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
      rebuildTerrain()
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

    const vec = direction === 'forward' ? getForwardVector(rotY) : getRightVector(rotY)
    const spacing =
      direction === 'forward'
        ? (source.depth + target.depth) * 0.5
        : (source.width + target.width) * 0.5

    sourcePlane.position.x = targetPlane.position.x + vec.x * spacing
    sourcePlane.position.z = targetPlane.position.z + vec.z * spacing
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
    raycaster.setFromCamera(mouse, camera)
    const hits = raycaster.intersectObjects(texturePlaneGroup.children, true)
    for (const hit of hits) {
      if (!hit.face) continue
      hit.object.getWorldQuaternion(_surfaceQuat)
      const normalY = hit.face.normal.clone().applyQuaternion(_surfaceQuat).y
      if (normalY > 0.5) return hit.point.y
    }
    return null
  }

  function findObjectTopAt(worldX, worldZ, excludeObjects = []) {
    const MARGIN = 0.4
    let bestTop = null
    for (const obj of placedGroup.children) {
      if (excludeObjects.includes(obj)) continue
      if (!obj.visible) continue
      obj.updateWorldMatrix(true, true)
      const box = new THREE.Box3().setFromObject(obj)
      if (box.isEmpty()) continue
      if (
        worldX >= box.min.x - MARGIN && worldX <= box.max.x + MARGIN &&
        worldZ >= box.min.z - MARGIN && worldZ <= box.max.z + MARGIN &&
        (bestTop === null || box.max.y > bestTop)
      ) {
        bestTop = box.max.y
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
    const vec = direction === 'forward' ? getForwardVector(baseRotationY) : getRightVector(baseRotationY)

    const spacing =
      direction === 'forward'
        ? (targetFootprint.depth + sourceFootprint.depth) * 0.5
        : (targetFootprint.width + sourceFootprint.width) * 0.5

    return new THREE.Vector3(
      basePosition.x + vec.x * spacing,
      basePosition.y,
      basePosition.z + vec.z * spacing
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
      rebuildTerrain()
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
function applySmoothBrush(centerX, centerZ) {
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
      map.setVertexHeight(vx, vz, current + (target - current) * weight * 0.55)
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

    if (state.levelMode) {
      if (state.levelHeight === null) {
        state.levelHeight = map.getAverageTileHeight(tile.x, tile.z)
        updateToolUI()
      }

      map.flattenTileToHeight(tile.x, tile.z, state.levelHeight)
      rebuildTerrain({ skipTexturePlanes: true, skipShadows: true })
      return
    }

    if (eventLike?.ctrlKey) {
      applySmoothBrush(tile.x + 0.5, tile.z + 0.5)
    } else if (eventLike?.shiftKey) {
      applyGaussianBrush(tile.x + 0.5, tile.z + 0.5, -0.20)
    } else {
      applyGaussianBrush(tile.x + 0.5, tile.z + 0.5, 0.20)
    }

    rebuildTerrain({ skipTexturePlanes: true, skipShadows: true })
    return
  }

  if (state.tool === ToolMode.PAINT) {
    captureStrokeHistoryOnce()

    if (eventLike?.shiftKey || paintTabTextureId) {
      if (eventLike?.shiftKey || paintTabTextureId === '__erase__') {
        map.clearTextureTile(tile.x, tile.z)
      } else {
        map.paintTextureTile(tile.x, tile.z, paintTabTextureId, textureRotation, textureScale)
      }
      rebuildTerrain({ skipTexturePlanes: true, skipShadows: true })
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

    rebuildTerrain({ skipTexturePlanes: true, skipShadows: true })
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
    if (hoverEdgeHelper) { scene.remove(hoverEdgeHelper); hoverEdgeHelper = null }

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

    const group = new THREE.Group()
    const S = 0.22

    for (let i = 0; i < 4; i++) {
      const { px, pz, ht } = edges[i]
      const y = ht + 0.06
      const active = i === nearestIdx
      const color = active ? 0x55aaff : 0x2255aa
      const opacity = active ? 1.0 : 0.45
      const pts = [
        new THREE.Vector3(px - S, y, pz), new THREE.Vector3(px + S, y, pz),
        new THREE.Vector3(px, y, pz - S), new THREE.Vector3(px, y, pz + S),
      ]
      const geo = new THREE.BufferGeometry().setFromPoints(pts)
      const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity })
      group.add(new THREE.LineSegments(geo, mat))
    }

    hoverEdgeHelper = group
    scene.add(hoverEdgeHelper)
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
    tuneModelLighting(model, asset.path)

    if (isStoneModularAsset(asset)) {
      model.scale.y = 1
      if (asset.name?.toLowerCase().includes('wall')) scaleObjectToTiles(model, 2)
    }

    previewObject = makeGhostMaterial(model)
    previewObject.rotation.y = previewRotation
    previewObject.userData.assetId = asset.id
    scene.add(previewObject)

    const pos = tileWorldPosition(state.hovered.x, state.hovered.z)
    if (asset.name?.toLowerCase().includes('wall')) {
      const snap = getWallEdgeSnap(state.hovered)
      if (snap) { pos.x = snap.x; pos.z = snap.z }
    }
    previewObject.position.copy(pos)
  }

  async function placeSelectedAsset(tile, event) {
    if (!selectedAssetId) return

    const asset = assetRegistry.find((a) => a.id === selectedAssetId)
    if (!asset) return

    const model = await loadAssetModel(asset.path)
    tuneModelLighting(model, asset.path)

    if (isStoneModularAsset(asset)) {
      model.scale.y = 1
      if (asset.name?.toLowerCase().includes('wall')) scaleObjectToTiles(model, 2)
    }

    pushUndoState()

    const pos = tileWorldPosition(tile.x, tile.z)
    if (asset.name?.toLowerCase().includes('wall')) {
      const snap = getWallEdgeSnap(tile)
      if (snap) { pos.x = snap.x; pos.z = snap.z }
    }
    if (event) {
      const objTop = findObjectTopAt(pos.x, pos.z)
      const planeTop = findTexturePlaneTopAt(event)
      if (objTop !== null || planeTop !== null) {
        pos.y = Math.max(objTop ?? -Infinity, planeTop ?? -Infinity)
      } else {
        const sp = pickSurfacePoint(event)
        if (sp) pos.y = sp.y
      }
    }
    model.position.copy(pos)
    model.rotation.y = previewRotation
    model.userData.assetId = asset.id
    model.userData.type = 'asset'
    model.userData.layerId = activeLayerId
    placedGroup.add(model)
    rebuildTerrain()
  }

  function replaceSelectedTexturesWith(textureId) {
    if (!selectedTexturePlanes.length) return
    pushUndoState()
    for (const plane of selectedTexturePlanes) {
      plane.textureId = textureId
    }
    rebuildTerrain()
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
      model.position.copy(obj.position)
      model.rotation.copy(obj.rotation)
      model.scale.copy(obj.scale)
      model.userData.assetId = newAsset.id
      model.userData.type = 'asset'
      model.userData.layerId = obj.userData.layerId || activeLayerId
      const _rLayer = layers.find((l) => l.id === model.userData.layerId)
      model.visible = _rLayer ? _rLayer.visible : true
      placedGroup.remove(obj)
      placedGroup.add(model)
      replacements.push(model)
    }
    selectedPlacedObjects = replacements
    selectedPlacedObject = replacements[replacements.length - 1] || null
    rebuildTerrain()
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
          if (mode === 'forward') {
            snapPlaneFlushAlong(primaryClone, selectedTexturePlane, 'forward')
          } else {
            snapPlaneFlushAlong(primaryClone, selectedTexturePlane, 'right')
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
        rebuildTerrain()
        updateSelectionHelper()
        updateToolUI()
        return
      }

      const clone = JSON.parse(JSON.stringify(selectedTexturePlane))
      clone.id = `plane_${Date.now()}_${Math.floor(Math.random() * 100000)}`

      if (mode === 'stack') {
        stackPlaneAbove(clone, selectedTexturePlane)
      } else if (mode === 'forward') {
        snapPlaneFlushAlong(clone, selectedTexturePlane, 'forward')
      } else {
        snapPlaneFlushAlong(clone, selectedTexturePlane, 'right')
      }

      map.texturePlanes.push(clone)
      selectedTexturePlane = clone
      selectedTexturePlanes = [clone]
      selectedPlacedObject = null
      rebuildTerrain()
      updateSelectionHelper()
      updateToolUI()
      return
    }

    if (selectedPlacedObjects.length > 1) {
      let offsetVec = new THREE.Vector3()

      if (mode !== 'stack') {
        const primaryFootprint = getObjectFootprint(selectedPlacedObject)
        const newPos = snapObjectFlushAlongPosition(
          selectedPlacedObject.position,
          selectedPlacedObject.rotation.y,
          primaryFootprint,
          primaryFootprint,
          mode === 'forward' ? 'forward' : 'right'
        )
        offsetVec = newPos.clone().sub(selectedPlacedObject.position)
      }

      const newModels = []
      for (const src of selectedPlacedObjects) {
        if (!src.userData?.assetId) continue
        const asset = assetRegistry.find((a) => a.id === src.userData.assetId)
        if (!asset) continue

        const model = await loadAssetModel(asset.path)
        tuneModelLighting(model, asset.path)
        model.rotation.copy(src.rotation)
        model.scale.copy(src.scale)
        model.userData.assetId = asset.id
        model.userData.type = 'asset'
        model.userData.layerId = src.userData.layerId || activeLayerId
        placedGroup.add(model)

        if (mode === 'stack') {
          const srcFootprint = getObjectFootprint(src)
          const cloneFootprint = getObjectFootprint(model)
          model.position.copy(src.position)
          model.position.y += (srcFootprint.height + cloneFootprint.height) * 0.5
        } else {
          model.position.copy(src.position).add(offsetVec)
        }

        newModels.push(model)
      }

      if (newModels.length > 0) {
        selectedPlacedObject = newModels[0]
        selectedPlacedObjects = [...newModels]
        selectedTexturePlane = null
      selectedTexturePlanes = []
        rebuildTerrain()
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

      model.rotation.copy(selectedPlacedObject.rotation)
      model.scale.copy(selectedPlacedObject.scale)
      model.userData.assetId = asset.id
      model.userData.type = 'asset'
      model.userData.layerId = selectedPlacedObject.userData.layerId || activeLayerId

      placedGroup.add(model)

      const sourceFootprint = getObjectFootprint(model)

      if (mode === 'stack') {
        model.position.copy(selectedPlacedObject.position)
        model.position.y += (targetFootprint.height + sourceFootprint.height) * 0.5
      } else {
        model.position.copy(
          snapObjectFlushAlongPosition(
            selectedPlacedObject.position,
            selectedPlacedObject.rotation.y,
            targetFootprint,
            sourceFootprint,
            mode === 'forward' ? 'forward' : 'right'
          )
        )
      }

      selectedPlacedObject = model
      selectedPlacedObjects = [model]
      selectedTexturePlane = null
      selectedTexturePlanes = []
      rebuildTerrain()
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

      if (transformStart.groupStarts?.length) {
        for (const { obj, position, rotation } of transformStart.groupStarts) {
          obj.position.copy(position)
          if (rotation) obj.rotation.set(rotation.x, rotation.y, rotation.z)
        }
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
    thumbRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    thumbRenderer.setSize(80, 80)
    thumbRenderer.outputColorSpace = THREE.SRGBColorSpace

    thumbScene = new THREE.Scene()
    thumbScene.background = new THREE.Color(0x1e2230)
    thumbScene.add(new THREE.AmbientLight(0xffffff, 0.75))
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.3)
    dirLight.position.set(4, 7, 5)
    thumbScene.add(dirLight)

    thumbCamera = new THREE.PerspectiveCamera(40, 1, 0.001, 10000)
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

    if (isStoneModularAsset(asset)) {
      model.scale.y = 1
      if (asset.name?.toLowerCase().includes('wall')) scaleObjectToTiles(model, 2)
    }

    // Recompute bounds after any scaling
    const scaledBox = new THREE.Box3().setFromObject(model)
    const scaledSize = new THREE.Vector3()
    scaledBox.getSize(scaledSize)
    const bounds = { width: scaledSize.x, height: scaledSize.y, depth: scaledSize.z }
    const maxDim = Math.max(bounds.width, bounds.height, bounds.depth, 0.01)

    // model is bottom-center pivoted — shift down so it's truly centered
    model.position.set(0, -bounds.height / 2, 0)
    thumbScene.add(model)

    const fovRad = (40 * Math.PI) / 180
    const dist = (maxDim / 2) / Math.tan(fovRad / 2) * 1.6
    thumbCamera.position.set(dist * 0.75, dist * 0.55, dist * 0.75)
    thumbCamera.lookAt(0, 0, 0)
    thumbCamera.near = dist * 0.01
    thumbCamera.far = dist * 10
    thumbCamera.updateProjectionMatrix()

    thumbRenderer.render(thumbScene, thumbCamera)
    const dataUrl = thumbRenderer.domElement.toDataURL()

    thumbScene.remove(model)
    thumbnailCache.set(asset.id, dataUrl)
    return dataUrl
  }

  function refreshAssetList() {
    const q = assetSearch.value.trim().toLowerCase()

    const WALL_FILES = ['stone wall.glb', 'dark stone wall.glb', 'white wall.glb']

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

  function refreshPaintTexturePalette() {
    if (!paintTexturePalette) return
    const q = (paintTextureSearch?.value || '').trim().toLowerCase()
    const list = textureRegistry.filter((tex) => {
      const name = (tex.name || '').toLowerCase()
      return !q || name.includes(q) || String(tex.id).toLowerCase().includes(q)
    })
    paintTexturePalette.innerHTML = ''
    for (const tex of list) {
      const img = document.createElement('img')
      img.src = tex.path
      img.title = tex.name || tex.id
      img.style.cssText = `width:100%;aspect-ratio:1;object-fit:cover;cursor:pointer;border-radius:3px;border:2px solid ${tex.id === paintTabTextureId ? '#2d6cdf' : 'transparent'};`
      img.addEventListener('click', () => {
        paintTabTextureId = tex.id
        setTool(ToolMode.PAINT)
        refreshPaintTexturePalette()
        updateToolUI()
      })
      paintTexturePalette.appendChild(img)
    }
  }

  paintTextureSearch?.addEventListener('input', refreshPaintTexturePalette)

  const eraseTextureBrushBtn = sidebar.querySelector('#eraseTextureBrushBtn')
  eraseTextureBrushBtn?.addEventListener('click', () => {
    paintTabTextureId = '__erase__'
    setTool(ToolMode.PAINT)
    refreshPaintTexturePalette()
    updateToolUI()
  })

  tabProps.addEventListener('click', async () => {
    assetSectionFilter = 'Models'
    assetGroupFilter = 'all'
    tabProps.classList.add('active')
    tabModular.classList.remove('active')
    tabWalls.classList.remove('active')
    assetGroupSelect.style.display = 'none'
    refreshAssetList()
    await updatePreviewObject()
  })

  tabModular.addEventListener('click', async () => {
    assetSectionFilter = 'Modular Assets'
    assetGroupFilter = 'all'
    tabModular.classList.add('active')
    tabProps.classList.remove('active')
    tabWalls.classList.remove('active')
    assetGroupSelect.style.display = ''
    refreshAssetGroupOptions()
    refreshAssetList()
    await updatePreviewObject()
  })

  tabWalls.addEventListener('click', async () => {
    assetSectionFilter = '__walls__'
    assetGroupFilter = 'all'
    tabWalls.classList.add('active')
    tabProps.classList.remove('active')
    tabModular.classList.remove('active')
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

  levelModeBtn.addEventListener('click', () => {
    state.levelMode = !state.levelMode
    state.levelHeight = null
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
    // Try to restore handle from IndexedDB
    try {
      const stored = await idbGet('saveFileHandle')
      if (stored) {
        const perm = await stored.queryPermission({ mode: 'readwrite' })
        if (perm === 'granted') { saveFileHandle = stored; return saveFileHandle }
        const req = await stored.requestPermission({ mode: 'readwrite' })
        if (req === 'granted') { saveFileHandle = stored; return saveFileHandle }
      }
    } catch {}
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
    if (!window.showSaveFilePicker) { downloadJSON('main.json', buildSaveData()); return }
    try {
      let handle = await getSaveHandle()
      if (!handle) {
        handle = await window.showSaveFilePicker({
          suggestedName: 'main.json',
          types: [{ description: 'JSON Map', accept: { 'application/json': ['.json'] } }]
        })
        saveFileHandle = handle
        await idbSet('saveFileHandle', handle)
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

    rebuildTerrain()
    updateSelectionHelper()
    updateToolUI()
  })

  sidebar.querySelector('#toggleSplitLines').addEventListener('change', (e) => {
    state.showSplitLines = e.target.checked
    if (splitLines) splitLines.visible = state.showSplitLines
  })

  sidebar.querySelector('#toggleTileGrid').addEventListener('change', (e) => {
    state.showTileGrid = e.target.checked
    if (tileGrid) tileGrid.visible = state.showTileGrid
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
    heightCullEnabled = !heightCullEnabled
    sidebar.querySelector('#heightCullBtn')?.classList.toggle('active-tool', heightCullEnabled)
    if (heightCullEnabled) applyHeightCull()
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
      previewObject.position.copy(pos)
    }
    updateHoverEdgeHelper()

    const terrainPoint = pickTerrainPoint(event)

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
          const objTop = findObjectTopAt(snappedX, snappedZ, selectedPlacedObjects)
          const planeTop = findTexturePlaneTopAt(event)
          const surfaceTop = Math.max(objTop ?? -Infinity, planeTop ?? -Infinity)
          targetY = surfaceTop > -Infinity ? surfaceTop : (terrainPoint?.y ?? selectedPlacedObject.position.y)
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
    const v = worldPos.clone().project(camera)
    const rect = renderer.domElement.getBoundingClientRect()
    return {
      x: (v.x * 0.5 + 0.5) * rect.width + rect.left,
      y: (-v.y * 0.5 + 0.5) * rect.height + rect.top
    }
  }

  renderer.domElement.addEventListener('mousedown', async (event) => {
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
      state.isPainting = false
      state.draggedTiles.clear()
      state.historyCapturedThisStroke = false

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

          for (const obj of placedGroup.children) {
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
  const target = new THREE.Vector3(12, 2, 12)
  let heightCullEnabled = false

  function applyHeightCull() {
    for (const obj of placedGroup.children) {
      const layer = layers.find((l) => l.id === (obj.userData.layerId || 'layer_0'))
      const layerVisible = layer ? layer.visible : true
      obj.visible = layerVisible && (!heightCullEnabled || obj.position.y <= target.y)
    }
    if (texturePlaneGroup) {
      for (const mesh of texturePlaneGroup.children) {
        const plane = mesh.userData.texturePlane
        if (!plane) continue
        const layer = layers.find((l) => l.id === (plane.layerId || 'layer_0'))
        const layerVisible = layer ? layer.visible : true
        mesh.visible = layerVisible && (!heightCullEnabled || plane.position.y <= target.y)
      }
    }
  }

  function updateCamera() {
    camera.position.x = target.x + Math.cos(yaw) * Math.sin(pitch) * distance
    camera.position.y = target.y + Math.cos(pitch) * distance
    camera.position.z = target.z + Math.sin(yaw) * Math.sin(pitch) * distance
    camera.lookAt(target)
    updateCompass()
    if (heightCullEnabled) applyHeightCull()
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
          const step = Math.PI / 12
          selectedTexturePlane.rotation[axis] += e.deltaY > 0 ? step : -step
          selectedTexturePlane.rotation[axis] = snapAngleToQuarterIfClose(selectedTexturePlane.rotation[axis], 0.08)
        }

        updateTexturePlaneMeshTransform(selectedTexturePlane)
        updateSelectionHelper()
        return
      }

      if (selectedPlacedObject) {
        const delta = e.shiftKey ? (e.deltaY > 0 ? 1 : -1) * 0.1 : (e.deltaY > 0 ? 1 : -1) * (Math.PI / 12)

        selectedPlacedObject.rotation[axis] += delta
        if (!e.shiftKey) selectedPlacedObject.rotation[axis] = snapAngleToQuarterIfClose(selectedPlacedObject.rotation[axis], 0.08)

        for (const obj of selectedPlacedObjects) {
          if (obj === selectedPlacedObject) continue
          obj.rotation[axis] += delta
          if (!e.shiftKey) obj.rotation[axis] = snapAngleToQuarterIfClose(obj.rotation[axis], 0.08)
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
    distance = Math.max(2, Math.min(120, distance))
    updateCamera()
  })

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(window.innerWidth, window.innerHeight)
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
        rebuildTerrain()
        updateSelectionHelper()
        updateToolUI()
        return
      }

      if (selectedPlacedObjects.length > 0) {
        pushUndoState()
        for (const obj of selectedPlacedObjects) placedGroup.remove(obj)
        selectedPlacedObject = null
        selectedPlacedObjects = []
        rebuildTerrain()
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
  pushUndoState()
  applyGaussianBrush(x + 0.5, z + 0.5, 0.18)
  rebuildTerrain({ skipTexturePlanes: true, skipShadows: true })
  return
}

if (key === 'e') {
  pushUndoState()
  applyGaussianBrush(x + 0.5, z + 0.5, -0.18)
  rebuildTerrain({ skipTexturePlanes: true, skipShadows: true })
  return
}

    if (key === 'k') {
      snapSelectedThingNow()
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
    if (key === '5') return setTool(ToolMode.TEXTURE_PLANE)

    if (key === 'v') {
      texturePlaneVertical = !texturePlaneVertical
      updateToolUI()
      return
    }

    if (key === 'x' || key === 'y' || key === 'z') {
      if (transformMode === 'move') {
        if (key === 'x') transformAxis = 'x'
        else if (key === 'y') transformAxis = 'ground-z'
        else if (key === 'z') transformAxis = 'height'
      } else if (transformMode === 'scale') {
        // Z = up (world Y), Y = depth (world Z), X = X — matches move convention
        if (key === 'x') transformAxis = 'x'
        else if (key === 'y') transformAxis = 'z'
        else if (key === 'z') transformAxis = 'y'
      } else {
        transformAxis = key
      }

      updateToolUI()
      return
    }

    if (key === 'g') {
      // If nothing is selected, try to pick whatever is under the cursor
      if (!selectedTexturePlane && !selectedPlacedObject) {
        raycaster.setFromCamera(mouse, camera)

        if (texturePlaneGroup) {
          const hits = raycaster.intersectObjects(texturePlaneGroup.children, true)
          if (hits.length && hits[0].object?.userData?.texturePlane) {
            selectedTexturePlane = hits[0].object.userData.texturePlane
            selectedPlacedObject = null
            setTool(ToolMode.SELECT)
            updateSelectionHelper()
          }
        }

        if (!selectedTexturePlane) {
          const hits = raycaster.intersectObjects(placedGroup.children, true)
          if (hits.length) {
            let obj = hits[0].object
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

    if (key === 'a' && event.shiftKey) {
      await duplicateSelected('stack')
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
      tabProps.classList.add('active')
      tabModular.classList.remove('active')
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
      refreshPaintTexturePalette()
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
  buildGroundSwatches()
  refreshLayersPanel()
  updateToolUI()
  initAssets()
  initTextures()
  pushUndoState()

  function animate() {
    requestAnimationFrame(animate)
    if (Array.isArray(selectionHelper)) {
      for (const h of selectionHelper) h.update()
    } else if (selectionHelper) {
      selectionHelper.update()
    }
    const t = performance.now() * 0.0003
    waterTexture.offset.set(t * 0.18, t * 0.09)
    renderer.render(scene, camera)
  }

  animate()
}