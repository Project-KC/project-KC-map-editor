# ProjectRS — Browser-Based MMORPG

A multiplayer browser MMORPG inspired by RuneScape Classic and HighSpell. Built with Bun, TypeScript, and Babylon.js.

## Tech Stack

- **Runtime:** Bun (server), Browser (client)
- **Language:** TypeScript (strict mode, shared types between client/server)
- **3D Engine:** Babylon.js 7 (WebGL)
- **Visual Style:** Low-poly 3D terrain with 2D billboard sprites (RS Classic style)
- **Networking:** Dual WebSocket — binary game protocol + JSON chat protocol
- **Build:** Vite for client bundling, Bun for server
- **Monorepo:** Bun workspaces (`shared/`, `server/`, `client/`, `tools/`)

## Project Structure

```
ProjectRS/
├── package.json              # Workspace root
├── tsconfig.json             # Base TS config (ES2022, strict)
├── shared/                   # Shared types, constants, protocol
│   ├── index.ts              # Barrel re-export
│   ├── opcodes.ts            # Client/Server opcode enums
│   ├── constants.ts          # TICK_RATE, CHUNK_SIZE, CHUNK_LOAD_RADIUS, ports
│   ├── types.ts              # ItemDef, NpcDef, TileType, MapMeta, WorldObjectDef, etc.
│   ├── protocol.ts           # Binary packet encode/decode (opcode + int16 values)
│   ├── terrain.ts            # Shared terrain constants
│   └── skills.ts             # OSRS XP formulas, combat formulas, stances, bonuses
├── server/                   # Game server (Bun)
│   ├── src/
│   │   ├── main.ts           # Bun.serve() — HTTP static + WebSocket upgrade + map/data endpoints
│   │   ├── World.ts          # Multi-map game loop, tick processing, NPC/object spawning, combat, transitions
│   │   ├── GameMap.ts        # Loads heightmap/tilemap PNGs, collision, binary heap A* pathfinding
│   │   ├── ChunkManager.ts   # Server-side spatial index for chunk-filtered entity broadcasting
│   │   ├── Database.ts       # SQLite persistence (player state, map level)
│   │   ├── entity/
│   │   │   ├── Entity.ts     # Base: id, position, health, damage/heal, currentMapLevel
│   │   │   ├── Player.ts     # Inventory, equipment, skills, stance, movement
│   │   │   ├── Npc.ts        # AI wandering, combat target, respawn
│   │   │   └── WorldObject.ts # Trees, rocks, fishing spots, crafting stations
│   │   ├── combat/
│   │   │   └── Combat.ts     # OSRS hit chance, max hit, XP distribution, loot
│   │   ├── network/
│   │   │   ├── GameSocket.ts # Binary protocol handler (client opcodes incl. PLAYER_INTERACT_OBJECT)
│   │   │   └── ChatSocket.ts # JSON chat handler (local, PM, commands)
│   │   └── data/
│   │       └── DataLoader.ts # Loads items.json, npcs.json, objects.json, map spawns at startup
│   └── data/
│       ├── items.json        # 30 items (equipment, food, skilling resources, bars)
│       ├── npcs.json         # 9 NPC types (Chicken through Dark Knight)
│       ├── objects.json      # 8 world object types (trees, rocks, fishing, furnace, range, altar)
│       └── maps/
│           ├── overworld/    # 1024x1024 tile map
│           │   ├── meta.json
│           │   ├── heightmap.png   # 1025x1025 grayscale vertex heights
│           │   ├── tilemap.png     # 1024x1024 RGB tile types
│           │   └── spawns.json     # NPC + object spawn locations
│           └── underground/  # 256x256 tile map
│               ├── meta.json
│               ├── heightmap.png   # 257x257 grayscale vertex heights
│               ├── tilemap.png     # 256x256 RGB tile types
│               └── spawns.json
├── client/                   # Browser client (Vite + Babylon.js)
│   ├── index.html            # Game canvas
│   ├── vite.config.ts        # Aliases @projectrs/shared, proxies /ws and /api to :4000
│   ├── src/
│   │   ├── main.ts           # Entry point: login flow, session restore, creates GameManager
│   │   ├── managers/
│   │   │   ├── GameManager.ts    # Scene, chunk loading, fog, entities, UI, map transitions
│   │   │   ├── NetworkManager.ts # Dual WebSocket client (binary + JSON)
│   │   │   └── InputManager.ts   # Click-to-move via scene.pick() on chunk ground meshes
│   │   ├── rendering/
│   │   │   ├── ChunkManager.ts   # Fetches map PNGs via HTTP, builds/disposes 32x32 chunk meshes
│   │   │   ├── SpriteEntity.ts   # Billboard planes with dynamic textures
│   │   │   ├── Camera.ts         # ArcRotateCamera, WASD/arrow rotation, follow
│   │   │   └── Pathfinding.ts    # Client-side binary heap A* for click-to-move
│   │   └── ui/
│   │       ├── SidePanel.ts      # Tabbed: Inventory / Skills / Equipment
│   │       ├── InventoryPanel.ts # Inventory grid with context menus (equip/eat/drop)
│   │       ├── ChatPanel.ts      # Chat log + input, Enter to focus
│   │       ├── LoginScreen.ts    # Login/signup form with tab switching, token auth
│   │       ├── StatsPanel.ts     # HP bar (top-left)
│   │       └── Minimap.ts        # 150px canvas overlay (top-right), reads tiles from ChunkManager
├── editor/                   # Map editor (Vite + TypeScript)
│   ├── index.html
│   ├── vite.config.ts        # Runs on :5174, proxies to :4000
│   ├── src/
│   │   ├── main.ts           # Entry point
│   │   ├── EditorApp.ts      # Main editor controller (load/save, tool switching)
│   │   ├── api/
│   │   │   └── EditorApi.ts  # HTTP API client for load/save/create/export/import maps
│   │   ├── canvas/
│   │   │   ├── MapCanvas.ts      # Main 2D canvas with pan/zoom, delegates to renderers
│   │   │   ├── TileRenderer.ts   # Renders tiles + building overlays (floors/stairs/roofs)
│   │   │   ├── HeightRenderer.ts # Height visualization overlay
│   │   │   ├── WallRenderer.ts   # Wall edge visualization (uses wallHeights for opacity)
│   │   │   ├── GridOverlay.ts    # Optional grid lines
│   │   │   ├── SpawnRenderer.ts  # NPC/object spawn point markers
│   │   │   ├── MinimapCanvas.ts  # Small overview map
│   │   │   └── BuildingRenderer.ts # Renders floors/stairs/roofs on editor canvas
│   │   ├── panels/
│   │   │   ├── Toolbar.ts        # Tool buttons + settings panels (tile, height, wall, floor, stair, roof, NPC, object)
│   │   │   ├── MapSelector.ts    # Map list + create/load/export/import
│   │   │   ├── TilePalette.ts    # Tile type color swatches
│   │   │   └── PropertiesPanel.ts # Map properties editor (name, fog, spawn, transitions)
│   │   ├── state/
│   │   │   ├── EditorState.ts    # Central state: tiles, heights, walls, floors, stairs, roofs + getters/setters
│   │   │   └── UndoManager.ts    # Undo/redo with snapshot diffs
│   │   └── tools/                # Tool implementations (BaseTool interface)
│   │       ├── BaseTool.ts       # EditorToolInterface + EditorToolContext
│   │       ├── TileBrush.ts      # Paint tile types
│   │       ├── HeightBrush.ts    # Set/raise/lower/smooth heights
│   │       ├── WallBrush.ts      # Paint wall edges (with height slider)
│   │       ├── FloorBrush.ts     # Paint/remove elevated floors
│   │       ├── StairPlacer.ts    # Place/remove stairs (direction + heights)
│   │       ├── RoofBrush.ts      # Paint/remove roofs (flat/peaked)
│   │       ├── FloodFill.ts, RectTool.ts, LineTool.ts  # Shape tools
│   │       ├── NpcPlacer.ts, ObjectPlacer.ts            # Entity placement
│   │       ├── SpawnDragger.ts, SpawnEraser.ts          # Spawn management
│   │       ├── SelectTool.ts     # Region selection + copy/paste
│   │       └── Eyedropper.ts     # Sample tile type from canvas
├── tools/
│   └── generate-maps.ts      # Generates heightmap/tilemap PNGs, meta.json, spawns.json for all maps
```

## Running the Project

```bash
# Generate map files (only needed once, or after changing generate-maps.ts)
bun tools/generate-maps.ts

# Build client
cd client && bunx vite build

# Start server (serves built client on port 4000)
cd /path/to/ProjectRS && bun server/src/main.ts

# Open http://localhost:4000

# For development with hot reload (two terminals):
bun run dev:server    # watches server changes
bun run dev:client    # vite dev server on :5173, proxies /ws and /api to :4000
```

## Architecture

### Server-Authoritative

All game state lives on the server. The client sends intentions (move, attack, equip, interact), the server validates and broadcasts results. The server ticks at 600ms intervals.

### Multi-Map System

The world consists of multiple maps, each defined by a directory under `server/data/maps/`:
- **meta.json**: Map ID, dimensions, height range, water level, spawn point, fog settings, transition tiles
- **heightmap.png**: Grayscale PNG, `(width+1) x (height+1)` vertices, decoded as `pixel / 255 * range + minH`
- **tilemap.png**: RGB PNG, `width x height` tiles, decoded via nearest-color match (`tileTypeFromRgb()`)
- **spawns.json**: NPC and world object spawn positions

Maps currently: `overworld` (1024x1024) and `underground` (256x256).

Transitions are defined per-tile in meta.json. When a player steps on a transition tile, the server removes them from the old map, sends cleanup packets, transfers them to the new map, and sends `MAP_CHANGE`.

### Chunk System

Terrain is divided into 32x32 tile chunks (`CHUNK_SIZE=32`, `CHUNK_LOAD_RADIUS=2` = 5x5 grid around player).

- **Server (`ChunkManager.ts`):** Pure spatial index mapping entity IDs to chunk coordinates. Used to filter broadcasts — only sends entity updates to players whose loaded chunks overlap.
- **Client (`rendering/ChunkManager.ts`):** Fetches map PNGs via HTTP, decodes them, and builds BabylonJS meshes per chunk (ground mesh with vertex colors, water mesh at waterLevel with alpha, wall mesh with variable heights, roof mesh, floor mesh, stair mesh). Loads/disposes chunks dynamically as the player moves.

### Movement Model

- **Client:** Runs A* pathfinding on click (binary heap, maxSteps=200), smoothly interpolates along the path at 3.0 tiles/sec. Client path prediction is trusted for visual rendering — no server position correction is applied to the local player.
- **Server:** Receives the client's path, validates it against collision, processes 2 waypoints per tick (~3.33 tiles/sec) to stay ahead of the client.
- **Terrain sync:** Both client and server decode the same heightmap/tilemap PNGs, so terrain is always consistent. No more dual procedural generation.

### Network Protocol

Two WebSocket connections per client:

1. **Game socket** (`/ws/game`) — Binary `Uint8Array` packets: `[opcode (1 byte), ...int16 values]`
2. **Chat socket** (`/ws/chat`) — JSON messages

Opcodes are defined in `shared/opcodes.ts`. The protocol helpers are in `shared/protocol.ts`.

Key server→client opcodes:
| Opcode | Value | Purpose |
|--------|-------|---------|
| WORLD_OBJECT_SYNC | 55 | Spawn/update a world object |
| WORLD_OBJECT_DEPLETED | 56 | Toggle object depletion state |
| SKILLING_START | 57 | Begin skilling animation |
| SKILLING_STOP | 58 | Stop skilling |
| MAP_CHANGE | 60 | String packet: new map ID + coordinates |
| FLOOR_CHANGE | 61 | Player changed floor level (multi-floor buildings) |

Key client→server opcodes:
| Opcode | Value | Purpose |
|--------|-------|---------|
| PLAYER_INTERACT_OBJECT | 40 | Interact with world object (harvest/craft) |

### Building System (Edge Walls, Floors, Stairs, Roofs)

Buildings are defined in `walls.json` per map (backwards-compatible extension):

```json
{
  "walls": { "x,z": bitmask },           // N=1, E=2, S=4, W=8 edge bitmask
  "wallHeights": { "x,z": number },      // wall height override (default 1.8)
  "floors": { "x,z": number },           // elevated floor Y height
  "stairs": { "x,z": { "direction": "N"|"E"|"S"|"W", "baseHeight": 0, "topHeight": 3.5 } },
  "roofs": { "x,z": { "height": 3.5, "style": "flat"|"peaked_ns"|"peaked_ew", "peakHeight": 0.6 } }
}
```

**Wall system:** Edge-based thin walls (not full tiles). Each tile has a 4-bit bitmask for N/E/S/W edges. Walls block pathfinding via `isWallBlocked()` on both client and server. The server validates all paths against walls.

**Height priority for entities:** `getEffectiveHeight(x, z)` returns: stairs (interpolated) > elevated floors > terrain height. Used by both server and client for Y positioning.

**Rendering:** ChunkManager builds separate meshes per chunk:
- Wall mesh: extruded quads per edge, variable height per tile, accounts for floor height
- Floor mesh: walkable platform with top/bottom faces and edge faces where neighbors differ
- Stair mesh: 4-step ramp with direction, rendered as individual step treads and risers
- Roof mesh: flat quad or two-slope peaked roof per tile

**Editor tools:** FloorBrush (click/shift+click), StairPlacer (direction + heights), RoofBrush (style selector), WallBrush (extended with height slider).

**Multi-floor foundation:** Entities have `currentFloor`, server sends `FLOOR_CHANGE` (opcode 61) on stair transitions. Phase 4 (separate tile layers per floor, camera culling) is planned but not yet implemented.

### Authentication

Login/signup with username + password. Server hashes passwords with Bun's `Bun.password.hash()`, creates token-based sessions stored in SQLite. Client stores token + username in localStorage for auto-login.

- `POST /api/signup` — Create account, returns `{ token, username }`
- `POST /api/login` — Authenticate, returns `{ token, username }`
- WebSocket upgrade requires valid `?token=` query parameter

### HTTP Endpoints

- `/api/signup`, `/api/login`, `/api/logout` — Authentication (see above)
- `/maps/{mapId}/meta.json` — Map metadata
- `/maps/{mapId}/heightmap.png` — Heightmap image
- `/maps/{mapId}/tilemap.png` — Tilemap image
- `/data/objects.json` — World object definitions

### Combat System (OSRS-style)

Key formulas in `shared/skills.ts`:

- **Hit chance:** Piecewise function based on attack roll vs defence roll (`calculateHitChance`)
- **Max hit:** `floor(1.3 + effStr/10 + bStr/80 + effStr*bStr/640)` (`osrsMeleeMaxHit`)
- **XP:** 4 XP per damage dealt, distributed by stance. Combat skills auto-award 1/3 XP to hitpoints.
- **Stances:** Accurate (+3 acc), Aggressive (+3 pow), Defensive (+3 def), Controlled (+1 each)
- **Equipment bonuses:** Per-slot bonuses for stab/slash/crush attack and defence, melee strength, ranged, magic

### Skills System

12 skills with OSRS XP formula: `xpForLevel(L) = floor(sum(1..L-1 of floor(lvl + 300 * 2^(lvl/7))) / 4)`

Combat: accuracy, power, defence, magic, archery, hitpoints
Gathering/crafting: forestry, fishing, cooking, mining, smithing, crafting

Combat level: `floor(0.25*(def+hp) + max(0.325*(acc+pow), 0.325*(1.5*arch), 0.325*(1.5*mag)))`

### World Objects & Skilling

8 world objects defined in `server/data/objects.json`:

| ID | Name | Category | Skill | Harvest |
|----|------|----------|-------|---------|
| 1 | Tree | tree | forestry (1) | Logs |
| 2 | Oak Tree | tree | forestry (15) | Oak Logs |
| 3 | Copper Rock | rock | mining (1) | Copper Ore |
| 4 | Iron Rock | rock | mining (15) | Iron Ore |
| 5 | Fishing Spot | fishingspot | fishing (1) | Raw Shrimp |
| 6 | Furnace | furnace | smithing | Smelting station |
| 7 | Cooking Range | cookingrange | cooking | Cooking station |
| 8 | Altar | altar | — | Prayer |

Harvesting: player right-clicks object → auto-walks to adjacent tile → starts timed action → grants item + XP on success → rolls depletion chance → object respawns after timer. Moving cancels skilling.

Crafting: player interacts with furnace/range → first matching recipe is applied instantly → consumes input item, produces output, awards XP.

### Overworld Map (1024x1024)

Spawn at (512, 512). Distinct regions with roads connecting them:

| Region | Location | Terrain | NPCs/Objects |
|--------|----------|---------|-------------|
| Central Village | 480-550, 480-550 | Stone plaza, 7 buildings, farm | Guards, Shopkeeper, Chickens, Furnace, Range, Altar |
| NE Mountains | 650-850, 200-400 | Stone/dirt peaks (height 4-8) | Wolves, Copper Rocks, Iron Rocks, Mining Camp |
| E Forest | 650-850, 450-570 | Dense wall-tile trees | Spiders, Wolves, Oak Trees |
| SE Ruins | 710-790, 710-790 | Stone ruins, partial walls | Skeletons, Dark Knight, Altar, **Dungeon entrance** |
| SW Goblin Camp | 260-370, 660-770 | Dirt camp, tent structures | Goblins (10 spawns) |
| NW Swamp | 220-380, 220-380 | Water/sand/grass mix | Rats, Fishing Spots |
| River | NW to south | 3-4 tile water, sand banks | Fishing Spots along banks |
| South Coast | z > 870 | Sand beach → water | Fishing Spots |
| Lake | 555-575, 505-525 | Water pond east of village | Fishing Spot |

Roads: 2-tile dirt highways (N-S at x=511-512, E-W at z=511-512) + diagonal paths to each region. Roads bridge over the river.

### Underground Map (256x256)

Structured rooms and corridors (everything outside = impassable WALL):

| Area | Location | Contents |
|------|----------|----------|
| Central Hub | 110-145, 110-145 | 35x35 room, 3 doorways |
| Entrance Room | 122-134, 122-134 | Dirt-bordered marker, transition tile at (128,128) |
| Mining Chamber | 115-140, 50-70 | Iron Rocks, Furnace (via north corridor) |
| Skeleton Hall | 180-205, 115-140 | 4 Skeletons (via east corridor) |
| Boss Chamber | 115-145, 180-205 | Dark Knight boss (via south corridor) |

Spawn at (130.5, 130.5), transition back to overworld at tile (128, 128).

### Items

30 items defined in `server/data/items.json`:

- **Drops (1, 19, 20):** Bones, Feather (stackable), Big Bones
- **Equipment (2-9, 16-18, 21-22):** Copper Dagger/Sword/Shield/Helm, Iron Sword/Battleaxe/Shield/Helm/Legs, Leather Body/Legs, Chainmail, Amulet of Power
- **Coins (10):** Stackable currency
- **Food — raw (11, 14, 27):** Raw Chicken, Raw Rat Meat, Raw Shrimp
- **Food — cooked (12, 13, 15, 28):** Cooked Chicken (3hp), Bread (2hp), Cooked Meat (4hp), Cooked Shrimp (3hp)
- **Skilling Resources (23-26):** Logs, Oak Logs, Copper Ore, Iron Ore
- **Processed (29-30):** Copper Bar, Iron Bar

Equipment slots: weapon, shield, head, body, legs, neck, ring, hands, feet, cape

### NPCs

9 types in `server/data/npcs.json`:
| NPC | HP | Aggressive | Location |
|-----|-----|------------|----------|
| Chicken | 5 | No | Village farm |
| Rat | 8 | No | NW Swamp |
| Goblin | 15 | No | SW Camp |
| Wolf | 25 | Yes | NE Mountains, E Forest |
| Spider | 12 | No | E Forest |
| Skeleton | 30 | Yes | SE Ruins, Underground |
| Guard | 40 | No | Village |
| Shopkeeper | 50 | No | Village |
| Dark Knight | 60 | Yes | SE Ruins, Underground Boss |

### Persistence

SQLite database with three tables:
- **accounts**: username, password hash (Bun.password), created timestamp
- **sessions**: token-based auth, linked to account, 24-hour expiry
- **player_state**: position, inventory, equipment, skills, `map_level` — linked to account

Auto-saves every 60 seconds and on map transitions.

## Known Gotchas

- **Babylon.js tree-shaking:** Side-effect imports are needed. `InputManager.ts` requires `import '@babylonjs/core/Culling/ray'` or scene.pick() breaks silently.
- **ArcRotateCamera keyboard input:** Built-in keyboard handling is removed (`removeByType('ArcRotateCameraKeyboardMoveInput')`) so it doesn't conflict with our WASD handler. Pointer input is set to middle-mouse-button only (`buttons = [1]`).
- **Terrain PNGs are the source of truth:** Both client and server decode the same heightmap/tilemap PNGs. To change terrain, edit `tools/generate-maps.ts` and re-run it.
- **pngjs always uses RGBA internally:** Even with `colorType: 2` (RGB), the data buffer stride is `* 4`, not `* 3`. Alpha channel must be set to 255.
- **Binary protocol XP encoding:** XP values can exceed int16 range. Skills are sent as `[skillIndex, level, currentLevel, xpHigh, xpLow]` where XP is split into two 16-bit values. Reconstructed on client as `(xpHigh << 16) | (xpLow & 0xFFFF)`.
- **Bun serve binaryType:** Bun's WebSocket handler doesn't accept `binaryType` in the config object — messages arrive as `Buffer` and must be converted to `ArrayBuffer` via `.buffer.slice(0)`.
- **Vite build directory:** `bunx vite build` must be run from the `client/` directory, not the project root.
- **InputManager picks chunk meshes:** Ground meshes are named `chunk_X_Z`. `InputManager` filters picks by this prefix.
- **Position naming convention:** `position.x` = world X, `position.y` = world Z (historical naming in the protocol).
- **Entity IDs:** Players and NPCs share auto-incrementing IDs. World objects start at 10000 to avoid collisions.
- **MAP_CHANGE is a string packet:** Opcode 60 uses a special encoding (`decodeStringPacket`) unlike other binary opcodes.
- **Race condition on map load:** Server sends entity data before client finishes loading heightmap PNG. `getHeight()` returns 0 when heights are null. Fix: `repositionWorldObjects()` recalculates all entity Y positions after map load. This applies to initial load and map transitions.
- **GLB __root__ node:** Babylon's GLB loader creates a `__root__` Mesh (0 vertices) with coordinate system transforms (rotation + scale). It's included in `result.meshes`. When cloning via `instantiateHierarchy`, transforms are properly copied.
- **Client pathfinding must check walls:** All `findPath()` calls must pass `isWallBlocked` callback. Without it, client predicts paths through thin walls (server truncates the path but client visually walks through).
- **Editor save format changed:** `EditorApi.saveMap()` now takes a single `LoadedMap` object instead of individual parameters. The `walls.json` format is extended with optional `wallHeights`, `floors`, `stairs`, `roofs` fields.

## What's Implemented

- [x] Chunk-streamed 3D terrain with heightmap elevation, vertex colors, extruded walls
- [x] Multi-map system (overworld 1024x1024, underground 256x256)
- [x] Map transitions with fog changes and full entity cleanup
- [x] 1024x1024 overworld with distinct regions (village, mountains, forest, ruins, swamp, goblin camp, river, coast)
- [x] Structured underground with rooms and corridors
- [x] Click-to-move with A* pathfinding (8-directional, no corner cutting)
- [x] Server-authoritative multiplayer (multiple browser tabs = multiple players)
- [x] Billboard sprite entities with health bars
- [x] NPC AI (wandering, aggressive targeting)
- [x] OSRS-style tick-based combat with proper formulas
- [x] 12-skill XP system with OSRS formulas
- [x] 4 melee stances with XP distribution
- [x] Equipment system (10 slots, proper bonuses)
- [x] Inventory (28 slots, equip/eat/drop context menus)
- [x] Tabbed side panel (Inventory / Skills / Equipment)
- [x] Food healing system
- [x] Loot drops on NPC death
- [x] Ground item pickup
- [x] NPC respawning
- [x] World objects (trees, rocks, fishing spots, crafting stations)
- [x] Gathering skills (forestry, fishing, mining) with depletion + respawn
- [x] Crafting skills (smithing via furnace, cooking via range)
- [x] 30 items (equipment, food, skilling resources, processed bars)
- [x] SQLite persistence (position, inventory, skills, map level)
- [x] Chat system (local broadcast, private messages, /commands)
- [x] Enter-to-chat, Escape to unfocus
- [x] WASD/arrow camera rotation
- [x] Minimap with entity dots
- [x] HP bar with color transitions
- [x] XP drop notifications and level-up messages
- [x] Linear fog per map (sky blue overworld, dark purple underground)
- [x] Login/signup screen with token-based sessions (localStorage persistence)
- [x] Map generation tool (`bun tools/generate-maps.ts`)
- [x] Edge-based thin walls with collision (N/E/S/W bitmask per tile)
- [x] Variable wall heights (per-tile override, default 1.8)
- [x] Elevated floor tiles (platforms at arbitrary Y)
- [x] Stairs (4-step ramps with direction and height interpolation)
- [x] Roofs (flat and peaked NS/EW styles)
- [x] 3D tree models (pinetree.glb, auto-replaces sprites for tree category)
- [x] Terrain-aligned destination marker
- [x] Map editor with visual tools for tiles, heights, walls, floors, stairs, roofs, NPCs, objects
- [x] Map editor: undo/redo, copy/paste regions, flood fill, line/rect tools
- [x] Map editor: export/import, create new maps, live reload

## Not Yet Implemented

- [ ] Sprite art (currently colored rectangles with text)
- [ ] Sound effects / music
- [ ] NPC dialogue system
- [ ] Shop buy/sell UI (shopkeeper NPC exists but no trade interface)
- [ ] Death penalty (currently respawns at full HP, no item loss)
- [ ] Ranged/magic combat (formulas exist in shared/skills.ts but not wired up)
- [ ] Crafting skill (crafting recipes, not yet defined)
- [ ] 3D object models (pinetree.glb works, need more models)
- [ ] Multi-floor system Phase 4 (separate tile/wall layers per floor, camera culling, editor floor selector)
