import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { Vector3, Color3, Color4, Matrix, Quaternion } from '@babylonjs/core/Maths/math';
import { Viewport } from '@babylonjs/core/Maths/math.viewport';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { SceneLoader } from '@babylonjs/core/Loading/sceneLoader';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import '@babylonjs/loaders/glTF';
import { ChunkManager } from '../rendering/ChunkManager';
import { GameCamera } from '../rendering/Camera';
import { SpriteEntity, loadDirectionalSprites, loadAnimationSprites, load8DirAnimationSprites, type DirectionalSpriteSet, type AnimationSpriteSet } from '../rendering/SpriteEntity';
import { InputManager } from './InputManager';
import { NetworkManager } from './NetworkManager';
import { findPath } from '../rendering/Pathfinding';
import { SidePanel } from '../ui/SidePanel';
import { ChatPanel } from '../ui/ChatPanel';
import { Minimap } from '../ui/Minimap';
import { StatsPanel } from '../ui/StatsPanel';
import { ServerOpcode, ClientOpcode, encodePacket, ALL_SKILLS, SKILL_NAMES, decodeStringPacket, type WorldObjectDef } from '@projectrs/shared';

// NPC color palette by definition ID
const NPC_COLORS: Record<number, Color3> = {
  1: new Color3(0.9, 0.9, 0.8),   // Chicken — white
  2: new Color3(0.5, 0.4, 0.3),   // Rat — brown
  3: new Color3(0.3, 0.5, 0.2),   // Goblin — green
  4: new Color3(0.5, 0.5, 0.5),   // Wolf — grey
  5: new Color3(0.85, 0.85, 0.8), // Skeleton — bone white
  6: new Color3(0.3, 0.2, 0.1),   // Spider — dark brown
  7: new Color3(0.6, 0.6, 0.65),  // Guard — silver
  8: new Color3(0.7, 0.5, 0.2),   // Shopkeeper — gold
  9: new Color3(0.15, 0.1, 0.2),  // Dark Knight — dark purple
  10: new Color3(0.6, 0.4, 0.2),  // Cow — brown
};

const NPC_NAMES: Record<number, string> = {
  1: 'Chicken', 2: 'Rat', 3: 'Goblin', 4: 'Wolf',
  5: 'Skeleton', 6: 'Spider', 7: 'Guard', 8: 'Shopkeeper',
  9: 'Dark Knight', 10: 'Cow',
};

const NPC_SIZES: Record<number, { w: number; h: number }> = {
  1: { w: 0.7, h: 0.85 },  // Chicken (small, ~half player height)
  2: { w: 0.5, h: 0.7 },   // Rat (small)
  6: { w: 0.6, h: 0.5 },   // Spider (wide, short)
  9: { w: 1.0, h: 1.8 },   // Dark Knight (big)
  10: { w: 1.6, h: 1.4 },  // Cow (wide, slightly shorter than player)
};

interface GroundItemData {
  id: number;
  itemId: number;
  quantity: number;
  x: number;
  z: number;
}

export class GameManager {
  private engine: Engine;
  private scene: Scene;
  private camera: GameCamera;
  private chunkManager: ChunkManager;
  private inputManager: InputManager;
  private network: NetworkManager;

  // Auth
  private token: string;
  private username: string;

  // Local player
  private localPlayer: SpriteEntity | null = null;
  private localPlayerId: number = -1;
  private currentFloor: number = 0;
  private playerX: number = 512;
  private playerZ: number = 512;
  private playerHealth: number = 10;
  private playerMaxHealth: number = 10;

  // Movement
  private path: { x: number; z: number }[] = [];
  private moveSpeed: number = 3.0;

  // Combat follow (local player follows melee target)
  private combatTargetId: number = -1;
  // Combat facing: track who each entity is targeting (from COMBAT_HIT events)
  private npcCombatTargets: Map<number, number> = new Map();  // npcId -> playerId they're attacking
  private remoteCombatTargets: Map<number, number> = new Map();  // remotePlayerId -> npcId they're attacking

  // Remote players
  private remotePlayers: Map<number, SpriteEntity> = new Map();
  private remoteTargets: Map<number, { x: number; z: number }> = new Map();
  private playerNames: Map<number, string> = new Map();
  private nameToEntityId: Map<string, number> = new Map();

  // NPCs
  private npcSprites: Map<number, SpriteEntity> = new Map();
  private npcTargets: Map<number, { x: number; z: number }> = new Map();
  private npcDefs: Map<number, number> = new Map();

  // Ground items
  private groundItems: Map<number, GroundItemData> = new Map();
  private groundItemSprites: Map<number, SpriteEntity> = new Map();

  // World objects
  private worldObjectSprites: Map<number, SpriteEntity> = new Map();
  private worldObjectModels: Map<number, TransformNode> = new Map();
  private worldObjectDefs: Map<number, { defId: number; x: number; z: number; depleted: boolean }> = new Map();
  /** Tiles blocked by non-depleted world objects (key = `${tileX},${tileZ}`) */
  private blockedObjectTiles: Set<string> = new Set();
  private objectDefsCache: Map<number, WorldObjectDef> = new Map();
  /** Per-defId tree model templates: { template, scale } */
  private treeModels: Map<number, { template: TransformNode; scale: number }> = new Map();
  private rockModelTemplate: TransformNode | null = null;
  private rockModelScale: number = 1;
  private playerSprites: DirectionalSpriteSet | null = null;
  private playerWalkAnim: AnimationSpriteSet | null = null;
  private playerPunchAnim: AnimationSpriteSet | null = null;
  private playerKickAnim: AnimationSpriteSet | null = null;
  private playerSwordAnim: AnimationSpriteSet | null = null;
  /** Per-NPC-defId directional sprite sets */
  private npcSpriteSets: Map<number, DirectionalSpriteSet> = new Map();
  /** Per-NPC-defId attack animation sprite sets */
  private npcAttackAnims: Map<number, AnimationSpriteSet> = new Map();
  private isSkilling: boolean = false;
  private skillingObjectId: number = -1;

  // UI
  private destMarker: any = null;
  private contextMenu: HTMLDivElement | null = null;
  private sidePanel: SidePanel | null = null;
  private chatPanel: ChatPanel | null = null;
  private minimap: Minimap | null = null;
  private statsPanel: StatsPanel | null = null;

  // Combat hit splats (HTML overlay)
  private hitSplats: { worldPos: Vector3; el: HTMLDivElement; timer: number; startY: number }[] = [];

  // WASD camera
  private keysDown: Set<string> = new Set();

  constructor(canvas: HTMLCanvasElement, token: string, username: string, onDisconnect?: () => void) {
    this.token = token;
    this.username = username;

    this.engine = new Engine(canvas, true, { antialias: true });
    this.scene = new Scene(this.engine);
    this.scene.useRightHandedSystem = true; // Match Three.js coordinate system (KC editor)
    this.scene.clearColor = new Color4(0.4, 0.6, 0.9, 1.0);
    // Groups 1 (water) and 2 (texture planes) must NOT clear depth — they need terrain depth from group 0
    this.scene.setRenderingAutoClearDepthStencil(1, false, false, false);
    this.scene.setRenderingAutoClearDepthStencil(2, false, false, false);

    // Lighting — matched to KC editor's Three.js scene for correct terrain colors
    const ambient = new HemisphericLight('ambient', new Vector3(0, 1, 0), this.scene);
    ambient.intensity = 0.9;
    ambient.diffuse = new Color3(0.54, 0.54, 0.54);
    ambient.groundColor = new Color3(0.35, 0.33, 0.30);
    const sun = new DirectionalLight('sun', new Vector3(-0.5, -1, -0.3), this.scene);
    sun.intensity = 1.1;
    sun.diffuse = new Color3(1.0, 0.84, 0.54);
    const fill = new DirectionalLight('fill', new Vector3(0.3, -0.6, 0.5), this.scene);
    fill.intensity = 0.65;
    fill.diffuse = new Color3(0.67, 0.73, 0.80);

    // Camera
    this.camera = new GameCamera(this.scene, canvas);

    // Chunk-based terrain
    this.chunkManager = new ChunkManager(this.scene);

    // Destination marker
    this.createDestinationMarker();

    // Input — left click for movement (picks against chunk ground meshes)
    this.inputManager = new InputManager(this.scene, this.chunkManager);
    this.inputManager.setGroundClickHandler((worldX, worldZ) => {
      this.handleGroundClick(worldX, worldZ);
    });

    // Right-click context menu for NPCs/items
    this.setupContextMenu(canvas);

    // WASD keyboard controls
    this.setupKeyboard();

    // Network
    this.network = new NetworkManager();
    this.setupNetworkHandlers();
    this.network.connect(token);
    if (onDisconnect) {
      this.network.onDisconnect(onDisconnect);
    }

    // HUD
    this.createHUD();
    this.sidePanel = new SidePanel(this.network, this.token);
    this.chatPanel = new ChatPanel();
    this.chatPanel.setSendHandler((msg) => this.network.sendChat(msg));
    this.chatPanel.addSystemMessage(`Welcome, ${username}! Click to move, right-click NPCs to attack.`, '#0f0');

    // Chat message handler
    this.network.onChat((data) => {
      switch (data.type) {
        case 'player_info': {
          const entityId = (data as any).entityId as number;
          const name = (data as any).name as string;
          this.playerNames.set(entityId, name);
          this.nameToEntityId.set(name.toLowerCase(), entityId);
          const existing = this.remotePlayers.get(entityId);
          if (existing) {
            const target = this.remoteTargets.get(entityId);
            existing.dispose();
            const sprite = new SpriteEntity(this.scene, {
              name: `player_${entityId}`,
              color: new Color3(0.8, 0.2, 0.2),
              label: name,
              labelColor: '#ffffff',
            });
            if (target) {
              sprite.position = new Vector3(target.x, this.getHeight(target.x, target.z), target.z);
            }
            this.remotePlayers.set(entityId, sprite);
          }
          break;
        }
        case 'local': {
          if (this.chatPanel) {
            this.chatPanel.addMessage(data.from || '???', data.message, '#fff');
          }
          this.showPlayerChatBubble(data.from || '', data.message);
          break;
        }
        case 'private':
          if (this.chatPanel) this.chatPanel.addMessage(`[PM] ${data.from}`, data.message, '#c0f');
          break;
        case 'private_sent':
          if (this.chatPanel) this.chatPanel.addMessage(`[PM] To ${data.to}`, data.message, '#c0f');
          break;
        case 'system':
          if (this.chatPanel) this.chatPanel.addSystemMessage(data.message, '#ff0');
          break;
      }
    });

    // Load overworld map, object definitions, and tree 3D model
    this.chunkManager.loadMap('overworld').then(() => {
      this.applyFog();
      this.repositionWorldObjects();
    });
    this.loadObjectDefs();
    this.loadTreeModels();
    this.loadRockModel();
    this.loadPlayerSprites();
    this.loadNpcSprites();

    // Game loop
    let lastTime = performance.now();
    this.engine.runRenderLoop(() => {
      const now = performance.now();
      const dt = (now - lastTime) / 1000;
      lastTime = now;
      this.update(dt);
      this.scene.render();
    });

    window.addEventListener('resize', () => this.engine.resize());
  }

  private getHeight(x: number, z: number): number {
    return this.chunkManager.getEffectiveHeight(x, z);
  }

  private applyFog(): void {
    const meta = this.chunkManager.getMeta();
    if (!meta) return;

    this.scene.fogMode = Scene.FOGMODE_LINEAR;
    this.scene.fogColor = new Color3(meta.fogColor[0], meta.fogColor[1], meta.fogColor[2]);
    this.scene.fogStart = meta.fogStart;
    this.scene.fogEnd = meta.fogEnd;
    this.scene.clearColor = new Color4(meta.fogColor[0], meta.fogColor[1], meta.fogColor[2], 1.0);
  }

  private async loadObjectDefs(): Promise<void> {
    try {
      const res = await fetch('/data/objects.json');
      const defs: WorldObjectDef[] = await res.json();
      for (const def of defs) {
        this.objectDefsCache.set(def.id, def);
      }
      // Rebuild blocked tiles for any world objects that arrived before defs loaded
      this.rebuildBlockedObjectTiles();
    } catch (e) {
      console.warn('Failed to load object definitions:', e);
    }
  }

  /** Rebuild blockedObjectTiles from all known world objects. */
  private rebuildBlockedObjectTiles(): void {
    this.blockedObjectTiles.clear();
    for (const [, data] of this.worldObjectDefs) {
      const def = this.objectDefsCache.get(data.defId);
      if (def?.blocking && !data.depleted) {
        this.blockedObjectTiles.add(`${Math.floor(data.x)},${Math.floor(data.z)}`);
      }
    }
  }

  /** Tree model config: defId → GLB file + target height */
  private static readonly TREE_MODEL_CONFIG: { defId: number; file: string; targetHeight: number }[] = [
    { defId: 1, file: 'tree.glb', targetHeight: 3.0 },         // Tree (level 1)
    { defId: 2, file: 'tree.glb', targetHeight: 3.75 },       // Oak Tree (level 15)
  ];

  private async loadTreeModels(): Promise<void> {
    const loads = GameManager.TREE_MODEL_CONFIG.map(async (cfg) => {
      try {
        const result = await SceneLoader.ImportMeshAsync('', '/models/', cfg.file, this.scene);

        let minY = Infinity;
        let maxY = -Infinity;
        for (const mesh of result.meshes) {
          if (mesh.getTotalVertices() === 0) continue;
          mesh.computeWorldMatrix(true);
          const bb = mesh.getBoundingInfo().boundingBox;
          if (bb.minimumWorld.y < minY) minY = bb.minimumWorld.y;
          if (bb.maximumWorld.y > maxY) maxY = bb.maximumWorld.y;
        }
        const modelHeight = maxY - minY;
        const scale = modelHeight > 0 ? cfg.targetHeight / modelHeight : 1;

        const root = new TransformNode(`treeTemplate_${cfg.defId}`, this.scene);
        for (const mesh of result.meshes) {
          if (!mesh.parent) mesh.parent = root;
        }
        for (const child of root.getChildren()) {
          (child as TransformNode).position.y -= minY;
        }
        root.setEnabled(false);

        this.treeModels.set(cfg.defId, { template: root, scale });
        console.log(`Tree model '${cfg.file}' loaded for defId=${cfg.defId} (height=${modelHeight.toFixed(2)}, scale=${scale.toFixed(3)})`);
      } catch (e) {
        console.warn(`Failed to load tree model '${cfg.file}':`, e);
      }
    });

    await Promise.all(loads);
    this.upgradeTreeSpritesToModels();
  }

  private createTreeModel(objectEntityId: number, objectDefId: number, x: number, z: number, isDepleted: boolean): void {
    const model = this.treeModels.get(objectDefId);
    if (!model) return;

    const clone = model.template.instantiateHierarchy(null, undefined, (source, cloned) => {
      cloned.name = source.name + `_${objectEntityId}`;
    })!;
    clone.setEnabled(!isDepleted);
    for (const child of clone.getChildMeshes()) {
      child.setEnabled(true);
      child.metadata = { objectEntityId };
      // Use alpha-test cutout — avoids depth-sorting bleed on foliage while
      // still discarding transparent (black) pixels in leaf textures.
      const mat = child.material as any;
      if (mat) {
        if (mat.transparencyMode !== undefined) mat.transparencyMode = 1; // ALPHATEST
        mat.alpha = 1;
      }
    }
    const s = model.scale;
    clone.scaling.set(s, s, s);
    const cx = Math.floor(x) + 0.5;
    const cz = Math.floor(z) + 0.5;
    clone.position.set(cx, this.getHeight(cx, cz), cz);
    this.worldObjectModels.set(objectEntityId, clone);
  }

  private upgradeTreeSpritesToModels(): void {
    for (const [objectEntityId, data] of this.worldObjectDefs) {
      if (this.worldObjectModels.has(objectEntityId)) continue;
      const def = this.objectDefsCache.get(data.defId);
      if (def?.category !== 'tree') continue;
      if (!this.treeModels.has(data.defId)) continue;
      const sprite = this.worldObjectSprites.get(objectEntityId);
      if (sprite) {
        sprite.dispose();
        this.worldObjectSprites.delete(objectEntityId);
      }
      this.createTreeModel(objectEntityId, data.defId, data.x, data.z, data.depleted);
    }
  }

  /** Ore color tints per object def ID */
  private static readonly ROCK_COLORS: Record<number, [number, number, number]> = {
    3: [0.72, 0.45, 0.20],  // Copper Rock — warm orange-brown
    4: [0.45, 0.35, 0.32],  // Iron Rock — dark reddish-brown
  };
  private static readonly ROCK_DEPLETED_COLOR: [number, number, number] = [0.4, 0.4, 0.4]; // grey when mined

  private async loadRockModel(): Promise<void> {
    try {
      const result = await SceneLoader.ImportMeshAsync('', '/models/', 'rpgRock.glb', this.scene);

      let minY = Infinity;
      let maxY = -Infinity;
      for (const mesh of result.meshes) {
        if (mesh.getTotalVertices() === 0) continue;
        mesh.computeWorldMatrix(true);
        const bb = mesh.getBoundingInfo().boundingBox;
        if (bb.minimumWorld.y < minY) minY = bb.minimumWorld.y;
        if (bb.maximumWorld.y > maxY) maxY = bb.maximumWorld.y;
      }
      const modelHeight = maxY - minY;
      this.rockModelScale = modelHeight > 0 ? 1.0 / modelHeight : 1;

      const root = new TransformNode('rockTemplate', this.scene);
      for (const mesh of result.meshes) {
        if (!mesh.parent) {
          mesh.parent = root;
        }
      }
      for (const child of root.getChildren()) {
        (child as TransformNode).position.y -= minY;
      }

      root.setEnabled(false);
      this.rockModelTemplate = root;
      console.log(`Rock model loaded (height=${modelHeight.toFixed(2)}, minY=${minY.toFixed(2)}, scale=${this.rockModelScale.toFixed(3)})`);

      this.upgradeRockSpritesToModels();
    } catch (e) {
      console.warn('Failed to load rock model, falling back to sprites:', e);
    }
  }

  private createRockModel(objectEntityId: number, objectDefId: number, x: number, z: number, isDepleted: boolean): void {
    if (!this.rockModelTemplate) return;

    const clone = this.rockModelTemplate.instantiateHierarchy(null, undefined, (source, cloned) => {
      cloned.name = source.name + `_rock_${objectEntityId}`;
    })!;
    clone.setEnabled(true);

    // Apply ore-specific color tint
    const tint = isDepleted
      ? GameManager.ROCK_DEPLETED_COLOR
      : (GameManager.ROCK_COLORS[objectDefId] ?? [0.5, 0.5, 0.5]);

    for (const child of clone.getChildMeshes()) {
      child.setEnabled(true);
      child.metadata = { objectEntityId };
      // Create unique material per rock instance for individual coloring
      const mat = new StandardMaterial(`rockMat_${objectEntityId}_${child.name}`, this.scene);
      mat.diffuseColor = new Color3(tint[0], tint[1], tint[2]);
      mat.specularColor = new Color3(0.15, 0.15, 0.15);
      child.material = mat;
    }

    const s = this.rockModelScale;
    clone.scaling.set(s, s, s);
    clone.position.set(x, this.getHeight(x, z), z);
    this.worldObjectModels.set(objectEntityId, clone);
  }

  private updateRockColor(objectEntityId: number, objectDefId: number, isDepleted: boolean): void {
    const model = this.worldObjectModels.get(objectEntityId);
    if (!model) return;
    const tint = isDepleted
      ? GameManager.ROCK_DEPLETED_COLOR
      : (GameManager.ROCK_COLORS[objectDefId] ?? [0.5, 0.5, 0.5]);
    for (const child of model.getChildMeshes()) {
      const mat = child.material as StandardMaterial;
      if (mat?.diffuseColor) {
        mat.diffuseColor.set(tint[0], tint[1], tint[2]);
      }
    }
  }

  private upgradeRockSpritesToModels(): void {
    if (!this.rockModelTemplate) return;
    for (const [objectEntityId, data] of this.worldObjectDefs) {
      if (this.worldObjectModels.has(objectEntityId)) continue;
      const def = this.objectDefsCache.get(data.defId);
      if (def?.category !== 'rock') continue;
      const sprite = this.worldObjectSprites.get(objectEntityId);
      if (sprite) {
        sprite.dispose();
        this.worldObjectSprites.delete(objectEntityId);
      }
      this.createRockModel(objectEntityId, data.defId, data.x, data.z, data.depleted);
    }
  }

  private async loadPlayerSprites(): Promise<void> {
    try {
      this.playerSprites = await loadDirectionalSprites(this.scene, '/sprites/player', 'player');
      console.log('Player directional sprites loaded');
      // Upgrade local player if already created
      if (this.localPlayer) {
        this.upgradeToDirectionalSprite(this.localPlayer);
      }
      // Upgrade existing remote players
      for (const [, sprite] of this.remotePlayers) {
        this.upgradeToDirectionalSprite(sprite);
      }
    } catch (e) {
      console.warn('Failed to load player sprites, using fallback:', e);
    }

    // Load walk animation (8-direction, 4 frames)
    try {
      this.playerWalkAnim = await load8DirAnimationSprites(this.scene, '/sprites/player/walk', 'player_walk', 4);
      console.log('Player walk animation loaded');
      if (this.localPlayer) this.localPlayer.setWalkAnimation(this.playerWalkAnim);
      for (const [, sprite] of this.remotePlayers) sprite.setWalkAnimation(this.playerWalkAnim);
    } catch (e) {
      console.warn('Failed to load player walk animation:', e);
    }

    // Load punch animation (8-direction, 4 frames) — for Accurate/Defensive/Controlled stances
    try {
      this.playerPunchAnim = await load8DirAnimationSprites(this.scene, '/sprites/player/punch', 'player_punch', 4);
      console.log('Player punch animation loaded');
      this.attachPlayerAttackAnims(this.localPlayer);
      for (const [, sprite] of this.remotePlayers) this.attachPlayerAttackAnims(sprite);
    } catch (e) {
      console.warn('Failed to load player punch animation:', e);
    }

    // Load kick animation (4-direction, 4 frames) — for Aggressive stance
    try {
      this.playerKickAnim = await loadAnimationSprites(this.scene, '/sprites/player/kick', 'player_kick', 4);
      console.log('Player kick animation loaded');
      this.attachPlayerAttackAnims(this.localPlayer);
      for (const [, sprite] of this.remotePlayers) this.attachPlayerAttackAnims(sprite);
    } catch (e) {
      console.warn('Failed to load player kick animation:', e);
    }

    // Load sword animation (4-direction, 4 frames) — for when weapon is equipped
    try {
      this.playerSwordAnim = await loadAnimationSprites(this.scene, '/sprites/player/sword', 'player_sword', 4);
      console.log('Player sword animation loaded');
      this.attachPlayerAttackAnims(this.localPlayer);
      for (const [, sprite] of this.remotePlayers) this.attachPlayerAttackAnims(sprite);
    } catch (e) {
      console.warn('Failed to load player sword animation:', e);
    }
  }

  /** Attach all loaded player attack animations to a sprite */
  private attachPlayerAttackAnims(sprite: SpriteEntity | null): void {
    if (!sprite) return;
    if (this.playerPunchAnim) sprite.addAttackAnimation('punch', this.playerPunchAnim);
    if (this.playerKickAnim) sprite.addAttackAnimation('kick', this.playerKickAnim);
    if (this.playerSwordAnim) sprite.addAttackAnimation('sword', this.playerSwordAnim);
  }

  /**
   * Choose the correct attack animation name based on stance and weapon.
   * - Weapon equipped (slot 0) → 'sword'
   * - Aggressive stance (no weapon) → 'kick'
   * - Accurate/Defensive/Controlled (no weapon) → 'punch'
   * For remote players, always use 'punch' (we don't know their stance/equip).
   */
  private getPlayerAttackAnimName(attackerId: number): string {
    if (attackerId === this.localPlayerId && this.sidePanel) {
      // Check if local player has a weapon equipped (slot 0)
      const weaponId = this.sidePanel.getEquipItem(0);
      if (weaponId > 0) return 'sword';
      // Check stance
      const stance = this.sidePanel.getStance();
      if (stance === 'aggressive') return 'kick';
      return 'punch';
    }
    // Remote players: default to punch
    return 'punch';
  }

  /** NPC sprite config: defId → sprite folder path + optional attack animation */
  private static readonly NPC_SPRITE_CONFIG: { defId: number; path: string; name: string; attackPath?: string; attackFrames?: number }[] = [
    { defId: 1, path: '/sprites/chicken', name: 'chicken' },
    { defId: 10, path: '/sprites/cow', name: 'cow', attackPath: '/sprites/cow/attack', attackFrames: 4 },
  ];

  private async loadNpcSprites(): Promise<void> {
    for (const cfg of GameManager.NPC_SPRITE_CONFIG) {
      try {
        const sprites = await loadDirectionalSprites(this.scene, cfg.path, cfg.name);
        this.npcSpriteSets.set(cfg.defId, sprites);
        console.log(`NPC sprites loaded for ${cfg.name} (defId=${cfg.defId})`);
        // Upgrade existing NPC sprites of this type
        for (const [entityId, sprite] of this.npcSprites) {
          if (this.npcDefs.get(entityId) === cfg.defId) {
            sprite.setDirectionalSprites(sprites);
          }
        }
      } catch (e) {
        console.warn(`Failed to load NPC sprites for ${cfg.name}:`, e);
      }

      // Load attack animation if configured
      if (cfg.attackPath && cfg.attackFrames) {
        try {
          const attackAnim = await loadAnimationSprites(this.scene, cfg.attackPath, cfg.name, cfg.attackFrames);
          // Compute mesh scale so attack frames match idle sprite pixel density
          const idleSprites = this.npcSpriteSets.get(cfg.defId);
          if (idleSprites) {
            const idleTex = idleSprites.materials[0]?.diffuseTexture;
            const atkTex = attackAnim.materials[0]?.[0]?.diffuseTexture;
            if (idleTex && atkTex) {
              const idleSize = idleTex.getSize();
              const atkSize = atkTex.getSize();
              if (idleSize.width > 0 && idleSize.height > 0) {
                attackAnim.meshScaleX = atkSize.width / idleSize.width;
                attackAnim.meshScaleY = atkSize.height / idleSize.height;
              }
            }
          }
          this.npcAttackAnims.set(cfg.defId, attackAnim);
          console.log(`Attack animation loaded for ${cfg.name} (${cfg.attackFrames} frames, scale ${attackAnim.meshScaleX.toFixed(2)}x${attackAnim.meshScaleY.toFixed(2)})`);
          // Attach to existing NPC sprites of this type
          for (const [entityId, sprite] of this.npcSprites) {
            if (this.npcDefs.get(entityId) === cfg.defId) {
              sprite.setAttackAnimation(attackAnim);
            }
          }
        } catch (e) {
          console.warn(`Failed to load attack animation for ${cfg.name}:`, e);
        }
      }
    }
  }

  private upgradeToDirectionalSprite(sprite: SpriteEntity): void {
    if (!this.playerSprites) return;
    sprite.setDirectionalSprites(this.playerSprites);
    if (this.playerWalkAnim) sprite.setWalkAnimation(this.playerWalkAnim);
    this.attachPlayerAttackAnims(sprite);
  }

  /** Reposition all world objects/models after heightmap loads (fixes race condition) */
  private repositionWorldObjects(): void {
    for (const [objectEntityId, data] of this.worldObjectDefs) {
      const h = this.getHeight(data.x, data.z);
      const model = this.worldObjectModels.get(objectEntityId);
      if (model) {
        model.position.y = h;
      }
      const sprite = this.worldObjectSprites.get(objectEntityId);
      if (sprite) {
        sprite.position = new Vector3(data.x, h, data.z);
      }
    }
    // Reposition NPCs
    for (const [entityId, sprite] of this.npcSprites) {
      const target = this.npcTargets.get(entityId);
      if (target) {
        sprite.position = new Vector3(target.x, this.getHeight(target.x, target.z), target.z);
      }
    }
    // Reposition remote players
    for (const [entityId, sprite] of this.remotePlayers) {
      const target = this.remoteTargets.get(entityId);
      if (target) {
        sprite.position = new Vector3(target.x, this.getHeight(target.x, target.z), target.z);
      }
    }
    // Also reposition ground items
    for (const [groundItemId, item] of this.groundItems) {
      const sprite = this.groundItemSprites.get(groundItemId);
      if (sprite) {
        sprite.position = new Vector3(item.x, this.getHeight(item.x, item.z), item.z);
      }
    }
    // Reposition local player
    if (this.localPlayer) {
      this.localPlayer.position = new Vector3(this.playerX, this.getHeight(this.playerX, this.playerZ), this.playerZ);
    }
  }

  private setupKeyboard(): void {
    window.addEventListener('keydown', (e) => {
      if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;
      this.keysDown.add(e.key.toLowerCase());
    });
    window.addEventListener('keyup', (e) => {
      this.keysDown.delete(e.key.toLowerCase());
    });
  }

  private setupNetworkHandlers(): void {
    this.network.on(ServerOpcode.LOGIN_OK, (_op, v) => {
      this.localPlayerId = v[0];
      this.playerX = v[1] / 10;
      this.playerZ = v[2] / 10;
      this.network.setLocalPlayerId(this.localPlayerId);

      this.localPlayer = new SpriteEntity(this.scene, {
        name: 'localPlayer',
        color: new Color3(0.2, 0.4, 0.9),
        width: 1.0,
        height: 1.7,
        label: this.username,
        labelColor: '#00ff00',
        directionalSprites: this.playerSprites ?? undefined,
      });
      this.localPlayer.position = new Vector3(this.playerX, this.getHeight(this.playerX, this.playerZ), this.playerZ);
      console.log(`Logged in as player ${this.localPlayerId}`);
    });

    this.network.on(ServerOpcode.PLAYER_SYNC, (_op, v) => {
      const [entityId, x10, z10, health, maxHealth] = v;
      const x = x10 / 10;
      const z = z10 / 10;

      if (entityId === this.localPlayerId) {
        this.playerHealth = health;
        this.playerMaxHealth = maxHealth;
        this.updateHUD();
        if (this.localPlayer) {
          if (health < maxHealth) {
            this.localPlayer.showHealthBar(health, maxHealth);
          } else {
            this.localPlayer.hideHealthBar();
          }
        }
        return;
      }

      if (!this.remotePlayers.has(entityId)) {
        const playerName = this.playerNames.get(entityId) || 'Player';
        const sprite = new SpriteEntity(this.scene, {
          name: `player_${entityId}`,
          color: new Color3(0.8, 0.2, 0.2),
          width: 1.6,
          height: 2.8,
          label: playerName,
          labelColor: '#ffffff',
          directionalSprites: this.playerSprites ?? undefined,
        });
        sprite.position = new Vector3(x, this.getHeight(x, z), z);
        this.remotePlayers.set(entityId, sprite);
      }
      this.remoteTargets.set(entityId, { x, z });
      const sprite = this.remotePlayers.get(entityId)!;
      if (health < maxHealth) {
        sprite.showHealthBar(health, maxHealth);
      } else {
        sprite.hideHealthBar();
      }
    });

    this.network.on(ServerOpcode.NPC_SYNC, (_op, v) => {
      const [entityId, npcDefId, x10, z10, health, maxHealth] = v;
      const x = x10 / 10;
      const z = z10 / 10;

      this.npcDefs.set(entityId, npcDefId);

      if (!this.npcSprites.has(entityId)) {
        const color = NPC_COLORS[npcDefId] || new Color3(0.5, 0.5, 0.5);
        const name = NPC_NAMES[npcDefId] || `NPC${npcDefId}`;
        const size = NPC_SIZES[npcDefId] || { w: 0.8, h: 1.4 };
        const npcSpriteSet = this.npcSpriteSets.get(npcDefId);
        const sprite = new SpriteEntity(this.scene, {
          name: `npc_${entityId}`,
          color,
          label: name,
          labelColor: '#ffff00',
          width: size.w,
          height: size.h,
          directionalSprites: npcSpriteSet ?? undefined,
        });
        sprite.position = new Vector3(x, this.getHeight(x, z), z);
        // Attach attack animation if available for this NPC type
        const attackAnim = this.npcAttackAnims.get(npcDefId);
        if (attackAnim) sprite.setAttackAnimation(attackAnim);
        this.npcSprites.set(entityId, sprite);
      }

      this.npcTargets.set(entityId, { x, z });

      const sprite = this.npcSprites.get(entityId)!;
      if (health < maxHealth) {
        sprite.showHealthBar(health, maxHealth);
      } else {
        sprite.hideHealthBar();
      }
    });

    this.network.on(ServerOpcode.GROUND_ITEM_SYNC, (_op, v) => {
      const [groundItemId, itemId, quantity, x10, z10] = v;
      if (itemId === 0) {
        const sprite = this.groundItemSprites.get(groundItemId);
        if (sprite) {
          sprite.dispose();
          this.groundItemSprites.delete(groundItemId);
        }
        this.groundItems.delete(groundItemId);
        return;
      }

      const x = x10 / 10;
      const z = z10 / 10;
      this.groundItems.set(groundItemId, { id: groundItemId, itemId, quantity, x, z });

      if (!this.groundItemSprites.has(groundItemId)) {
        const sprite = new SpriteEntity(this.scene, {
          name: `gitem_${groundItemId}`,
          color: new Color3(0.8, 0.7, 0.2),
          label: `Item`,
          labelColor: '#ffaa00',
          width: 0.4,
          height: 0.4,
        });
        sprite.position = new Vector3(x, this.getHeight(x, z), z);
        this.groundItemSprites.set(groundItemId, sprite);
      }
    });

    this.network.on(ServerOpcode.ENTITY_DEATH, (_op, v) => {
      const entityId = v[0];

      if (entityId === this.combatTargetId) {
        this.combatTargetId = -1;
      }

      // Clean up combat facing targets
      this.npcCombatTargets.delete(entityId);
      this.remoteCombatTargets.delete(entityId);
      // Also remove any entity that was targeting this dead entity
      for (const [npcId, targetId] of this.npcCombatTargets) {
        if (targetId === entityId) this.npcCombatTargets.delete(npcId);
      }
      for (const [playerId, targetId] of this.remoteCombatTargets) {
        if (targetId === entityId) this.remoteCombatTargets.delete(playerId);
      }

      const playerSprite = this.remotePlayers.get(entityId);
      if (playerSprite) {
        playerSprite.dispose();
        this.remotePlayers.delete(entityId);
        this.remoteTargets.delete(entityId);
        const name = this.playerNames.get(entityId);
        if (name) this.nameToEntityId.delete(name.toLowerCase());
        this.playerNames.delete(entityId);
      }

      const npcSprite = this.npcSprites.get(entityId);
      if (npcSprite) {
        npcSprite.dispose();
        this.npcSprites.delete(entityId);
        this.npcTargets.delete(entityId);
        this.npcDefs.delete(entityId);
      }
    });

    this.network.on(ServerOpcode.COMBAT_HIT, (_op, v) => {
      const [attackerId, targetId, damage, targetHp, targetMaxHp] = v;
      const targetSprite = this.npcSprites.get(targetId) || this.remotePlayers.get(targetId);
      if (targetSprite) {
        this.showHitSplat(targetSprite.position, damage);
      }

      // Track combat targets for facing
      if (this.npcSprites.has(attackerId)) {
        // NPC attacking a player
        this.npcCombatTargets.set(attackerId, targetId);
      } else if (this.remotePlayers.has(attackerId)) {
        // Remote player attacking an NPC
        this.remoteCombatTargets.set(attackerId, targetId);
      }

      // Trigger attack animation on the attacker sprite
      const attackerSprite = this.npcSprites.get(attackerId)
        || this.remotePlayers.get(attackerId)
        || (attackerId === this.localPlayerId ? this.localPlayer : null);
      if (attackerSprite) {
        const isPlayer = attackerId === this.localPlayerId || this.remotePlayers.has(attackerId);
        if (isPlayer) {
          attackerSprite.playAttackAnimation(this.getPlayerAttackAnimName(attackerId));
        } else {
          // NPC — use default attack animation
          attackerSprite.playAttackAnimation();
        }
      }

      if (targetId === this.localPlayerId && this.localPlayer) {
        this.showHitSplat(this.localPlayer.position, damage);
        this.playerHealth = targetHp;
        this.playerMaxHealth = targetMaxHp;
        this.updateHUD();
        if (targetHp < targetMaxHp) {
          this.localPlayer.showHealthBar(targetHp, targetMaxHp);
        } else {
          this.localPlayer.hideHealthBar();
        }
      }
    });

    this.network.on(ServerOpcode.WORLD_OBJECT_SYNC, (_op, v) => {
      const [objectEntityId, objectDefId, x10, z10, depleted] = v;
      const x = x10 / 10;
      const z = z10 / 10;
      const isDepleted = depleted === 1;

      this.worldObjectDefs.set(objectEntityId, { defId: objectDefId, x, z, depleted: isDepleted });

      const def = this.objectDefsCache.get(objectDefId);

      // Track blocking tiles for pathfinding
      const tileKey = `${Math.floor(x)},${Math.floor(z)}`;
      if (def?.blocking && !isDepleted) {
        this.blockedObjectTiles.add(tileKey);
      } else {
        this.blockedObjectTiles.delete(tileKey);
      }
      const isTree = def?.category === 'tree';
      const isRock = def?.category === 'rock';
      const hasTreeModel = isTree && this.treeModels.has(objectDefId);
      const hasRockModel = isRock && !!this.rockModelTemplate;

      // Create visual if not yet created
      if (hasTreeModel && !this.worldObjectModels.has(objectEntityId)) {
        this.createTreeModel(objectEntityId, objectDefId, x, z, isDepleted);
      } else if (hasRockModel && !this.worldObjectModels.has(objectEntityId)) {
        this.createRockModel(objectEntityId, objectDefId, x, z, isDepleted);
      } else if (!hasTreeModel && !hasRockModel && !this.worldObjectSprites.has(objectEntityId) && !this.worldObjectModels.has(objectEntityId)) {
        const name = def?.name ?? `Object${objectDefId}`;
        const color = def?.color
          ? new Color3(def.color[0] / 255, def.color[1] / 255, def.color[2] / 255)
          : new Color3(0.5, 0.5, 0.5);
        const width = def?.width ?? 0.8;
        const height = def?.height ?? 1.0;

        const sprite = new SpriteEntity(this.scene, {
          name: `obj_${objectEntityId}`,
          color,
          label: name,
          labelColor: '#88ccff',
          width,
          height,
        });
        sprite.position = new Vector3(x, this.getHeight(x, z), z);
        this.worldObjectSprites.set(objectEntityId, sprite);
      }

      // Update depletion visual
      const model = this.worldObjectModels.get(objectEntityId);
      if (model) {
        model.setEnabled(!isDepleted);
      } else {
        const sprite = this.worldObjectSprites.get(objectEntityId);
        if (sprite && isDepleted) {
          sprite.getMesh().isVisible = false;
        } else if (sprite && !isDepleted) {
          sprite.getMesh().isVisible = true;
        }
      }
    });

    this.network.on(ServerOpcode.WORLD_OBJECT_DEPLETED, (_op, v) => {
      const [objectEntityId, isDepleted] = v;
      const data = this.worldObjectDefs.get(objectEntityId);
      if (data) data.depleted = isDepleted === 1;

      // Update blocking tiles for pathfinding
      if (data) {
        const def2 = this.objectDefsCache.get(data.defId);
        const tileKey = `${Math.floor(data.x)},${Math.floor(data.z)}`;
        if (def2?.blocking && isDepleted === 0) {
          this.blockedObjectTiles.add(tileKey);
        } else {
          this.blockedObjectTiles.delete(tileKey);
        }
      }

      const def = data ? this.objectDefsCache.get(data.defId) : null;
      const isRock = def?.category === 'rock';

      const model = this.worldObjectModels.get(objectEntityId);
      if (model) {
        if (isRock && data) {
          // Rocks change color instead of hiding (grey when depleted, ore color when respawned)
          this.updateRockColor(objectEntityId, data.defId, isDepleted === 1);
        } else {
          model.setEnabled(isDepleted === 0);
        }
      } else {
        const sprite = this.worldObjectSprites.get(objectEntityId);
        if (sprite) {
          sprite.getMesh().isVisible = isDepleted === 0;
        }
      }
    });

    this.network.on(ServerOpcode.SKILLING_START, (_op, v) => {
      this.isSkilling = true;
      this.skillingObjectId = v[0];
      if (this.chatPanel) {
        const data = this.worldObjectDefs.get(v[0]);
        const def = data ? this.objectDefsCache.get(data.defId) : null;
        const actionName = def?.actions[0] ?? 'Working';
        this.chatPanel.addSystemMessage(`You begin to ${actionName.toLowerCase()}...`, '#8cf');
      }
    });

    this.network.on(ServerOpcode.SKILLING_STOP, (_op, _v) => {
      this.isSkilling = false;
      this.skillingObjectId = -1;
    });

    this.network.on(ServerOpcode.PLAYER_STATS, (_op, v) => {
      this.playerHealth = v[0];
      this.playerMaxHealth = v[1];
      this.updateHUD();
    });

    this.network.on(ServerOpcode.PLAYER_INVENTORY, (_op, v) => {
      const [slotIndex, itemId, quantity] = v;
      if (this.sidePanel) {
        this.sidePanel.updateInvSlot(slotIndex, itemId, quantity);
      }
    });

    this.network.on(ServerOpcode.PLAYER_SKILLS, (_op, v) => {
      const [skillIndex, level, currentLevel, xpHigh, xpLow] = v;
      const xp = (xpHigh << 16) | (xpLow & 0xFFFF);
      if (this.sidePanel) {
        this.sidePanel.updateSkill(skillIndex, level, currentLevel, xp);
      }
      if (skillIndex === ALL_SKILLS.indexOf('hitpoints')) {
        this.playerHealth = currentLevel;
        this.playerMaxHealth = level;
        this.updateHUD();
      }
    });

    this.network.on(ServerOpcode.PLAYER_EQUIPMENT, (_op, v) => {
      const [slotIndex, itemId] = v;
      if (this.sidePanel) {
        this.sidePanel.updateEquipSlot(slotIndex, itemId);
      }
    });

    this.network.on(ServerOpcode.XP_GAIN, (_op, v) => {
      const [skillIndex, amount] = v;
      if (skillIndex >= 0 && skillIndex < ALL_SKILLS.length) {
        const skillName = SKILL_NAMES[ALL_SKILLS[skillIndex]];
        if (this.chatPanel && amount > 0) {
          this.chatPanel.addSystemMessage(`+${amount} ${skillName} XP`, '#8f8');
        }
      }
    });

    this.network.on(ServerOpcode.LEVEL_UP, (_op, v) => {
      const [skillIndex, newLevel] = v;
      if (skillIndex >= 0 && skillIndex < ALL_SKILLS.length) {
        const skillName = SKILL_NAMES[ALL_SKILLS[skillIndex]];
        if (this.chatPanel) {
          this.chatPanel.addSystemMessage(`Level up! ${skillName} is now level ${newLevel}!`, '#ff0');
        }
      }
    });

    // Handle FLOOR_CHANGE
    this.network.on(ServerOpcode.FLOOR_CHANGE, (_op, values) => {
      const newFloor = values[0];
      this.currentFloor = newFloor;
      console.log(`Floor changed to ${newFloor}`);
      // Update chunk visibility for multi-floor
      this.chunkManager.setCurrentFloor(newFloor);
    });

    // Handle MAP_CHANGE as a raw binary handler
    this.network.onRawMessage((data: ArrayBuffer) => {
      const view = new DataView(data);
      const opcode = view.getUint8(0);
      if (opcode === ServerOpcode.MAP_CHANGE) {
        const { str: mapId, values } = decodeStringPacket(data);
        const newX = values[0] / 10;
        const newZ = values[1] / 10;
        this.handleMapChange(mapId, newX, newZ);
      }
    });
  }

  private async handleMapChange(mapId: string, newX: number, newZ: number): Promise<void> {
    console.log(`Map change to '${mapId}' at (${newX}, ${newZ})`);

    // Clear all entity sprites
    for (const [, sprite] of this.remotePlayers) sprite.dispose();
    this.remotePlayers.clear();
    this.remoteTargets.clear();

    for (const [, sprite] of this.npcSprites) sprite.dispose();
    this.npcSprites.clear();
    this.npcTargets.clear();
    this.npcDefs.clear();

    for (const [, sprite] of this.groundItemSprites) sprite.dispose();
    this.groundItemSprites.clear();
    this.groundItems.clear();

    for (const [, sprite] of this.worldObjectSprites) sprite.dispose();
    this.worldObjectSprites.clear();
    for (const [, model] of this.worldObjectModels) model.dispose();
    this.worldObjectModels.clear();
    this.worldObjectDefs.clear();
    this.blockedObjectTiles.clear();

    this.isSkilling = false;
    this.skillingObjectId = -1;

    // Load new map
    await this.chunkManager.loadMap(mapId);
    this.applyFog();

    // Update player position
    this.playerX = newX;
    this.playerZ = newZ;
    this.path = [];
    if (this.localPlayer) this.localPlayer.stopWalking();
    this.combatTargetId = -1;

    if (this.localPlayer) {
      this.localPlayer.position = new Vector3(this.playerX, this.getHeight(this.playerX, this.playerZ), this.playerZ);
    }

    // Reposition any entities that arrived before map finished loading
    this.repositionWorldObjects();

    if (this.chatPanel) {
      this.chatPanel.addSystemMessage(`Entered ${this.chunkManager.getMeta()?.name || mapId}.`, '#0f0');
    }
  }

  private setupContextMenu(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.hideContextMenu();

      const pickResult = this.scene.pick(this.scene.pointerX, this.scene.pointerY);
      if (!pickResult?.hit || !pickResult.pickedMesh) return;

      const meshName = pickResult.pickedMesh.name;
      const options: { label: string; action: () => void }[] = [];

      for (const [entityId, sprite] of this.npcSprites) {
        if (sprite.getMesh().name === meshName) {
          const npcDefId = this.npcDefs.get(entityId);
          const name = NPC_NAMES[npcDefId || 0] || 'NPC';
          options.push({
            label: `Attack ${name}`,
            action: () => this.attackNpc(entityId),
          });
          if (npcDefId === 8) {
            options.push({
              label: `Talk-to ${name}`,
              action: () => {
                if (this.chatPanel) this.chatPanel.addSystemMessage('The shopkeeper nods at you.', '#ff0');
              },
            });
          }
          break;
        }
      }

      for (const [groundItemId, sprite] of this.groundItemSprites) {
        if (sprite.getMesh().name === meshName) {
          options.push({
            label: `Pick up item`,
            action: () => this.pickupItem(groundItemId),
          });
          break;
        }
      }

      // Check 3D tree models — walk up parent chain looking for objectEntityId metadata
      let pickedObjectEntityId: number | null = null;
      let walkMesh: any = pickResult.pickedMesh;
      while (walkMesh) {
        if (walkMesh.metadata?.objectEntityId != null) {
          pickedObjectEntityId = walkMesh.metadata.objectEntityId;
          break;
        }
        walkMesh = walkMesh.parent;
      }

      if (pickedObjectEntityId != null) {
        const data = this.worldObjectDefs.get(pickedObjectEntityId);
        if (data && !data.depleted) {
          const def = this.objectDefsCache.get(data.defId);
          if (def) {
            for (let i = 0; i < def.actions.length; i++) {
              const actionName = def.actions[i];
              const eid = pickedObjectEntityId;
              const actionIdx = i;
              options.push({
                label: `${actionName} ${def.name}`,
                action: () => this.interactObject(eid, actionIdx),
              });
            }
          }
        }
      }

      // Check sprite-based world objects
      for (const [objectEntityId, sprite] of this.worldObjectSprites) {
        if (sprite.getMesh().name === meshName) {
          const data = this.worldObjectDefs.get(objectEntityId);
          if (data && !data.depleted) {
            const def = this.objectDefsCache.get(data.defId);
            if (def) {
              for (let i = 0; i < def.actions.length; i++) {
                const actionName = def.actions[i];
                const actionIdx = i;
                options.push({
                  label: `${actionName} ${def.name}`,
                  action: () => this.interactObject(objectEntityId, actionIdx),
                });
              }
            }
          }
          break;
        }
      }

      if (options.length > 0) {
        this.showContextMenu(e.clientX, e.clientY, options);
      }
    });
  }

  private showContextMenu(x: number, y: number, options: { label: string; action: () => void }[]): void {
    this.hideContextMenu();

    const menu = document.createElement('div');
    menu.style.cssText = `
      position: fixed; left: ${x}px; top: ${y}px;
      background: #3a3125; border: 2px solid #5a4a35;
      font-family: monospace; font-size: 13px; z-index: 1000;
      min-width: 120px; box-shadow: 2px 2px 8px rgba(0,0,0,0.5);
    `;

    for (const opt of options) {
      const item = document.createElement('div');
      item.textContent = opt.label;
      item.style.cssText = `padding: 4px 12px; color: #ffcc00; cursor: pointer;`;
      item.addEventListener('mouseenter', () => item.style.background = '#5a4a35');
      item.addEventListener('mouseleave', () => item.style.background = 'transparent');
      item.addEventListener('click', () => {
        opt.action();
        this.hideContextMenu();
      });
      menu.appendChild(item);
    }

    document.body.appendChild(menu);
    this.contextMenu = menu;

    const closeHandler = () => {
      this.hideContextMenu();
      document.removeEventListener('click', closeHandler);
    };
    setTimeout(() => document.addEventListener('click', closeHandler), 0);
  }

  private hideContextMenu(): void {
    if (this.contextMenu) {
      this.contextMenu.remove();
      this.contextMenu = null;
    }
  }

  private attackNpc(npcEntityId: number): void {
    this.combatTargetId = npcEntityId;
    this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_ATTACK_NPC, npcEntityId));

    const target = this.npcTargets.get(npcEntityId);
    if (target) {
      const path = findPath(this.playerX, this.playerZ, target.x, target.z,
        this.isTileBlocked,
        this.chunkManager.getMapWidth(), this.chunkManager.getMapHeight(), 200,
        (fx, fz, tx, tz) => this.currentFloor === 0 ? this.chunkManager.isWallBlocked(fx, fz, tx, tz) : this.chunkManager.isWallBlockedOnFloor(fx, fz, tx, tz, this.currentFloor));
      if (path.length > 1) {
        const last = path[path.length - 1];
        if (Math.floor(last.x) === Math.floor(target.x) && Math.floor(last.z) === Math.floor(target.z)) {
          path.pop();
        }
      }
      if (path.length > 0) {
        this.path = path;
        this.destMarker.isVisible = false;
        this.minimap?.clearDestination();
      }
    }
  }

  private pickupItem(groundItemId: number): void {
    this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_PICKUP_ITEM, groundItemId));
  }

  private interactObject(objectEntityId: number, actionIndex: number): void {
    this.combatTargetId = -1;

    const data = this.worldObjectDefs.get(objectEntityId);
    if (!data) return;

    // Walk to the object if not adjacent
    const dx = data.x - this.playerX;
    const dz = data.z - this.playerZ;
    const dist = Math.hypot(dx, dz);
    if (dist > 2.0) {
      const path = findPath(this.playerX, this.playerZ, data.x, data.z,
        this.isTileBlocked,
        this.chunkManager.getMapWidth(), this.chunkManager.getMapHeight(), 200,
        (fx, fz, tx, tz) => this.currentFloor === 0 ? this.chunkManager.isWallBlocked(fx, fz, tx, tz) : this.chunkManager.isWallBlockedOnFloor(fx, fz, tx, tz, this.currentFloor));
      if (path.length > 1) {
        const last = path[path.length - 1];
        if (Math.floor(last.x) === Math.floor(data.x) && Math.floor(last.z) === Math.floor(data.z)) {
          path.pop();
        }
      }
      if (path.length > 0) {
        this.path = path;
        this.network.sendMove(path);
      }
    }

    // Send interaction request
    this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_INTERACT_OBJECT, objectEntityId, actionIndex));
  }

  private showPlayerChatBubble(fromName: string, message: string): void {
    if (!fromName) return;

    if (fromName.toLowerCase() === this.username.toLowerCase()) {
      if (this.localPlayer) {
        this.localPlayer.showChatBubble(message);
      }
      return;
    }

    const entityId = this.nameToEntityId.get(fromName.toLowerCase());
    if (entityId !== undefined) {
      const sprite = this.remotePlayers.get(entityId);
      if (sprite) {
        sprite.showChatBubble(message);
      }
    }
  }

  private showHitSplat(pos: Vector3, damage: number): void {
    const el = document.createElement('div');
    el.style.cssText = `
      position: fixed; pointer-events: none; z-index: 250;
      width: 32px; height: 32px;
      transform: translate(-50%, -50%);
      display: flex; align-items: center; justify-content: center;
      image-rendering: pixelated;
      transition: opacity 0.3s ease-out;
    `;

    const img = document.createElement('img');
    img.src = damage > 0 ? '/sprites/effects/hitsplash.png' : '/sprites/effects/nohitsplash.png';
    img.style.cssText = `
      position: absolute; top: 0; left: 0; width: 100%; height: 100%;
      image-rendering: pixelated; pointer-events: none;
    `;
    el.appendChild(img);

    const numEl = document.createElement('span');
    numEl.textContent = damage.toString();
    numEl.style.cssText = `
      position: relative; z-index: 1;
      color: #fff; font-family: monospace; font-size: 13px; font-weight: bold;
      text-shadow: 1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000;
    `;
    el.appendChild(numEl);

    document.body.appendChild(el);

    const worldPos = new Vector3(
      pos.x + (Math.random() - 0.5) * 0.3,
      pos.y + 1.5,
      pos.z
    );

    this.hitSplats.push({
      worldPos,
      el,
      timer: 1.2,
      startY: worldPos.y,
    });
  }

  private createDestinationMarker(): void {
    const marker = MeshBuilder.CreateDisc('destMarker', { radius: 0.3, tessellation: 6 }, this.scene);
    marker.isVisible = false;
    // Lay disc flat on ground (default disc normal is +Z, rotate to +Y)
    marker.rotationQuaternion = Quaternion.RotationAxis(Vector3.Right(), -Math.PI / 2);
    const mat = new StandardMaterial('destMarkerMat', this.scene);
    mat.diffuseColor = new Color3(1, 1, 0);
    mat.emissiveColor = new Color3(0.5, 0.5, 0);
    mat.specularColor = Color3.Black();
    mat.backFaceCulling = false;
    marker.material = mat;
    this.destMarker = marker;
  }

  /** Align the destination marker to the terrain normal at (x, z) */
  private alignMarkerToTerrain(x: number, z: number): void {
    const d = 0.25; // sample offset for gradient
    const hC = this.getHeight(x, z);
    const hR = this.getHeight(x + d, z);
    const hF = this.getHeight(x, z + d);
    // Terrain tangent vectors
    const tx = new Vector3(d, hR - hC, 0);
    const tz = new Vector3(0, hF - hC, d);
    // Normal = cross product (tz × tx gives upward-facing normal)
    const normal = Vector3.Cross(tz, tx).normalize();
    // Base rotation: lay disc flat (disc normal +Z → +Y)
    const baseRot = Quaternion.RotationAxis(Vector3.Right(), -Math.PI / 2);
    // Tilt from up to terrain normal
    const up = Vector3.Up();
    const angle = Math.acos(Math.min(1, Vector3.Dot(up, normal)));
    if (angle > 0.001) {
      const axis = Vector3.Cross(up, normal).normalize();
      const tilt = Quaternion.RotationAxis(axis, angle);
      this.destMarker.rotationQuaternion = tilt.multiply(baseRot);
    } else {
      this.destMarker.rotationQuaternion = baseRot;
    }
  }

  /** Tile blocked check that includes world objects (trees, rocks, etc.) */
  private isTileBlocked = (x: number, z: number): boolean => {
    if (this.currentFloor === 0) {
      return this.chunkManager.isBlocked(x, z) || this.blockedObjectTiles.has(`${x},${z}`);
    }
    return this.chunkManager.isBlockedOnFloor(x, z, this.currentFloor);
  };

  private handleGroundClick(worldX: number, worldZ: number): void {
    this.combatTargetId = -1;

    const tx = Math.floor(worldX), tz = Math.floor(worldZ);
    const blocked = this.isTileBlocked(tx, tz);
    console.log(`[Click] target=(${worldX.toFixed(1)}, ${worldZ.toFixed(1)}) tile=(${tx},${tz}) blocked=${blocked}`);

    const path = findPath(this.playerX, this.playerZ, worldX, worldZ,
      this.isTileBlocked,
      this.chunkManager.getMapWidth(), this.chunkManager.getMapHeight(), 200,
      (fx, fz, tx, tz) => this.currentFloor === 0 ? this.chunkManager.isWallBlocked(fx, fz, tx, tz) : this.chunkManager.isWallBlockedOnFloor(fx, fz, tx, tz, this.currentFloor));

    if (path.length > 0) {
      this.path = path;
      const dest = path[path.length - 1];
      this.destMarker.position.x = dest.x;
      this.destMarker.position.y = this.getHeight(dest.x, dest.z) + 0.02;
      this.destMarker.position.z = dest.z;
      this.alignMarkerToTerrain(dest.x, dest.z);
      this.destMarker.isVisible = true;
      this.minimap?.setDestination(dest.x, dest.z);
      this.network.sendMove(path);
    }
  }

  private createHUD(): void {
    this.statsPanel = new StatsPanel();
    this.minimap = new Minimap(200);
    this.minimap.setClickMoveHandler((worldX, worldZ) => {
      this.handleGroundClick(worldX, worldZ);
    });
  }

  destroy(): void {
    this.engine.stopRenderLoop();
    this.engine.dispose();
    this.chunkManager.disposeAll();
    for (const [, sprite] of this.worldObjectSprites) sprite.dispose();
    this.worldObjectSprites.clear();
    for (const [, model] of this.worldObjectModels) model.dispose();
    this.worldObjectModels.clear();
    for (const [, m] of this.treeModels) m.template.dispose();
    this.treeModels.clear();
    document.getElementById('chat-panel')?.remove();
    document.getElementById('side-panel')?.remove();
    for (const splat of this.hitSplats) splat.el.remove();
    this.hitSplats = [];
    document.querySelectorAll('.chat-bubble-overlay').forEach(el => el.remove());
    document.querySelectorAll('.entity-health-bar').forEach(el => el.remove());
  }

  private updateOverlayPositions(): void {
    const cam = this.scene.activeCamera;
    if (!cam) return;

    const engine = this.engine;
    const w = engine.getRenderWidth();
    const h = engine.getRenderHeight();
    const viewMatrix = cam.getViewMatrix();
    const projMatrix = cam.getProjectionMatrix();
    const transform = viewMatrix.multiply(projMatrix);
    const viewport = new Viewport(0, 0, w, h);

    const allSprites: SpriteEntity[] = [];
    if (this.localPlayer) allSprites.push(this.localPlayer);
    for (const [, sprite] of this.remotePlayers) allSprites.push(sprite);
    for (const [, sprite] of this.npcSprites) allSprites.push(sprite);

    for (const sprite of allSprites) {
      if (sprite.hasChatBubble()) {
        const worldPos = sprite.getChatBubbleWorldPos();
        if (worldPos) {
          const screenPos = Vector3.Project(worldPos, Matrix.Identity(), transform, viewport);
          sprite.updateChatBubbleScreenPos(screenPos.x, screenPos.y);
        }
      }
      if (sprite.hasHealthBar()) {
        const worldPos = sprite.getHealthBarWorldPos();
        if (worldPos) {
          const screenPos = Vector3.Project(worldPos, Matrix.Identity(), transform, viewport);
          sprite.updateHealthBarScreenPos(screenPos.x, screenPos.y);
        }
      }
    }
  }

  private updateHUD(): void {
    if (this.statsPanel) {
      this.statsPanel.updateHealth(this.playerHealth, this.playerMaxHealth);
    }
  }

  private update(dt: number): void {
    // WASD camera rotation
    const camSpeed = 2.0 * dt;
    const cam = this.camera.getCamera();
    if (this.keysDown.has('a') || this.keysDown.has('arrowleft')) cam.alpha -= camSpeed;
    if (this.keysDown.has('d') || this.keysDown.has('arrowright')) cam.alpha += camSpeed;
    if (this.keysDown.has('w') || this.keysDown.has('arrowup')) cam.beta = Math.max(0.2, cam.beta - camSpeed);
    if (this.keysDown.has('s') || this.keysDown.has('arrowdown')) cam.beta = Math.min(Math.PI / 2.2, cam.beta + camSpeed);

    // Update attack animations on all sprites
    if (this.localPlayer) this.localPlayer.updateAnimation(dt);
    for (const [, sprite] of this.remotePlayers) sprite.updateAnimation(dt);
    for (const [, sprite] of this.npcSprites) sprite.updateAnimation(dt);

    // Update chunks around player
    this.chunkManager.updatePlayerPosition(this.playerX, this.playerZ);
    this.chunkManager.updateAnimations();

    // Combat follow
    if (this.combatTargetId >= 0 && this.localPlayer) {
      const npcTarget = this.npcTargets.get(this.combatTargetId);
      if (npcTarget) {
        const dx = npcTarget.x - this.playerX;
        const dz = npcTarget.z - this.playerZ;
        const dist = Math.hypot(dx, dz);
        if (dist > 1.5) {
          if (this.path.length === 0 || dist > 3) {
            const newPath = findPath(this.playerX, this.playerZ, npcTarget.x, npcTarget.z,
              this.isTileBlocked,
              this.chunkManager.getMapWidth(), this.chunkManager.getMapHeight(), 200,
              (fx, fz, tx, tz) => this.currentFloor === 0 ? this.chunkManager.isWallBlocked(fx, fz, tx, tz) : this.chunkManager.isWallBlockedOnFloor(fx, fz, tx, tz, this.currentFloor));
            if (newPath.length > 1) {
              const last = newPath[newPath.length - 1];
              if (Math.floor(last.x) === Math.floor(npcTarget.x) && Math.floor(last.z) === Math.floor(npcTarget.z)) {
                newPath.pop();
              }
            }
            if (newPath.length > 0) {
              this.path = newPath;
              this.destMarker.isVisible = false;
              this.minimap?.clearDestination();
            }
          }
        }
      }
    }

    // Move local player
    if (this.path.length > 0 && this.localPlayer) {
      // Start walk animation when path is active
      if (!this.localPlayer.isWalking()) this.localPlayer.startWalking();

      if (this.combatTargetId >= 0) {
        const npcTarget = this.npcTargets.get(this.combatTargetId);
        if (npcTarget) {
          const toDist = Math.hypot(npcTarget.x - this.playerX, npcTarget.z - this.playerZ);
          if (toDist <= 1.5) {
            this.path = [];
            this.localPlayer.stopWalking();
            this.playerX = Math.floor(this.playerX) + 0.5;
            this.playerZ = Math.floor(this.playerZ) + 0.5;
            this.localPlayer!.position = new Vector3(this.playerX, this.getHeight(this.playerX, this.playerZ), this.playerZ);
          }
        }
      }

      if (this.path.length > 0) {
        const target = this.path[0];
        const dx = target.x - this.playerX;
        const dz = target.z - this.playerZ;
        const dist = Math.hypot(dx, dz);
        const step = this.moveSpeed * dt;

        // Update sprite direction based on movement + camera angle
        const camPos = this.scene.activeCamera?.position;
        if (camPos) this.localPlayer.updateMovementDirection(dx, dz, camPos);

        if (dist <= step) {
          this.playerX = target.x;
          this.playerZ = target.z;
          this.path.shift();
          if (this.path.length === 0) {
            this.destMarker.isVisible = false;
            this.minimap?.clearDestination();
            this.localPlayer.stopWalking();
          }
        } else {
          this.playerX += (dx / dist) * step;
          this.playerZ += (dz / dist) * step;
        }
        this.localPlayer.position = new Vector3(this.playerX, this.getHeight(this.playerX, this.playerZ), this.playerZ);
      }
    }

    // Face local player toward combat target when idle
    if (this.localPlayer && this.path.length === 0 && this.combatTargetId >= 0) {
      const camPos = this.scene.activeCamera?.position;
      if (camPos) {
        const npcTarget = this.npcTargets.get(this.combatTargetId);
        const npcSprite = this.npcSprites.get(this.combatTargetId);
        if (npcTarget && npcSprite) {
          this.localPlayer.faceToward(npcSprite.position, camPos);
        }
      }
    }

    // Interpolate remote players
    for (const [entityId, sprite] of this.remotePlayers) {
      const target = this.remoteTargets.get(entityId);
      if (!target) continue;
      const c = sprite.position;
      const dx = target.x - c.x;
      const dz = target.z - c.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 0.05) {
        if (!sprite.isWalking()) sprite.startWalking();
        const camPos = this.scene.activeCamera?.position;
        if (camPos) sprite.updateMovementDirection(dx, dz, camPos);
        const step = Math.min(4.0 * dt, dist);
        const nx = c.x + (dx / dist) * step;
        const nz = c.z + (dz / dist) * step;
        sprite.position = new Vector3(nx, this.getHeight(nx, nz), nz);
      } else {
        if (sprite.isWalking()) sprite.stopWalking();
        // Idle — face combat target if in combat
        const combatTarget = this.remoteCombatTargets.get(entityId);
        if (combatTarget !== undefined) {
          const camPos = this.scene.activeCamera?.position;
          if (camPos) {
            const targetSprite = this.npcSprites.get(combatTarget);
            if (targetSprite) sprite.faceToward(targetSprite.position, camPos);
          }
        }
      }
    }

    // Interpolate NPCs
    for (const [entityId, sprite] of this.npcSprites) {
      const target = this.npcTargets.get(entityId);
      if (!target) continue;
      const c = sprite.position;
      const dx = target.x - c.x;
      const dz = target.z - c.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 0.05) {
        const camPos = this.scene.activeCamera?.position;
        if (camPos) sprite.updateMovementDirection(dx, dz, camPos);
        const step = Math.min(3.0 * dt, dist);
        const nx = c.x + (dx / dist) * step;
        const nz = c.z + (dz / dist) * step;
        sprite.position = new Vector3(nx, this.getHeight(nx, nz), nz);
      } else {
        // Idle — face combat target if in combat
        const combatTarget = this.npcCombatTargets.get(entityId);
        if (combatTarget !== undefined) {
          const camPos = this.scene.activeCamera?.position;
          if (camPos) {
            // NPC's target could be local player or a remote player
            if (combatTarget === this.localPlayerId && this.localPlayer) {
              sprite.faceToward(this.localPlayer.position, camPos);
            } else {
              const targetSprite = this.remotePlayers.get(combatTarget);
              if (targetSprite) sprite.faceToward(targetSprite.position, camPos);
            }
          }
        }
      }
    }

    // Update hit splats
    {
      const cam = this.scene.activeCamera;
      if (cam) {
        const w = this.engine.getRenderWidth();
        const h = this.engine.getRenderHeight();
        const viewMatrix = cam.getViewMatrix();
        const projMatrix = cam.getProjectionMatrix();
        const transform = viewMatrix.multiply(projMatrix);
        const vp = new Viewport(0, 0, w, h);

        for (let i = this.hitSplats.length - 1; i >= 0; i--) {
          const splat = this.hitSplats[i];
          splat.timer -= dt;
          splat.worldPos.y += dt * 0.5;

          const opacity = splat.timer < 0.3 ? splat.timer / 0.3 : 1;
          splat.el.style.opacity = opacity.toString();

          if (splat.timer <= 0) {
            splat.el.remove();
            this.hitSplats.splice(i, 1);
          } else {
            const screenPos = Vector3.Project(splat.worldPos, Matrix.Identity(), transform, vp);
            splat.el.style.left = `${screenPos.x}px`;
            splat.el.style.top = `${screenPos.y}px`;
          }
        }
      }
    }

    // Camera follows player
    if (this.localPlayer) {
      this.camera.followTarget(new Vector3(this.playerX, this.getHeight(this.playerX, this.playerZ), this.playerZ));
    }

    // Note: player sprite directions are updated during movement interpolation above
    // (based on movement direction, not camera angle)

    // Update all HTML overlay positions
    this.updateOverlayPositions();

    // Update minimap
    if (this.minimap && this.chunkManager.isLoaded()) {
      const remotePosArr: { x: number; z: number }[] = [];
      for (const [, target] of this.remoteTargets) {
        remotePosArr.push(target);
      }
      const npcPosArr: { x: number; z: number }[] = [];
      for (const [, target] of this.npcTargets) {
        npcPosArr.push(target);
      }
      const camAlpha = this.camera.getCamera().alpha;
      this.minimap.update(
        this.playerX, this.playerZ,
        remotePosArr, npcPosArr,
        this.chunkManager,
        camAlpha
      );
    }
  }
}
