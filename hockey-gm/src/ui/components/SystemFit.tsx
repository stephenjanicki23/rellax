import type { League, Player } from '../../engine/types';
import { SYSTEM_DEMANDS, fitLabel, fitNorm, fitScore, playerFit, type FitArea } from '../../engine/team/fit';

const NAMES: Record<string, string> = {
  balanced: 'Balanced', '1-2-2': '1-2-2 forecheck',
  rush: 'Rush', cycle: 'Cycle', possession: 'Possession', dumpChase: 'Dump & chase', aggressive: 'Aggressive', trap: 'Trap', passive: 'Passive',
  physical: 'Physical', '2-1-2': '2-1-2 forecheck', '1-3-1': '1-3-1', umbrella: 'Umbrella PP', overload: 'Overload PP', shooting: 'Shooting PP',
  netFront: 'Net-front PP', box: 'Box PK', diamond: 'Diamond PK',
};
const AREAS: { area: FitArea; label: string }[] = [
  { area: 'offense', label: 'Offence' },
  { area: 'defense', label: 'Defence' },
  { area: 'forecheck', label: 'Forecheck' },
  { area: 'pp', label: 'Power play' },
  { area: 'pk', label: 'Penalty kill' },
];

/** How a skater suits his team's systems and which styles suit him best. */
export function SystemFit({ league, p }: { league: League; p: Player }) {
  if (p.pos === 'G') return <div className="muted">Systems apply to skaters.</div>;
  const norm = fitNorm(league);
  const team = p.teamId !== null ? league.teams[p.teamId] : null;
  const best = (area: FitArea) =>
    Object.keys(SYSTEM_DEMANDS[area])
      .map((o) => ({ o, z: playerFit(p, area, o, norm) }))
      .sort((a, b) => b.z - a.z);
  return (
    <div className="stack" style={{ gap: 8 }}>
      {team && (
        <div className="kv">
          {AREAS.map(({ area, label }) => {
            const opt = String(team.tactics[area]);
            const has = !!SYSTEM_DEMANDS[area][opt];
            const z = has ? playerFit(p, area, opt, norm) : 0;
            const l = fitLabel(z);
            return (
              <span key={area} style={{ display: 'contents' }}>
                <span className="k">
                  {label} <span className="dim">({team.abbr}: {NAMES[opt] ?? opt})</span>
                </span>
                <span className={l.cls}>{has ? `${l.text} · ${fitScore(z)}` : 'Neutral (system asks nothing special)'}</span>
              </span>
            );
          })}
        </div>
      )}
      <div className="muted" style={{ fontSize: 12 }}>
        Best suited to:{' '}
        {AREAS.map(({ area }) => {
          const b = best(area)[0];
          return b && b.z > 0.2 ? NAMES[b.o] : null;
        })
          .filter(Boolean)
          .join(' · ') || 'no system in particular (a well-rounded player)'}
      </div>
    </div>
  );
}
