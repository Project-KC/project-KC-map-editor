import { Scene } from '@babylonjs/core/scene';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { PointerEventTypes } from '@babylonjs/core/Events/pointerEvents';
import '@babylonjs/core/Culling/ray';
import type { ChunkManager } from '../rendering/ChunkManager';

export type GroundClickCallback = (worldX: number, worldZ: number) => void;

/**
 * Handles mouse/keyboard input for the game.
 * Click-to-move: detects clicks on chunk terrain meshes and reports world coordinates.
 */
export class InputManager {
  private scene: Scene;
  private chunkManager: ChunkManager;
  private onGroundClick: GroundClickCallback | null = null;

  constructor(scene: Scene, chunkManager: ChunkManager) {
    this.scene = scene;
    this.chunkManager = chunkManager;

    this.scene.onPointerObservable.add((pointerInfo) => {
      if (pointerInfo.type === PointerEventTypes.POINTERDOWN) {
        // Only left click
        if (pointerInfo.event.button !== 0) return;

        const pickResult = this.scene.pick(
          this.scene.pointerX,
          this.scene.pointerY,
          (mesh) => this.chunkManager.isWalkableMesh(mesh.name)
        );

        if (pickResult?.hit && pickResult.pickedPoint) {
          const point = pickResult.pickedPoint;
          this.onGroundClick?.(point.x, point.z);
        }
      }
    });
  }

  setGroundClickHandler(callback: GroundClickCallback): void {
    this.onGroundClick = callback;
  }
}
