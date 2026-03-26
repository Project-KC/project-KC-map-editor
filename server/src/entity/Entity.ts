import { Position } from '@projectrs/shared';

let nextEntityId = 1;

export abstract class Entity {
  readonly id: number;
  position: Position;
  name: string;
  health: number;
  maxHealth: number;
  currentMapLevel: string = 'overworld';
  currentFloor: number = 0;

  constructor(name: string, x: number, z: number, maxHealth: number) {
    this.id = nextEntityId++;
    this.name = name;
    this.position = { x, y: z }; // y in Position = z in world
    this.health = maxHealth;
    this.maxHealth = maxHealth;
  }

  get alive(): boolean {
    return this.health > 0;
  }

  takeDamage(amount: number): number {
    const actual = Math.min(amount, this.health);
    this.health -= actual;
    return actual;
  }

  heal(amount: number): void {
    this.health = Math.min(this.health + amount, this.maxHealth);
  }
}
