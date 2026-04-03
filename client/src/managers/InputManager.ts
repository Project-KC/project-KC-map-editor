import { Scene } from '@babylonjs/core/scene';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { Plane } from '@babylonjs/core/Maths/math.plane';
import { PointerEventTypes } from '@babylonjs/core/Events/pointerEvents';
import '@babylonjs/core/Culling/ray';
import type { ChunkManager } from '../rendering/ChunkManager';

export type GroundClickCallback = (worldX: number, worldZ: number) => void;
export type ObjectClickCallback = (objectEntityId: number) => void;

/**
 * Handles mouse/keyboard input for the game.
 *
 * Ground clicks use ray-plane projection at player height so that walls,
 * placed objects, and other vertical geometry never block the click target.
 * Pathfinding handles obstacle avoidance.
 */
export class InputManager {
  private scene: Scene;
  private chunkManager: ChunkManager;
  private onGroundClick: GroundClickCallback | null = null;
  private onObjectClick: ObjectClickCallback | null = null;
  private playerY: number = 0;

  constructor(scene: Scene, chunkManager: ChunkManager) {
    this.scene = scene;
    this.chunkManager = chunkManager;

    this.scene.onPointerObservable.add((pointerInfo) => {
      if (pointerInfo.type === PointerEventTypes.POINTERDOWN) {
        if (pointerInfo.event.button !== 0) return;

        // Check for interactive object hit (trees, rocks, doors)
        // Use multiPick to check ALL meshes along the ray — walls won't block doors behind them
        if (this.onObjectClick) {
          const picks = this.scene.multiPick(this.scene.pointerX, this.scene.pointerY);
          if (picks) {
            for (const pick of picks) {
              if (!pick.hit || !pick.pickedMesh) continue;
              let node: any = pick.pickedMesh;
              while (node) {
                if (node.metadata?.objectEntityId != null) {
                  this.onObjectClick(node.metadata.objectEntityId);
                  return;
                }
                node = node.parent;
              }
            }
          }
        }

        // Ground click: project ray onto horizontal plane at player height.
        // This ignores walls and objects entirely — click WHERE you want to go.
        const groundPos = this.pickGround();
        if (groundPos) {
          this.onGroundClick?.(groundPos.x, groundPos.z);
        }
      }
    });
  }

  /** Update the current player Y height (call each frame during movement) */
  setPlayerY(y: number): void {
    this.playerY = y;
  }

  /**
   * Project the click ray onto a horizontal plane at the player's Y height.
   * Simple, predictable, and never blocked by vertical geometry.
   */
  private pickGround(): { x: number; z: number } | null {
    if (!this.scene.activeCamera) return null;

    const ray = this.scene.createPickingRay(
      this.scene.pointerX,
      this.scene.pointerY,
      null,
      this.scene.activeCamera
    );

    if (ray.direction.y === 0) return null;

    const t = (this.playerY - ray.origin.y) / ray.direction.y;
    if (t <= 0) return null;

    return {
      x: ray.origin.x + ray.direction.x * t,
      z: ray.origin.z + ray.direction.z * t,
    };
  }

  setGroundClickHandler(callback: GroundClickCallback): void {
    this.onGroundClick = callback;
  }

  setObjectClickHandler(callback: ObjectClickCallback): void {
    this.onObjectClick = callback;
  }

  setIndoorCheck(check: () => { indoors: boolean; playerY: number }): void {
    // Kept for API compatibility — indoor handling is now implicit via playerY
  }
}
