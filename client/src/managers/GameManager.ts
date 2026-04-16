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
import { CharacterEntity, loadGearTemplate, type GearDef } from '../rendering/CharacterEntity';
import { Npc3DEntity } from '../rendering/Npc3DEntity';
import { loadRecoloredDirectionalSprites, loadRecolored8DirAnimationSprites, loadRecoloredAnimationSprites, type RecolorConfig } from '../rendering/SpriteRecolor';
import { InputManager } from './InputManager';
import { NetworkManager } from './NetworkManager';
import { findPath } from '../rendering/Pathfinding';
import { SidePanel } from '../ui/SidePanel';
import { ChatPanel } from '../ui/ChatPanel';
import { GearDebugPanel } from '../ui/GearDebugPanel';
import { Minimap } from '../ui/Minimap';
import { StatsPanel } from '../ui/StatsPanel';
import { ShopPanel, type ShopItem } from '../ui/ShopPanel';
import { ServerOpcode, ClientOpcode, encodePacket, ALL_SKILLS, SKILL_NAMES, ASSET_TO_OBJECT_DEF, WallEdge, decodeStringPacket, type WorldObjectDef, type ItemDef } from '@projectrs/shared';

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
  11: new Color3(0.6, 0.2, 0.15), // Weapon Smith — dark red
  12: new Color3(0.4, 0.4, 0.45), // Armorer — steel grey
  13: new Color3(0.45, 0.35, 0.25), // Leg Armorer — brown
  14: new Color3(0.3, 0.35, 0.5),  // Shield Smith — blue-grey
};

const NPC_NAMES: Record<number, string> = {
  1: 'Chicken', 2: 'Rat', 3: 'Goblin', 4: 'Wolf',
  5: 'Skeleton', 6: 'Spider', 7: 'Guard', 8: 'Shopkeeper',
  9: 'Dark Knight', 10: 'Cow',
  11: 'Weapon Smith', 12: 'Armorer', 13: 'Leg Armorer', 14: 'Shield Smith',
};

const NPC_SIZES: Record<number, { w: number; h: number }> = {
  1: { w: 0.7, h: 0.85 },  // Chicken (small, ~half player height)
  2: { w: 0.5, h: 0.7 },   // Rat (small)
  6: { w: 0.6, h: 0.5 },   // Spider (wide, short)
  9: { w: 1.0, h: 1.8 },   // Dark Knight (big)
  10: { w: 1.6, h: 1.4 },  // Cow (wide, slightly shorter than player)
};

/** 3D model config for NPCs. npcDefId → GLB path + scale + animation name mappings */
const NPC_3D_MODELS: Record<number, { file: string; scale: number; anims: { idle: string; walk?: string; attack?: string; death?: string } }> = {
  1:  { file: '/models/npcs/cow.glb', scale: 0.15, anims: { idle: 'Armature|Armature|Idle', walk: 'Armature|Armature|WalkSlow', death: 'Armature|Armature|Death' } }, // Chicken placeholder
  2:  { file: '/models/npcs/rat.glb', scale: 0.2, anims: { idle: 'RatArmature|RatArmature|Rat_Idle', walk: 'RatArmature|RatArmature|Rat_Walk', attack: 'RatArmature|RatArmature|Rat_Attack', death: 'RatArmature|RatArmature|Rat_Death' } },
  6:  { file: '/models/npcs/spider.glb', scale: 0.2, anims: { idle: 'SpiderArmature|SpiderArmature|Spider_Idle', walk: 'SpiderArmature|SpiderArmature|Spider_Walk', attack: 'SpiderArmature|SpiderArmature|Spider_Attack', death: 'SpiderArmature|SpiderArmature|Spider_Death' } },
  10: { file: '/models/npcs/cow.glb', scale: 0.2, anims: { idle: 'Armature|Armature|Idle', walk: 'Armature|Armature|WalkSlow', death: 'Armature|Armature|Death' } },
  15: { file: '/models/npcs/Camel.glb', scale: 1.0, anims: { idle: 'ready', walk: 'walk', attack: 'attack', death: 'death' } },
};

/**
 * Equipment slot → bone attachment config.
 * Each slot maps to a bone on the character skeleton + default transform.
 * Gear GLBs go in /gear/{slot}/{itemId}.glb
 */
const EQUIP_SLOT_BONES: Record<string, { boneName: string; localPosition: { x: number; y: number; z: number }; localRotation: { x: number; y: number; z: number }; scale: number }> = {
  weapon:  { boneName: 'hand_r',    localPosition: { x: -0.05, y: 0.08, z: -0.2 },    localRotation: { x: Math.PI / 2, y: 0, z: 0 }, scale: 0.9 },
  shield:  { boneName: 'lowerarm_l', localPosition: { x: -0.08, y: -0.15, z: 0 },    localRotation: { x: 0, y: Math.PI, z: 0 }, scale: 0.85 },
  head:    { boneName: 'Head',      localPosition: { x: 0, y: 0.08, z: 0 },    localRotation: { x: 0, y: 0, z: 0 }, scale: 1 },
  body:    { boneName: 'spine_02',  localPosition: { x: 0, y: 0, z: 0 },    localRotation: { x: 0, y: 0, z: 0 }, scale: 1 },
  legs:    { boneName: 'pelvis',    localPosition: { x: 0, y: 0, z: 0 },    localRotation: { x: 0, y: 0, z: 0 }, scale: 1 },
  feet:    { boneName: 'foot_r',    localPosition: { x: 0, y: 0, z: 0 },    localRotation: { x: 0, y: 0, z: 0 }, scale: 1 },
  hands:   { boneName: 'hand_r',    localPosition: { x: 0, y: 0, z: 0 },    localRotation: { x: 0, y: 0, z: 0 }, scale: 1 },
  neck:    { boneName: 'neck_01',   localPosition: { x: 0, y: 0, z: 0 },    localRotation: { x: 0, y: 0, z: 0 }, scale: 1 },
  ring:    { boneName: 'hand_l',    localPosition: { x: 0, y: 0, z: 0 },    localRotation: { x: 0, y: 0, z: 0 }, scale: 1 },
  cape:    { boneName: 'spine_03',  localPosition: { x: 0, y: -0.1, z: -0.1 }, localRotation: { x: 0, y: 0, z: 0 }, scale: 1 },
};

/** Equipment slot index → slot name (matches server slot ordering) */
const EQUIP_SLOT_NAMES = ['weapon', 'shield', 'head', 'body', 'legs', 'neck', 'ring', 'hands', 'feet', 'cape'];

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
  private localPlayer: CharacterEntity | null = null;
  private localPlayerId: number = -1;
  private currentFloor: number = 0;
  private playerX: number = 512;
  private playerZ: number = 512;
  private playerHealth: number = 10;
  private playerMaxHealth: number = 10;

  // Movement — tick-aligned tile stepping (RS-style)
  private path: { x: number; z: number }[] = [];
  private pathIndex: number = 0;
  private moveSpeed: number = 1.67; // RS2 walk speed: 1 tile per 600ms tick
  private pendingPath: { x: number; z: number }[] | null = null; // queued path from click-while-moving
  private pendingSkill: { objectId: number; variant?: string } | null = null; // deferred skilling until walk finishes
  private skillCancelTime: number = 0; // timestamp when skilling was last cancelled
  private skillingFacingAngle: number = 0; // locked facing angle while skilling
  private tileProgress: number = 0; // 0→1 progress through current tile step
  private tileFrom: { x: number; z: number } = { x: 0, z: 0 }; // where we started this tile step
  private _tempVec: Vector3 = new Vector3(); // reusable temp vector to avoid per-frame allocations
  private _minimapRemotes: { x: number; z: number }[] = [];
  private _minimapNpcs: { x: number; z: number }[] = [];
  // NOTE: do NOT reuse a single Vector3 for entity positions — the setter stores the reference
  private _splatVp = new Viewport(0, 0, 1, 1); // reusable viewport for hit splat projection

  // Local player equipment tracking (slot index → item ID)
  private localEquipment: Map<number, number> = new Map();

  // Gear — cached templates so the same GLB isn't loaded twice
  private gearTemplateCache: Map<string, any> = new Map(); // key: "slot/itemId"
  private gearLoadingPromises: Map<string, Promise<any>> = new Map();

  // Combat follow (local player follows melee target)
  private combatTargetId: number = -1;
  private _combatPathTimer: number = 0;
  // Combat facing: track who each entity is targeting (from COMBAT_HIT events)
  private npcCombatTargets: Map<number, number> = new Map();  // npcId -> playerId they're attacking
  private remoteCombatTargets: Map<number, number> = new Map();  // remotePlayerId -> npcId they're attacking

  // Remote players
  private remotePlayers: Map<number, SpriteEntity> = new Map();
  private remoteTargets: Map<number, { x: number; z: number }> = new Map();
  private playerNames: Map<number, string> = new Map();
  private nameToEntityId: Map<string, number> = new Map();

  // NPCs
  private npcSprites: Map<number, SpriteEntity | Npc3DEntity> = new Map();
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
  private itemDefsCache: Map<number, ItemDef> = new Map();
  /** Per-defId tree model templates: { template, scale } */
  private treeModels: Map<number, { template: TransformNode; scale: number }> = new Map();
  private playerSprites: DirectionalSpriteSet | null = null;
  private playerWalkAnim: AnimationSpriteSet | null = null;
  private playerPunchAnim: AnimationSpriteSet | null = null;
  private playerKickAnim: AnimationSpriteSet | null = null;
  private playerSwordAnim: AnimationSpriteSet | null = null;
  /** Per-NPC-defId directional sprite sets */
  private npcSpriteSets: Map<number, DirectionalSpriteSet> = new Map();
  /** Per-NPC-defId attack animation sprite sets */
  private npcAttackAnims: Map<number, AnimationSpriteSet> = new Map();
  /** Per-NPC-defId walk animation sprite sets (for recolored humanoid NPCs) */
  private npcWalkAnims: Map<number, AnimationSpriteSet> = new Map();
  private isSkilling: boolean = false;
  private isIndoors: boolean = false;
  private hiddenRoofNodes: TransformNode[] = [];
  private _lastIndoorTileX: number = -9999;
  private _lastIndoorTileZ: number = -9999;
  private _roofDedup: Set<TransformNode> = new Set();
  private skillingObjectId: number = -1;

  // UI
  private destMarker: any = null;
  private interactMarker: any = null;
  private contextMenu: HTMLDivElement | null = null;
  private sidePanel: SidePanel | null = null;
  private chatPanel: ChatPanel | null = null;
  private minimap: Minimap | null = null;
  private gearDebugPanel: GearDebugPanel | null = null;
  private statsPanel: StatsPanel | null = null;
  private shopPanel: ShopPanel | null = null;

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
    this.inputManager.setTeleportClickHandler((worldX, worldZ) => {
      console.log(`[DEBUG] Shift+click teleport to ${worldX.toFixed(1)}, ${worldZ.toFixed(1)}`);
      this.network.sendChat(`/tp ${worldX.toFixed(1)} ${worldZ.toFixed(1)}`);
    });
    this.inputManager.setObjectClickHandler((objectEntityId) => {
      this.handleObjectClick(objectEntityId);
    });
    this.inputManager.setIndoorCheck(() => ({
      indoors: this.isIndoors,
      playerY: this.localPlayer?.position.y ?? this.getHeight(this.playerX, this.playerZ),
    }));

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
    this.chatPanel.setSendHandler((msg) => {
      if (msg === '/geardebug') {
        if (!this.gearDebugPanel) this.gearDebugPanel = new GearDebugPanel();
        // Find currently equipped weapon node
        const weaponGear = this.localPlayer?.getGearNode?.('weapon');
        this.gearDebugPanel.toggle(weaponGear);
        return;
      }
      this.network.sendChat(msg);
    });
    this.shopPanel = new ShopPanel(this.network, this.itemDefsCache);
    this.shopPanel.setOnClose(() => {
      this.sidePanel?.setSellCallback(null);
    });
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

    // When a chunk's placed objects finish loading, link them to world entities
    this.chunkManager.setOnChunkObjectsLoaded(() => {
      this.linkPlacedObjectsToWorldObjects();
      this.cleanupDisposedWorldObjects();
    });

    // Load map, then tell server we're ready for entity data
    this.chunkManager.loadMap('kcmap').then(() => {
      this.applyFog();
      this.network.sendRaw(encodePacket(ClientOpcode.MAP_READY));
      this.repositionWorldObjects();
    });
    this.loadObjectDefs();
    this.loadTreeModels();
    this.loadDepletedRockModel();
    this.loadPlayerSprites();
    this.loadNpcSprites();

    // FPS counter
    const fpsEl = document.createElement('div');
    fpsEl.style.cssText = 'position:fixed;top:4px;left:50%;transform:translateX(-50%);color:#0f0;font:bold 14px monospace;z-index:9999;text-shadow:1px 1px 0 #000;pointer-events:none';
    document.body.appendChild(fpsEl);
    let fpsFrames = 0, fpsLast = performance.now();

    // Game loop
    let lastTime = performance.now();
    this.engine.runRenderLoop(() => {
      const now = performance.now();
      const dt = (now - lastTime) / 1000;
      lastTime = now;
      this.update(dt);
      this.scene.render();

      fpsFrames++;
      if (now - fpsLast >= 1000) {
        fpsEl.textContent = `${fpsFrames} FPS | ${this.scene.getActiveMeshes().length} meshes`;
        fpsFrames = 0;
        fpsLast = now;
      }
    });

    window.addEventListener('resize', () => this.engine.resize());
  }

  private getHeight(x: number, z: number): number {
    const currentY = this.localPlayer?.position.y;
    return this.chunkManager.getEffectiveHeight(x, z, undefined, currentY);
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
      this.rebuildBlockedObjectTiles();
    } catch (e) {
      console.warn('Failed to load object definitions:', e);
    }
    try {
      const res = await fetch('/data/items.json');
      const defs: ItemDef[] = await res.json();
      for (const def of defs) {
        this.itemDefsCache.set(def.id, def);
      }
      if (this.sidePanel) this.sidePanel.setItemDefs(this.itemDefsCache);
    } catch (e) {
      console.warn('Failed to load item definitions:', e);
    }
  }

  /** Rebuild blockedObjectTiles from all known world objects. */
  private rebuildBlockedObjectTiles(): void {
    this.blockedObjectTiles.clear();
    for (const [, data] of this.worldObjectDefs) {
      const def = this.objectDefsCache.get(data.defId);
      if (def?.blocking && !data.depleted) {
        const bx = Math.floor(data.x);
        const bz = Math.floor(data.z);
        if (def.category === 'tree') {
          // Trees block a 2x2 area around their trunk
          for (const [dx, dz] of [[-1,-1],[0,-1],[-1,0],[0,0]]) {
            this.blockedObjectTiles.add(`${bx + dx},${bz + dz}`);
          }
        } else {
          this.blockedObjectTiles.add(`${bx},${bz}`);
        }
      }
    }
  }

  /** Tree model config: defId → GLB files + target height + stump file */
  private static readonly TREE_MODEL_CONFIG: { defId: number; files: string[]; targetHeight: number; stumpFile: string }[] = [
    { defId: 1, files: ['sTree_1.glb', 'sTree_2.glb', 'stree_3.glb', 'sTree4.glb', 'stree_autumn.glb'], targetHeight: 3.45, stumpFile: 'stump1.glb' },
    { defId: 2, files: ['oaktree2.glb'], targetHeight: 4.3, stumpFile: 'oakstump.glb' },
    { defId: 9, files: ['willow_tree.glb'], targetHeight: 4.6, stumpFile: 'willowstump.glb' },
    { defId: 10, files: ['DeadTreeLam.glb'], targetHeight: 2.875, stumpFile: 'stump2.glb' },
  ];
  private treeModelVariants: Map<number, { template: TransformNode; scale: number }[]> = new Map();
  private stumpModels: Map<number, { template: TransformNode; scale: number }> = new Map();
  private stumpModelsByName: Map<string, { template: TransformNode; scale: number }> = new Map();

  /** Depleted models for objects (stumps for trees, depleted rock for rocks) */
  private worldObjectStumps: Map<number, TransformNode> = new Map();
  private depletedRockModel: { template: TransformNode; scale: number } | null = null;
  private thinkingBubble: HTMLDivElement | null = null;

  private async loadTreeModels(): Promise<void> {
    const loads = GameManager.TREE_MODEL_CONFIG.map(async (cfg) => {
      const templates: { template: TransformNode; scale: number }[] = [];
      for (const file of cfg.files) {
        try {
          const result = await SceneLoader.ImportMeshAsync('', '/models/', file, this.scene);
          let minY = Infinity, maxY = -Infinity;
          for (const mesh of result.meshes) {
            if (mesh.getTotalVertices() === 0) continue;
            mesh.computeWorldMatrix(true);
            const bb = mesh.getBoundingInfo().boundingBox;
            if (bb.minimumWorld.y < minY) minY = bb.minimumWorld.y;
            if (bb.maximumWorld.y > maxY) maxY = bb.maximumWorld.y;
          }
          const modelHeight = maxY - minY;
          const scale = modelHeight > 0 ? cfg.targetHeight / modelHeight : 1;
          const root = new TransformNode(`treeTemplate_${cfg.defId}_${file}`, this.scene);
          for (const mesh of result.meshes) {
            if (!mesh.parent) mesh.parent = root;
          }
          for (const child of root.getChildren()) {
            (child as TransformNode).position.y -= minY;
          }
          root.setEnabled(false);
          templates.push({ template: root, scale });
          console.log(`Tree model '${file}' loaded for defId=${cfg.defId} (height=${modelHeight.toFixed(2)}, scale=${scale.toFixed(3)})`);
        } catch (e) {
          console.warn(`Failed to load tree model '${file}':`, e);
        }
      }
      if (templates.length > 0) {
        // Store first as default, keep all for random picking
        this.treeModels.set(cfg.defId, templates[0]);
        this.treeModelVariants.set(cfg.defId, templates);
      }
    });

    await Promise.all(loads);

    // Load stump models — one per unique stump file from TREE_MODEL_CONFIG
    const uniqueStumps = [...new Set(GameManager.TREE_MODEL_CONFIG.map(c => c.stumpFile))];
    const stumpLoads = uniqueStumps.map(async (stumpFile) => {
      const cfg = GameManager.TREE_MODEL_CONFIG.find(c => c.stumpFile === stumpFile)!;
      try {
        const result = await SceneLoader.ImportMeshAsync('', '/models/', stumpFile, this.scene);
        let minY = Infinity, maxY = -Infinity;
        for (const mesh of result.meshes) {
          if (mesh.getTotalVertices() === 0) continue;
          mesh.computeWorldMatrix(true);
          const bb = mesh.getBoundingInfo().boundingBox;
          if (bb.minimumWorld.y < minY) minY = bb.minimumWorld.y;
          if (bb.maximumWorld.y > maxY) maxY = bb.maximumWorld.y;
        }
        const modelHeight = maxY - minY;
        const root = new TransformNode(`stumpTemplate_${stumpFile}`, this.scene);
        for (const mesh of result.meshes) {
          if (!mesh.parent) mesh.parent = root;
        }
        for (const child of root.getChildren()) {
          (child as TransformNode).position.y -= minY;
        }
        root.setEnabled(false);
        this.stumpModelsByName.set(stumpFile, { template: root, scale: 1 });
        console.log(`Stump model '${stumpFile}' loaded (height=${modelHeight.toFixed(3)}, minY=${minY.toFixed(3)})`);
      } catch (e) {
        console.warn(`Failed to load stump model '${stumpFile}':`, e);
      }
    });
    await Promise.all(stumpLoads);

    // Populate stumpModels by defId from TREE_MODEL_CONFIG
    for (const cfg of GameManager.TREE_MODEL_CONFIG) {
      const stump = this.stumpModelsByName.get(cfg.stumpFile);
      if (stump) this.stumpModels.set(cfg.defId, stump);
    }
  }

  private async loadDepletedRockModel(): Promise<void> {
    try {
      const result = await SceneLoader.ImportMeshAsync('', '/models/', 'depleted_rock.glb', this.scene);
      let minY = Infinity;
      for (const mesh of result.meshes) {
        if (mesh.getTotalVertices() === 0) continue;
        mesh.computeWorldMatrix(true);
        const bb = mesh.getBoundingInfo().boundingBox;
        if (bb.minimumWorld.y < minY) minY = bb.minimumWorld.y;
      }
      const root = new TransformNode('depletedRockTemplate', this.scene);
      for (const mesh of result.meshes) {
        if (!mesh.parent) mesh.parent = root;
      }
      for (const child of root.getChildren()) {
        (child as TransformNode).position.y -= minY;
      }
      root.setEnabled(false);
      this.depletedRockModel = { template: root, scale: 1 };
      console.log('Depleted rock model loaded');
    } catch (e) {
      console.warn('Failed to load depleted rock model:', e);
    }
  }

  private createTreeModel(objectEntityId: number, objectDefId: number, x: number, z: number, isDepleted: boolean): void {
    // Pick a random variant if available
    const variants = this.treeModelVariants.get(objectDefId);
    const model = variants ? variants[objectEntityId % variants.length] : this.treeModels.get(objectDefId);
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
    const terrainY = this.getHeight(cx, cz);
    clone.position.set(cx, terrainY, cz);
    this.worldObjectModels.set(objectEntityId, clone);

    // Create stump model (hidden until tree is depleted)
    const stumpModel = this.stumpModels.get(objectDefId);
    if (stumpModel) {
      const stump = stumpModel.template.instantiateHierarchy(null, undefined, (source, cloned) => {
        cloned.name = source.name + `_stump_${objectEntityId}`;
      })!;
      stump.setEnabled(isDepleted);
      for (const child of stump.getChildMeshes()) {
        child.setEnabled(true);
        const mat = child.material as any;
        if (mat) {
          if (mat.transparencyMode !== undefined) mat.transparencyMode = 1;
          mat.alpha = 1;
        }
      }
      const ss = stumpModel.scale;
      stump.scaling.set(ss, ss, ss);
      stump.position.set(cx, terrainY, cz);
      this.worldObjectStumps.set(objectEntityId, stump);
    }
  }

  private upgradeTreeSpritesToModels(): void {
    // Trees now use placed GLB objects from the editor — no GameManager models needed
  }


  private async loadPlayerSprites(): Promise<void> {
    try {
      this.playerSprites = await loadDirectionalSprites(this.scene, '/sprites/player', 'player');
      console.log('Player directional sprites loaded');
      // Note: local player is now a 3D CharacterEntity — no sprite upgrade needed
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
      // Note: local player is a 3D CharacterEntity with its own walk animation
      for (const [, sprite] of this.remotePlayers) sprite.setWalkAnimation(this.playerWalkAnim);
    } catch (e) {
      console.warn('Failed to load player walk animation:', e);
    }

    // Load punch animation (8-direction, 4 frames) — for Accurate/Defensive/Controlled stances
    try {
      this.playerPunchAnim = await load8DirAnimationSprites(this.scene, '/sprites/player/punch', 'player_punch', 4);
      console.log('Player punch animation loaded');
      for (const [, sprite] of this.remotePlayers) this.attachPlayerAttackAnims(sprite);
    } catch (e) {
      console.warn('Failed to load player punch animation:', e);
    }

    // Load kick animation (4-direction, 4 frames) — for Aggressive stance
    try {
      this.playerKickAnim = await loadAnimationSprites(this.scene, '/sprites/player/kick', 'player_kick', 4);
      console.log('Player kick animation loaded');
      for (const [, sprite] of this.remotePlayers) this.attachPlayerAttackAnims(sprite);
    } catch (e) {
      console.warn('Failed to load player kick animation:', e);
    }

    // Load sword animation (4-direction, 4 frames) — for when weapon is equipped
    try {
      this.playerSwordAnim = await loadAnimationSprites(this.scene, '/sprites/player/sword', 'player_sword', 4);
      console.log('Player sword animation loaded');
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

  /** NPC sprite config: defId → sprite folder path + optional attack animation + optional recolor */
  private static readonly NPC_SPRITE_CONFIG: {
    defId: number; path: string; name: string;
    attackPath?: string; attackFrames?: number;
    /** If set, loads player sprites recolored instead of dedicated NPC sprites */
    recolor?: RecolorConfig;
  }[] = [
    { defId: 1, path: '/sprites/chicken', name: 'chicken' },
    { defId: 10, path: '/sprites/cow', name: 'cow', attackPath: '/sprites/cow/attack', attackFrames: 4 },
    // Humanoid NPCs — recolored from player sprites
    { defId: 3, path: '/sprites/player', name: 'goblin_sprite', recolor: {
      shirtHue: 100, shirtSat: 0.6, shirtLightOffset: -0.05,   // green shirt
      pantsHue: 30, pantsSat: 0.4, pantsLightOffset: -0.15,     // brown pants
      skinHue: 95, skinSat: 0.5, skinLightOffset: -0.15,        // greenish skin
      hairHue: 30, hairSat: 0.3, hairLightOffset: -0.1,         // dark hair
    }},
    { defId: 7, path: '/sprites/player', name: 'guard_sprite', recolor: {
      shirtHue: 220, shirtSat: 0.3, shirtLightOffset: 0.1,     // silver-blue armor
      pantsHue: 220, pantsSat: 0.2, pantsLightOffset: -0.05,    // matching grey pants
      hairHue: 25, hairSat: 0.6,                                 // keep brown hair
    }},
    { defId: 8, path: '/sprites/player', name: 'shopkeeper_sprite', recolor: {
      shirtHue: 35, shirtSat: 0.7, shirtLightOffset: 0.05,     // gold/tan shirt
      pantsHue: 25, pantsSat: 0.3, pantsLightOffset: -0.1,      // brown pants
      hairHue: 10, hairSat: 0.4, hairLightOffset: -0.1,         // dark reddish hair
    }},
    { defId: 9, path: '/sprites/player', name: 'darkknight_sprite', recolor: {
      shirtHue: 270, shirtSat: 0.6, shirtLightOffset: -0.15,   // dark purple armor
      pantsHue: 270, pantsSat: 0.4, pantsLightOffset: -0.25,    // dark purple pants
      hairHue: 0, hairSat: 0.0, hairLightOffset: -0.15,         // black hair
      skinHue: 10, skinSat: 0.2, skinLightOffset: -0.15,        // pale skin
    }},
    { defId: 5, path: '/sprites/player', name: 'skeleton_sprite', recolor: {
      shirtHue: 50, shirtSat: 0.05, shirtLightOffset: 0.3,     // bone white shirt
      pantsHue: 50, pantsSat: 0.05, pantsLightOffset: 0.1,      // bone white pants
      skinHue: 50, skinSat: 0.1, skinLightOffset: 0.1,          // bone-colored skin
      hairHue: 0, hairSat: 0.0, hairLightOffset: -0.2,          // no hair (dark)
    }},
    // Specialist shopkeepers
    { defId: 11, path: '/sprites/player', name: 'weaponsmith_sprite', recolor: {
      shirtHue: 10, shirtSat: 0.6, shirtLightOffset: -0.05,    // dark red shirt
      pantsHue: 25, pantsSat: 0.3, pantsLightOffset: -0.2,      // dark brown pants
      hairHue: 15, hairSat: 0.5, hairLightOffset: -0.1,         // dark auburn hair
    }},
    { defId: 12, path: '/sprites/player', name: 'armorer_sprite', recolor: {
      shirtHue: 220, shirtSat: 0.15, shirtLightOffset: -0.05,  // steel grey shirt
      pantsHue: 220, pantsSat: 0.1, pantsLightOffset: -0.1,     // dark grey pants
      hairHue: 0, hairSat: 0.0, hairLightOffset: -0.15,         // black hair
    }},
    { defId: 13, path: '/sprites/player', name: 'legarmorer_sprite', recolor: {
      shirtHue: 30, shirtSat: 0.5, shirtLightOffset: -0.05,    // brown shirt
      pantsHue: 30, pantsSat: 0.6, pantsLightOffset: -0.1,      // rich brown pants
      hairHue: 35, hairSat: 0.7, hairLightOffset: 0.0,          // light brown hair
    }},
    { defId: 14, path: '/sprites/player', name: 'shieldsmith_sprite', recolor: {
      shirtHue: 210, shirtSat: 0.4, shirtLightOffset: 0.0,     // blue-grey shirt
      pantsHue: 210, pantsSat: 0.2, pantsLightOffset: -0.1,     // grey-blue pants
      hairHue: 20, hairSat: 0.3, hairLightOffset: -0.05,        // dark hair
    }},
  ];

  private async loadNpcSprites(): Promise<void> {
    for (const cfg of GameManager.NPC_SPRITE_CONFIG) {
      try {
        let sprites: DirectionalSpriteSet;
        if (cfg.recolor) {
          // Load player sprites with recolored pixels
          sprites = await loadRecoloredDirectionalSprites(this.scene, cfg.path, cfg.name, cfg.recolor);
          console.log(`Recolored NPC sprites loaded for ${cfg.name} (defId=${cfg.defId})`);
        } else {
          sprites = await loadDirectionalSprites(this.scene, cfg.path, cfg.name);
          console.log(`NPC sprites loaded for ${cfg.name} (defId=${cfg.defId})`);
        }
        this.npcSpriteSets.set(cfg.defId, sprites);
        // Upgrade existing NPC sprites of this type
        for (const [entityId, sprite] of this.npcSprites) {
          if (this.npcDefs.get(entityId) === cfg.defId) {
            sprite.setDirectionalSprites(sprites);
          }
        }
      } catch (e) {
        console.warn(`Failed to load NPC sprites for ${cfg.name}:`, e);
      }

      // Load attack animation if configured (dedicated path)
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

      // For recolored humanoid NPCs, also load recolored walk/punch animations from player sprites
      if (cfg.recolor) {
        try {
          const walkAnim = await loadRecolored8DirAnimationSprites(
            this.scene, '/sprites/player/walk', `${cfg.name}_walk`, 4, cfg.recolor
          );
          // Attach walk anim to existing NPC sprites of this type
          for (const [entityId, sprite] of this.npcSprites) {
            if (this.npcDefs.get(entityId) === cfg.defId) {
              sprite.setWalkAnimation(walkAnim);
            }
          }
          // Store for future spawns
          this.npcWalkAnims.set(cfg.defId, walkAnim);
          console.log(`Recolored walk animation loaded for ${cfg.name}`);
        } catch (e) {
          console.warn(`Failed to load recolored walk animation for ${cfg.name}:`, e);
        }

        try {
          const punchAnim = await loadRecolored8DirAnimationSprites(
            this.scene, '/sprites/player/punch', `${cfg.name}_punch`, 4, cfg.recolor
          );
          this.npcAttackAnims.set(cfg.defId, punchAnim);
          for (const [entityId, sprite] of this.npcSprites) {
            if (this.npcDefs.get(entityId) === cfg.defId) {
              sprite.setAttackAnimation(punchAnim);
            }
          }
          console.log(`Recolored punch animation loaded for ${cfg.name}`);
        } catch (e) {
          console.warn(`Failed to load recolored punch animation for ${cfg.name}:`, e);
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
      this.localPlayer.setPositionXYZ(this.playerX, this.getHeight(this.playerX, this.playerZ), this.playerZ);
    }
  }

  /** Clean up world object references to disposed placed nodes (after chunk unload) */
  private cleanupDisposedWorldObjects(): void {
    for (const [entityId, node] of this.worldObjectModels) {
      if (node.isDisposed()) {
        this.worldObjectModels.delete(entityId);
        // Also dispose stump/depleted model
        const stump = this.worldObjectStumps.get(entityId);
        if (stump) {
          stump.dispose();
          this.worldObjectStumps.delete(entityId);
        }
      }
    }
  }

  /** Link placed GLB objects to server world objects after map finishes loading */
  private linkPlacedObjectsToWorldObjects(): void {
    let linked = 0;
    for (const [objectEntityId, data] of this.worldObjectDefs) {
      if (this.worldObjectModels.has(objectEntityId)) continue;

      const placedNode = this.chunkManager.findPlacedObjectNear(data.x, data.z, 1.5, data.defId);
      if (!placedNode) continue;

      this.linkPlacedNodeToEntity(objectEntityId, data, placedNode);
      linked++;
    }
  }

  /** Link a placed GLB node to a world object entity, tagging for picking and handling depletion */
  private linkPlacedNodeToEntity(
    objectEntityId: number,
    data: { defId: number; x: number; z: number; depleted: boolean },
    placedNode: TransformNode,
  ): void {
    this.worldObjectModels.set(objectEntityId, placedNode);
    // Tag all descendants for right-click picking
    if (!placedNode.metadata) placedNode.metadata = {};
    placedNode.metadata.objectEntityId = objectEntityId;
    for (const child of placedNode.getChildMeshes(false)) {
      if (!child.metadata) child.metadata = {};
      child.metadata.objectEntityId = objectEntityId;
    }
    for (const child of placedNode.getChildTransformNodes(false)) {
      if (!child.metadata) child.metadata = {};
      child.metadata.objectEntityId = objectEntityId;
    }
    if (data.depleted) placedNode.setEnabled(false);

    // Create depleted model only if already depleted (lazy — otherwise created on first depletion event)
    if (data.depleted) {
      this.createDepletedModel(objectEntityId, data.defId, placedNode);
    }

    // Remove any sprite that was created before the GLB loaded
    const sprite = this.worldObjectSprites.get(objectEntityId);
  }

  /** Create a depleted model (stump/depleted rock) at the placed node's position */
  private createDepletedModel(objectEntityId: number, defId: number, placedNode: TransformNode): TransformNode | null {
    if (this.worldObjectStumps.has(objectEntityId)) return this.worldObjectStumps.get(objectEntityId)!;
    const def = this.objectDefsCache.get(defId);
    let depletedModel: { template: TransformNode; scale: number } | null = null;
    if (def?.category === 'tree') {
      depletedModel = this.stumpModels.get(defId) ?? null;
    } else if (def?.category === 'rock') {
      depletedModel = this.depletedRockModel;
    }
    if (!depletedModel) return null;
    const depleted = depletedModel.template.instantiateHierarchy(null, undefined, (source, cloned) => {
      cloned.name = source.name + `_depleted_${objectEntityId}`;
    })!;
    depleted.setEnabled(true);
    for (const child of depleted.getChildMeshes()) {
      child.setEnabled(true);
      const mat = child.material as any;
      if (mat && mat.transparencyMode !== undefined) mat.transparencyMode = 1;
    }
    // Match the placed node's scale so depleted model fits the same footprint
    depleted.scaling.copyFrom(placedNode.scaling);
    depleted.position.set(placedNode.position.x, placedNode.position.y, placedNode.position.z);
    if (placedNode.rotationQuaternion) {
      depleted.rotationQuaternion = placedNode.rotationQuaternion.clone();
    }
    this.worldObjectStumps.set(objectEntityId, depleted);
    return depleted;
    if (sprite) {
      sprite.dispose();
      this.worldObjectSprites.delete(objectEntityId);
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

  /**
   * Equip or unequip a 3D gear piece on the local player.
   * Loads /gear/{slotName}/{itemId}.glb on demand, caches the template.
   * itemId = 0 or -1 means unequip.
   */
  private async equipGear(slotIndex: number, itemId: number): Promise<void> {
    if (!this.localPlayer) return;
    const slotName = EQUIP_SLOT_NAMES[slotIndex];
    if (!slotName) return;

    // Unequip
    if (itemId <= 0) {
      this.localPlayer.detachGear(slotName);
      return;
    }

    // Already wearing this item?
    if (this.localPlayer.getGearItemId(slotName) === itemId) return;

    const cacheKey = `${slotName}/${itemId}`;
    const boneConfig = EQUIP_SLOT_BONES[slotName];
    if (!boneConfig) return;

    // Check if this is a bow/crossbow — needs different grip transform
    const itemDef = this.itemDefsCache.get(itemId);
    const isBow = itemDef?.weaponStyle === 'bow' || itemDef?.weaponStyle === 'crossbow';

    // Clear cache for this item so rotation changes take effect immediately
    this.gearTemplateCache.delete(cacheKey);

    // Check cache
    let template = this.gearTemplateCache.get(cacheKey);
    if (!template) {
      // Check if already loading
      let promise = this.gearLoadingPromises.get(cacheKey);
      if (!promise) {
        promise = (async () => {
          // Tools share a single model file by toolType
          const toolType = itemDef?.toolType;
          const toolModelMap: Record<string, string> = {
            axe: '/assets/equipment/Tools/Axe.glb',
            pickaxe: '/assets/equipment/Tools/Pickaxe.glb',
          };
          // Tool-specific transforms (grip position, rotation, scale)
          const toolTransforms: Record<string, { pos: { x: number; y: number; z: number }; rot: { x: number; y: number; z: number }; scale: number; center: boolean }> = {
            axe:     { pos: { x: -0.06, y: 0.09, z: -0.12 }, rot: { x: -1.65, y: 0.2, z: -3.15 }, scale: 0.6, center: false },
            pickaxe: { pos: { x: -0.01, y: 0.54, z: 0.25 }, rot: { x: 2.7, y: 0.1, z: 0.1 }, scale: 0.9, center: false },
          };
          const toolTx = toolType ? toolTransforms[toolType] : null;
          const pos = isBow
            ? { x: -0.04, y: 0, z: 0 }
            : toolTx ? toolTx.pos
            : boneConfig.localPosition;
          const rot = isBow
            ? { x: Math.PI / 2, y: 0, z: 0 }
            : toolTx ? toolTx.rot
            : boneConfig.localRotation;
          const gearScale = isBow ? 0.9 : toolTx ? toolTx.scale : boneConfig.scale;
          const gearFile = (toolType && toolModelMap[toolType]) || `/gear/${slotName}/${itemId}.glb`;
          const gearDef: GearDef = {
            itemId,
            file: gearFile,
            boneName: boneConfig.boneName,
            localPosition: pos,
            localRotation: rot,
            scale: gearScale,
            centerOrigin: isBow || (toolTx?.center ?? false),
          };
          const tmpl = await loadGearTemplate(this.scene, gearDef);
          if (tmpl) {
            this.gearTemplateCache.set(cacheKey, tmpl);
            console.log(`[Gear] Loaded ${slotName} item ${itemId}`);
          }
          this.gearLoadingPromises.delete(cacheKey);
          return tmpl;
        })();
        this.gearLoadingPromises.set(cacheKey, promise);
      }
      template = await promise;
    }

    if (template && this.localPlayer) {
      this.localPlayer.attachGear(slotName, itemId, template);
    }
  }

  private setupNetworkHandlers(): void {
    this.network.on(ServerOpcode.LOGIN_OK, (_op, v) => {
      this.localPlayerId = v[0];
      this.playerX = v[1] / 10;
      this.playerZ = v[2] / 10;
      this.network.setLocalPlayerId(this.localPlayerId);

      this.localPlayer = new CharacterEntity(this.scene, {
        name: 'localPlayer',
        modelPath: '/Character models/main character.glb',
        targetHeight: 1.53,
        label: this.username,
        labelColor: '#00ff00',
        // Each animation can be replaced individually by dropping a GLB into
        // /Character models/animations/ (e.g. walk.glb, idle.glb, attack.glb).
        // The GLB just needs the armature + one animation — the mesh is ignored.
        // Fallback: UAL library animations until replaced.
        additionalAnimations: [
          { name: 'idle', path: '/Character models/animations/idle.glb', fallback: { path: '/Character models/Universal Animation Library[Standard]/Unreal-Godot/UAL1_Standard.glb', animName: 'Idle_Loop' } },
          { name: 'walk', path: '/Character models/animations/walk.glb', fallback: { path: '/Character models/Universal Animation Library[Standard]/Unreal-Godot/UAL1_Standard.glb', animName: 'Walk_Loop' } },
          { name: 'attack', path: '/Character models/animations/attack.glb', fallback: { path: '/Character models/Universal Animation Library[Standard]/Unreal-Godot/UAL1_Standard.glb', animName: 'Sword_Attack' } },
          { name: 'attack_slash', path: '/Character models/animations/attack_slash.glb', fallback: { path: '/Character models/Universal Animation Library[Standard]/Unreal-Godot/UAL1_Standard.glb', animName: 'Sword_Attack' } },
          { name: 'attack_punch', path: '/Character models/animations/attack_punch.glb', fallback: { path: '/Character models/Universal Animation Library[Standard]/Unreal-Godot/UAL1_Standard.glb', animName: 'Punch_Cross' } },
          { name: 'chop', path: '/Character models/animations/chop.glb', fallback: { path: '/Character models/Universal Animation Library 2[Source]/Unreal-Godot/UAL2.glb', animName: 'TreeChopping_Loop' } },
          { name: 'mine', path: '/Character models/animations/mine.glb', fallback: { path: '/Character models/Universal Animation Library 2[Source]/Unreal-Godot/UAL2.glb', animName: 'Mining_Loop' } },
          { name: 'bow_attack', path: '/Character models/animations/bow_attack.glb', fallback: { path: '/Character models/Universal Animation Library[Standard]/Unreal-Godot/UAL1_Standard.glb', animName: 'Spell_Simple_Shoot' } },
          { name: 'death', path: '/Character models/animations/death.glb', fallback: { path: '/Character models/Universal Animation Library[Standard]/Unreal-Godot/UAL1_Standard.glb', animName: 'Death01' } },
        ],
      });
      const spawnH = this.getHeight(this.playerX, this.playerZ);
      this.localPlayer.setPositionXYZ(this.playerX, spawnH, this.playerZ);
      this.inputManager.setPlayerY(spawnH);
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
        const name = NPC_NAMES[npcDefId] || `NPC${npcDefId}`;
        const modelCfg = NPC_3D_MODELS[npcDefId];

        if (modelCfg) {
          // Use 3D model
          const npc3d = new Npc3DEntity(this.scene, modelCfg.file, modelCfg.scale, modelCfg.anims, name);
          npc3d.position = new Vector3(x, this.getHeight(x, z), z);
          this.npcSprites.set(entityId, npc3d);

        } else {
          // Fall back to sprite
          const color = NPC_COLORS[npcDefId] || new Color3(0.5, 0.5, 0.5);
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
          const attackAnim = this.npcAttackAnims.get(npcDefId);
          if (attackAnim) sprite.setAttackAnimation(attackAnim);
          const walkAnim = this.npcWalkAnims.get(npcDefId);
          if (walkAnim) sprite.setWalkAnimation(walkAnim);
          this.npcSprites.set(entityId, sprite);
        }
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
        const itemDef = this.itemDefsCache.get(itemId);
        const itemName = itemDef?.name ?? `Item ${itemId}`;
        const iconPath = itemDef?.sprite ? `/sprites/items/${itemDef.sprite}`
          : itemDef?.icon ? `/items/${itemDef.icon}`
          : null;
        const sprite = new SpriteEntity(this.scene, {
          name: `gitem_${groundItemId}`,
          color: new Color3(0.8, 0.7, 0.2),
          label: itemName,
          labelColor: '#ffaa00',
          width: 0.48,
          height: 0.48,
          iconUrl: iconPath ?? undefined,
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

      // Trigger attack animation on the attacker
      if (attackerId === this.localPlayerId && this.localPlayer) {
        // Use punch animation for ranged (no bow draw animation yet)
        const weaponId = this.localEquipment.get(0) ?? -1; // slot 0 = weapon
        const weaponDef = this.itemDefsCache.get(weaponId);
        const isBow = weaponDef?.weaponStyle === 'bow' || weaponDef?.weaponStyle === 'crossbow';
        this.localPlayer.playAttackAnimation(isBow ? 'bow_attack' : undefined);
      } else {
        const attackerSprite = this.npcSprites.get(attackerId)
          || this.remotePlayers.get(attackerId);
        if (attackerSprite) {
          const isPlayer = this.remotePlayers.has(attackerId);
          if (isPlayer) {
            attackerSprite.playAttackAnimation(this.getPlayerAttackAnimName(attackerId));
          } else {
            attackerSprite.playAttackAnimation();
          }
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

    // Ranged projectile visual
    this.network.on(ServerOpcode.COMBAT_PROJECTILE, (_op, v) => {
      const [attackerId, targetId, _projectileType] = v;

      // Get attacker and target positions
      let fromPos: Vector3 | null = null;
      let toPos: Vector3 | null = null;

      if (attackerId === this.localPlayerId && this.localPlayer) {
        fromPos = this.localPlayer.position.clone();
      } else {
        const sprite = this.remotePlayers.get(attackerId) || this.npcSprites.get(attackerId);
        if (sprite) fromPos = sprite.position.clone();
      }

      const targetSprite = this.npcSprites.get(targetId) || this.remotePlayers.get(targetId);
      if (targetSprite) toPos = targetSprite.position.clone();
      if (targetId === this.localPlayerId && this.localPlayer) {
        toPos = this.localPlayer.position.clone();
      }

      if (fromPos && toPos) {
        this.spawnProjectile(fromPos, toPos);
      }
    });

    this.network.on(ServerOpcode.SHOP_OPEN, (_op, v) => {
      const npcEntityId = v[0];
      const itemCount = v[1];
      const items: ShopItem[] = [];
      for (let i = 0; i < itemCount; i++) {
        items.push({
          itemId: v[2 + i * 3],
          price: v[2 + i * 3 + 1],
          stock: v[2 + i * 3 + 2],
        });
      }
      if (this.shopPanel) {
        const npcDefId = this.npcDefs.get(npcEntityId);
        const shopTitle = NPC_NAMES[npcDefId || 0] || 'Shop';
        this.shopPanel.show(npcEntityId, items, shopTitle);
        // Enable sell option in inventory context menu
        this.sidePanel?.setSellCallback((slot) => {
          this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_SELL_ITEM, slot, 1));
        });
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
      if (def?.category === 'door') {
        // Doors block a specific edge, not the whole tile.
        // Determine which edge based on fractional position (door sits on tile boundary)
        const tx = Math.floor(x), tz = Math.floor(z);
        const fracX = x - tx, fracZ = z - tz;
        // Door is on the edge closest to its position within the tile
        let edge = 0;
        if (fracX < 0.15) edge = WallEdge.W;
        else if (fracX > 0.85) edge = WallEdge.E;
        else if (fracZ < 0.15) edge = WallEdge.N;
        else if (fracZ > 0.85) edge = WallEdge.S;
        else edge = WallEdge.N | WallEdge.S; // center — fallback to N/S

        if (!isDepleted && edge) {
          // Closed — set edge on door tile
          const current = this.chunkManager.getWallRawPublic(tx, tz);
          this.chunkManager.setWall(tx, tz, current | edge);
        }
        // Don't add to blockedObjectTiles — tile stays walkable
      } else if (def?.blocking && !isDepleted) {
        const bx = Math.floor(x), bz = Math.floor(z);
        if (def.category === 'tree') {
          for (const [dx, dz] of [[-1,-1],[0,-1],[-1,0],[0,0]]) {
            this.blockedObjectTiles.add(`${bx + dx},${bz + dz}`);
          }
        } else {
          this.blockedObjectTiles.add(tileKey);
        }
      } else {
        if (def?.category === 'tree') {
          const bx = Math.floor(x), bz = Math.floor(z);
          for (const [dx, dz] of [[-1,-1],[0,-1],[-1,0],[0,0]]) {
            this.blockedObjectTiles.delete(`${bx + dx},${bz + dz}`);
          }
        } else {
          this.blockedObjectTiles.delete(tileKey);
        }
      }

      // Try to link to an editor-placed GLB model
      if (!this.worldObjectModels.has(objectEntityId)) {
        const placedNode = this.chunkManager.findPlacedObjectNear(x, z, 1.5, objectDefId);
        if (placedNode) {
          this.linkPlacedNodeToEntity(objectEntityId, { defId: objectDefId, x, z, depleted: isDepleted }, placedNode);
        } else if (!this.chunkManager.isChunkObjectsLoaded(x, z)) {
          // Chunk is still loading — skip sprite, will link via onChunkObjectsLoaded callback
        } else if (!this.worldObjectSprites.has(objectEntityId)) {
          // Chunk loaded but no GLB — fall back to sprite (fishing spots, altars, etc.)
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
      }

      // Update depletion visuals
      const model = this.worldObjectModels.get(objectEntityId);
      if (model) {
        // Trees: handled entirely by WORLD_OBJECT_DEPLETED (show/hide stump)
        // Other GLB objects: toggle visibility
        if (def?.category !== 'tree') {
          model.setEnabled(!isDepleted);
        }
      } else {
        const sprite = this.worldObjectSprites.get(objectEntityId);
        if (sprite) sprite.getMesh().isVisible = !isDepleted;
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
        if (def2?.category === 'door') {
          const tx = Math.floor(data.x), tz = Math.floor(data.z);
          const fracX = data.x - tx, fracZ = data.z - tz;
          let edge = 0;
          if (fracX < 0.15) edge = WallEdge.W;
          else if (fracX > 0.85) edge = WallEdge.E;
          else if (fracZ < 0.15) edge = WallEdge.N;
          else if (fracZ > 0.85) edge = WallEdge.S;
          else edge = WallEdge.N | WallEdge.S;

          if (isDepleted === 1) {
            // Opened — clear door edge
            this.chunkManager.setWall(tx, tz, this.chunkManager.getWallRawPublic(tx, tz) & ~edge);
          } else {
            // Closed — restore door edge
            this.chunkManager.setWall(tx, tz, this.chunkManager.getWallRawPublic(tx, tz) | edge);
          }
        } else if (def2?.blocking && isDepleted === 0) {
          const bx = Math.floor(data.x), bz = Math.floor(data.z);
          if (def2.category === 'tree') {
            for (const [dx, dz] of [[-1,-1],[0,-1],[-1,0],[0,0]]) {
              this.blockedObjectTiles.add(`${bx + dx},${bz + dz}`);
            }
          } else {
            this.blockedObjectTiles.add(tileKey);
          }
        } else {
          if (def2?.category === 'tree') {
            const bx = Math.floor(data.x), bz = Math.floor(data.z);
            for (const [dx, dz] of [[-1,-1],[0,-1],[-1,0],[0,0]]) {
              this.blockedObjectTiles.delete(`${bx + dx},${bz + dz}`);
            }
          } else {
            this.blockedObjectTiles.delete(tileKey);
          }
        }
      }

      const def = data ? this.objectDefsCache.get(data.defId) : null;
      const hasDepleteModel = def?.category === 'tree' || def?.category === 'rock';

      const model = this.worldObjectModels.get(objectEntityId);
      if (hasDepleteModel && data) {
        // Find placed GLB and toggle visibility
        const placedNode = model ?? this.chunkManager.findPlacedObjectNear(data.x, data.z, 1.5, data.defId);
        if (placedNode) {
          if (!model) this.worldObjectModels.set(objectEntityId, placedNode);
          placedNode.setEnabled(isDepleted === 0);

          // Create or toggle depleted model (stump / depleted rock)
          let depleted = this.worldObjectStumps.get(objectEntityId);
          if (!depleted && isDepleted === 1) {
            depleted = this.createDepletedModel(objectEntityId, data.defId, placedNode);
          }
          if (depleted) depleted.setEnabled(isDepleted === 1);
        }
      } else if (model) {
        model.setEnabled(isDepleted === 0);
      } else {
        const sprite = this.worldObjectSprites.get(objectEntityId);
        if (sprite) sprite.getMesh().isVisible = isDepleted === 0;
      }
    });

    this.network.on(ServerOpcode.SKILLING_START, (_op, v) => {
      this.isSkilling = true;
      this.skillingObjectId = v[0];
      if (this.interactMarker) this.interactMarker.isVisible = false;
      if (this.chatPanel) {
        const data = this.worldObjectDefs.get(v[0]);
        const def = data ? this.objectDefsCache.get(data.defId) : null;
        const actionName = def?.actions[0] ?? 'Working';
        this.chatPanel.addSystemMessage(`You begin to ${actionName.toLowerCase()}...`, '#8cf');
      }
      // Determine which animation to play
      const objData = this.worldObjectDefs.get(v[0]);
      const objDef = objData ? this.objectDefsCache.get(objData.defId) : null;
      const variant = objDef?.category === 'tree' ? 'chop' : objDef?.category === 'rock' ? 'mine' : undefined;

      // If still walking, defer the skill animation until path completes
      const stillWalking = this.pathIndex < this.path.length;
      if (stillWalking) {
        this.pendingSkill = { objectId: v[0], variant };
      } else {
        this.startSkillingVisual(v[0], variant);
      }
    });

    this.network.on(ServerOpcode.SKILLING_STOP, (_op, _v) => {
      this.isSkilling = false;
      this.skillingObjectId = -1;
      this.hideThinkingBubble();
      this.localPlayer?.stopSkillAnimation();
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

    // Batch inventory: [slot0_itemId, slot0_qty, slot1_itemId, slot1_qty, ...]
    this.network.on(ServerOpcode.PLAYER_INVENTORY_BATCH, (_op, v) => {
      if (this.sidePanel) {
        for (let i = 0; i < v.length; i += 2) {
          this.sidePanel.updateInvSlot(i / 2, v[i], v[i + 1]);
        }
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

    // Batch skills: [skill0_level, skill0_currentLevel, skill0_xpHigh, skill0_xpLow, ...]
    this.network.on(ServerOpcode.PLAYER_SKILLS_BATCH, (_op, v) => {
      if (this.sidePanel) {
        for (let i = 0; i < v.length; i += 4) {
          const skillIndex = i / 4;
          const level = v[i], currentLevel = v[i + 1];
          const xp = (v[i + 2] << 16) | (v[i + 3] & 0xFFFF);
          this.sidePanel.updateSkill(skillIndex, level, currentLevel, xp);
          if (skillIndex === ALL_SKILLS.indexOf('hitpoints')) {
            this.playerHealth = currentLevel;
            this.playerMaxHealth = level;
            this.updateHUD();
          }
        }
      }
    });

    this.network.on(ServerOpcode.PLAYER_EQUIPMENT, (_op, v) => {
      const [slotIndex, itemId] = v;
      this.localEquipment.set(slotIndex, itemId);
      if (this.sidePanel) {
        this.sidePanel.updateEquipSlot(slotIndex, itemId);
      }
      // Attach/detach 3D gear on local player
      this.equipGear(slotIndex, itemId);
    });

    // Batch equipment: [slot0_itemId, slot1_itemId, ...]
    this.network.on(ServerOpcode.PLAYER_EQUIPMENT_BATCH, (_op, v) => {
      if (this.sidePanel) {
        for (let i = 0; i < v.length; i++) {
          this.sidePanel.updateEquipSlot(i, v[i]);
          this.localEquipment.set(i, v[i]);
        }
      }
      // Attach/detach 3D gear on local player
      for (let i = 0; i < v.length; i++) {
        this.equipGear(i, v[i]);
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
    // Only dispose models that GameManager created, not linked placed objects from ChunkManager
    for (const [, model] of this.worldObjectModels) {
      if (!this.chunkManager.isPlacedObjectNode(model)) model.dispose();
    }
    this.worldObjectModels.clear();
    for (const [, stump] of this.worldObjectStumps) stump.dispose();
    this.worldObjectStumps.clear();
    this.worldObjectDefs.clear();
    this.blockedObjectTiles.clear();

    this.isSkilling = false;
    this.skillingObjectId = -1;

    // Load new map
    await this.chunkManager.loadMap(mapId);
    this.applyFog();
    // Tell server we're ready to receive entity data — SYNCs will link trees via the handler
    this.network.sendRaw(encodePacket(ClientOpcode.MAP_READY));

    // Update player position
    this.playerX = newX;
    this.playerZ = newZ;
    this.path = []; this.pathIndex = 0; this.tileProgress = 0; this.pendingPath = null;
    if (this.localPlayer) this.localPlayer.stopWalking();
    this.combatTargetId = -1;

    if (this.localPlayer) {
      this.localPlayer.setPositionXYZ(this.playerX, this.getHeight(this.playerX, this.playerZ), this.playerZ);
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
          if (npcDefId === 8 || npcDefId === 11 || npcDefId === 12 || npcDefId === 13 || npcDefId === 14) {
            // Shopkeeper — trade instead of attack
            options.push({
              label: `Trade ${name}`,
              action: () => this.talkToNpc(entityId),
            });
          } else {
            options.push({
              label: `Attack ${name}`,
              action: () => this.attackNpc(entityId),
            });
          }
          break;
        }
      }

      for (const [groundItemId, sprite] of this.groundItemSprites) {
        if (sprite.getMesh().name === meshName) {
          const gItem = this.groundItems.get(groundItemId);
          const iDef = gItem ? this.itemDefsCache.get(gItem.itemId) : null;
          const iName = iDef?.name ?? 'item';
          options.push({
            label: `Pick up ${iName}`,
            action: () => this.pickupItem(groundItemId),
          });
          break;
        }
      }

      // Check 3D models (trees, rocks, placed objects) — walk up parent chain looking for objectEntityId metadata
      let pickedObjectEntityId: number | null = null;
      let walkMesh: any = pickResult.pickedMesh;
      while (walkMesh) {
        if (walkMesh.metadata?.objectEntityId != null) {
          pickedObjectEntityId = walkMesh.metadata.objectEntityId;
          break;
        }
        walkMesh = walkMesh.parent;
      }

      // If no objectEntityId found, check if this is a placed object near a world object
      if (pickedObjectEntityId == null && pickResult.pickedMesh) {
        // Walk up to root placed node
        let rootNode: any = pickResult.pickedMesh;
        while (rootNode.parent) {
          if (this.chunkManager.isPlacedObjectNode(rootNode)) break;
          rootNode = rootNode.parent;
        }

        if (this.chunkManager.isPlacedObjectNode(rootNode)) {
          // Only match if this placed object is actually an interactable asset
          const rootAssetId = rootNode.metadata?.assetId;
          if (rootAssetId && rootAssetId in ASSET_TO_OBJECT_DEF) {
            const expectedDefId = ASSET_TO_OBJECT_DEF[rootAssetId];
            const px = rootNode.position.x;
            const pz = rootNode.position.z;
            let bestEid = -1, bestDist = 3.0;
            for (const [eid, data] of this.worldObjectDefs) {
              if (data.defId !== expectedDefId) continue;
              const dist = Math.hypot(data.x - px, data.z - pz);
              if (dist < bestDist) {
                bestDist = dist;
                bestEid = eid;
              }
            }
            if (bestEid >= 0) {
              pickedObjectEntityId = bestEid;
              this.worldObjectModels.set(bestEid, rootNode);
            }
          }
        }
      }

      if (pickedObjectEntityId != null) {
        const data = this.worldObjectDefs.get(pickedObjectEntityId);
        if (data) {
          const def = this.objectDefsCache.get(data.defId);
          if (def && (!data.depleted || def.category === 'door')) {
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
          if (data) {
            const def = this.objectDefsCache.get(data.defId);
            if (def && (!data.depleted || def.category === 'door')) {
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
        this.isWallBlockedForPath);
      if (path.length > 1) {
        const last = path[path.length - 1];
        if (Math.floor(last.x) === Math.floor(target.x) && Math.floor(last.z) === Math.floor(target.z)) {
          path.pop();
        }
      }
      if (path.length > 0) {
        this.path = path; this.pathIndex = 0; this.tileProgress = 0; this.tileFrom = { x: this.playerX, z: this.playerZ };
        this.destMarker.isVisible = false;
        this.minimap?.clearDestination();
      }
    }
  }

  private talkToNpc(npcEntityId: number): void {
    const target = this.npcTargets.get(npcEntityId);
    if (!target) return;

    // Walk to NPC first, then send talk opcode
    const path = findPath(this.playerX, this.playerZ, target.x, target.z,
      this.isTileBlocked,
      this.chunkManager.getMapWidth(), this.chunkManager.getMapHeight(), 200,
      this.isWallBlockedForPath);
    if (path.length > 1) {
      const last = path[path.length - 1];
      if (Math.floor(last.x) === Math.floor(target.x) && Math.floor(last.z) === Math.floor(target.z)) {
        path.pop();
      }
    }
    if (path.length > 0) {
      this.path = path; this.pathIndex = 0; this.tileProgress = 0; this.tileFrom = { x: this.playerX, z: this.playerZ };
      this.destMarker.isVisible = false;
      this.minimap?.clearDestination();
    }
    // Send talk opcode — server checks distance
    this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_TALK_NPC, npcEntityId));
  }

  private pickupItem(groundItemId: number): void {
    this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_PICKUP_ITEM, groundItemId));
  }

  private handleObjectClick(objectEntityId: number): void {
    // Cooldown after cancelling a skill — prevent spam-restarting
    if (performance.now() - this.skillCancelTime < 600) return;
    const data = this.worldObjectDefs.get(objectEntityId);
    if (!data) return;
    const def = this.objectDefsCache.get(data.defId);
    if (!def) return;
    // Doors can always be clicked (open/close toggle). Other objects can't when depleted.
    if (data.depleted && def.category !== 'door') return;
    // Auto-interact with harvestable objects (trees, rocks) and doors
    if ((def.skill && def.harvestItemId) || def.category === 'door') {
      // Show red interaction marker at the object
      if (this.interactMarker) {
        this.interactMarker.position.x = data.x;
        this.interactMarker.position.y = this.getHeight(data.x, data.z) + 0.02;
        this.interactMarker.position.z = data.z;
        this.alignMarkerToTerrain(data.x, data.z, this.interactMarker);
        this.interactMarker.isVisible = true;
        this.destMarker.isVisible = false;
      }
      this.interactObject(objectEntityId, 0);
    }
  }

  private interactObject(objectEntityId: number, actionIndex: number): void {
    this.combatTargetId = -1;

    // Cancel current skilling if clicking a different object
    if (this.isSkilling && this.skillingObjectId !== objectEntityId) {
      this.isSkilling = false;
      this.skillingObjectId = -1;
      this.pendingSkill = null;
      this.localPlayer?.stopSkillAnimation();
    }

    const data = this.worldObjectDefs.get(objectEntityId);
    if (!data) return;

    const dx = data.x - this.playerX;
    const dz = data.z - this.playerZ;
    const dist = Math.hypot(dx, dz);

    // Find a reachable adjacent tile and walk there
    const def = this.objectDefsCache.get(data.defId);
    const isHarvestable = def?.category === 'rock' || def?.category === 'tree';
    const otx = Math.floor(data.x);
    const otz = Math.floor(data.z);
    const objTiles = def?.category === 'tree'
      ? [[-1,-1],[0,-1],[-1,0],[0,0]].map(([ddx,ddz]) => [otx+ddx, otz+ddz])
      : [[otx, otz]];
    const dirs = isHarvestable ? [[0,-1],[0,1],[-1,0],[1,0]] : [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];

    // Check if already on a valid adjacent tile
    const ptx = Math.floor(this.playerX);
    const ptz = Math.floor(this.playerZ);
    const alreadyAdj = objTiles.some(([tx, tz]) => {
      return dirs.some(([ddx, ddz]) => ptx === tx + ddx && ptz === tz + ddz);
    });

    if (!alreadyAdj) {
      // Find closest valid adjacent tile and pathfind there
      let bestPath: { x: number; z: number }[] | null = null;
      let bestLen = Infinity;
      for (const [tx, tz] of objTiles) {
        for (const [ddx, ddz] of dirs) {
          const ax = tx + ddx, az = tz + ddz;
          if (objTiles.some(([ox, oz]) => ox === ax && oz === az)) continue;
          if (this.isTileBlocked(ax, az)) continue;
          const path = findPath(this.playerX, this.playerZ, ax + 0.5, az + 0.5,
            this.isTileBlocked,
            this.chunkManager.getMapWidth(), this.chunkManager.getMapHeight(), 500,
            this.isWallBlockedForPath);
          if (path.length > 0 && path.length < bestLen) {
            bestLen = path.length;
            bestPath = path;
          }
        }
      }
      if (bestPath) {
        this.path = bestPath; this.pathIndex = 0; this.tileProgress = 0; this.tileFrom = { x: this.playerX, z: this.playerZ };
        this.network.sendMove(bestPath);
      }
    }

    // Send interaction request — server validates distance
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

  /** Spawn a simple arrow projectile that flies from→to over 300ms */
  private spawnProjectile(from: Vector3, to: Vector3): void {
    // Create a thin cylinder as the arrow
    const arrow = MeshBuilder.CreateCylinder('projectile', { height: 0.6, diameter: 0.04 }, this.scene);
    const mat = new StandardMaterial('projMat', this.scene);
    mat.diffuseColor = new Color3(0.4, 0.25, 0.1); // brown
    mat.emissiveColor = new Color3(0.2, 0.12, 0.05);
    arrow.material = mat;

    // Position at start, elevated slightly
    from.y += 1.0;
    to.y += 0.8;
    arrow.position = from.clone();

    // Orient toward target
    const dir = to.subtract(from).normalize();
    const up = Vector3.Up();
    const right = Vector3.Cross(up, dir).normalize();
    const correctedUp = Vector3.Cross(dir, right);
    arrow.rotationQuaternion = Quaternion.FromLookDirectionLH(dir, correctedUp);

    // Animate over 300ms
    const duration = 300;
    const startTime = performance.now();
    const obs = this.scene.onBeforeRenderObservable.add(() => {
      const t = Math.min(1, (performance.now() - startTime) / duration);
      arrow.position = Vector3.Lerp(from, to, t);
      if (t >= 1) {
        this.scene.onBeforeRenderObservable.remove(obs);
        arrow.dispose();
        mat.dispose();
      }
    });
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

    // Red marker for object interactions
    const iMarker = MeshBuilder.CreateDisc('interactMarker', { radius: 0.3, tessellation: 6 }, this.scene);
    iMarker.isVisible = false;
    iMarker.rotationQuaternion = Quaternion.RotationAxis(Vector3.Right(), -Math.PI / 2);
    const iMat = new StandardMaterial('interactMarkerMat', this.scene);
    iMat.diffuseColor = new Color3(1, 0.2, 0.2);
    iMat.emissiveColor = new Color3(0.6, 0.1, 0.1);
    iMat.specularColor = Color3.Black();
    iMat.backFaceCulling = false;
    iMarker.material = iMat;
    this.interactMarker = iMarker;
  }

  /** Align a marker disc to the terrain normal at (x, z) */
  private alignMarkerToTerrain(x: number, z: number, marker?: any): void {
    const target = marker ?? this.destMarker;
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
      target.rotationQuaternion = tilt.multiply(baseRot);
    } else {
      target.rotationQuaternion = baseRot;
    }
  }

  /** Tile blocked check that includes world objects (trees, rocks, etc.) */
  private isTileBlocked = (x: number, z: number): boolean => {
    if (this.currentFloor === 0) {
      return this.chunkManager.isBlocked(x, z) || this.blockedObjectTiles.has(`${x},${z}`);
    }
    return this.chunkManager.isBlockedOnFloor(x, z, this.currentFloor);
  };

  private isWallBlockedForPath = (fx: number, fz: number, tx: number, tz: number): boolean => {
    if (this.currentFloor !== 0) {
      return this.chunkManager.isWallBlockedOnFloor(fx, fz, tx, tz, this.currentFloor);
    }
    // Pass player height so walls below the player don't block
    const playerY = this.localPlayer?.position.y ?? this.getHeight(this.playerX, this.playerZ);
    return this.chunkManager.isWallBlocked(fx, fz, tx, tz, playerY);
  };

  /** Get the cardinal facing angle (N/E/S/W) toward a target from a source position. */
  private cardinalFacingAngle(dx: number, dz: number): number {
    // Pick the axis with the larger absolute component
    // If equal, prefer X axis (east/west)
    if (Math.abs(dx) >= Math.abs(dz)) {
      return dx > 0 ? Math.PI / 2 : -Math.PI / 2; // East or West
    } else {
      return dz > 0 ? 0 : Math.PI; // South or North
    }
  }

  private startSkillingVisual(objectId: number, variant?: string): void {
    this.path = []; this.pathIndex = 0; this.tileProgress = 0; this.pendingPath = null;
    // Snap player to tile center
    this.playerX = Math.round(this.playerX - 0.5) + 0.5;
    this.playerZ = Math.round(this.playerZ - 0.5) + 0.5;
    if (this.localPlayer) {
      this.localPlayer.stopWalking();
      const h = this.getHeight(this.playerX, this.playerZ);
      this.localPlayer.setPositionXYZ(this.playerX, h, this.playerZ);
      // Face toward the object
      const objData = this.worldObjectDefs.get(objectId);
      if (objData) {
        this.localPlayer.faceToward(new Vector3(objData.x, 0, objData.z));
      }
      this.localPlayer.startSkillAnimation(variant);
    }
  }

  private handleGroundClick(worldX: number, worldZ: number): void {
    this.combatTargetId = -1;
    this.pendingSkill = null;
    if (this.isSkilling) {
      this.isSkilling = false;
      this.skillingObjectId = -1;
      // Clicking on own tile — delay the cancel so you can't spam restart
      const clickedOwnTile = Math.floor(worldX) === Math.floor(this.playerX) && Math.floor(worldZ) === Math.floor(this.playerZ);
      if (clickedOwnTile) {
        this.skillCancelTime = performance.now();
        setTimeout(() => {
          if (!this.isSkilling) this.localPlayer?.stopSkillAnimation();
        }, 600);
      } else {
        this.localPlayer?.stopSkillAnimation();
      }
    }
    if (this.interactMarker) this.interactMarker.isVisible = false;

    const tx = Math.floor(worldX), tz = Math.floor(worldZ);
    const blocked = this.isTileBlocked(tx, tz);

    const path = findPath(this.playerX, this.playerZ, worldX, worldZ,
      this.isTileBlocked,
      this.chunkManager.getMapWidth(), this.chunkManager.getMapHeight(), 200,
      this.isWallBlockedForPath);
    if (path.length > 0) {
      this.path = path; this.pathIndex = 0;
      this.tileProgress = 0;
      this.tileFrom = { x: this.playerX, z: this.playerZ };
      this.pendingPath = null;
      const dest = path[path.length - 1];
      this.destMarker.position.x = dest.x;
      this.destMarker.position.y = this.getHeight(dest.x, dest.z) + 0.02;
      this.destMarker.position.z = dest.z;
      this.alignMarkerToTerrain(dest.x, dest.z);
      this.destMarker.isVisible = true;
      this.minimap?.setDestination(dest.x, dest.z);
      // Always send the full new path to the server
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

  private static readonly IDENTITY = Matrix.Identity();

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
    const identity = GameManager.IDENTITY;

    // Project overlays for sprites that actually have visible overlays — no intermediate array
    const projectSprite = (sprite: SpriteEntity | CharacterEntity) => {
      const hasBubble = sprite.hasChatBubble();
      const hasBar = sprite.hasHealthBar();
      if (!hasBubble && !hasBar) return;

      if (hasBubble) {
        const worldPos = sprite.getChatBubbleWorldPos();
        if (worldPos) {
          const screenPos = Vector3.Project(worldPos, identity, transform, viewport);
          sprite.updateChatBubbleScreenPos(screenPos.x, screenPos.y);
        }
      }
      if (hasBar) {
        const worldPos = sprite.getHealthBarWorldPos();
        if (worldPos) {
          const screenPos = Vector3.Project(worldPos, identity, transform, viewport);
          sprite.updateHealthBarScreenPos(screenPos.x, screenPos.y);
        }
      }
    };

    if (this.localPlayer) projectSprite(this.localPlayer);
    for (const [, sprite] of this.remotePlayers) projectSprite(sprite);
    for (const [, sprite] of this.npcSprites) projectSprite(sprite);
  }

  private updateHUD(): void {
    if (this.statsPanel) {
      this.statsPanel.updateHealth(this.playerHealth, this.playerMaxHealth);
    }
  }

  private showThinkingBubble(iconUrl: string): void {
    this.hideThinkingBubble();
    const bubble = document.createElement('div');
    bubble.style.cssText = `
      position: fixed; pointer-events: none; z-index: 200;
      background: white; border: 2px solid #333; border-radius: 12px;
      padding: 4px; width: 36px; height: 36px;
      display: flex; align-items: center; justify-content: center;
    `;
    const img = document.createElement('img');
    img.src = iconUrl;
    img.style.cssText = 'width: 28px; height: 28px; image-rendering: pixelated;';
    bubble.appendChild(img);
    // Small tail triangle
    const tail = document.createElement('div');
    tail.style.cssText = `
      position: absolute; bottom: -8px; left: 50%; transform: translateX(-50%);
      width: 0; height: 0;
      border-left: 6px solid transparent; border-right: 6px solid transparent;
      border-top: 8px solid #333;
    `;
    bubble.appendChild(tail);
    document.body.appendChild(bubble);
    this.thinkingBubble = bubble;
  }

  private hideThinkingBubble(): void {
    if (this.thinkingBubble) {
      this.thinkingBubble.remove();
      this.thinkingBubble = null;
    }
  }

  private updateThinkingBubble(): void {
    if (!this.thinkingBubble || !this.localPlayer) return;
    const cam = this.scene.activeCamera;
    if (!cam) return;
    const pos = this.localPlayer.position.clone();
    pos.y += 2.2; // above player head
    const screenPos = Vector3.Project(pos, Matrix.Identity(),
      cam.getViewMatrix().multiply(cam.getProjectionMatrix()),
      new Viewport(0, 0, this.engine.getRenderWidth(), this.engine.getRenderHeight()));
    this.thinkingBubble.style.left = `${screenPos.x - 20}px`;
    this.thinkingBubble.style.top = `${screenPos.y - 48}px`;
  }

  private update(dt: number): void {
    // WASD camera rotation
    const camSpeed = 2.0 * dt;
    const cam = this.camera.getCamera();
    if (this.keysDown.has('a') || this.keysDown.has('arrowleft')) cam.alpha += camSpeed;
    if (this.keysDown.has('d') || this.keysDown.has('arrowright')) cam.alpha -= camSpeed;
    if (this.keysDown.has('w') || this.keysDown.has('arrowup')) cam.beta = Math.max(0.2, cam.beta - camSpeed);
    if (this.keysDown.has('s') || this.keysDown.has('arrowdown')) cam.beta = Math.min(Math.PI / 2.2, cam.beta + camSpeed);
    // Escape resets camera rotation to default
    if (this.keysDown.has('escape')) {
      cam.alpha = -Math.PI / 4;
      cam.beta = Math.PI / 3.2;
      this.keysDown.delete('escape');
    }

    // Update attack animations on all sprites
    if (this.localPlayer) this.localPlayer.updateAnimation(dt);
    for (const [, sprite] of this.remotePlayers) sprite.updateAnimation(dt);
    for (const [, sprite] of this.npcSprites) sprite.updateAnimation(dt);

    // Cache camera position for this frame
    const camPos = this.scene.activeCamera?.position ?? null;

    // Update chunks around player
    this.chunkManager.updatePlayerPosition(this.playerX, this.playerZ);
    this.chunkManager.updateAnimations();

    // Combat follow
    this._combatPathTimer -= dt;
    if (this.combatTargetId >= 0 && this.localPlayer) {
      const npcTarget = this.npcTargets.get(this.combatTargetId);
      if (npcTarget) {
        const dx = npcTarget.x - this.playerX;
        const dz = npcTarget.z - this.playerZ;
        const dist = Math.hypot(dx, dz);
        if (dist > 1.5) {
          if ((this.pathIndex >= this.path.length || dist > 3) && this._combatPathTimer <= 0) {
            this._combatPathTimer = 0.3;
            const newPath = findPath(this.playerX, this.playerZ, npcTarget.x, npcTarget.z,
              this.isTileBlocked,
              this.chunkManager.getMapWidth(), this.chunkManager.getMapHeight(), 200,
              this.isWallBlockedForPath);
            if (newPath.length > 1) {
              const last = newPath[newPath.length - 1];
              if (Math.floor(last.x) === Math.floor(npcTarget.x) && Math.floor(last.z) === Math.floor(npcTarget.z)) {
                newPath.pop();
              }
            }
            if (newPath.length > 0) {
              this.path = newPath; this.pathIndex = 0;
              this.destMarker.isVisible = false;
              this.minimap?.clearDestination();
            }
          }
        }
      }
    }

    // Move local player — tick-aligned tile stepping
    if (this.pathIndex < this.path.length && this.localPlayer) {
      if (!this.localPlayer.isWalking()) this.localPlayer.startWalking();

      // Combat range check
      if (this.combatTargetId >= 0) {
        const npcTarget = this.npcTargets.get(this.combatTargetId);
        if (npcTarget) {
          const toDist = Math.hypot(npcTarget.x - this.playerX, npcTarget.z - this.playerZ);
          if (toDist <= 1.5) {
            this.pathIndex = this.path.length;
            this.localPlayer.stopWalking();
            this.playerX = Math.floor(this.playerX) + 0.5;
            this.playerZ = Math.floor(this.playerZ) + 0.5;
            this.localPlayer!.setPositionXYZ(this.playerX, this.getHeight(this.playerX, this.playerZ), this.playerZ);
          }
        }
      }

      if (this.pathIndex < this.path.length) {
        const target = this.path[this.pathIndex];
        const dx = target.x - this.tileFrom.x;
        const dz = target.z - this.tileFrom.z;
        const tileDist = Math.hypot(dx, dz);
        // Speed: 1 tile per 600ms = 1.67 tiles/sec. Diagonal tiles are ~1.41 tiles distance.
        const stepRate = tileDist > 0 ? (this.moveSpeed * dt) / tileDist : 1;
        this.tileProgress += stepRate;

        if (this.tileProgress >= 1.0) {
          // Arrived at tile center — snap
          this.playerX = target.x;
          this.playerZ = target.z;
          this.tileProgress = 0;
          this.tileFrom = { x: target.x, z: target.z };
          this.pathIndex++;

          // Apply pending path at every tile boundary (max 1 tile delay on redirect)
          if (this.pendingPath) {
            this.path = this.pendingPath;
            this.pathIndex = 0;
            this.pendingPath = null;
          }

          if (this.pathIndex >= this.path.length) {
            this.destMarker.isVisible = false;
            this.minimap?.clearDestination();
            this.localPlayer.stopWalking();
            // Start deferred skilling animation now that we've arrived
            if (this.pendingSkill) {
              const { objectId, variant } = this.pendingSkill;
              this.pendingSkill = null;
              this.startSkillingVisual(objectId, variant);
            }
          }
        } else {
          // Lerp between tile centers
          this.playerX = this.tileFrom.x + dx * this.tileProgress;
          this.playerZ = this.tileFrom.z + dz * this.tileProgress;
        }

        // Update facing direction (skip if skilling — startSkillingVisual handles facing)
        if (!this.isSkilling) {
          if (camPos && this.pathIndex < this.path.length) {
            const nextTarget = this.path[this.pathIndex];
            this.localPlayer.updateMovementDirection(nextTarget.x - this.playerX, nextTarget.z - this.playerZ, camPos);
          } else if (camPos && (dx !== 0 || dz !== 0)) {
            this.localPlayer.updateMovementDirection(dx, dz, camPos);
          }
        }

        const playerH = this.getHeight(this.playerX, this.playerZ);
        this.localPlayer.setPositionXYZ(this.playerX, playerH, this.playerZ);
        this.inputManager.setPlayerY(playerH);
      }
    }

    // Face local player toward combat target when idle
    if (this.localPlayer && this.pathIndex >= this.path.length && this.combatTargetId >= 0) {
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
        if (camPos) sprite.updateMovementDirection(dx, dz, camPos);
        const step = Math.min(1.67 * dt, dist);
        const nx = c.x + (dx / dist) * step;
        const nz = c.z + (dz / dist) * step;
        sprite.setPositionXYZ(nx, this.getHeight(nx, nz), nz);
      } else {
        if (sprite.isWalking()) sprite.stopWalking();
        // Idle — face combat target if in combat
        const combatTarget = this.remoteCombatTargets.get(entityId);
        if (combatTarget !== undefined) {
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
        if (!sprite.isWalking()) sprite.startWalking();
        if (camPos) sprite.updateMovementDirection(dx, dz, camPos);
        const step = Math.min(3.0 * dt, dist);
        const nx = c.x + (dx / dist) * step;
        const nz = c.z + (dz / dist) * step;
        sprite.setPositionXYZ(nx, this.getHeight(nx, nz), nz);
      } else {
        if (sprite.isWalking()) sprite.stopWalking();
        // Idle — face combat target if in combat
        const combatTarget = this.npcCombatTargets.get(entityId);
        if (combatTarget !== undefined) {
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
      if (cam && this.hitSplats.length > 0) {
        const w = this.engine.getRenderWidth();
        const h = this.engine.getRenderHeight();
        const transform = cam.getViewMatrix().multiply(cam.getProjectionMatrix());
        this._splatVp.x = 0; this._splatVp.y = 0; this._splatVp.width = w; this._splatVp.height = h;

        let writeIdx = 0;
        for (let i = 0; i < this.hitSplats.length; i++) {
          const splat = this.hitSplats[i];
          splat.timer -= dt;
          splat.worldPos.y += dt * 0.5;

          if (splat.timer <= 0) {
            splat.el.remove();
          } else {
            splat.el.style.opacity = (splat.timer < 0.3 ? splat.timer / 0.3 : 1).toString();
            const screenPos = Vector3.Project(splat.worldPos, Matrix.Identity(), transform, this._splatVp);
            splat.el.style.left = `${screenPos.x}px`;
            splat.el.style.top = `${screenPos.y}px`;
            this.hitSplats[writeIdx++] = splat;
          }
        }
        this.hitSplats.length = writeIdx;
      }
    }

    // Indoor detection — check if player is under a roof
    const playerY = this.localPlayer?.position.y ?? this.getHeight(this.playerX, this.playerZ);
    const underRoof = this.chunkManager.isUnderRoof(this.playerX, this.playerZ, playerY);
    if (underRoof && !this.isIndoors) {
      this.isIndoors = true;
      this._lastIndoorTileX = -9999;
      this._lastIndoorTileZ = -9999;
      this.camera.setTargetRadius(10);
    } else if (!underRoof && this.isIndoors) {
      this.isIndoors = false;
      for (const node of this.hiddenRoofNodes) node.setEnabled(true);
      this.hiddenRoofNodes = [];
      this._lastIndoorTileX = -9999;
      this._lastIndoorTileZ = -9999;
      this.camera.setTargetRadius(12);
    }
    // While indoors, update which objects are hidden — only when player tile changes
    if (this.isIndoors) {
      const ptx = Math.floor(this.playerX);
      const ptz = Math.floor(this.playerZ);
      if (ptx !== this._lastIndoorTileX || ptz !== this._lastIndoorTileZ) {
        this._lastIndoorTileX = ptx;
        this._lastIndoorTileZ = ptz;
        // Show previously hidden nodes
        for (const node of this.hiddenRoofNodes) node.setEnabled(true);
        const playerY = this.localPlayer?.position.y ?? 0;
        // Hide objects above the player's current height
        this.hiddenRoofNodes = [
          ...this.chunkManager.getRoofNodesNear(this.playerX, this.playerZ, 8, playerY + 0.5),
          ...this.chunkManager.getNodesAboveHeight(this.playerX, this.playerZ, 8, playerY + 1.5),
        ];
        this._roofDedup.clear();
        this.hiddenRoofNodes = this.hiddenRoofNodes.filter(n => {
          if (this._roofDedup.has(n)) return false;
          this._roofDedup.add(n);
          return true;
        });
        for (const node of this.hiddenRoofNodes) node.setEnabled(false);
      }
    }

    // Camera follows player — use sprite's actual Y position (accounts for bridges/floors)
    if (this.localPlayer) {
      this._tempVec.set(this.playerX, this.localPlayer.position.y, this.playerZ);
      this.camera.followTarget(this._tempVec);
    }

    // Note: player sprite directions are updated during movement interpolation above
    // (based on movement direction, not camera angle)

    // Update all HTML overlay positions
    this.updateOverlayPositions();
    this.updateThinkingBubble();

    // Update minimap
    if (this.minimap && this.chunkManager.isLoaded()) {
      this._minimapRemotes.length = 0;
      for (const [, target] of this.remoteTargets) {
        this._minimapRemotes.push(target);
      }
      this._minimapNpcs.length = 0;
      for (const [, target] of this.npcTargets) {
        this._minimapNpcs.push(target);
      }
      const camAlpha = this.camera.getCamera().alpha;
      this.minimap.update(
        this.playerX, this.playerZ,
        this._minimapRemotes, this._minimapNpcs,
        this.chunkManager,
        camAlpha
      );
    }
  }
}
