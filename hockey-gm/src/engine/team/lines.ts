import type { Lines, Player } from '../types';
import { isForward } from '../player/ability';

/** Offensive value used for line building and PP selection. */
export function offenseScore(p: Player): number {
  const a = p.attrs;
  return (
    0.22 * a.offAwareness + 0.16 * a.wristAccuracy + 0.1 * a.wristPower + 0.14 * a.passing + 0.12 * a.stickhandling +
    0.08 * a.creativity + 0.08 * a.hockeySense + 0.05 * a.oneTimer + 0.05 * a.speed
  );
}

/** Defensive value used for PK selection and matchup lines. */
export function defenseScore(p: Player): number {
  const a = p.attrs;
  return (
    0.22 * a.defAwareness + 0.2 * a.defPositioning + 0.16 * a.stickChecking + 0.14 * a.shotBlocking + 0.1 * a.positioning +
    0.1 * a.anticipation + 0.08 * a.backchecking
  );
}

export function emptyLines(): Lines {
  return { fwd: [[], [], [], []], def: [[], [], []], goalies: [], pp: [[], []], pk: [[], []] };
}

const healthy = (p: Player) => !p.injury || p.injury.daysRemaining <= 0;

/**
 * Build a sensible default lineup from a roster: best players on top lines,
 * natural centers down the middle, handedness-balanced pairings, offensive
 * specialists on the PP and defensive specialists on the PK.
 */
export function autoLines(roster: Player[]): Lines {
  const avail = roster.filter((p) => healthy(p) && p.status === 'active');
  const fwds = avail.filter((p) => isForward(p.pos)).sort((a, b) => b.ca - a.ca);
  const dmen = avail.filter((p) => p.pos === 'D').sort((a, b) => b.ca - a.ca);
  const goalies = avail.filter((p) => p.pos === 'G').sort((a, b) => b.ca - a.ca);

  // If short of D, use forwards (and vice versa) as emergency fill.
  while (dmen.length < 6 && fwds.length > 12) dmen.push(fwds.pop()!);
  const dressedF = fwds.slice(0, 12);
  const dressedD = dmen.slice(0, 6);

  // Centers: best four natural centers, else best faceoff forwards.
  const centers = dressedF.filter((p) => p.pos === 'C').slice(0, 4);
  if (centers.length < 4) {
    const extra = dressedF.filter((p) => !centers.includes(p)).sort((a, b) => b.attrs.faceoffs - a.attrs.faceoffs);
    while (centers.length < 4 && extra.length) centers.push(extra.shift()!);
  }
  centers.sort((a, b) => b.ca - a.ca);
  const wingers = dressedF.filter((p) => !centers.includes(p)).sort((a, b) => b.ca - a.ca);
  const fwd: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const pair = wingers.slice(i * 2, i * 2 + 2);
    // Put the natural left winger (or left shot) on the left.
    pair.sort((a, b) => sideScore(a) - sideScore(b));
    const lw = pair[0];
    const rw = pair[1];
    fwd.push([lw?.id, centers[i]?.id, rw?.id].filter((x): x is number => x !== undefined));
  }

  const def: number[][] = [];
  const pool = [...dressedD];
  for (let i = 0; i < 3 && pool.length; i++) {
    const first = pool.shift()!;
    // Prefer the best partner of opposite handedness among the next two.
    const candidates = pool.slice(0, 2);
    const partner = candidates.find((p) => p.shoots !== first.shoots) ?? candidates[0];
    if (partner) pool.splice(pool.indexOf(partner), 1);
    const pairing = [first, partner].filter(Boolean) as Player[];
    pairing.sort((a, b) => (a.shoots === 'L' ? -1 : 1) - (b.shoots === 'L' ? -1 : 1));
    def.push(pairing.map((p) => p.id));
  }

  const ppF = [...dressedF].sort((a, b) => offenseScore(b) - offenseScore(a));
  const ppD = [...dressedD].sort((a, b) => offenseScore(b) - offenseScore(a));
  // PP1: 4F + 1D, PP2: 3F + 2D.
  const pp1 = [...ppF.slice(0, 3), ppF[3], ppD[0]].filter(Boolean).map((p) => p!.id);
  const pp2 = [...ppF.slice(4, 7), ppD[1], ppD[2]].filter(Boolean).map((p) => p!.id);
  const pkF = [...dressedF].sort((a, b) => defenseScore(b) + b.ca * 0.3 - (defenseScore(a) + a.ca * 0.3));
  const pkD = [...dressedD].sort((a, b) => defenseScore(b) + b.ca * 0.3 - (defenseScore(a) + a.ca * 0.3));
  const pk1 = [pkF[0], pkF[1], pkD[0], pkD[1]].filter(Boolean).map((p) => p!.id);
  const pk2 = [pkF[2], pkF[3], pkD[2], pkD[3]].filter(Boolean).map((p) => p!.id);

  return {
    fwd,
    def,
    goalies: goalies.slice(0, 2).map((g) => g.id),
    pp: [pp1, pp2],
    pk: [pk1, pk2],
  };
}

function sideScore(p: Player): number {
  if (p.pos === 'LW') return 0;
  if (p.pos === 'RW') return 2;
  return p.shoots === 'L' ? 0.5 : 1.5;
}

/** All player ids referenced by the lines (the dressed lineup). */
export function dressedIds(lines: Lines): number[] {
  const s = new Set<number>();
  for (const l of lines.fwd) l.forEach((id) => s.add(id));
  for (const l of lines.def) l.forEach((id) => s.add(id));
  lines.goalies.forEach((id) => s.add(id));
  return [...s];
}

/**
 * Make sure a lineup only references healthy, rostered players. Missing slots
 * are filled with the best available scratch of the right position group.
 * Returns true if anything changed.
 */
export function repairLines(lines: Lines, roster: Player[]): boolean {
  const byId = new Map(roster.map((p) => [p.id, p]));
  const ok = (id: number) => {
    const p = byId.get(id);
    return !!p && healthy(p) && p.status === 'active';
  };
  let changed = false;
  const used = new Set<number>();
  const scratches = () =>
    roster
      .filter((p) => healthy(p) && p.status === 'active' && !used.has(p.id))
      .sort((a, b) => b.ca - a.ca);
  const fill = (ids: number[], size: number, group: 'F' | 'D' | 'G') => {
    for (let i = 0; i < size; i++) {
      const id = ids[i];
      if (id !== undefined && ok(id) && !used.has(id)) {
        used.add(id);
        continue;
      }
      const match = (p: Player) => (group === 'G' ? p.pos === 'G' : group === 'D' ? p.pos === 'D' : isForward(p.pos));
      const sub = scratches().find(match) ?? (group !== 'G' ? scratches().find((p) => p.pos !== 'G') : undefined);
      if (sub) {
        ids[i] = sub.id;
        used.add(sub.id);
        changed = true;
      } else if (id !== undefined) {
        ids.splice(i, 1);
        i--;
        size--;
        changed = true;
      }
    }
  };
  for (const l of lines.fwd) fill(l, 3, 'F');
  for (const l of lines.def) fill(l, 2, 'D');
  fill(lines.goalies, Math.min(2, roster.filter((p) => p.pos === 'G' && ok(p.id)).length), 'G');
  // Special teams may reuse dressed players; just drop invalid ids and refill from dressed.
  const dressed = new Set(dressedIds(lines));
  const dressedPlayers = roster.filter((p) => dressed.has(p.id) && p.pos !== 'G');
  const fixUnit = (unit: number[], size: number, scoreFn: (p: Player) => number) => {
    const valid = unit.filter((id) => dressed.has(id) && ok(id));
    if (valid.length !== unit.length || unit.length < size) changed = true;
    const extra = dressedPlayers.filter((p) => !valid.includes(p.id)).sort((a, b) => scoreFn(b) - scoreFn(a));
    while (valid.length < size && extra.length) valid.push(extra.shift()!.id);
    unit.splice(0, unit.length, ...valid);
  };
  lines.pp.forEach((u) => fixUnit(u, 5, offenseScore));
  lines.pk.forEach((u) => fixUnit(u, 4, defenseScore));
  return changed;
}
