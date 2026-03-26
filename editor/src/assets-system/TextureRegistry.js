export async function loadTextureRegistry() {
  const response = await fetch('/assets/textures/textures.json')

  if (!response.ok) {
    throw new Error(`Failed to load textures.json: ${response.status}`)
  }

  const data = await response.json()

  let textures = []

  if (Array.isArray(data)) {
    textures = data
  } else if (Array.isArray(data.textures)) {
    textures = data.textures
  } else {
    throw new Error('textures.json must be either an array or { "textures": [...] }')
  }

  return textures
    .map((tex) => ({
      id: tex.id || tex.file || tex.name,
      name: tex.name || tex.id || tex.file || 'Unnamed Texture',
      path: tex.path || `/assets/textures/${tex.file}`,
      ...(tex.defaultScale != null && { defaultScale: tex.defaultScale })
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}