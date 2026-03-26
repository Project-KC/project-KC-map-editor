import type { Player } from '../entity/Player';
import type { Npc } from '../entity/Npc';
import {
  addXp, STANCE_BONUSES, STANCE_XP, ACC_BASE,
  osrsMeleeMaxHit, calculateHitChance,
  type CombatBonuses, type ItemDef,
} from '@projectrs/shared';

export interface CombatHit {
  attackerId: number;
  targetId: number;
  damage: number;
  targetHealth: number;
  targetMaxHealth: number;
}

export interface XpDrop {
  skill: string;
  amount: number;
}

/**
 * OSRS-style melee combat: player attacks NPC.
 * Returns hit info + XP drops for the player.
 */
export function processPlayerCombat(
  player: Player,
  npc: Npc,
  itemDefs: Map<number, ItemDef>
): { hit: CombatHit; xpDrops: XpDrop[]; levelUps: { skill: string; level: number }[] } | null {
  if (npc.dead || !player.alive) return null;

  // Check distance — must be adjacent (within 1.5 tiles)
  const dx = Math.abs(player.position.x - npc.position.x);
  const dz = Math.abs(player.position.y - npc.position.y);
  if (dx > 1.5 || dz > 1.5) return null;

  // Check cooldown
  player.attackCooldown--;
  if (player.attackCooldown > 0) return null;
  player.attackCooldown = player.getAttackSpeed(itemDefs);

  // Compute equipment bonuses
  const bonuses = player.computeBonuses(itemDefs);
  const stance = STANCE_BONUSES[player.stance];

  // Effective levels
  const effAcc = player.skills.accuracy.currentLevel + stance.accuracy + 8;
  const effStr = player.skills.power.currentLevel + stance.power + 8;

  // Weapon style determines which attack bonus to use
  const weaponStyle = player.getWeaponStyle(itemDefs);
  let attackBonus = 0;
  if (weaponStyle === 'stab') attackBonus = bonuses.stabAttack;
  else if (weaponStyle === 'slash') attackBonus = bonuses.slashAttack;
  else attackBonus = bonuses.crushAttack;

  // Attack roll
  const attackRoll = effAcc * (attackBonus + ACC_BASE);

  // NPC defence roll (NPCs use flat defence stat)
  const npcDefLevel = npc.def.defence + 8;
  const npcDefRoll = npcDefLevel * ACC_BASE; // NPCs have no equipment

  // Hit chance
  const hitChance = calculateHitChance(attackRoll, npcDefRoll);

  // Max hit
  const maxHit = osrsMeleeMaxHit(effStr, bonuses.meleeStrength);

  let damage = 0;
  if (Math.random() < hitChance) {
    damage = 1 + Math.floor(Math.random() * maxHit);
  }

  const actual = npc.takeDamage(damage);

  // NPC retaliates
  if (npc.alive) {
    npc.combatTarget = player;
  }

  // Award XP based on stance (4 XP per damage dealt)
  const xpDrops: XpDrop[] = [];
  const levelUps: { skill: string; level: number }[] = [];

  if (actual > 0) {
    const stanceXp = STANCE_XP[player.stance];
    if (stanceXp.accuracy > 0) {
      const amt = actual * stanceXp.accuracy;
      const r = addXp(player.skills, 'accuracy', amt);
      xpDrops.push({ skill: 'accuracy', amount: Math.floor(amt) });
      if (r.leveled) levelUps.push({ skill: 'accuracy', level: r.newLevel });
    }
    if (stanceXp.power > 0) {
      const amt = actual * stanceXp.power;
      const r = addXp(player.skills, 'power', amt);
      xpDrops.push({ skill: 'power', amount: Math.floor(amt) });
      if (r.leveled) levelUps.push({ skill: 'power', level: r.newLevel });
    }
    if (stanceXp.defence > 0) {
      const amt = actual * stanceXp.defence;
      const r = addXp(player.skills, 'defence', amt);
      xpDrops.push({ skill: 'defence', amount: Math.floor(amt) });
      if (r.leveled) levelUps.push({ skill: 'defence', level: r.newLevel });
    }
    // HP XP is auto-awarded by addXp for combat skills
    // but let's check if HP leveled
    const oldHpLevel = player.skills.hitpoints.level;
    // HP XP already added by addXp's auto mechanism, just check level
    if (player.skills.hitpoints.level > oldHpLevel) {
      levelUps.push({ skill: 'hitpoints', level: player.skills.hitpoints.level });
    }

    // Sync health from skills (HP level may have changed)
    player.syncHealthFromSkills();
  }

  return {
    hit: {
      attackerId: player.id,
      targetId: npc.id,
      damage: actual,
      targetHealth: npc.health,
      targetMaxHealth: npc.maxHealth,
    },
    xpDrops,
    levelUps,
  };
}

/**
 * NPC attacks player — simpler: NPC uses flat stats.
 */
export function processNpcCombat(
  npc: Npc,
  target: Player,
  itemDefs: Map<number, ItemDef>
): CombatHit | null {
  if (npc.dead || !target.alive) {
    npc.combatTarget = null;
    return null;
  }

  // Check distance — must be adjacent to attack (chasing handled by AI)
  const dx = Math.abs(npc.position.x - target.position.x);
  const dz = Math.abs(npc.position.y - target.position.y);
  if (dx > 1.5 || dz > 1.5) {
    return null; // Not in range yet, NPC AI will chase
  }

  // Check cooldown
  npc.attackCooldown--;
  if (npc.attackCooldown > 0) return null;
  npc.attackCooldown = npc.def.attackSpeed;

  // NPC attack roll
  const npcEffAcc = npc.def.attack + 8;
  const npcAttackRoll = npcEffAcc * ACC_BASE;

  // Player defence roll
  const bonuses = target.computeBonuses(itemDefs);
  const stance = STANCE_BONUSES[target.stance];
  const effDef = target.skills.defence.currentLevel + stance.defence + 8;

  // Use average of stab/slash/crush defence (NPC attack style unspecified)
  const avgDef = Math.floor((bonuses.stabDefence + bonuses.slashDefence + bonuses.crushDefence) / 3);
  const playerDefRoll = effDef * (avgDef + ACC_BASE);

  const hitChance = calculateHitChance(npcAttackRoll, playerDefRoll);

  // NPC max hit
  const npcMaxHit = osrsMeleeMaxHit(npc.def.strength + 8, 0); // no equipment bonus

  let damage = 0;
  if (Math.random() < hitChance) {
    damage = 1 + Math.floor(Math.random() * npcMaxHit);
  }

  const actual = target.takeDamage(damage);
  // Sync current HP into skills
  target.skills.hitpoints.currentLevel = target.health;

  return {
    attackerId: npc.id,
    targetId: target.id,
    damage: actual,
    targetHealth: target.health,
    targetMaxHealth: target.maxHealth,
  };
}

/**
 * Roll loot from NPC's loot table.
 */
export function rollLoot(npc: Npc): { itemId: number; quantity: number }[] {
  const drops: { itemId: number; quantity: number }[] = [];
  for (const drop of npc.def.lootTable) {
    if (Math.random() <= drop.chance) {
      drops.push({ itemId: drop.itemId, quantity: drop.quantity });
    }
  }
  return drops;
}
