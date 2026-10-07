/**
 * Shot-location zones for shot charts: bands of distance from the net and
 * angle from the centre line. The engine knows a shot's distance and angle
 * but not which side of the ice it came from, so a zone covers both sides.
 */
export const DIST_BANDS = [10, 20, 30, 45, 60, 200] as const;
export const ANGLE_BANDS = [20, 40, 90] as const;
export const ZONE_COUNT = DIST_BANDS.length * ANGLE_BANDS.length;

export function shotZone(dist: number, angle: number): number {
  const d = DIST_BANDS.findIndex((b) => dist < b);
  const a = ANGLE_BANDS.findIndex((b) => Math.abs(angle) < b);
  return (d < 0 ? DIST_BANDS.length - 1 : d) * ANGLE_BANDS.length + (a < 0 ? ANGLE_BANDS.length - 1 : a);
}

/** [inner distance, outer distance, inner angle, outer angle] of a zone (feet, degrees). */
export function zoneBounds(z: number): [number, number, number, number] {
  const d = Math.floor(z / ANGLE_BANDS.length);
  const a = z % ANGLE_BANDS.length;
  return [d ? DIST_BANDS[d - 1] : 0, Math.min(DIST_BANDS[d], 75), a ? ANGLE_BANDS[a - 1] : 0, ANGLE_BANDS[a]];
}

export const ZONE_NAMES = (z: number): string => {
  const [d0, d1, a0, a1] = zoneBounds(z);
  const where = a1 <= 20 ? 'straight on' : a1 <= 40 ? 'off-centre' : 'sharp angle';
  return `${d0}–${d1 >= 75 ? '60+' : d1} ft, ${where} (${a0}–${a1}°)`;
};

/** Per-player shot chart for a season: on-goal shots and goals per zone. */
export interface ShotChart {
  sog: number[];
  goals: number[];
}

export const emptyChart = (): ShotChart => ({ sog: new Array(ZONE_COUNT).fill(0), goals: new Array(ZONE_COUNT).fill(0) });
