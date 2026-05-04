import { Scene } from '@babylonjs/core/scene';
import { SceneLoader } from '@babylonjs/core/Loading/sceneLoader';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import { Skeleton } from '@babylonjs/core/Bones/skeleton';
import { Bone } from '@babylonjs/core/Bones/bone';
import { AnimationGroup } from '@babylonjs/core/Animations/animationGroup';
import { Animation } from '@babylonjs/core/Animations/animation';
import { Vector3, Quaternion } from '@babylonjs/core/Maths/math.vector';
import { Viewport } from '@babylonjs/core/Maths/math.viewport';
import { Matrix } from '@babylonjs/core/Maths/math.vector';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { type PlayerAppearance, type AppearanceColorSlot, APPEARANCE_MATERIAL_MAP, getPalette, BELT_NO_BELT, SHIRT_COLORS, HAIR_STYLE_COUNT, GEAR_COLOR_COUNT } from '@projectrs/shared';
import '@babylonjs/loaders/glTF';
import { quantizeAnimationGroup, rs2Rotation, ANIM_DURATIONS, DEFAULT_QUANTIZE_FRAMES } from './AnimationQuantizer';

const HAIR_MATERIAL_NAMES = new Set(['hair_1']);

/**
 * Per-animation, per-bone rotation offsets applied during retargeting.
 * Outer key = animation name from additionalAnimations[].name ('idle', 'walk', …).
 * Use '*' to apply to every animation.
 * Inner values are Euler offsets (radians) post-multiplied onto every keyframe.
 * ~0.087 rad = 5°.
 */
const BONE_ROTATION_OFFSETS: Record<string, Record<string, { x: number; y: number; z: number }>> = {
  idle: {
    'mixamorig:LeftShoulder':  { x: 0, y: 0, z: -0.261 },  // ~15° back
    'mixamorig:RightShoulder': { x: 0, y: 0, z:  0.261 },
    'mixamorig:LeftForeArm':   { x: 0, y: 0, z:  0.122 },  // ~7° bend (testing Z)
    'mixamorig:RightForeArm':  { x: 0, y: 0, z: -0.122 },
  },
};


/**
 * Animation state priority (higher = takes precedence).
 * The state machine always plays the highest-priority active state.
 */
export enum AnimState {
  Idle = 0,
  Walk = 1,
  Skill = 2,   // chopping, mining, fishing, etc.
  Attack = 3,
  Death = 4,
}

/** Gear attachment: a cloned mesh parented to a skeleton bone. */
interface GearAttachment {
  itemId: number;
  node: TransformNode;
}

/** Cached gear template ready to be cloned and attached. */
export interface GearTemplate {
  template: TransformNode;
  /** Which bone name to attach to (e.g. 'hand_R', 'head') */
  boneName: string;
  /** Local offset relative to the bone */
  localPosition: Vector3;
  /** Local rotation in euler radians */
  localRotation: Vector3;
  /** Uniform scale */
  scale: number;
}

/**
 * Configuration for loading gear templates.
 * Maps itemId → GLB file + attachment info.
 */
export interface GearDef {
  itemId: number;
  file: string;
  boneName: string;
  localPosition?: { x: number; y: number; z: number };
  localRotation?: { x: number; y: number; z: number };
  scale?: number;
  /** If true, keep the model's origin as-is (centered grip). Default: shift bottom to Y=0 (swords). */
  centerOrigin?: boolean;
  /** Optional tint for the "metal" material. The tool GLBs name their metal material
   *  `Material.002` (the handle is `Material.001`, which is left untouched). */
  metalColor?: [number, number, number];
}

/**
 * Additional animation to load from a separate GLB file.
 * The GLB only needs the armature + animation — the mesh is ignored.
 */
export interface AdditionalAnimation {
  /** Name to register the animation under (e.g. 'idle', 'attack_slash') */
  name: string;
  /** Path to the GLB file containing the animation */
  path: string;
  /** If the GLB contains multiple animations, pick this one by name. If omitted, uses the first. */
  animName?: string;
}

export interface CharacterEntityOptions {
  name: string;
  /** Path to the character .glb file (e.g. '/models/character.glb') */
  modelPath: string;
  /** Desired height of the character in world units (auto-scales the model) */
  targetHeight?: number;
  /** Label shown above head */
  label?: string;
  labelColor?: string;
  /**
   * Additional animations to load from separate GLB files.
   * Use this when you can't (or don't want to) merge animations in Blender.
   * Each GLB should contain the same armature with a single animation.
   */
  additionalAnimations?: AdditionalAnimation[];
}

/**
 * A 3D skeletal character entity.
 * Loads a GLB with embedded animations, supports gear attachment via bones,
 * and provides the same public interface as SpriteEntity for drop-in use.
 */
export class CharacterEntity {
  private scene: Scene;
  private root: TransformNode | null = null;
  private meshes: AbstractMesh[] = [];
  private skeleton: Skeleton | null = null;
  private _position: Vector3 = Vector3.Zero();
  private _rotationY: number = 0;
  private targetRotationY: number = 0;
  private modelScale: number = 1;
  private yOffset: number = 0; // half model height, for health bar positioning
  private childYOffset: number = 0; // -minY applied to root children so feet are at y=0

  // Animations — keyed by name as exported from Blender NLA strips
  private animGroups: Map<string, AnimationGroup> = new Map();
  private currentState: AnimState = AnimState.Idle;
  private currentAnimName: string = '';
  private queuedState: AnimState = AnimState.Idle;
  private queuedAnimName: string = '';

  // One-shot animations (attack/death) call back when done
  private oneShotCallback: (() => void) | null = null;

  // Gear — per equipment slot
  private gearAttachments: Map<string, GearAttachment> = new Map(); // slot name → attachment
  private boneRestRotations: Map<string, Quaternion> = new Map();
  private armatureNode: TransformNode | null = null;
  private skinnedArmorMeshes: Map<string, AbstractMesh[]> = new Map();
  private skinnedArmorItemIds: Map<string, number> = new Map();

  // Head meshes — collected during load for hide/show under full helmets
  private headMeshes: AbstractMesh[] = [];

  // Modular mesh parts — keyed by mesh name for show/hide
  private modularMeshes: Map<string, AbstractMesh> = new Map();

  // Gear color texture swapping — materials whose name starts with genericRGBMat_Objects
  private objectMaterials: StandardMaterial[] = [];
  private static gearColorTextures: Map<string, Texture> = new Map();

  // Last applied appearance — used to restore correct hair/face after helmet unequip
  private lastAppearance: PlayerAppearance | null = null;

  // Health bar (HTML overlay — same pattern as SpriteEntity)
  private healthBarEl: HTMLDivElement | null = null;
  private healthBarFillEl: HTMLDivElement | null = null;
  private healthBarTextEl: HTMLDivElement | null = null;
  private maxHealth: number = 10;
  private currentHealth: number = 10;
  private healthBarVisible: boolean = false;

  // Chat bubble
  private chatBubbleEl: HTMLDivElement | null = null;
  private chatBubbleTimer: ReturnType<typeof setTimeout> | null = null;

  // Ready state
  private _ready: boolean = false;
  private _readyPromise: Promise<void>;
  private _resolveReady!: () => void;

  constructor(scene: Scene, options: CharacterEntityOptions) {
    this.scene = scene;
    this._readyPromise = new Promise((resolve) => {
      this._resolveReady = resolve;
    });
    this.load(options);
  }

  // ---------------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------------

  private async load(options: CharacterEntityOptions): Promise<void> {
    try {
      // Split path into directory + filename for SceneLoader
      const lastSlash = options.modelPath.lastIndexOf('/');
      const dir = options.modelPath.substring(0, lastSlash + 1);
      const file = options.modelPath.substring(lastSlash + 1);

      const result = await SceneLoader.ImportMeshAsync('', dir, file, this.scene);

      // Apply nearest-neighbor filtering to character textures
      for (const mesh of result.meshes) {
        const mat = mesh.material;
        if (mat && 'diffuseTexture' in mat && (mat as any).diffuseTexture) {
          (mat as any).diffuseTexture.updateSamplingMode(Texture.NEAREST_NEAREST_MIPLINEAR);
        }
        if (mat && 'albedoTexture' in mat && (mat as any).albedoTexture) {
          (mat as any).albedoTexture.updateSamplingMode(Texture.NEAREST_NEAREST_MIPLINEAR);
        }
      }

      // Root transform node (GLB __root__)
      this.root = new TransformNode(options.name, this.scene);
      for (const mesh of result.meshes) {
        if (!mesh.parent || mesh.parent.name === '__root__') {
          mesh.parent = this.root;
        }
      }
      // Dispose the __root__ created by the loader if it exists
      const loaderRoot = result.meshes.find(m => m.name === '__root__');
      if (loaderRoot && loaderRoot !== this.root) {
        // Re-parent its children first
        for (const child of loaderRoot.getChildren()) {
          (child as TransformNode).parent = this.root;
        }
      }

      // Find the Armature TransformNode — skinned armor meshes are parented here
      for (const child of this.root.getChildren()) {
        if (child.name === 'Armature' && child instanceof TransformNode) {
          this.armatureNode = child;
          break;
        }
      }

      this.meshes = result.meshes.filter(m => m.getTotalVertices() > 0);
      this.skeleton = result.skeletons.length > 0 ? result.skeletons[0] : null;

      if (this.skeleton) {
        for (const bone of this.skeleton.bones) {
          const tn = bone.getTransformNode();
          if (tn?.rotationQuaternion) {
            this.boneRestRotations.set(bone.name, tn.rotationQuaternion.clone());
          }
        }
      }

      // Index modular hair meshes by name for show/hide (must happen before bounds calc)
      for (const mesh of this.meshes) {
        if (mesh.name.startsWith('M_hair_')) {
          this.modularMeshes.set(mesh.name, mesh);
          mesh.setEnabled(false);
        }
      }

      // Compute model bounds for scaling — only use enabled base body meshes
      let minY = Infinity, maxY = -Infinity;
      for (const mesh of this.meshes) {
        if (!mesh.isEnabled()) continue;
        mesh.computeWorldMatrix(true);
        const bb = mesh.getBoundingInfo().boundingBox;
        if (bb.minimumWorld.y < minY) minY = bb.minimumWorld.y;
        if (bb.maximumWorld.y > maxY) maxY = bb.maximumWorld.y;
      }
      const modelHeight = maxY - minY;
      const targetH = options.targetHeight ?? 1.3;
      this.modelScale = modelHeight > 0 ? targetH / modelHeight : 1;
      this.yOffset = targetH / 2;

      // Adjust root so feet are at y=0
      this.childYOffset = -minY;
      for (const child of this.root.getChildren()) {
        (child as TransformNode).position.y -= minY;
      }
      this.root.scaling.set(this.modelScale, this.modelScale, this.modelScale);

      // Convert PBR → flat StandardMaterial (matches the low-poly world style)
      for (const mesh of this.meshes) {
        const pbrMat = mesh.material as any;
        if (!pbrMat) continue;

        const flat = new StandardMaterial(`${pbrMat.name}_flat`, this.scene);
        const hasTexture = !!pbrMat.albedoTexture;

        if (hasTexture) {
          flat.diffuseTexture = pbrMat.albedoTexture;
          pbrMat.albedoTexture.updateSamplingMode(Texture.NEAREST_NEAREST);
        }
        if (pbrMat.albedoColor && !hasTexture) {
          flat.diffuseColor = new Color3(
            Math.min(1, pbrMat.albedoColor.r * 1.3),
            Math.min(1, pbrMat.albedoColor.g * 1.3),
            Math.min(1, pbrMat.albedoColor.b * 1.3),
          );
        }

        flat.specularColor = Color3.Black();
        if (!hasTexture) {
          const dc = flat.diffuseColor;
          flat.emissiveColor = new Color3(dc.r * 0.55, dc.g * 0.55, dc.b * 0.55);
        }

        flat.backFaceCulling = pbrMat.backFaceCulling ?? true;
        flat.alpha = 1;

        mesh.material = flat;

        // Track object materials for gear color texture swapping
        if (pbrMat.name.startsWith('genericRGBMat_Objects')) {
          this.objectMaterials.push(flat);
        }
      }

      // Identify hair meshes for hide/show under full helmets
      for (const mesh of this.meshes) {
        const n = mesh.name;
        if (n.startsWith('M_hair_')) {
          this.headMeshes.push(mesh);
          continue;
        }
        const matBase = mesh.material?.name.replace(/_flat$/, '').replace(/\.\d+$/, '').toLowerCase() ?? '';
        if (HAIR_MATERIAL_NAMES.has(matBase)) {
          this.headMeshes.push(mesh);
        }
      }

      // Collect animation groups from the main GLB
      for (const group of result.animationGroups) {
        const name = group.name.toLowerCase().replace(/\s+/g, '_');
        this.animGroups.set(name, group);
        group.stop();
        console.log(`[CharacterEntity] Animation loaded: '${name}' (${group.targetedAnimations.length} targets, ${this.getAnimDuration(group).toFixed(2)}s)`);
      }

      // Load additional animations from separate GLB files
      if (options.additionalAnimations) {
        await this.loadAdditionalAnimations(options.additionalAnimations);
      }

      for (const [name, group] of this.animGroups) {
        quantizeAnimationGroup(group, name);
        console.log(`[CharacterEntity] Quantized '${name}' → ${DEFAULT_QUANTIZE_FRAMES} frames, ${(ANIM_DURATIONS[name] ?? 1.2).toFixed(1)}s`);
      }

      // Start idle by default
      this.playAnimByState(AnimState.Idle);

      // Apply initial position
      this.root.position.set(this._position.x, this._position.y, this._position.z);

      this._ready = true;
      this._resolveReady();
      console.log(`[CharacterEntity] '${options.name}' loaded — ${this.meshes.length} meshes, ${this.animGroups.size} animations, skeleton: ${this.skeleton ? 'yes' : 'no'}`);
      if (this.skeleton) {
        console.log(`[CharacterEntity] Bone names: ${this.skeleton.bones.map(b => b.name).join(', ')}`);
      }
    } catch (e) {
      console.error(`[CharacterEntity] Failed to load '${options.modelPath}':`, e);
      this._resolveReady(); // resolve anyway so callers don't hang
    }
  }

  /**
   * Load Mixamo animations from separate GLB files and retarget onto this skeleton.
   *
   * Only rotation tracks are transferred — position/scale tracks are discarded
   * because FBX→GLB exports use centimeter units that don't match our model.
   *
   * Rest-pose correction: FBX→GLB conversion can leave axis-compensation rotations
   * on bones (especially Hips). For each bone, if the source rest rotation differs
   * from ours, every keyframe is corrected:
   *   corrected = ourRest * inverse(srcRest) * keyframe
   * This removes the source rest orientation and applies ours, so animations play
   * in the correct orientation regardless of how the GLB was exported.
   */
  private async loadAdditionalAnimations(anims: AdditionalAnimation[]): Promise<void> {
    // Map bone names → our TransformNodes + their rest rotations
    const ourNodesByName = new Map<string, TransformNode>();
    const ourRestRotations = new Map<string, Quaternion>();

    if (this.skeleton) {
      for (const bone of this.skeleton.bones) {
        const tn = bone.getTransformNode();
        if (tn) {
          ourNodesByName.set(bone.name, tn);
          ourNodesByName.set(tn.name, tn);
          const rest = tn.rotationQuaternion?.clone() ?? Quaternion.Identity();
          ourRestRotations.set(bone.name, rest);
          ourRestRotations.set(tn.name, rest);
        }
      }
    }
    if (this.root) {
      for (const node of this.root.getDescendants(false)) {
        if (node instanceof TransformNode) {
          ourNodesByName.set(node.name, node);
        }
      }
    }

    interface LoadedFile {
      animationGroups: AnimationGroup[];
      skeletons: Skeleton[];
      meshes: AbstractMesh[];
      srcRestRotations: Map<string, Quaternion>;
    }
    const loadedFiles = new Map<string, LoadedFile>();

    for (const anim of anims) {
      try {
        let result = loadedFiles.get(anim.path);
        if (!result) {
          try {
            const lastSlash = anim.path.lastIndexOf('/');
            const dir = anim.path.substring(0, lastSlash + 1);
            const file = anim.path.substring(lastSlash + 1);
            const imported = await SceneLoader.ImportMeshAsync('', dir, file, this.scene);

            // Capture source bone rest rotations from TransformNodes
            // (animation GLBs have no Skeleton — bones are just TransformNodes)
            const srcRestRotations = new Map<string, Quaternion>();
            for (const tn of imported.transformNodes) {
              if (tn.rotationQuaternion) {
                srcRestRotations.set(tn.name, tn.rotationQuaternion.clone());
              }
            }

            result = {
              animationGroups: imported.animationGroups,
              skeletons: imported.skeletons,
              meshes: imported.meshes,
              srcRestRotations,
            };
            loadedFiles.set(anim.path, result);
            for (const g of result.animationGroups) g.stop();
            console.log(`[CharacterEntity] Animation '${anim.name}' loaded from ${anim.path}`);
          } catch {
            console.warn(`[CharacterEntity] Failed to load animation '${anim.name}' from ${anim.path}`);
            continue;
          }
        }

        // Find the animation group (by name, or first)
        let group: AnimationGroup | undefined;
        if (anim.animName) {
          group = result.animationGroups.find(g => g.name === anim.animName);
          if (!group) {
            console.warn(`[CharacterEntity] Animation '${anim.animName}' not found in '${anim.path}'. Available: ${result.animationGroups.map(g => g.name).join(', ')}`);
            continue;
          }
        } else {
          group = result.animationGroups[0];
        }
        if (!group) continue;

        const retargetedAnims = [];
        let missCount = 0;
        let correctedCount = 0;

        for (const ta of group.targetedAnimations) {
          const target = ta.target as TransformNode;
          if (!target?.name) continue;

          // Only rotation tracks
          const prop = ta.animation.targetProperty;
          if (prop !== 'rotationQuaternion' && !prop.startsWith('rotationQuaternion')) {
            continue;
          }

          // Match source bone → our bone by name
          let ourTarget = ourNodesByName.get(target.name) ?? null;
          if (!ourTarget) {
            const stripped = target.name.replace(/\.\d+$/, '');
            ourTarget = ourNodesByName.get(stripped) ?? null;
          }

          if (!ourTarget) {
            missCount++;
            if (missCount <= 5) {
              console.log(`[CharacterEntity] Retarget miss: '${target.name}'`);
            }
            continue;
          }

          // Rest-pose correction: if source and target rest rotations differ,
          // transform each keyframe so it plays correctly on our skeleton.
          const srcRest = result.srcRestRotations.get(target.name);
          const ourRest = ourRestRotations.get(ourTarget.name);
          if (srcRest && ourRest) {
            const dot = Math.abs(Quaternion.Dot(srcRest, ourRest));
            if (dot < 0.999) {
              const srcRestInv = Quaternion.Inverse(srcRest);
              const keys = ta.animation.getKeys();
              for (const key of keys) {
                if (key.value && key.value.w !== undefined) {
                  key.value = ourRest.multiply(srcRestInv.multiply(key.value));
                }
              }
              correctedCount++;
            }
          }

          // Apply constant bone rotation offsets (e.g. pull shoulders back).
          // Per-animation entries take priority; '*' applies to all.
          const offset = BONE_ROTATION_OFFSETS[anim.name]?.[ourTarget.name]
            ?? BONE_ROTATION_OFFSETS['*']?.[ourTarget.name];
          if (offset && (offset.x !== 0 || offset.y !== 0 || offset.z !== 0)) {
            const offsetQuat = Quaternion.FromEulerAngles(offset.x, offset.y, offset.z);
            const keys = ta.animation.getKeys();
            for (const key of keys) {
              if (key.value && key.value.w !== undefined) {
                key.value = key.value.multiply(offsetQuat);
              }
            }
          }

          retargetedAnims.push({ animation: ta.animation, target: ourTarget });
        }

        if (retargetedAnims.length > 0) {
          const newGroup = new AnimationGroup(anim.name, this.scene);
          for (const ra of retargetedAnims) {
            newGroup.addTargetedAnimation(ra.animation, ra.target);
          }
          this.animGroups.set(anim.name, newGroup);
          newGroup.stop();
          console.log(`[CharacterEntity] '${anim.name}': ${retargetedAnims.length} tracks retargeted, ${correctedCount} rest-corrected, ${missCount} missed`);
        } else {
          console.warn(`[CharacterEntity] Retargeting failed for '${anim.name}' — 0 tracks matched`);
        }
      } catch (e) {
        console.warn(`[CharacterEntity] Failed to load '${anim.name}' from '${anim.path}':`, e);
      }
    }

    // Clean up loaded GLB resources
    for (const [, result] of loadedFiles) {
      for (const ag of result.animationGroups) ag.dispose();
      for (const sk of result.skeletons) sk.dispose();
      for (const mesh of result.meshes) mesh.dispose();
    }
  }

  /** Wait until the model is loaded and ready. */
  whenReady(): Promise<void> {
    return this._readyPromise;
  }

  get isReady(): boolean {
    return this._ready;
  }

  // ---------------------------------------------------------------------------
  // Animation state machine
  // ---------------------------------------------------------------------------

  /**
   * Map an AnimState to the animation name(s) to try.
   * Override this to customize which GLB animations map to which states.
   * Falls back through the list until one is found.
   */
  private getAnimNamesForState(state: AnimState, variant?: string): string[] {
    switch (state) {
      case AnimState.Idle:
        return ['idle'];
      case AnimState.Walk:
        return ['walk', 'run'];
      case AnimState.Skill:
        return variant ? [variant, 'skill', 'chop', 'idle'] : ['skill', 'chop', 'mine', 'idle'];
      case AnimState.Attack:
        return variant ? [variant, 'attack_slash', 'attack'] : ['attack_punch', 'attack', 'attack_slash'];
      case AnimState.Death:
        return ['death', 'die'];
      default:
        return ['idle'];
    }
  }

  /** Play the best matching animation for a given state. */
  private playAnimByState(state: AnimState, variant?: string, loop?: boolean): void {
    const names = this.getAnimNamesForState(state, variant);
    for (const name of names) {
      const group = this.animGroups.get(name);
      if (group) {
        this.playAnim(name, loop ?? (state <= AnimState.Skill), () => {
          // One-shot finished — return to idle or walk
          if (this.currentState === state) {
            this.currentState = this.queuedState;
            this.playAnimByState(this.queuedState, this.queuedAnimName, undefined);
          }
        });
        this.currentState = state;
        return;
      }
    }
    // No animation found for this state — stay in current
    console.warn(`[CharacterEntity] No animation found for state ${AnimState[state]}, tried: ${names.join(', ')}`);
  }

  /** Low-level: play a named animation group. */
  private playAnim(name: string, loop: boolean, onEnd?: () => void): void {
    if (name === this.currentAnimName && loop) return;

    const oldGroup = this.currentAnimName ? this.animGroups.get(this.currentAnimName) : null;
    const group = this.animGroups.get(name);
    if (!group) return;

    if (oldGroup) oldGroup.stop();
    group.start(loop, 1.0, group.from, group.to, false);

    this.currentAnimName = name;
    this.oneShotCallback = onEnd ?? null;

    if (!loop && onEnd) {
      group.onAnimationGroupEndObservable.addOnce(() => {
        if (this.oneShotCallback === onEnd) {
          this.oneShotCallback = null;
          onEnd();
        }
      });
    }
  }

  private getAnimDuration(group: AnimationGroup): number {
    return (group.to - group.from) / 60;
  }

  // ---------------------------------------------------------------------------
  // Public animation API (mirrors SpriteEntity interface)
  // ---------------------------------------------------------------------------

  /** Start walking animation. */
  startWalking(): void {
    if (this.currentState >= AnimState.Attack) return; // don't interrupt attack
    this.queuedState = AnimState.Walk;
    this.queuedAnimName = '';
    if (this.currentState < AnimState.Walk) {
      this.playAnimByState(AnimState.Walk);
    }
  }

  /** Stop walking, return to idle. */
  stopWalking(): void {
    if (this.currentState === AnimState.Walk) {
      this.playAnimByState(AnimState.Idle);
    }
    this.queuedState = AnimState.Idle;
    this.queuedAnimName = '';
  }

  isWalking(): boolean {
    return this.currentState === AnimState.Walk;
  }

  /** Play a one-shot attack animation. Optional variant name (e.g. 'attack_slash'). */
  playAttackAnimation(variant?: string): void {
    // Don't restart if already playing an attack — let it finish
    if (this.currentState === AnimState.Attack) return;
    this.queuedState = this.currentState >= AnimState.Walk ? AnimState.Walk : AnimState.Idle;
    this.queuedAnimName = '';
    this.playAnimByState(AnimState.Attack, variant, false);
  }

  /** Play a looping skill animation (e.g. 'chop', 'mine', 'fish'). */
  startSkillAnimation(variant?: string): void {
    this.queuedState = AnimState.Skill;
    this.queuedAnimName = variant ?? '';
    this.playAnimByState(AnimState.Skill, variant, true);
  }

  /** Whether a skill animation is currently playing. */
  isSkillAnimPlaying(): boolean {
    return this.currentState === AnimState.Skill;
  }

  /** Stop skill animation, return to idle. */
  stopSkillAnimation(): void {
    if (this.currentState === AnimState.Skill) {
      this.playAnimByState(AnimState.Idle);
    }
    if (this.queuedState === AnimState.Skill) {
      this.queuedState = AnimState.Idle;
    }
  }

  /** Whether any one-shot animation is playing (attack/death). */
  isAnimating(): boolean {
    return this.currentState >= AnimState.Attack;
  }

  /** List all available animation names (as loaded from GLB). */
  getAnimationNames(): string[] {
    return [...this.animGroups.keys()];
  }

  // ---------------------------------------------------------------------------
  // Facing / rotation
  // ---------------------------------------------------------------------------

  setFacingAngle(radians: number): void {
    this._rotationY = radians;
    this.targetRotationY = radians;
    if (this.root) {
      this.root.rotation.y = radians;
    }
  }

  setTargetFacing(radians: number): void {
    this.targetRotationY = radians;
  }

  faceToward(target: Vector3, _cameraPos?: Vector3): void {
    const dx = target.x - this._position.x;
    const dz = target.z - this._position.z;
    if (Math.abs(dx) < 0.001 && Math.abs(dz) < 0.001) return;
    this.targetRotationY = Math.atan2(dx, dz);
  }

  updateMovementDirection(dx: number, dz: number, _cameraPos?: Vector3): void {
    if (Math.abs(dx) < 0.001 && Math.abs(dz) < 0.001) return;
    this.targetRotationY = Math.atan2(dx, dz);
  }

  /** SpriteEntity compat — no-op for 3D characters. */
  updateDirection(_cameraPos: Vector3): void {
    // 3D models don't need camera-based direction swapping
  }

  // ---------------------------------------------------------------------------
  // Position
  // ---------------------------------------------------------------------------

  get position(): Vector3 {
    return this._position;
  }

  set position(pos: Vector3) {
    this._position = pos;
    if (this.root) {
      this.root.position.set(pos.x, pos.y, pos.z);
    }
  }

  setPositionXYZ(x: number, y: number, z: number): void {
    this._position.set(x, y, z);
    if (this.root) {
      this.root.position.set(x, y, z);
    }
  }

  // ---------------------------------------------------------------------------
  // Per-frame update
  // ---------------------------------------------------------------------------

  updateAnimation(dt: number): void {
    if (!this.root) return;

    const newYaw = rs2Rotation(this._rotationY, this.targetRotationY, dt);
    if (newYaw !== this._rotationY) {
      this._rotationY = newYaw;
      this.root.rotation.y = newYaw;
    }
  }

  // ---------------------------------------------------------------------------
  // Gear attachment
  // ---------------------------------------------------------------------------

  /**
   * Attach a gear piece to a bone.
   * @param slot Equipment slot name (e.g. 'weapon', 'head', 'body')
   * @param itemId The item ID for tracking
   * @param gearTemplate Pre-loaded gear template
   */
  attachGear(slot: string, itemId: number, gearTemplate: GearTemplate): void {
    // Remove existing gear in this slot
    this.detachGear(slot);

    if (!this.skeleton) {
      console.warn('[CharacterEntity] No skeleton — cannot attach gear');
      return;
    }

    // Find the bone by name
    const bone = this.skeleton.bones.find(b => b.name === gearTemplate.boneName);
    if (!bone) {
      console.warn(`[CharacterEntity] Bone '${gearTemplate.boneName}' not found in skeleton`);
      return;
    }

    // Clone the gear template
    const clone = gearTemplate.template.instantiateHierarchy(null, undefined, (source, cloned) => {
      cloned.name = `${source.name}_${slot}_${itemId}`;
    });
    if (!clone) {
      console.warn('[CharacterEntity] Failed to clone gear template');
      return;
    }

    clone.setEnabled(true);
    for (const child of clone.getChildMeshes()) {
      child.setEnabled(true);
    }

    // Attach to bone
    const boneTransform = bone.getTransformNode();
    if (boneTransform) {
      clone.parent = boneTransform;
    } else {
      // Fallback: attach to bone directly via attachToBone helper
      clone.attachToBone(bone, this.root!);
    }

    // Apply local transform — null out rotationQuaternion so euler rotation works
    clone.rotationQuaternion = null;
    clone.position.set(
      gearTemplate.localPosition.x,
      gearTemplate.localPosition.y,
      gearTemplate.localPosition.z
    );
    clone.rotation.set(
      gearTemplate.localRotation.x,
      gearTemplate.localRotation.y,
      gearTemplate.localRotation.z
    );
    const s = gearTemplate.scale;
    clone.scaling.set(s, s, s);

    this.gearAttachments.set(slot, { itemId, node: clone });
    if (slot === 'head') this.setHeadVisible(false);
  }

  /** Remove gear from a slot. */
  detachGear(slot: string): void {
    const existing = this.gearAttachments.get(slot);
    if (existing) {
      existing.node.dispose();
      this.gearAttachments.delete(slot);
      if (slot === 'head') this.setHeadVisible(true);
    }
  }

  /**
   * Attach skinned armor by parenting meshes directly under the Armature TransformNode.
   * This ensures the mesh world matrix chain is identical to the character mesh,
   * so GPU skinning produces correct results with no clipping.
   */
  attachSkinnedArmor(slot: string, meshes: AbstractMesh[], armorSkeleton: Skeleton, itemId: number = -1): void {
    this.detachSkinnedArmor(slot);
    if (!this.skeleton || !this.armatureNode) {
      console.warn('[CharacterEntity] Cannot attach skinned armor: no skeleton or armature');
      return;
    }

    const kept: AbstractMesh[] = [];
    for (const mesh of meshes) {
      if (mesh.getTotalVertices() === 0) continue;
      if (mesh.skeleton === armorSkeleton) {
        mesh.skeleton = this.skeleton;
      }
      mesh.parent = this.armatureNode;
      mesh.rotationQuaternion = null;
      mesh.position.set(0, 0, 0);
      mesh.rotation.set(0, 0, 0);
      mesh.scaling.set(1, 1, 1);
      kept.push(mesh);
    }
    armorSkeleton.dispose();
    this.skinnedArmorMeshes.set(slot, kept);
    this.skinnedArmorItemIds.set(slot, itemId);
    if (slot === 'head') this.setHeadVisible(false);
    console.log(`[SkinnedArmor] Attached ${kept.length} meshes in slot '${slot}' itemId=${itemId}`);
  }

  detachSkinnedArmor(slot: string): void {
    const meshes = this.skinnedArmorMeshes.get(slot);
    if (meshes) {
      for (const mesh of meshes) mesh.dispose();
      this.skinnedArmorMeshes.delete(slot);
    }
    this.skinnedArmorItemIds.delete(slot);
    if (slot === 'head') this.setHeadVisible(true);
  }

  applySkinnedArmorTransform(slot: string, override: { localPosition?: { x: number; y: number; z: number }; localRotation?: { x: number; y: number; z: number }; scale?: number }): void {
    const meshes = this.skinnedArmorMeshes.get(slot);
    if (!meshes) return;
    for (const mesh of meshes) {
      if (override.localPosition) {
        mesh.position.set(override.localPosition.x, override.localPosition.y, override.localPosition.z);
      }
      if (override.localRotation) {
        mesh.rotation.set(override.localRotation.x, override.localRotation.y, override.localRotation.z);
      }
      if (override.scale != null) {
        mesh.scaling.set(override.scale, override.scale, override.scale);
      }
    }
  }

  /** Get the transform node for gear in a slot (for debug panel). */
  getGearNode(slot: string): import('@babylonjs/core/Meshes/transformNode').TransformNode | null {
    return this.gearAttachments.get(slot)?.node ?? this.skinnedArmorMeshes.get(slot)?.[0] ?? null;
  }

  getSkinnedArmorMeshes(slot: string): AbstractMesh[] | undefined {
    return this.skinnedArmorMeshes.get(slot);
  }

  setHeadVisible(visible: boolean): void {
    if (!visible) {
      for (const mesh of this.headMeshes) {
        mesh.setEnabled(false);
      }
    } else if (this.lastAppearance) {
      // Re-apply correct hair style instead of enabling all variants
      for (let i = 1; i <= HAIR_STYLE_COUNT; i++) {
        this.modularMeshes.get(`M_hair_${i}`)?.setEnabled(this.lastAppearance.hairStyle === i);
      }
    } else {
      for (const mesh of this.headMeshes) {
        mesh.setEnabled(true);
      }
    }
  }

  /** Remove all gear (bone-parented + skinned). */
  detachAllGear(): void {
    for (const [slot] of this.gearAttachments) {
      this.detachGear(slot);
    }
    for (const [slot] of this.skinnedArmorMeshes) {
      this.detachSkinnedArmor(slot);
    }
  }

  /** Get currently attached gear item ID for a slot, or -1. */
  getGearItemId(slot: string): number {
    return this.gearAttachments.get(slot)?.itemId ?? this.skinnedArmorItemIds.get(slot) ?? -1;
  }

  // ---------------------------------------------------------------------------
  // Health bar (same HTML overlay pattern as SpriteEntity)
  // ---------------------------------------------------------------------------

  showHealthBar(current: number, max: number): void {
    this.currentHealth = current;
    this.maxHealth = max;
    this.healthBarVisible = true;

    if (!this.healthBarEl) {
      this.healthBarEl = document.createElement('div');
      this.healthBarEl.className = 'entity-health-bar';
      this.healthBarEl.style.cssText = `
        position: fixed; pointer-events: none; z-index: 150;
        width: 48px; height: 8px;
        background: #400; border: 1px solid #000;
        transform: translate(-50%, -50%);
        border-radius: 1px; overflow: hidden;
      `;
      this.healthBarFillEl = document.createElement('div');
      this.healthBarFillEl.style.cssText = `
        height: 100%; transition: width 0.15s, background 0.15s;
      `;
      this.healthBarEl.appendChild(this.healthBarFillEl);
      this.healthBarTextEl = document.createElement('div');
      this.healthBarTextEl.style.cssText = `
        position: absolute; top: -1px; left: 0; right: 0;
        text-align: center; font-family: monospace;
        font-size: 8px; font-weight: bold; color: #fff;
        text-shadow: 1px 1px 0 #000, -1px -1px 0 #000;
        line-height: 10px; pointer-events: none;
      `;
      this.healthBarEl.appendChild(this.healthBarTextEl);
      document.body.appendChild(this.healthBarEl);
    }

    const ratio = Math.max(0, current / max);
    this.healthBarFillEl!.style.width = `${ratio * 100}%`;
    if (ratio > 0.5) {
      this.healthBarFillEl!.style.background = '#0b0';
    } else if (ratio > 0.25) {
      this.healthBarFillEl!.style.background = '#bb0';
    } else {
      this.healthBarFillEl!.style.background = '#b00';
    }
    this.healthBarTextEl!.textContent = `${current}/${max}`;
  }

  hideHealthBar(): void {
    this.healthBarVisible = false;
    if (this.healthBarEl) {
      this.healthBarEl.remove();
      this.healthBarEl = null;
      this.healthBarFillEl = null;
      this.healthBarTextEl = null;
    }
  }

  getHealthBarWorldPos(out?: Vector3): Vector3 | null {
    if (!this.healthBarVisible || !this.healthBarEl) return null;
    const v = out ?? new Vector3();
    v.set(this._position.x, this._position.y + this.yOffset * 2 + 0.3, this._position.z);
    return v;
  }

  updateHealthBarScreenPos(screenX: number, screenY: number): void {
    if (this.healthBarEl) {
      this.healthBarEl.style.left = `${screenX}px`;
      this.healthBarEl.style.top = `${screenY}px`;
    }
  }

  hasHealthBar(): boolean {
    return this.healthBarVisible && this.healthBarEl !== null;
  }

  // ---------------------------------------------------------------------------
  // Chat bubble (same HTML overlay pattern as SpriteEntity)
  // ---------------------------------------------------------------------------

  showChatBubble(message: string, duration: number = 5000): void {
    this.hideChatBubble();
    const text = message.length > 80 ? message.substring(0, 77) + '...' : message;
    const el = document.createElement('div');
    el.className = 'chat-bubble-overlay';
    el.textContent = text;
    el.style.cssText = `
      position: fixed; pointer-events: none; z-index: 200;
      background: rgba(0, 0, 0, 0.8); color: #fff;
      font-family: monospace; font-size: 13px;
      padding: 4px 10px; border-radius: 6px;
      border: 1px solid #5a4a35; white-space: nowrap;
      transform: translate(-50%, -100%);
      text-shadow: 1px 1px 1px rgba(0,0,0,0.5);
    `;
    document.body.appendChild(el);
    this.chatBubbleEl = el;
    this.chatBubbleTimer = setTimeout(() => this.hideChatBubble(), duration);
  }

  hideChatBubble(): void {
    if (this.chatBubbleTimer) {
      clearTimeout(this.chatBubbleTimer);
      this.chatBubbleTimer = null;
    }
    if (this.chatBubbleEl) {
      this.chatBubbleEl.remove();
      this.chatBubbleEl = null;
    }
  }

  getChatBubbleWorldPos(out?: Vector3): Vector3 | null {
    if (!this.chatBubbleEl) return null;
    const v = out ?? new Vector3();
    v.set(this._position.x, this._position.y + this.yOffset * 2 + 0.6, this._position.z);
    return v;
  }

  updateChatBubbleScreenPos(screenX: number, screenY: number): void {
    if (this.chatBubbleEl) {
      this.chatBubbleEl.style.left = `${screenX}px`;
      this.chatBubbleEl.style.top = `${screenY}px`;
    }
  }

  hasChatBubble(): boolean {
    return this.chatBubbleEl !== null;
  }

  // ---------------------------------------------------------------------------
  // Picking / mesh access
  // ---------------------------------------------------------------------------

  /** Get all renderable meshes (for raycasting / picking). */
  getMeshes(): AbstractMesh[] {
    return this.meshes;
  }

  /** Get the root transform node. */
  getRoot(): TransformNode | null {
    return this.root;
  }

  /** Get the skeleton (for advanced bone queries). */
  getSkeleton(): Skeleton | null {
    return this.skeleton;
  }

  /** Y offset applied to root children so model feet sit at y=0. */
  getChildYOffset(): number {
    return this.childYOffset;
  }

  /** The Armature TransformNode — skinned armor meshes are parented here. */
  getArmatureNode(): TransformNode | null {
    return this.armatureNode;
  }

  /** List all bone names in the skeleton (useful for debugging gear attachment). */
  getBoneNames(): string[] {
    if (!this.skeleton) return [];
    return this.skeleton.bones.map(b => b.name);
  }

  getBoneRestRotation(boneName: string): Quaternion | null {
    return this.boneRestRotations.get(boneName) ?? null;
  }

  // ---------------------------------------------------------------------------
  // Appearance — recolor clothing/hair materials
  // ---------------------------------------------------------------------------

  /**
   * Apply a PlayerAppearance by recoloring the GLB's materials.
   * Material names are matched case-insensitively, with .001/.002 suffixes stripped.
   */
  applyAppearance(appearance: PlayerAppearance): void {
    this.lastAppearance = appearance;
    // Color-based recoloring (per-material name matching)
    for (const mesh of this.meshes) {
      const mat = mesh.material;
      if (!mat) continue;
      const baseName = mat.name.replace(/_flat$/, '').replace(/\.\d+$/, '');

      for (const [slot, matNames] of Object.entries(APPEARANCE_MATERIAL_MAP)) {
        let colorIdx = appearance[slot as AppearanceColorSlot];
        let palette = getPalette(slot as AppearanceColorSlot);
        if (slot === 'beltColor' && colorIdx === BELT_NO_BELT) {
          colorIdx = appearance.shirtColor;
          palette = SHIRT_COLORS;
        }
        if (colorIdx < 0 || colorIdx >= palette.length) continue;

        for (const target of matNames) {
          if (baseName.toLowerCase() === target.toLowerCase()) {
            const rgb = palette[colorIdx];
            const c = new Color3(
              Math.min(1, rgb[0] * 1.3),
              Math.min(1, rgb[1] * 1.3),
              Math.min(1, rgb[2] * 1.3),
            );
            (mat as StandardMaterial).diffuseColor = c;
            (mat as StandardMaterial).emissiveColor = new Color3(c.r * 0.55, c.g * 0.55, c.b * 0.55);
          }
        }
      }
    }

    // Modular mesh show/hide — hair only (0 = bald, 1+ = M_hair_1 … M_hair_N)
    if (this.modularMeshes.size > 0) {
      for (let i = 1; i <= HAIR_STYLE_COUNT; i++) {
        this.modularMeshes.get(`M_hair_${i}`)?.setEnabled(appearance.hairStyle === i);
      }
    }

    // Gear color: swap diffuseTexture on all genericRGBMat_Objects materials
    if (this.objectMaterials.length > 0 && appearance.gearColor >= 0 && appearance.gearColor < GEAR_COLOR_COUNT) {
      const colorIdx = appearance.gearColor + 1; // textures are 1-indexed (objectColor1.png)
      const cacheKey = `${this.scene.uid}_${colorIdx}`;
      let tex = CharacterEntity.gearColorTextures.get(cacheKey);
      if (!tex || !tex.getScene()) {
        tex = new Texture(
          `/Character models/gear-colors/objectColor${colorIdx}.png`,
          this.scene,
          false, true, Texture.NEAREST_NEAREST,
        );
        CharacterEntity.gearColorTextures.set(cacheKey, tex);
      }
      for (const mat of this.objectMaterials) {
        mat.diffuseTexture = tex;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  dispose(): void {
    this.hideChatBubble();
    this.hideHealthBar();
    this.detachAllGear();

    // Stop all animations
    for (const [, group] of this.animGroups) {
      group.stop();
      group.dispose();
    }
    this.animGroups.clear();

    // Dispose meshes
    for (const mesh of this.meshes) {
      mesh.dispose();
    }
    this.meshes = [];
    this.headMeshes = [];
    this.modularMeshes.clear();

    if (this.root) {
      this.root.dispose();
      this.root = null;
    }
    this.skeleton = null;
  }

}

// ---------------------------------------------------------------------------
// Gear template loader (static utility)
// ---------------------------------------------------------------------------

/**
 * Load a gear template from a GLB file.
 * The template is disabled and ready to be cloned + attached to bones.
 */
export async function loadGearTemplate(
  scene: Scene,
  def: GearDef,
): Promise<GearTemplate | null> {
  try {
    const lastSlash = def.file.lastIndexOf('/');
    const dir = def.file.substring(0, lastSlash + 1);
    const file = def.file.substring(lastSlash + 1);

    const result = await SceneLoader.ImportMeshAsync('', dir, file, scene);

    // Apply nearest-neighbor filtering to gear textures
    for (const mesh of result.meshes) {
      const mat = mesh.material;
      if (mat && 'diffuseTexture' in mat && (mat as any).diffuseTexture) {
        (mat as any).diffuseTexture.updateSamplingMode(Texture.NEAREST_NEAREST_MIPLINEAR);
      }
      if (mat && 'albedoTexture' in mat && (mat as any).albedoTexture) {
        (mat as any).albedoTexture.updateSamplingMode(Texture.NEAREST_NEAREST_MIPLINEAR);
      }
    }

    const root = new TransformNode(`gearTemplate_${def.itemId}`, scene);
    for (const mesh of result.meshes) {
      if (!mesh.parent || mesh.parent.name === '__root__') {
        mesh.parent = root;
      }
    }

    // Optional: recolor the tool's metal material (keeps handle untouched).
    // The Axe.glb / Pickaxe.glb split metal vs handle into separate materials
    // named "Material.002" (metal) and "Material.001" (handle).
    if (def.metalColor) {
      const [r, g, b] = def.metalColor;
      const tint = new Color3(r, g, b);
      const recolored = new Set<string>();
      for (const mesh of result.meshes) {
        const mat = mesh.material as any;
        if (!mat || !mat.name) continue;
        if (!mat.name.includes('Material.002')) continue;
        // Clone to avoid mutating a shared template material
        const clonedName = `${mat.name}_tint_${def.itemId}`;
        let cloned: any;
        if (recolored.has(clonedName)) {
          cloned = scene.getMaterialByName(clonedName);
        } else {
          cloned = mat.clone(clonedName);
          if (cloned) {
            if ('albedoColor' in cloned) cloned.albedoColor = tint;
            if ('diffuseColor' in cloned) cloned.diffuseColor = tint;
            recolored.add(clonedName);
          }
        }
        if (cloned) mesh.material = cloned;
      }
    }

    // Normalize position so the attachment point is at origin
    // centerOrigin: keep model centered (bows grip at center)
    // default: shift bottom to Y=0 (swords held by handle end)
    if (!def.centerOrigin) {
      let minY = Infinity;
      for (const mesh of result.meshes) {
        if (mesh.getTotalVertices() === 0) continue;
        mesh.computeWorldMatrix(true);
        const bb = mesh.getBoundingInfo().boundingBox;
        if (bb.minimumWorld.y < minY) minY = bb.minimumWorld.y;
      }
      for (const child of root.getChildren()) {
        (child as TransformNode).position.y -= minY;
      }
    }

    root.setEnabled(false);

    return {
      template: root,
      boneName: def.boneName,
      localPosition: def.localPosition
        ? new Vector3(def.localPosition.x, def.localPosition.y, def.localPosition.z)
        : Vector3.Zero(),
      localRotation: def.localRotation
        ? new Vector3(def.localRotation.x, def.localRotation.y, def.localRotation.z)
        : Vector3.Zero(),
      scale: def.scale ?? 1,
    };
  } catch (e) {
    console.warn(`[GearTemplate] Failed to load '${def.file}':`, e);
    return null;
  }
}
