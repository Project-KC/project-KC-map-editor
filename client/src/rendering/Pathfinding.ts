interface PathNode {
  x: number;
  z: number;
  g: number;
  h: number;
  f: number;
  parent: PathNode | null;
  heapIdx: number;
}

/** Binary min-heap for A* open list, keyed by f value */
class MinHeap {
  private data: PathNode[] = [];

  get length(): number { return this.data.length; }

  push(node: PathNode): void {
    node.heapIdx = this.data.length;
    this.data.push(node);
    this.bubbleUp(this.data.length - 1);
  }

  pop(): PathNode {
    const top = this.data[0];
    const last = this.data.pop()!;
    if (this.data.length > 0) {
      this.data[0] = last;
      last.heapIdx = 0;
      this.sinkDown(0);
    }
    return top;
  }

  decreaseKey(node: PathNode): void {
    this.bubbleUp(node.heapIdx);
  }

  private bubbleUp(i: number): void {
    const node = this.data[i];
    while (i > 0) {
      const parentIdx = (i - 1) >> 1;
      const parent = this.data[parentIdx];
      if (node.f >= parent.f) break;
      this.data[i] = parent;
      parent.heapIdx = i;
      i = parentIdx;
    }
    this.data[i] = node;
    node.heapIdx = i;
  }

  private sinkDown(i: number): void {
    const len = this.data.length;
    const node = this.data[i];
    while (true) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < len && this.data[left].f < this.data[smallest].f) smallest = left;
      if (right < len && this.data[right].f < this.data[smallest].f) smallest = right;
      if (smallest === i) break;
      this.data[i] = this.data[smallest];
      this.data[i].heapIdx = i;
      i = smallest;
    }
    this.data[i] = node;
    node.heapIdx = i;
  }
}

/**
 * A* pathfinding on a 2D tile grid with binary heap.
 * isBlocked(x, z) returns true if tile is impassable.
 * mapWidth/mapHeight define the map bounds.
 */
export function findPath(
  startX: number,
  startZ: number,
  goalX: number,
  goalZ: number,
  isBlocked: (x: number, z: number) => boolean,
  mapWidth: number = 1024,
  mapHeight: number = 1024,
  maxSteps: number = 200,
  isWallBlocked?: (fx: number, fz: number, tx: number, tz: number) => boolean
): { x: number; z: number }[] {
  const sx = Math.floor(startX);
  const sz = Math.floor(startZ);
  const gx = Math.floor(goalX);
  const gz = Math.floor(goalZ);

  if (sx === gx && sz === gz) return [];
  if (isBlocked(gx, gz)) {
    const neighbors = getNeighbors(gx, gz, isBlocked);
    let bestNeighbor: { x: number; z: number } | null = null;
    let bestDist = Infinity;
    for (const n of neighbors) {
      if (!isBlocked(n.x, n.z)) {
        const dist = Math.abs(n.x - sx) + Math.abs(n.z - sz);
        if (dist < bestDist) {
          bestDist = dist;
          bestNeighbor = n;
        }
      }
    }
    if (!bestNeighbor) return [];
    return findPath(startX, startZ, bestNeighbor.x + 0.5, bestNeighbor.z + 0.5, isBlocked, mapWidth, mapHeight, maxSteps, isWallBlocked);
  }

  const open = new MinHeap();
  const closed = new Set<number>();
  const openMap = new Map<number, PathNode>();

  const key = (x: number, z: number) => z * mapWidth + x;
  const heuristic = (x: number, z: number) => {
    const dx = Math.abs(x - gx);
    const dz = Math.abs(z - gz);
    return Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz);
  };

  const startH = heuristic(sx, sz);
  const startNode: PathNode = { x: sx, z: sz, g: 0, h: startH, f: startH, parent: null, heapIdx: 0 };
  open.push(startNode);
  openMap.set(key(sx, sz), startNode);

  let steps = 0;
  while (open.length > 0 && steps < maxSteps) {
    steps++;

    const current = open.pop();
    const k = key(current.x, current.z);
    openMap.delete(k);

    if (current.x === gx && current.z === gz) {
      const path: { x: number; z: number }[] = [];
      let node: PathNode | null = current;
      while (node && !(node.x === sx && node.z === sz)) {
        path.unshift({ x: node.x + 0.5, z: node.z + 0.5 });
        node = node.parent;
      }
      return path;
    }

    closed.add(k);

    for (const neighbor of getNeighbors(current.x, current.z, isBlocked, isWallBlocked)) {
      const nk = key(neighbor.x, neighbor.z);
      if (closed.has(nk)) continue;
      if (neighbor.x < 0 || neighbor.x >= mapWidth || neighbor.z < 0 || neighbor.z >= mapHeight) continue;
      if (isBlocked(neighbor.x, neighbor.z)) continue;
      if (isWallBlocked && isWallBlocked(current.x, current.z, neighbor.x, neighbor.z)) continue;

      const isDiagonal = neighbor.x !== current.x && neighbor.z !== current.z;
      const g = current.g + (isDiagonal ? 1.414 : 1);

      const existing = openMap.get(nk);
      if (existing) {
        if (g < existing.g) {
          existing.g = g;
          existing.f = g + existing.h;
          existing.parent = current;
          open.decreaseKey(existing);
        }
        continue;
      }

      const h = heuristic(neighbor.x, neighbor.z);
      const node: PathNode = { x: neighbor.x, z: neighbor.z, g, h, f: g + h, parent: current, heapIdx: 0 };
      open.push(node);
      openMap.set(nk, node);
    }
  }

  return [];
}

function getNeighbors(
  x: number, z: number,
  isBlocked: (x: number, z: number) => boolean,
  isWallBlocked?: (fx: number, fz: number, tx: number, tz: number) => boolean
): { x: number; z: number }[] {
  const neighbors = [
    { x: x - 1, z },
    { x: x + 1, z },
    { x, z: z - 1 },
    { x, z: z + 1 },
  ];

  const wb = isWallBlocked || (() => false);
  const canW = !isBlocked(x - 1, z) && !wb(x, z, x - 1, z);
  const canE = !isBlocked(x + 1, z) && !wb(x, z, x + 1, z);
  const canN = !isBlocked(x, z - 1) && !wb(x, z, x, z - 1);
  const canS = !isBlocked(x, z + 1) && !wb(x, z, x, z + 1);
  if (canW && canN) neighbors.push({ x: x - 1, z: z - 1 });
  if (canE && canN) neighbors.push({ x: x + 1, z: z - 1 });
  if (canW && canS) neighbors.push({ x: x - 1, z: z + 1 });
  if (canE && canS) neighbors.push({ x: x + 1, z: z + 1 });

  return neighbors;
}
