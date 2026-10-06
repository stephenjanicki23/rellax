/**
 * Team systems on the live rink: where players set up given the coach's
 * tactics (read-only for the user), the zone, and the manpower situation.
 *
 * Each system returns an ordered list of spots. Defencemen take spots from
 * the front of the list (points, low coverage), forwards the rest, so a
 * power-play unit with four forwards and one defenceman puts the defenceman
 * at the top and the forwards down low.
 *
 * Coordinates are in "attack space": u is feet from centre ice toward the net
 * this team attacks (the attacking goal line is u = 89, its own is u = -89),
 * y is across the ice. SIMPLIFICATION: the shapes are textbook versions of
 * each system, not play-by-play reads.
 */
import type { Tactics } from '../../engine/types';
import type { Pt } from './director';

const CY = 42.5;

export interface SystemContext {
  /** +1 if this team attacks to the right this period. */
  d: 1 | -1;
  /** Zone of the puck from this team's point of view. */
  zone: 'D' | 'N' | 'O';
  attacking: boolean;
  /** Skaters on the ice for this team and the opponent. */
  us: number;
  them: number;
  /** The puck in attack space. */
  puckU: number;
  puckY: number;
  tactics?: Tactics;
}

/** Ordered spots for this team's skaters, or null to use the default shape. */
export function systemSpots(c: SystemContext): Pt[] | null {
  const s = c.puckY < CY ? -1 : 1;
  const at = (u: number, y: number): Pt => ({ x: 100 + c.d * u, y });
  const t = c.tactics;
  const pp = c.us > c.them && c.them >= 3;
  const pk = c.us < c.them;

  if (c.attacking && c.zone === 'O') {
    if (pp) {
      switch (t?.pp ?? 'umbrella') {
        case 'overload':
          return [at(32, CY + s * 16), at(40, CY - s * 22), at(56, CY + s * 31), at(83, CY + s * 24), at(81, CY - s * 2)];
        case 'shooting':
          return [at(32, CY - 18), at(32, CY + 18), at(58, CY + s * 29), at(67, CY - s * 23), at(81, CY + s * 2)];
        case 'netFront':
          return [at(32, CY), at(56, CY + s * 27), at(56, CY - s * 27), at(81, CY - 4), at(81, CY + 4)];
        default:
          // Umbrella (1-3-1): quarterback up top, two flanks on the half-walls, bumper in the slot, net front.
          return [at(32, CY), at(57, CY + s * 27), at(57, CY - s * 27), at(66, CY), at(81, CY + s * 3)];
      }
    }
    if (c.us === 3 && c.them === 3) return [at(35, CY - s * 14), at(62, CY + s * 24), at(70, CY - s * 20)];
    switch (t?.offense) {
      case 'cycle':
        return [at(32, CY - 19), at(32, CY + 19), at(83, CY + s * 27), at(60, CY + s * 31), at(76, CY - s * 4)];
      case 'dumpChase':
        return [at(32, CY - 19), at(32, CY + 19), at(85, CY + s * 30), at(83, CY - s * 26), at(70, CY)];
      case 'rush':
        return [at(34, CY - 16), at(34, CY + 16), at(58, CY), at(66, CY - s * 24), at(77, CY + s * 3)];
      default:
        return null;
    }
  }

  if (!c.attacking && c.zone === 'D' && pk) {
    // Penalty kill in our own end. A gentle shade toward the puck side.
    const sh = (c.puckY - CY) * 0.22;
    if (c.us <= 3) return [at(-80, CY - 8 + sh), at(-80, CY + 8 + sh), at(-62, CY + sh)];
    switch (t?.pk ?? 'box') {
      case 'diamond':
        return [at(-80, CY + sh), at(-69, CY + s * 16 + sh), at(-69, CY - s * 16 + sh), at(-54, CY + sh)];
      case 'passive':
        return [at(-80, CY - 8 + sh), at(-80, CY + 8 + sh), at(-66, CY - 11 + sh), at(-66, CY + 11 + sh)];
      case 'aggressive': {
        // Box with the puck-side high forward attacking the carrier.
        const press = at(Math.max(-80, c.puckU + 4), c.puckY - s * 2);
        return [at(-78, CY - 9 + sh), at(-78, CY + 9 + sh), press, at(-60, CY - s * 14 + sh)];
      }
      default:
        return [at(-78, CY - 9 + sh), at(-78, CY + 9 + sh), at(-60, CY - 14 + sh), at(-60, CY + 14 + sh)];
    }
  }

  if (!c.attacking && c.zone === 'O' && !pk) {
    // Forechecking in their end (their puck, deep).
    const press = at(Math.min(86, c.puckU - 3), c.puckY + (CY - c.puckY) * 0.2);
    switch (t?.forecheck ?? '1-2-2') {
      case '2-1-2':
        return [at(32, CY - 20), at(32, CY + 20), press, at(78, CY - s * 16), at(56, CY)];
      case '1-3-1':
        // One in deep, three across the top of the zone, one back.
        return [at(4, CY), at(40, CY), press, at(40, CY - 25), at(40, CY + 25)];
      default:
        return [at(32, CY - 18), at(32, CY + 18), press, at(55, CY - s * 16), at(52, CY + s * 18)];
    }
  }

  if (!c.attacking && c.zone === 'N' && !pk) {
    const pu = c.puckU;
    switch (t?.defense) {
      case 'trap':
        // Neutral-zone trap (1-2-2): steer the carrier wide, wall off our blue line.
        return [at(-36, CY - 13), at(-36, CY + 13), at(Math.max(-12, pu - 7), (c.puckY + CY) / 2), at(-21, CY - 23), at(-21, CY + 23)];
      case 'aggressive':
        return [at(pu - 20, CY - 15), at(pu - 20, CY + 15), at(pu - 3, c.puckY), at(pu - 7, c.puckY - s * 14), at(pu - 12, CY - s * 18)];
      case 'passive':
        return [at(-38, CY - 14), at(-38, CY + 14), at(pu - 10, c.puckY), at(-26, CY - 20), at(-26, CY + 20)];
      default:
        return null;
    }
  }
  return null;
}
