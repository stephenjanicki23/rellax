import { useMemo } from 'react';
import { useGame } from '../store';
import { Card, PlayerLink, Pos } from '../components/common';
import { FIT_AREAS, SYSTEM_DEMANDS, allOptionFits, fitLabel, fitNorm, fullFamiliarity, playerSystemFit, regulars, type FitArea } from '../../engine/team/fit';
import type { Tactics } from '../../engine/types';
import { PHILOSOPHY_LABEL, coachOverall, tacticsForPhilosophy } from '../../engine/team/coaching';
import { href } from '../router';

type Opt<K extends keyof Tactics> = { id: Tactics[K]; label: string; desc: string };

const OFFENSE: Opt<'offense'>[] = [
  { id: 'balanced', label: 'Balanced', desc: 'Read the play: carry when there is space, dump it in when there is not.' },
  { id: 'rush', label: 'Rush', desc: 'Attack with speed off the transition. More carry-ins and odd-man rushes; more neutral-zone turnovers.' },
  { id: 'cycle', label: 'Cycle', desc: 'Grind the puck down low and wear the defence out. Rewards strength and puck protection.' },
  { id: 'possession', label: 'Possession', desc: 'Patient, pass-heavy offence that builds high-quality chances and takes fewer low-percentage shots.' },
  { id: 'dumpChase', label: 'Dump & Chase', desc: 'Get it deep and win it back on the forecheck. Safer entries; depends on winning battles.' },
];
const DEFENSE: Opt<'defense'>[] = [
  { id: 'balanced', label: 'Balanced', desc: 'Standard structure with moderate pressure.' },
  { id: 'aggressive', label: 'Aggressive forecheck', desc: 'Pressure the breakout to force turnovers in dangerous areas. Risk of odd-man rushes against.' },
  { id: 'trap', label: 'Neutral-zone trap', desc: 'Clog the neutral zone to kill rushes. Slower, lower-event games.' },
  { id: 'passive', label: 'Passive', desc: 'Protect the slot and concede the perimeter. More shots against, but fewer dangerous ones.' },
  { id: 'physical', label: 'Physical', desc: 'Finish every check. Wins battles and tires opponents; more penalties.' },
];
const FORECHECK: Opt<'forecheck'>[] = [
  { id: '1-2-2', label: '1-2-2', desc: 'Safe and balanced. One forward pressures, two support.' },
  { id: '2-1-2', label: '2-1-2', desc: 'Two forwards in hard. More forced turnovers, more risk.' },
  { id: '1-3-1', label: '1-3-1', desc: 'Neutral-zone heavy. Limits clean entries, forces few turnovers.' },
];
const PP: Opt<'pp'>[] = [
  { id: 'umbrella', label: 'Umbrella', desc: 'Point shots and one-timers from the top, quarterbacked from the blue line.' },
  { id: 'overload', label: 'Overload', desc: 'Load one side and move the puck to create high-danger looks.' },
  { id: 'shooting', label: 'Shooting-heavy', desc: 'Get pucks to the net from everywhere. More shots, more rebounds, lower quality.' },
  { id: 'netFront', label: 'Net-front', desc: 'Screens, tips and rebounds. Rewards big bodies in front.' },
];
const PK: Opt<'pk'>[] = [
  { id: 'box', label: 'Box', desc: 'Protect the house; concede point shots.' },
  { id: 'diamond', label: 'Diamond', desc: 'Pressure the top of the zone and block shots.' },
  { id: 'aggressive', label: 'Aggressive', desc: 'Attack puck carriers and clear less. Shorthanded chances, but risky.' },
  { id: 'passive', label: 'Passive', desc: 'Collapse and clear at every opportunity.' },
];
const USAGE: Opt<'lineUsage'>[] = [
  { id: 'balanced', label: 'Balanced', desc: 'Roughly 35/30/21/14% of even-strength ice time for the four lines.' },
  { id: 'topHeavy', label: 'Top-heavy', desc: 'Lean on your best players. More fatigue for the top lines.' },
  { id: 'rollFour', label: 'Roll four lines', desc: 'Spread minutes evenly; fresher legs and more development for depth players.' },
];
const PULL: Opt<'pullGoalie'>[] = [
  { id: 'conservative', label: 'Conservative', desc: 'Pull late.' },
  { id: 'normal', label: 'Normal', desc: 'League-typical timing (~1:30 down one, ~2:00 down two).' },
  { id: 'aggressive', label: 'Aggressive', desc: 'Pull early for the extra attacker.' },
];

const AREA_OF: Partial<Record<keyof Tactics, FitArea>> = { offense: 'offense', defense: 'defense', forecheck: 'forecheck', pp: 'pp', pk: 'pk' };
const AREA_LABEL: Record<FitArea, string> = { offense: 'Offence', defense: 'Defence', forecheck: 'Forecheck', pp: 'Power play', pk: 'Penalty kill' };

function FitBadge({ v }: { v: number }) {
  const l = fitLabel(v);
  return (
    <span className={`pill ${l.cls}`} title={`Team fit ${v >= 0 ? '+' : ''}${v.toFixed(2)} (−1 to +1)`} style={{ whiteSpace: 'nowrap' }}>
      {l.text} {v >= 0 ? '+' : ''}
      {v.toFixed(2)}
    </span>
  );
}

export function TacticsPage() {
  const { league, version } = useGame();
  const team = league.teams[league.userTeamId];
  const hc = team.staff.headCoach !== null ? league.coaches[team.staff.headCoach] : undefined;
  const roster = useMemo(() => Object.values(league.players).filter((p) => p.teamId === team.id && p.status === 'active'), [league, version, team.id]);
  const norm = fitNorm(league);
  const fits = useMemo(() => allOptionFits(norm, roster, team.lines), [norm, roster, team.lines]);
  const fam = team.familiarity ?? fullFamiliarity();
  const coachPref = { ...(hc ? tacticsForPhilosophy(hc.philosophy) : {}), ...(hc?.system ?? {}) } as Partial<Tactics>;
  const regs = regulars(roster);
  const sysFit = regs.map((p) => ({ p, f: playerSystemFit(norm, p, team.tactics).overall })).sort((a, b) => b.f - a.f);
  const group = <K extends keyof Tactics>(title: string, k: K, opts: Opt<K>[]) => {
    const area = AREA_OF[k];
    const best = area ? Object.entries(fits[area]).sort((a, b) => b[1] - a[1])[0]?.[0] : undefined;
    return (
    <Card title={title} right={area ? <span className="muted" style={{ fontSize: 12 }}>Familiarity {Math.round(fam[area] * 100)}%</span> : undefined}>
      <div className="stack" style={{ gap: 6 }}>
        {opts.map((o) => (
          <div key={String(o.id)} className="row" style={{ alignItems: 'flex-start', gap: 8, padding: '6px 8px', borderRadius: 6, background: team.tactics[k] === o.id ? 'var(--panel2)' : 'transparent', border: `1px solid ${team.tactics[k] === o.id ? 'var(--accent)' : 'transparent'}`, opacity: team.tactics[k] === o.id ? 1 : 0.6 }}>
            <span aria-hidden style={{ width: 14, marginTop: 2, color: 'var(--accent)' }}>{team.tactics[k] === o.id ? '●' : '○'}</span>
            <span className="stack" style={{ gap: 2, flex: 1 }}>
              <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                <b>{o.label}</b>
                {area && SYSTEM_DEMANDS[area][String(o.id)] && <FitBadge v={fits[area][String(o.id)] ?? 0} />}
                {area && best === String(o.id) && (fits[area][best] ?? 0) > 0.15 && <span className="pill accent">Best fit</span>}
                {coachPref[k] === o.id && <span className="pill" title="Your head coach's preferred system">Coach's system</span>}
              </span>
              <span className="muted" style={{ fontSize: 12 }}>{o.desc}</span>
              {area && SYSTEM_DEMANDS[area][String(o.id)] && <span className="dim" style={{ fontSize: 11 }}>Needs {SYSTEM_DEMANDS[area][String(o.id)]!.why}</span>}
            </span>
          </div>
        ))}
      </div>
    </Card>
    );
  };
  return (
    <>
      <div className="page-head">
        <h1>Tactics</h1>
        <span className="sub">Your head coach runs the systems. You shape them as GM: build a roster that fits, or hire a coach whose style you want.</span>
      </div>
      {hc && (
        <div className="banner">
          <b>
            Head coach {hc.first} {hc.last}
          </b>
          <span className="muted">
            {PHILOSOPHY_LABEL[hc.philosophy]}{hc.styleNote ? ` — ${hc.styleNote}` : ''} · Overall {coachOverall(hc)} · Tactics {hc.ratings.tactics} (better tacticians get more out of any system and install it faster)
          </span>
          <a href={href(`team/${team.id}?tab=staff`)} style={{ marginLeft: 'auto' }}>
            Change coach →
          </a>
        </div>
      )}
      <div className="grid g-main" style={{ marginBottom: 14 }}>
        <Card title="System familiarity" right={<span className="muted" style={{ fontSize: 12 }}>Grows each game · halves when the coach switches a system · resets with a new coach</span>}>
          <div className="stack" style={{ gap: 6 }}>
            {FIT_AREAS.map((a) => (
              <div key={a} className="row" style={{ gap: 8 }}>
                <span style={{ width: 92 }}>{AREA_LABEL[a]}</span>
                <div className="bar" style={{ flex: 1, height: 8 }}>
                  <i style={{ width: `${Math.round(fam[a] * 100)}%`, background: fam[a] > 0.8 ? 'var(--good)' : fam[a] > 0.5 ? 'var(--warn)' : 'var(--bad)' }} />
                </div>
                <span className="num" style={{ width: 36, textAlign: 'right' }}>{Math.round(fam[a] * 100)}%</span>
                <FitBadge v={fits[a][String(team.tactics[a])] ?? 0} />
              </div>
            ))}
          </div>
        </Card>
        <Card title="Who fits your systems">
          <div className="list" style={{ fontSize: 13 }}>
            {[...sysFit.slice(0, 4), ...sysFit.slice(-3)].map(({ p, f }, i) => (
              <div className="item" key={p.id} style={i === 4 ? { borderTop: '1px solid var(--line)', paddingTop: 6 } : undefined}>
                <Pos pos={p.pos} /> <PlayerLink p={p} />
                <span className={`pill ${fitLabel(f).cls}`} style={{ marginLeft: 'auto' }}>{fitLabel(f).text}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>
      <div className="grid g3">
        {group('Offensive style', 'offense', OFFENSE)}
        {group('Defensive style', 'defense', DEFENSE)}
        {group('Forecheck', 'forecheck', FORECHECK)}
        {group('Power play', 'pp', PP)}
        {group('Penalty kill', 'pk', PK)}
        <div className="grid">
          {group('Line usage', 'lineUsage', USAGE)}
          {group('Pulling the goalie', 'pullGoalie', PULL)}
        </div>
      </div>
    </>
  );
}
