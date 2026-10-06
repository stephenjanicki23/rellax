import type { ReactNode } from 'react';
import type { GameSnapshot } from '../../engine/sim/gameTypes';
import type { Team } from '../../engine/types';
import { teamBar } from '../teamColors';
import { clockLabel, periodLabel } from '../../engine/sim/commentary';
import { TeamLogo } from '../components/common';

export type Speed = 'pause' | '1' | '2' | '5' | '10' | '30' | '60';

const SPEEDS: { id: Speed; label: string; tip: string }[] = [
  { id: 'pause', label: '❚❚', tip: 'Pause' },
  { id: '1', label: '1×', tip: 'Real time: one game second per second' },
  { id: '2', label: '2×', tip: 'Two game seconds per second' },
  { id: '5', label: '5×', tip: 'Five game seconds per second' },
  { id: '10', label: '10×', tip: 'Ten game seconds per second (a period in 2 minutes)' },
  { id: '30', label: '30×', tip: 'Thirty game seconds per second' },
  { id: '60', label: '60×', tip: 'A period in about 20 seconds' },
];

export interface GameState {
  label: string;
  detail?: string;
  team: 0 | 1 | null;
  tone: 'even' | 'pp' | 'en' | 'so';
}

/** What the strength situation is right now, from the engine snapshot. */
export function gameState(s: GameSnapshot, abbr: [string, string]): GameState {
  if (s.inShootout) return { label: 'Shootout', team: null, tone: 'so' };
  const [h, a] = s.strength;
  const empty = ([0, 1] as const).find((t) => s.goalies[t] === null);
  if (h !== a) {
    const pp = (h > a ? 0 : 1) as 0 | 1;
    const left = s.ppTimeLeft[pp];
    const label = `${abbr[pp]} power play`;
    const n = `${Math.max(h, a)}-on-${Math.min(h, a)}`;
    return { label, detail: `${n}${left > 0 ? ` · ${clockLabel(0, Math.ceil(left))}` : ''}${empty !== undefined ? ` · ${abbr[empty]} empty net` : ''}`, team: pp, tone: 'pp' };
  }
  if (empty !== undefined) return { label: `${abbr[empty]} empty net`, detail: 'Extra attacker', team: empty, tone: 'en' };
  if (h < 5) return { label: `${h}-on-${a}`, detail: s.period > 3 ? 'Overtime' : undefined, team: null, tone: 'even' };
  return { label: 'Even strength', detail: '5-on-5', team: null, tone: 'even' };
}

export interface ScoreboardProps {
  home: Team;
  away: Team;
  snap: GameSnapshot;
  period: number;
  clock: number;
  playoff: boolean;
  info: string;
  records?: [string, string];
  speed: Speed;
  onSpeed: (s: Speed) => void;
  onInstant: () => void;
  finished: boolean;
  /** Shown in place of the speed controls once the game is over. */
  finalActions: ReactNode;
  /** Player id → "#17 Kessel" for penalty listings. */
  label: (id: number) => string;
  /** Between periods: the period that just ended (shown as "End 1st · INT"). */
  intermissionAfter?: number;
}

export function Scoreboard({ home, away, snap: s, period, clock, playoff, info, records, speed, onSpeed, onInstant, finished, finalActions, label, intermissionAfter }: ScoreboardProps) {
  const teams = [home, away] as const;
  const st = gameState(s, [home.abbr, away.abbr]);
  const fo = (t: 0 | 1) => {
    const ts = s.teamStats[t];
    const tot = ts.fow + ts.fol;
    return tot ? Math.round((ts.fow / tot) * 100) : 50;
  };
  const running = !finished && speed !== 'pause';
  const side = (t: 0 | 1) => {
    const team = teams[t];
    const ts = s.teamStats[t];
    const box = s.box.filter((b) => b.team === t && !b.coincidental).sort((a, b) => a.remaining - b.remaining);
    return (
      <div className={`sb-team ${t === 1 ? 'away' : ''}`} style={{ '--tc': teamBar(team.colors) } as React.CSSProperties}>
        <TeamLogo team={team} size={46} />
        <div className="sb-id">
          <div className="sb-abbr">
            {team.abbr}
            {!finished && s.possession === t && (
              <em className="sb-poss" title={`${team.abbr} has the puck`}>
                PUCK
              </em>
            )}
          </div>
          <div className="sb-name">
            {team.city} {team.name}
            {records?.[t] ? <span className="sb-rec"> · {records[t]}</span> : null}
          </div>
          <div className="sb-mini">
            <span title="Shots on goal">
              SOG <b>{ts.shots}</b>
            </span>
            <span title="Faceoff win %">
              FO <b>{fo(t)}%</b>
            </span>
            <span title="Power-play goals / opportunities">
              PP <b>{ts.ppg}/{ts.ppOpp}</b>
            </span>
          </div>
          {box.length > 0 && (
            <div className="sb-box">
              {box.map((b) => (
                <span key={`${b.player}-${b.minutes}`} title={`${b.minutes}-minute penalty`}>
                  ⚑ {label(b.player)} <b>{clockLabel(0, Math.ceil(b.remaining))}</b>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  };
  return (
    <div className="scoreboard2">
      <div className="sb-main">
        {side(0)}
        <div className="sb-center">
          <div className="sb-score" key={`h${s.score[0]}`}>
            {s.score[0]}
          </div>
          <div className="sb-clock">
            <div className="sb-period">
              {finished ? `Final${s.inShootout ? ' / SO' : s.period > 3 ? ' / OT' : ''}` : s.inShootout ? 'Shootout' : intermissionAfter ? `End ${periodLabel(intermissionAfter, playoff)}` : periodLabel(period, playoff)}
            </div>
            {!finished && !s.inShootout && <div className="sb-time">{intermissionAfter ? 'INT' : clockLabel(clock, s.periodLength)}</div>}
            <div className="sb-info">{info}</div>
          </div>
          <div className="sb-score" key={`a${s.score[1]}`}>
            {s.score[1]}
          </div>
        </div>
        {side(1)}
      </div>
      <div className="sb-strip">
        <div className={`sb-state ${st.tone}`} style={st.team !== null ? ({ '--tc': teamBar(teams[st.team].colors) } as React.CSSProperties) : undefined}>
          {!finished && (
            <>
              <b>{st.label}</b>
              {st.detail && <span>{st.detail}</span>}
            </>
          )}
          {finished && <b>Game over</b>}
        </div>
        <div className="sb-tools">
          {!finished ? (
            <>
              <div className="sb-speed" role="group" aria-label="Simulation speed">
                {SPEEDS.map((o) => (
                  <button key={o.id} className={speed === o.id ? 'on' : ''} title={o.tip} aria-pressed={speed === o.id} onClick={() => onSpeed(o.id)}>
                    {o.label}
                  </button>
                ))}
              </div>
              <button className="sb-instant" title="Simulate the rest of the game instantly" onClick={onInstant}>
                ⏭ Instant
              </button>
            </>
          ) : (
            finalActions
          )}
        </div>
        <div className="sb-live">
          {!finished && !s.inShootout && (
            <span className="sb-play" style={{ '--tc': teamBar(teams[s.possession].colors) } as React.CSSProperties} title="Who has the puck and where">
              <b>{teams[s.possession].abbr}</b> {s.zone === 'O' ? 'attacking · offensive zone' : s.zone === 'N' ? 'through the neutral zone' : 'breaking out · own zone'}
            </span>
          )}
          {running ? <span className="sb-dot">Live</span> : !finished ? <span className="sb-paused">Paused</span> : null}
        </div>
      </div>
    </div>
  );
}
