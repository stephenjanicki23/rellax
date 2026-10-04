import type { League, Player } from '../../engine/types';
import { SYSTEM_DEMANDS, fitLabel, fitNorm, fitScore, playerFit, playerSystemFit, type FitArea } from '../../engine/team/fit';

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

/** One-line summary for the top of the player card. */
export function SystemFitStrip({ league, p }: { league: League; p: Player }) {
  if (p.pos === 'G') return null;
  const norm = fitNorm(league);
  const mine = league.teams[league.userTeamId];
  const team = p.teamId !== null ? league.teams[p.teamId] : mine;
  const target = p.teamId === league.userTeamId || p.teamId === null ? mine : team;
  const items = AREAS.filter(({ area }) => SYSTEM_DEMANDS[area][String(target.tactics[area])]).map(({ area, label }) => {
    const z = playerFit(p, area, String(target.tactics[area]), norm);
    return { label, opt: NAMES[String(target.tactics[area])] ?? String(target.tactics[area]), z };
  });
  const forMe = p.teamId !== league.userTeamId ? playerSystemFit(norm, p, mine.tactics).overall : null;
  return (
    <div className="card row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center', padding: '8px 12px', marginBottom: 12 }}>
      <b style={{ marginRight: 4 }}>System fit · {target.abbr}</b>
      {items.map((i) => {
        const l = fitLabel(i.z);
        return (
          <span key={i.label} className={`pill ${l.cls}`} title={`${i.label}: ${i.opt}`}>
            {i.opt} · {l.text} {fitScore(i.z)}
          </span>
        );
      })}
      {!items.length && <span className="muted">{target.abbr} play balanced systems (no special demands).</span>}
      {forMe !== null && p.teamId !== null && (
        <span className={`pill ${fitLabel(forMe).cls}`} style={{ marginLeft: 'auto' }} title="How he would fit your team's systems">
          Fit for {mine.abbr}: {fitLabel(forMe).text} {fitScore(forMe)}
        </span>
      )}
    </div>
  );
}

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
      {p.teamId !== league.userTeamId && (() => {
        const mine = league.teams[league.userTeamId];
        const z = playerSystemFit(norm, p, mine.tactics).overall;
        const l = fitLabel(z);
        return (
          <div className="row" style={{ gap: 8 }}>
            <span>
              Fit to your systems ({mine.abbr}: {NAMES[mine.tactics.offense] ?? mine.tactics.offense} / {NAMES[mine.tactics.defense] ?? mine.tactics.defense}):
            </span>
            <b className={l.cls}>
              {l.text} · {fitScore(z)}
            </b>
          </div>
        );
      })()}
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
