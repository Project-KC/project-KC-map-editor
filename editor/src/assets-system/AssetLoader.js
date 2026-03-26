import { SceneLoader } from '@babylonjs/core/Loading/sceneLoader'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { Color3 } from '@babylonjs/core/Maths/math.color'
import '@babylonjs/loaders/glTF'

const cache = new Map()           // path -> { template: TransformNode, animGroups: AnimationGroup[] }

let _scene = null

/** Must be called once with the Babylon.js scene before loading any assets */
export function initAssetLoader(scene) {
  _scene = scene
}

async function buildCenteredPivotTemplate(meshes, root) {
  // Compute world-space bounding box of all meshes
  let minX = Infinity, maxX = -Infinity
  let minY = Infinity, maxY = -Infinity
  let minZ = Infinity, maxZ = -Infinity
  for (const mesh of meshes) {
    if (mesh.getTotalVertices && mesh.getTotalVertices() === 0) continue
    mesh.computeWorldMatrix(true)
    const bb = mesh.getBoundingInfo().boundingBox
    if (bb.minimumWorld.x < minX) minX = bb.minimumWorld.x
    if (bb.maximumWorld.x > maxX) maxX = bb.maximumWorld.x
    if (bb.minimumWorld.y < minY) minY = bb.minimumWorld.y
    if (bb.maximumWorld.y > maxY) maxY = bb.maximumWorld.y
    if (bb.minimumWorld.z < minZ) minZ = bb.minimumWorld.z
    if (bb.maximumWorld.z > maxZ) maxZ = bb.maximumWorld.z
  }

  const centerX = (minX + maxX) / 2
  const centerZ = (minZ + maxZ) / 2
  const sizeX = maxX - minX
  const sizeY = maxY - minY
  const sizeZ = maxZ - minZ

  // Create pivot TransformNode at bottom-center
  const pivot = new TransformNode('asset-pivot', _scene)

  // Offset root so model's bottom-center aligns with pivot's origin
  root.parent = pivot
  root.position.x -= centerX
  root.position.y -= minY
  root.position.z -= centerZ

  pivot.metadata = {
    bounds: { width: sizeX, height: sizeY, depth: sizeZ }
  }

  return pivot
}

export async function loadAssetModel(path) {
  if (!_scene) throw new Error('AssetLoader not initialized — call initAssetLoader(scene) first')

  if (!cache.has(path)) {
    const encodedPath = path.split('/').map(s => encodeURIComponent(s)).join('/')
    const lastSlash = encodedPath.lastIndexOf('/')
    const dir = encodedPath.substring(0, lastSlash + 1)
    const file = encodedPath.substring(lastSlash + 1)

    const result = await SceneLoader.ImportMeshAsync('', dir, file, _scene)
    const root = result.meshes[0]
    const template = await buildCenteredPivotTemplate(result.meshes, root)

    // Stop auto-played animations on template (they'll be cloned per instance)
    const animGroups = result.animationGroups || []
    for (const ag of animGroups) ag.stop()

    template.setEnabled(false)
    cache.set(path, { template, animGroups })
  }

  const { template, animGroups } = cache.get(path)
  const instance = template.instantiateHierarchy(null, undefined, (source, cloned) => {
    cloned.name = `placed_${source.name}`
  })
  if (instance) {
    instance.setEnabled(true)
    for (const child of instance.getChildMeshes()) {
      child.setEnabled(true)
    }
    // Copy bounds metadata and initialize userData for compatibility
    instance.metadata = { ...(template.metadata || {}) }
    instance.userData = { bounds: instance.metadata?.bounds || null }

    // Add .scale alias for .scaling (Three.js compat for scene.js code)
    if (!instance.scale && instance.scaling) {
      Object.defineProperty(instance, 'scale', {
        get() { return this.scaling },
        set(v) { if (v && v.x !== undefined) this.scaling.copyFrom(v) }
      })
    }
  }

  // Note: AnimationGroup.clone() doesn't exist in Babylon.js 7.
  // For placed objects in the editor, animations are not critical.
  // The original animation groups from the template will still animate
  // the template's meshes. Per-instance animations would require manual
  // retargeting which is complex and not needed for an editor.

  return instance
}

export function getAssetAnimations(path) {
  const entry = cache.get(path)
  return entry ? entry.animGroups : []
}

export function makeGhostMaterial(sourceModel) {
  if (!_scene) return null

  const ghost = sourceModel.instantiateHierarchy(null, undefined, (source, cloned) => {
    cloned.name = `ghost_${source.name}`
  })

  if (!ghost) return null

  ghost.setEnabled(true)
  ghost.userData = {}
  if (!ghost.scale && ghost.scaling) {
    Object.defineProperty(ghost, 'scale', {
      get() { return this.scaling },
      set(v) { if (v && v.x !== undefined) this.scaling.copyFrom(v) }
    })
  }
  const ghostMat = new StandardMaterial('ghost-material', _scene)
  ghostMat.diffuseColor = new Color3(1, 1, 1)
  ghostMat.specularColor = new Color3(0, 0, 0)
  ghostMat.alpha = 0.55

  for (const mesh of ghost.getChildMeshes()) {
    mesh.setEnabled(true)
    mesh.material = ghostMat
  }

  return ghost
}
