import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

const loader = new GLTFLoader()
const cache = new Map()

export async function loadAssetModel(path) {
  if (cache.has(path)) {
    return cache.get(path).clone(true)
  }

  const gltf = await loader.loadAsync(path)
  const root = gltf.scene || gltf.scenes[0]

  root.traverse((obj) => {
    if (obj.isMesh) {
      obj.castShadow = true
      obj.receiveShadow = true
    }
  })

  cache.set(path, root)
  return root.clone(true)
}

export function makeGhostMaterial(object) {
  object.traverse((obj) => {
    if (obj.isMesh) {
      obj.material = new THREE.MeshLambertMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.55
      })
    }
  })
  return object
}