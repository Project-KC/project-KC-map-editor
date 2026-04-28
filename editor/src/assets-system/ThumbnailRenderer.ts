import { Engine } from '@babylonjs/core/Engines/engine'
import { Scene } from '@babylonjs/core/scene'
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera'
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight'
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color'
import { SceneLoader } from '@babylonjs/core/Loading/sceneLoader'
import type { ISceneLoaderAsyncResult } from '@babylonjs/core/Loading/sceneLoader'
import type { Material } from '@babylonjs/core/Materials/material'
import '@babylonjs/loaders/glTF'
import { getCachedThumb, putCachedThumb } from './ThumbnailCache'

const THUMB_SIZE = 128
// Bump to invalidate every cached thumbnail across clients.
const THUMB_VERSION = 1
const RENDER_TIMEOUT_MS = 10000

let _engine: Engine | null = null
let _scene: Scene | null = null
let _camera: ArcRotateCamera | null = null
let _canvas: HTMLCanvasElement | null = null

function ensureEngine(): void {
  if (_engine) return
  _canvas = document.createElement('canvas')
  _canvas.width = THUMB_SIZE
  _canvas.height = THUMB_SIZE
  _engine = new Engine(_canvas, true, { preserveDrawingBuffer: true, antialias: true })
  _scene = new Scene(_engine)
  _scene.useRightHandedSystem = true
  _scene.clearColor = new Color4(0, 0, 0, 0)

  const ambient = new HemisphericLight('thumb-ambient', new Vector3(0, 1, 0), _scene)
  ambient.intensity = 0.9
  ambient.diffuse = new Color3(0.55, 0.55, 0.55)
  ambient.groundColor = new Color3(0.35, 0.33, 0.30)
  ambient.specular = new Color3(0, 0, 0)

  const sun = new DirectionalLight('thumb-sun', new Vector3(-0.5, -1, -0.3), _scene)
  sun.intensity = 1.1
  sun.diffuse = new Color3(1.0, 0.84, 0.54)

  const fill = new DirectionalLight('thumb-fill', new Vector3(0.3, -0.6, 0.5), _scene)
  fill.intensity = 0.65
  fill.diffuse = new Color3(0.67, 0.73, 0.80)

  _camera = new ArcRotateCamera(
    'thumb-cam',
    -Math.PI / 4,
    Math.PI / 2.6,
    10,
    Vector3.Zero(),
    _scene
  )
  _camera.minZ = 0.01
  _camera.maxZ = 1000
  _camera.fov = 0.8
}

interface QueueItem {
  path: string
  resolve: (value: string | null) => void
}

const queue: QueueItem[] = []
let processing = false

function enqueue(path: string): Promise<string | null> {
  return new Promise((resolve) => {
    queue.push({ path, resolve })
    if (!processing) processQueue()
  })
}

async function processQueue(): Promise<void> {
  processing = true
  while (queue.length > 0) {
    const { path, resolve } = queue.shift()!
    try {
      const url = await withTimeout(renderOne(path), RENDER_TIMEOUT_MS)
      resolve(url)
    } catch (err) {
      console.warn('[ThumbnailRenderer] render failed for', path, err)
      resolve(null)
    }
  }
  processing = false
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('thumbnail render timeout')), ms)
    promise.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) }
    )
  })
}

async function renderOne(path: string): Promise<string | null> {
  ensureEngine()

  const encodedPath = path.split('/').map((s) => encodeURIComponent(s)).join('/')
  const lastSlash = encodedPath.lastIndexOf('/')
  const dir = encodedPath.substring(0, lastSlash + 1)
  const file = encodedPath.substring(lastSlash + 1)

  const result: ISceneLoaderAsyncResult = await SceneLoader.ImportMeshAsync('', dir, file, _scene!)

  for (const ag of result.animationGroups || []) ag.stop()

  let minX = Infinity, maxX = -Infinity
  let minY = Infinity, maxY = -Infinity
  let minZ = Infinity, maxZ = -Infinity
  for (const mesh of result.meshes) {
    if (!mesh.getTotalVertices || mesh.getTotalVertices() === 0) continue
    if (mesh.material) (mesh.material as any).backFaceCulling = false
    mesh.computeWorldMatrix(true)
    const bb = mesh.getBoundingInfo().boundingBox
    if (bb.minimumWorld.x < minX) minX = bb.minimumWorld.x
    if (bb.maximumWorld.x > maxX) maxX = bb.maximumWorld.x
    if (bb.minimumWorld.y < minY) minY = bb.minimumWorld.y
    if (bb.maximumWorld.y > maxY) maxY = bb.maximumWorld.y
    if (bb.minimumWorld.z < minZ) minZ = bb.minimumWorld.z
    if (bb.maximumWorld.z > maxZ) maxZ = bb.maximumWorld.z
  }

  let dataUrl: string | null = null
  if (Number.isFinite(minX)) {
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    const cz = (minZ + maxZ) / 2
    const sizeMax = Math.max(maxX - minX, maxY - minY, maxZ - minZ) || 1
    _camera!.setTarget(new Vector3(cx, cy, cz))
    _camera!.radius = (sizeMax / Math.tan(_camera!.fov / 2)) * 0.75

    await _scene!.whenReadyAsync()
    // Two renders: first compiles shaders, second produces correct pixels.
    _scene!.render()
    _scene!.render()
    dataUrl = _canvas!.toDataURL('image/png')
  }

  disposeImportResult(result)

  return dataUrl
}

function disposeImportResult(result: ISceneLoaderAsyncResult): void {
  const materialsSeen = new Set<Material>()
  for (const ag of result.animationGroups || []) {
    try { ag.dispose() } catch { /* ignore */ }
  }
  for (const skel of result.skeletons || []) {
    try { skel.dispose() } catch { /* ignore */ }
  }
  for (const mesh of result.meshes || []) {
    if (mesh.material) materialsSeen.add(mesh.material)
    try { mesh.dispose(false, false) } catch { /* ignore */ }
  }
  for (const tn of result.transformNodes || []) {
    try { tn.dispose(false, false) } catch { /* ignore */ }
  }
  for (const mat of materialsSeen) {
    try {
      const textures = mat.getActiveTextures ? mat.getActiveTextures() : []
      for (const tex of textures) {
        try { tex.dispose() } catch { /* ignore */ }
      }
      mat.dispose()
    } catch { /* ignore */ }
  }
}

export async function getThumbnail(path: string): Promise<string | null> {
  if (!path) return null
  const cached = await getCachedThumb(path, THUMB_VERSION)
  if (cached) return cached
  const rendered = await enqueue(path)
  if (rendered) putCachedThumb(path, rendered, THUMB_VERSION)
  return rendered
}
