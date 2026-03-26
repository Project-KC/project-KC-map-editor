function humanizeName(value) {
  return String(value || '')
    .replace(/%20/g, ' ')
    .replace(/[-_]+/g, ' ')
    .replace(/\.glb$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (m) => m.toUpperCase())
}

function deriveAssetMeta(path) {
  const normalized = decodeURIComponent(String(path || '').replace(/\\/g, '/'))
  const parts = normalized.split('/').filter(Boolean)

  const assetsIndex = parts.findIndex((p) => p.toLowerCase() === 'assets')
  const rel = assetsIndex >= 0 ? parts.slice(assetsIndex + 1) : parts

  let section = 'Other'
  let group = 'General'

  if (rel[0]?.toLowerCase() === 'models') {
    section = 'Models'
    group = 'Base Models'
  } else if (rel[0]?.toLowerCase() === 'modular assets') {
    section = 'Modular Assets'
    group = rel[1] ? humanizeName(rel[1]) : 'General'
  } else {
    section = rel[0] ? humanizeName(rel[0]) : 'Other'
    group = rel[1] ? humanizeName(rel[1]) : 'General'
  }

  return {
    section,
    group,
    folderPath: rel.slice(0, -1).map(humanizeName).join(' / ')
  }
}

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
    .map((asset) => {
      const meta = deriveAssetMeta(asset.path)
      const fileName = asset.path.split('/').pop() || 'asset.glb'

      return {
        id: asset.id || asset.name || asset.path,
        name: asset.name || humanizeName(fileName),
        path: asset.path,
        section: asset.section || meta.section,
        group: asset.group || meta.group,
        folderPath: meta.folderPath,
        tags: Array.isArray(asset.tags) ? asset.tags : []
      }
    })
    .sort((a, b) => {
      if (a.section !== b.section) return a.section.localeCompare(b.section)
      if (a.group !== b.group) return a.group.localeCompare(b.group)
      return a.name.localeCompare(b.name)
    })
}