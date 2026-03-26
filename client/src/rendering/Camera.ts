import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Scene } from '@babylonjs/core/scene';

export class GameCamera {
  private camera: ArcRotateCamera;
  private targetPosition: Vector3;

  constructor(scene: Scene, canvas: HTMLCanvasElement) {
    this.targetPosition = new Vector3(32, 0, 32);

    this.camera = new ArcRotateCamera(
      'gameCamera',
      -Math.PI / 4,    // horizontal rotation (45 degrees)
      Math.PI / 3.2,   // vertical angle (~56 degrees — nice isometric feel)
      25,              // zoom distance
      this.targetPosition.clone(),
      scene
    );

    // Constrain camera
    this.camera.lowerBetaLimit = 0.4;
    this.camera.upperBetaLimit = Math.PI / 2.2;
    this.camera.lowerRadiusLimit = 12;
    this.camera.upperRadiusLimit = 50;

    // Smooth camera
    this.camera.inertia = 0.9;
    this.camera.panningInertia = 0.9;

    // Only allow rotation and zoom, not panning
    this.camera.panningSensibility = 0; // disable panning

    this.camera.attachControl(canvas, true);

    // Use middle mouse button for rotation so left-click is free for game input
    (this.camera.inputs.attached.pointers as any).buttons = [1]; // middle button only

    // Remove built-in keyboard input — we handle WASD manually
    this.camera.inputs.removeByType('ArcRotateCameraKeyboardMoveInput');
  }

  followTarget(position: Vector3): void {
    // Smooth follow — lerp camera target toward player
    const speed = 0.2;
    this.camera.target.x += (position.x - this.camera.target.x) * speed;
    this.camera.target.y += (position.y - this.camera.target.y) * speed;
    this.camera.target.z += (position.z - this.camera.target.z) * speed;
  }

  getCamera(): ArcRotateCamera {
    return this.camera;
  }
}
