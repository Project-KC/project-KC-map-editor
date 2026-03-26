export const ToolMode = {
  TERRAIN: 'terrain',
  PAINT: 'paint',
  PLACE: 'place',
  SELECT: 'select',
  TEXTURE: 'texture',
  TEXTURE_PLANE: 'texture_plane'
}

export function toolLabel(mode) {
  if (mode === ToolMode.TERRAIN) return 'Terrain Tool'
  if (mode === ToolMode.PAINT) return 'Paint Tool'
  if (mode === ToolMode.PLACE) return 'Place Asset'
  if (mode === ToolMode.SELECT) return 'Select'
  if (mode === ToolMode.TEXTURE) return 'Texture Paint'
  if (mode === ToolMode.TEXTURE_PLANE) return 'Texture Plane'
  return 'Unknown Tool'
}