// Skills system ported from TextQuest — OSRS-style XP formulas

export type SkillId =
  | 'accuracy' | 'power' | 'defence' | 'magic' | 'archery' | 'hitpoints'
  | 'forestry' | 'fishing' | 'cooking' | 'mining' | 'smithing' | 'crafting';

export const ALL_SKILLS: SkillId[] = [
  'accuracy', 'power', 'defence', 'magic', 'archery', 'hitpoints',
  'forestry', 'fishing', 'cooking', 'mining', 'smithing', 'crafting',
];

export const COMBAT_SKILLS: SkillId[] = ['accuracy', 'power', 'defence', 'magic', 'archery'];

export const SKILL_NAMES: Record<SkillId, string> = {
  accuracy: 'Accuracy',
  power: 'Power',
  defence: 'Defence',
  magic: 'Magic',
  archery: 'Archery',
  hitpoints: 'Hitpoints',
  forestry: 'Forestry',
  fishing: 'Fishing',
  cooking: 'Cooking',
  mining: 'Mining',
  smithing: 'Smithing',
  crafting: 'Crafting',
};

export const SKILL_COLORS: Record<SkillId, string> = {
  accuracy: '#c44',
  power: '#e80',
  defence: '#48c',
  magic: '#a4e',
  archery: '#4a4',
  hitpoints: '#e44',
  forestry: '#2a6',
  fishing: '#4ae',
  cooking: '#c84',
  mining: '#888',
  smithing: '#aaa',
  crafting: '#ca4',
};

export interface SkillState {
  xp: number;
  level: number;
  currentLevel: number;
}

export type SkillBlock = Record<SkillId, SkillState>;

// OSRS-style XP formula
export function xpForLevel(L: number): number {
  if (L <= 1) return 0;
  if (L > 99) L = 99;
  let points = 0;
  for (let lvl = 1; lvl < L; lvl++) {
    points += Math.floor(lvl + 300.0 * Math.pow(2.0, lvl / 7.0));
  }
  return Math.floor(points / 4);
}

export function levelFromXp(xp: number, maxLevel = 99): number {
  let lo = 1, hi = maxLevel + 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xpForLevel(mid) <= xp) lo = mid + 1;
    else hi = mid;
  }
  return Math.min(maxLevel, lo - 1);
}

export function initSkills(): SkillBlock {
  const s: Partial<SkillBlock> = {};
  for (const id of ALL_SKILLS) {
    if (id === 'hitpoints') {
      const hpXp = xpForLevel(10);
      s[id] = { xp: hpXp, level: 10, currentLevel: 10 };
    } else {
      s[id] = { xp: 0, level: 1, currentLevel: 1 };
    }
  }
  return s as SkillBlock;
}

export function addXp(skills: SkillBlock, id: SkillId, amount: number): { leveled: boolean; newLevel: number } {
  const cur = skills[id];
  const oldLevel = cur.level;
  cur.xp = Math.max(0, cur.xp + Math.floor(amount));
  const newLevel = levelFromXp(cur.xp);
  const leveled = newLevel > oldLevel;
  cur.level = newLevel;
  if (leveled) cur.currentLevel = newLevel;

  // Combat skills auto-award 1/3 XP to hitpoints
  if (COMBAT_SKILLS.includes(id) && amount > 0) {
    const hpXp = Math.floor(amount / 3);
    if (hpXp > 0) addXp(skills, 'hitpoints', hpXp);
  }

  return { leveled, newLevel };
}

// Combat level formula from TextQuest
export function combatLevel(skills: SkillBlock): number {
  const base = 0.25 * (skills.defence.level + skills.hitpoints.level);
  const melee = 0.325 * (skills.accuracy.level + skills.power.level);
  const range = 0.325 * (Math.floor(skills.archery.level / 2) + skills.archery.level);
  const mage = 0.325 * (Math.floor(skills.magic.level / 2) + skills.magic.level);
  return Math.floor(base + Math.max(melee, range, mage));
}

// Melee stance types
export type MeleeStance = 'accurate' | 'aggressive' | 'defensive' | 'controlled';

export const STANCE_BONUSES: Record<MeleeStance, { accuracy: number; power: number; defence: number }> = {
  accurate:   { accuracy: 3, power: 0, defence: 0 },
  aggressive: { accuracy: 0, power: 3, defence: 0 },
  defensive:  { accuracy: 0, power: 0, defence: 3 },
  controlled: { accuracy: 1, power: 1, defence: 1 },
};

// XP distribution per stance: 4 XP per damage dealt
export const STANCE_XP: Record<MeleeStance, { accuracy: number; power: number; defence: number }> = {
  accurate:   { accuracy: 4, power: 0, defence: 0 },
  aggressive: { accuracy: 0, power: 4, defence: 0 },
  defensive:  { accuracy: 0, power: 0, defence: 4 },
  controlled: { accuracy: 1.33, power: 1.33, defence: 1.33 },
};

// OSRS combat formulas
export const ACC_BASE = 64;

export function osrsMeleeMaxHit(effStr: number, bStr: number, dmgMult: number = 1.0): number {
  const base = Math.floor(1.3 + (effStr / 10) + (bStr / 80) + (effStr * bStr) / 640);
  return Math.max(1, Math.floor(base * dmgMult));
}

export function calculateHitChance(attackRoll: number, defenceRoll: number): number {
  if (attackRoll > defenceRoll) {
    return 1 - ((defenceRoll + 2) / (2 * (attackRoll + 1)));
  } else {
    return attackRoll / (2 * (defenceRoll + 1));
  }
}

// Equipment bonus types
export interface CombatBonuses {
  stabAttack: number;
  slashAttack: number;
  crushAttack: number;
  stabDefence: number;
  slashDefence: number;
  crushDefence: number;
  meleeStrength: number;
  rangedAccuracy: number;
  rangedStrength: number;
  rangedDefence: number;
  magicAccuracy: number;
  magicDefence: number;
}

export function zeroBonuses(): CombatBonuses {
  return {
    stabAttack: 0, slashAttack: 0, crushAttack: 0,
    stabDefence: 0, slashDefence: 0, crushDefence: 0,
    meleeStrength: 0,
    rangedAccuracy: 0, rangedStrength: 0, rangedDefence: 0,
    magicAccuracy: 0, magicDefence: 0,
  };
}
