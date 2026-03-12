export async function loadAssetRegistry() {
  const response = await fetch('/assets/assets.json')
  if (!response.ok) {
    throw new Error('Failed to load /assets/assets.json')
  }

  const data = await response.json()

  let assets = []

  if (Array.isArray(data)) {
    assets = data
  } else if (Array.isArray(data.assets)) {
    assets = data.assets
  }

  return assets
    .filter((asset) => asset.path && asset.path.toLowerCase().endsWith('.glb'))
    .map((asset) => ({
      id: asset.id || asset.name || asset.path,
      name: asset.name || asset.id || asset.path.split('/').pop().replace('.glb', ''),
      path: asset.path
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}