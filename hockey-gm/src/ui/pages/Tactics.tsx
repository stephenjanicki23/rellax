import { useGame, mutate } from '../store';
import { Card } from '../components/common';
import type { Tactics } from '../../engine/types';
import { PHILOSOPHY_LABEL, coachOverall } from '../../engine/team/coaching';
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

export function TacticsPage() {
  const { league } = useGame();
  const team = league.teams[league.userTeamId];
  const hc = team.staff.headCoach !== null ? league.coaches[team.staff.headCoach] : undefined;
  const set = <K extends keyof Tactics>(k: K, v: Tactics[K]) => mutate((l) => (l.teams[l.userTeamId].tactics = { ...l.teams[l.userTeamId].tactics, [k]: v }));
  const group = <K extends keyof Tactics>(title: string, k: K, opts: Opt<K>[]) => (
    <Card title={title}>
      <div className="stack" style={{ gap: 6 }}>
        {opts.map((o) => (
          <label key={String(o.id)} className="row" style={{ alignItems: 'flex-start', gap: 8, cursor: 'pointer', padding: '6px 8px', borderRadius: 6, background: team.tactics[k] === o.id ? 'var(--panel2)' : 'transparent', border: `1px solid ${team.tactics[k] === o.id ? 'var(--accent)' : 'transparent'}` }}>
            <input type="radio" checked={team.tactics[k] === o.id} onChange={() => set(k, o.id)} style={{ marginTop: 3 }} />
            <span className="stack" style={{ gap: 1 }}>
              <b>{o.label}</b>
              <span className="muted" style={{ fontSize: 12 }}>{o.desc}</span>
            </span>
          </label>
        ))}
      </div>
    </Card>
  );
  return (
    <>
      <div className="page-head">
        <h1>Tactics</h1>
        <span className="sub">Every setting changes the probabilities inside the game engine — trade-offs, not free boosts.</span>
      </div>
      {hc && (
        <div className="banner">
          <b>
            Head coach {hc.first} {hc.last}
          </b>
          <span className="muted">
            {PHILOSOPHY_LABEL[hc.philosophy]} · Overall {coachOverall(hc)} · Tactical knowledge {hc.ratings.tactics} (better coaches get more out of any system)
          </span>
          <a href={href(`team/${team.id}?tab=staff`)} style={{ marginLeft: 'auto' }}>
            Coaching staff →
          </a>
        </div>
      )}
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
