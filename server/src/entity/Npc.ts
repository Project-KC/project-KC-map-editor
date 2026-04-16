import { Entity } from './Entity';
import type { NpcDef } from '@projectrs/shared';

export class Npc extends Entity {
  readonly npcId: number; // Definition ID
  readonly def: NpcDef;
  readonly spawnX: number;
  readonly spawnZ: number;

  // AI
  wanderCooldown: number = 0;
  wanderStepsLeft: number = 0;
  wanderDirX: number = 0;
  wanderDirZ: number = 0;
  combatTarget: Entity | null = null;
  attackCooldown: number = 0;
  returning: boolean = false; // Walking back to spawn after leash

  // Death / respawn
  dead: boolean = false;
  respawnTimer: number = 0;

  // Hero points: tracks damage per attacker for kill credit
  private heroPoints: Map<number, number> = new Map();

  // Single-combat timer: tick when last attacked (8-tick lockout)
  lastCombatTick: number = 0;
  lastAttackerId: number = -1;

  // OSRS-style leash: retreat max range (how far NPC can be from spawn in combat)
  static readonly RETREAT_MAX_RANGE = 7;
  // Retreat interaction range: if target is this far from spawn, NPC drops combat
  static readonly RETREAT_INTERACTION_RANGE = 18;

  // 8-directional wander directions (static to avoid per-call allocation)
  private static readonly WANDER_DIRS: [number, number][] = [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]];

  readonly wanderRangeOverride?: number;

  constructor(def: NpcDef, x: number, z: number, wanderRange?: number) {
    super(def.name, x, z, def.health);
    this.npcId = def.id;
    this.def = def;
    this.spawnX = x;
    this.spawnZ = z;
    this.wanderRangeOverride = wanderRange;
  }

  get wanderRange(): number {
    return this.wanderRangeOverride ?? this.def.wanderRange;
  }

  processAI(isBlocked: (x: number, z: number) => boolean, isWallBlocked?: (fx: number, fz: number, tx: number, tz: number) => boolean): void {
    if (this.dead) return;

    // Returning to spawn after losing combat target (walk back)
    if (this.returning) {
      const dx = this.spawnX - this.position.x;
      const dz = this.spawnZ - this.position.y;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < 0.5) {
        this.position.x = this.spawnX;
        this.position.y = this.spawnZ;
        this.returning = false;
        return;
      }
      this.stepToward(this.spawnX, this.spawnZ, isBlocked, isWallBlocked);
      return;
    }

    // In combat with a target
    if (this.combatTarget) {
      // Snap to tile center to prevent drifting between tiles
      this.position.x = Math.floor(this.position.x) + 0.5;
      this.position.y = Math.floor(this.position.y) + 0.5;
      const targetX = this.combatTarget.position.x;
      const targetZ = this.combatTarget.position.y;
      const dx = targetX - this.position.x;
      const dz = targetZ - this.position.y;
      const dist = Math.sqrt(dx * dx + dz * dz);

      // Non-aggressive NPCs: retaliate in place only, don't chase.
      // If target walks out of melee range, drop combat and return to spawn.
      if (!this.def.aggressive) {
        if (dist > 1.5) {
          this.combatTarget = null;
          this.returning = true;
        }
        return;
      }

      // Aggressive NPCs: chase with OSRS-style leash

      // Drop combat if target is too far from NPC spawn
      const dxSpawn = Math.abs(targetX - this.spawnX);
      const dzSpawn = Math.abs(targetZ - this.spawnZ);
      if (dxSpawn > Npc.RETREAT_INTERACTION_RANGE || dzSpawn > Npc.RETREAT_INTERACTION_RANGE) {
        this.combatTarget = null;
        this.returning = true;
        return;
      }

      // NPC won't move further than retreat max range from its spawn
      const npcDxSpawn = Math.abs(this.position.x - this.spawnX);
      const npcDzSpawn = Math.abs(this.position.y - this.spawnZ);
      if (npcDxSpawn > Npc.RETREAT_MAX_RANGE || npcDzSpawn > Npc.RETREAT_MAX_RANGE) {
        this.combatTarget = null;
        this.returning = true;
        return;
      }

      // Chase toward target if not in melee range (but don't step onto target's tile)
      if (dist > 1.5) {
        const sx = dx !== 0 ? Math.sign(dx) : 0;
        const sz = dz !== 0 ? Math.sign(dz) : 0;
        const nx = this.position.x + sx;
        const nz = this.position.y + sz;
        if (Math.abs(nx - this.spawnX) <= Npc.RETREAT_MAX_RANGE &&
            Math.abs(nz - this.spawnZ) <= Npc.RETREAT_MAX_RANGE) {
          const targetTileX = Math.floor(targetX);
          const targetTileZ = Math.floor(targetZ);
          this.stepTowardAvoidTile(targetX, targetZ, targetTileX, targetTileZ, isBlocked, isWallBlocked);
        } else {
          this.combatTarget = null;
          this.returning = true;
        }
      }
      return;
    }

    // Wander behavior (only when not in combat)
    if (this.wanderRange > 0) {
      // Currently walking in a direction — take another step
      if (this.wanderStepsLeft > 0) {
        const nx = this.position.x + this.wanderDirX;
        const nz = this.position.y + this.wanderDirZ;
        const dxSpawn = nx - this.spawnX;
        const dzSpawn = nz - this.spawnZ;
        const wallBlock = isWallBlocked ? isWallBlocked(this.position.x, this.position.y, nx, nz) : false;
        if (
          Math.abs(dxSpawn) <= this.wanderRange &&
          Math.abs(dzSpawn) <= this.wanderRange &&
          !isBlocked(nx, nz) && !wallBlock
        ) {
          this.position.x = nx;
          this.position.y = nz;
          this.wanderStepsLeft--;
        } else {
          // Blocked — stop walking, pause before next wander
          this.wanderStepsLeft = 0;
          this.wanderCooldown = 3 + Math.floor(Math.random() * 5);
        }
        return;
      }

      // Pausing — count down until next wander
      this.wanderCooldown--;
      if (this.wanderCooldown <= 0) {
        // Pick a random direction (8 directions including diagonals)
        const r = Math.floor(Math.random() * 8);
        const dirs = Npc.WANDER_DIRS;
        this.wanderDirX = dirs[r][0];
        this.wanderDirZ = dirs[r][1];
        // Walk 1-4 steps in this direction
        this.wanderStepsLeft = 1 + Math.floor(Math.random() * 4);
        // Pause 5-20 ticks after finishing this walk
        this.wanderCooldown = 5 + Math.floor(Math.random() * 15);
      }
    }
  }

  /** Step one tile toward (tx, tz) but avoid landing on (avoidTileX, avoidTileZ) */
  private stepTowardAvoidTile(
    tx: number, tz: number,
    avoidTileX: number, avoidTileZ: number,
    isBlocked: (x: number, z: number) => boolean,
    isWallBlocked?: (fx: number, fz: number, tx: number, tz: number) => boolean
  ): void {
    const dx = tx - this.position.x;
    const dz = tz - this.position.y;
    const sx = dx !== 0 ? Math.sign(dx) : 0;
    const sz = dz !== 0 ? Math.sign(dz) : 0;
    const px = this.position.x, py = this.position.y;

    // Try diagonal
    if (sx !== 0 && sz !== 0) {
      const nx = px + sx, nz = py + sz;
      if (!isBlocked(nx, nz) && (Math.floor(nx) !== avoidTileX || Math.floor(nz) !== avoidTileZ) &&
          (!isWallBlocked || !isWallBlocked(px, py, nx, nz))) {
        this.position.x = nx; this.position.y = nz; return;
      }
    }
    // Try X
    if (sx !== 0) {
      const nx = px + sx;
      if (!isBlocked(nx, py) && (Math.floor(nx) !== avoidTileX || Math.floor(py) !== avoidTileZ) &&
          (!isWallBlocked || !isWallBlocked(px, py, nx, py))) {
        this.position.x = nx; return;
      }
    }
    // Try Z
    if (sz !== 0) {
      const nz = py + sz;
      if (!isBlocked(px, nz) && (Math.floor(px) !== avoidTileX || Math.floor(nz) !== avoidTileZ) &&
          (!isWallBlocked || !isWallBlocked(px, py, px, nz))) {
        this.position.y = nz;
      }
    }
  }

  /** Step one tile toward (tx, tz), trying diagonal first then cardinal */
  private stepToward(tx: number, tz: number, isBlocked: (x: number, z: number) => boolean, isWallBlocked?: (fx: number, fz: number, tx: number, tz: number) => boolean): void {
    const dx = tx - this.position.x;
    const dz = tz - this.position.y;
    const sx = dx !== 0 ? Math.sign(dx) : 0;
    const sz = dz !== 0 ? Math.sign(dz) : 0;
    const px = this.position.x, py = this.position.y;

    // Try diagonal
    if (sx !== 0 && sz !== 0 && !isBlocked(px + sx, py + sz) && (!isWallBlocked || !isWallBlocked(px, py, px + sx, py + sz))) {
      this.position.x += sx;
      this.position.y += sz;
    } else if (sx !== 0 && !isBlocked(px + sx, py) && (!isWallBlocked || !isWallBlocked(px, py, px + sx, py))) {
      this.position.x += sx;
    } else if (sz !== 0 && !isBlocked(px, py + sz) && (!isWallBlocked || !isWallBlocked(px, py, px, py + sz))) {
      this.position.y += sz;
    }
  }

  die(): void {
    this.dead = true;
    this.health = 0;
    this.combatTarget = null;
    this.respawnTimer = this.def.respawnTime;
  }

  respawn(): void {
    this.dead = false;
    this.health = this.maxHealth;
    this.position.x = this.spawnX;
    this.position.y = this.spawnZ;
    this.combatTarget = null;
    this.attackCooldown = 0;
    this.wanderCooldown = 0;
    this.wanderStepsLeft = 0;
    this.returning = false;
    this.heroPoints.clear();
    this.lastCombatTick = 0;
    this.lastAttackerId = -1;
  }

  tickRespawn(): boolean {
    if (!this.dead) return false;
    this.respawnTimer--;
    if (this.respawnTimer <= 0) {
      this.respawn();
      return true; // Respawned
    }
    return false;
  }

  /** Track damage dealt by each attacker for kill credit */
  addHeroPoints(attackerId: number, damage: number): void {
    this.heroPoints.set(attackerId, (this.heroPoints.get(attackerId) ?? 0) + damage);
  }

  /** Get the attacker who dealt the most total damage (kill credit) */
  getTopDamager(): number | null {
    let topId: number | null = null;
    let topDmg = 0;
    for (const [id, dmg] of this.heroPoints) {
      if (dmg > topDmg) { topId = id; topDmg = dmg; }
    }
    return topId;
  }
}
