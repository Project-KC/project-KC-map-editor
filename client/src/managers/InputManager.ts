import { Scene } from '@babylonjs/core/scene';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Node } from '@babylonjs/core/node';
import { Plane } from '@babylonjs/core/Maths/math.plane';
import { PointerEventTypes } from '@babylonjs/core/Events/pointerEvents';
import '@babylonjs/core/Culling/ray';
import type { ChunkManager } from '../rendering/ChunkManager';

export type GroundClickCallback = (worldX: number, worldZ: number) => void;
export type TeleportClickCallback = (worldX: number, worldZ: number) => void;
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
  private onTeleportClick: TeleportClickCallback | null = null;
  private onObjectClick: ObjectClickCallback | null = null;
  private playerY: number = 0;

  constructor(scene: Scene, chunkManager: ChunkManager) {
    this.scene = scene;
    this.chunkManager = chunkManager;

    this.scene.onPointerObservable.add((pointerInfo) => {
      if (pointerInfo.type === PointerEventTypes.POINTERDOWN) {
        if (pointerInfo.event.button !== 0) return;

        // Shift+click = debug teleport
        if (pointerInfo.event.shiftKey && this.onTeleportClick) {
          const groundPos = this.pickGround();
          if (groundPos) {
            this.onTeleportClick(groundPos.x, groundPos.z);
          }
          return;
        }

        // Check for interactive object hit (trees, rocks, doors)
        // Use scene.pick (closest to camera) for objects — prevents clicking
        // a rock behind another rock or through terrain
        if (this.onObjectClick) {
          const pick = this.scene.pick(
            this.scene.pointerX,
            this.scene.pointerY,
            (mesh) => {
              // Only pick meshes that belong to interactive objects
              let node: Node | null = mesh;
              while (node) {
                if (node.metadata?.objectEntityId != null) return true;
                node = node.parent;
              }
              return false;
            },
            false,
            this.scene.activeCamera!
          );
          if (pick?.hit && pick.pickedMesh) {
            let node: Node | null = pick.pickedMesh;
            while (node) {
              if (node.metadata?.objectEntityId != null) {
                this.onObjectClick(node.metadata.objectEntityId);
                return;
              }
              node = node.parent;
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
   * Pick the ground tile the cursor is over by raycasting against terrain chunks.
   * Falls back to horizontal plane projection if no terrain mesh is hit.
   * Result is snapped to tile center for predictable RS2-style movement.
   */
  private pickGround(): { x: number; z: number } | null {
    if (!this.scene.activeCamera) return null;

    // Raycast against terrain chunk meshes (named "chunk_X_Z")
    const pick = this.scene.pick(
      this.scene.pointerX,
      this.scene.pointerY,
      (mesh) => mesh.name.startsWith('chunk_') && mesh.isEnabled() && mesh.isVisible,
      false,
      this.scene.activeCamera
    );

    if (pick?.hit && pick.pickedPoint) {
      // Snap to tile center
      return {
        x: Math.floor(pick.pickedPoint.x) + 0.5,
        z: Math.floor(pick.pickedPoint.z) + 0.5,
      };
    }

    // Fallback: project onto horizontal plane at player height
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
      x: Math.floor(ray.origin.x + ray.direction.x * t) + 0.5,
      z: Math.floor(ray.origin.z + ray.direction.z * t) + 0.5,
    };
  }

  setGroundClickHandler(callback: GroundClickCallback): void {
    this.onGroundClick = callback;
  }

  setTeleportClickHandler(callback: TeleportClickCallback): void {
    this.onTeleportClick = callback;
  }

  setObjectClickHandler(callback: ObjectClickCallback): void {
    this.onObjectClick = callback;
  }

  setIndoorCheck(check: () => { indoors: boolean; playerY: number }): void {
    // Kept for API compatibility — indoor handling is now implicit via playerY
  }
}
