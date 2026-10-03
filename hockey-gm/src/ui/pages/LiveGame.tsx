import { useEffect, useMemo, useRef, useState } from 'react';
import { useGame, runSim, mutate, toast } from '../store';
import { navigate } from '../router';
import { Card, TeamLogo, Seg } from '../components/common';
import { GameSim } from '../../engine/sim/engine';
import { buildGameInput } from '../../engine/league/gameInput';
import { prepareUserGame } from '../../engine/league/season';
import { describe, periodLabel, clockLabel, type CommentaryLine } from '../../engine/sim/commentary';
import type { GameEvent, GameSnapshot } from '../../engine/sim/gameTypes';
import type { ScheduledGame } from '../../engine/types';
import { recordString } from '../../engine/league/standings';
import { playoffRoundName } from '../../engine/league/playoffs';

type Speed = 'pause' | '1' | '2' | '5' | '10';
/** Game seconds simulated per real second at 1x. A full game takes about six minutes at 1x. */
const BASE_RATE = 10;

export function LiveGame() {
  const { league } = useGame();
  const [game, setGame] = useState<ScheduledGame | undefined>(undefined);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const g = mutate((l) => prepareUserGame(l), { save: false });
    setGame(g);
    setReady(true);
  }, []);
  if (!ready) return null;
  if (!game || game.id < 0) {
    return (
      <div className="empty">
        <p>Your team doesn't play today.</p>
        <button className="btn primary" onClick={() => void runSim('toUserGame')}>
          Sim to next game day
        </button>
      </div>
    );
  }
  return <LiveView key={game.id} game={game} seasonLeague={league} />;
}

function LiveView({ game, seasonLeague: league }: { game: ScheduledGame; seasonLeague: ReturnType<typeof useGame>['league'] }) {
  const simRef = useRef<GameSim | null>(null);
  if (!simRef.current) simRef.current = new GameSim(buildGameInput(league, game.id, true));
  const sim = simRef.current;
  const [speed, setSpeed] = useState<Speed>('pause');
  const [lines, setLines] = useState<CommentaryLine[]>([]);
  const [snap, setSnap] = useState<GameSnapshot>(() => sim.snapshot());
  const [finished, setFinished] = useState(false);
  const [applying, setApplying] = useState(false);
  const home = league.teams[game.home];
  const away = league.teams[game.away];
  const names = useMemo(() => {
    const m = new Map<number, string>();
    for (const t of sim.teams) for (const p of t.players) m.set(p.id, p.name);
    return m;
  }, [sim]);
  const ctx = useMemo(() => ({ name: (id?: number) => (id !== undefined ? names.get(id) ?? '?' : '?'), team: (s: 0 | 1) => (s === 0 ? home.name : away.name) }), [names, home, away]);

  const pushEvents = (evs: GameEvent[]) => {
    const out: CommentaryLine[] = [];
    for (const e of evs) {
      const l = describe(e, ctx);
      if (l) out.push(l);
    }
    if (out.length) setLines((prev) => [...out.reverse(), ...prev].slice(0, 400));
  };

  useEffect(() => {
    if (speed === 'pause' || finished) return;
    const rate = BASE_RATE * Number(speed);
    const id = setInterval(() => {
      const target = sim.elapsed + rate * 0.1;
      const evs: GameEvent[] = [];
      let guard = 0;
      while (!sim.finished && sim.elapsed < target && guard++ < 200) evs.push(...sim.step());
      pushEvents(evs);
      setSnap(sim.snapshot());
      if (sim.finished) {
        setFinished(true);
        setSpeed('pause');
      }
    }, 100);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speed, finished]);

  const instant = () => {
    const evs: GameEvent[] = [];
    while (!sim.finished) evs.push(...sim.step());
    pushEvents(evs);
    setSnap(sim.snapshot());
    setFinished(true);
    setSpeed('pause');
  };

  const finalize = async () => {
    setApplying(true);
    const result = sim.result();
    await runSim('day', new Map([[game.id, result]]));
    toast('Result recorded. The rest of the league played tonight too.', 'good');
    navigate(`game/${game.id}`);
  };

  const s = snap;
  const ppSide = s.ppTimeLeft[0] > 0 ? 0 : s.ppTimeLeft[1] > 0 ? 1 : -1;
  const goals = lines.filter((l) => l.kind === 'goal' && l.text.startsWith('GOAL')).reverse();
  const pens = lines.filter((l) => l.kind === 'penalty').reverse();
  const hRec = league.standings[home.id];
  const aRec = league.standings[away.id];
  const possShare = s.possTime[0] + s.possTime[1] > 0 ? s.possTime[0] / (s.possTime[0] + s.possTime[1]) : 0.5;

  const onIce = (side: 0 | 1) =>
    s.onIce[side].map((id) => (
      <div key={id} className="row" style={{ gap: 6, fontSize: 12 }}>
        <span style={{ width: 90, overflow: 'hidden', textOverflow: 'ellipsis' }}>{names.get(id)}</span>
        <div className="bar" style={{ flex: 1 }}>
          <i style={{ width: `${s.energy[id] ?? 100}%`, background: (s.energy[id] ?? 100) < 50 ? 'var(--bad)' : (s.energy[id] ?? 100) < 70 ? 'var(--warn)' : 'var(--good)' }} />
        </div>
      </div>
    ));

  return (
    <>
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="scoreboard">
          <div className="team">
            <TeamLogo team={home} size={56} />
            <div className="stack" style={{ gap: 0 }}>
              <b style={{ fontSize: 16 }}>{home.city} {home.name}</b>
              <span className="muted">{hRec ? recordString(hRec) : ''} · SOG {s.shots[0]}</span>
              {ppSide === 0 && <span className="pill good">POWER PLAY {Math.ceil(s.ppTimeLeft[0])}s</span>}
            </div>
            <span className="score" style={{ marginLeft: 'auto' }}>{s.score[0]}</span>
          </div>
          <div className="clock">
            <div className="big">{s.inShootout ? 'SO' : periodLabel(s.period, !!game.playoff)}</div>
            <div className="mono" style={{ fontSize: 18 }}>{clockLabel(s.clock, s.periodLength)}</div>
            <div className="muted" style={{ fontSize: 11 }}>{game.playoff ? `${playoffRoundName(league, game.playoff.round)} · G${game.playoff.game}` : home.arena}</div>
          </div>
          <div className="team away">
            <TeamLogo team={away} size={56} />
            <div className="stack" style={{ gap: 0 }}>
              <b style={{ fontSize: 16 }}>{away.city} {away.name}</b>
              <span className="muted">{aRec ? recordString(aRec) : ''} · SOG {s.shots[1]}</span>
              {ppSide === 1 && <span className="pill good">POWER PLAY {Math.ceil(s.ppTimeLeft[1])}s</span>}
            </div>
            <span className="score" style={{ marginRight: 'auto' }}>{s.score[1]}</span>
          </div>
        </div>
        <div className="row" style={{ marginTop: 14, justifyContent: 'center' }}>
          {!finished ? (
            <>
              <Seg value={speed} onChange={setSpeed} options={[{ id: 'pause', label: '❚❚ Pause' }, { id: '1', label: '▶ 1×' }, { id: '2', label: '2×' }, { id: '5', label: '5×' }, { id: '10', label: '10×' }]} />
              <button className="btn" onClick={instant}>⏭ Instant result</button>
            </>
          ) : (
            <>
              <b className="good">Final{snap.inShootout ? ' (SO)' : snap.period > 3 ? ' (OT)' : ''}</b>
              <button className="btn primary" disabled={applying} onClick={() => void finalize()}>
                Record result & continue →
              </button>
            </>
          )}
        </div>
      </div>
      <div className="grid g-main">
        <div className="grid">
          <Card title="Play-by-play" tight>
            <div className="feed">
              {lines.length === 0 && <div className="empty">Press play to drop the puck.</div>}
              {lines.map((l, i) => (
                <div key={`${l.t}-${i}`} className={`ln ${l.kind}`}>
                  <span className="t">{periodLabel(l.period, !!game.playoff)} {clockLabel(l.clock, l.period > 3 && !game.playoff ? 300 : 1200)}</span>
                  <span>{l.text}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>
        <div className="grid" style={{ alignContent: 'start' }}>
          <Card title="Ice">
            <Rink snap={s} homeColor={home.colors[0]} awayColor={away.colors[0]} />
            <div className="row muted" style={{ justifyContent: 'space-between', fontSize: 12, marginTop: 6 }}>
              <span>{home.abbr} {s.strength[0]} skaters{s.goalies[0] === null ? ' + EN' : ''}</span>
              <span>Momentum</span>
              <span>{away.abbr} {s.strength[1]} skaters{s.goalies[1] === null ? ' + EN' : ''}</span>
            </div>
            <div className="momentum" style={{ marginTop: 4 }}>
              <i style={{ left: s.momentum >= 0 ? '50%' : `${50 + s.momentum * 50}%`, width: `${Math.abs(s.momentum) * 50}%`, background: s.momentum >= 0 ? home.colors[0] : away.colors[0] }} />
            </div>
          </Card>
          <Card title="Game stats">
            <table className="tbl">
              <tbody>
                {[
                  ['Shots', s.shots[0], s.shots[1]],
                  ['Shot attempts', s.attempts[0], s.attempts[1]],
                  ['Expected goals', s.xg[0].toFixed(2), s.xg[1].toFixed(2)],
                  ['Hits', s.hits[0], s.hits[1]],
                  ['Faceoffs won', s.fow[0], s.fow[1]],
                  ['Possession', `${Math.round(possShare * 100)}%`, `${Math.round((1 - possShare) * 100)}%`],
                ].map(([k, a, b]) => (
                  <tr key={String(k)}>
                    <td className="num"><b>{a}</b></td>
                    <td className="muted" style={{ textAlign: 'center' }}>{k}</td>
                    <td><b>{b}</b></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <Card title="On the ice">
            <div className="grid g2">
              <div className="stack" style={{ gap: 3 }}>
                <b>{home.abbr} · L{s.lineIdx[0] + 1}</b>
                {onIce(0)}
              </div>
              <div className="stack" style={{ gap: 3 }}>
                <b>{away.abbr} · L{s.lineIdx[1] + 1}</b>
                {onIce(1)}
              </div>
            </div>
          </Card>
          <Card title="Scoring">
            {goals.length ? goals.map((g, i) => <div key={i} style={{ fontSize: 12, padding: '3px 0' }}><span className="dim">{periodLabel(g.period)} {clockLabel(g.clock, 1200)}</span> {g.text.replace(/^GOAL! /, '')}</div>) : <span className="muted">No goals yet.</span>}
          </Card>
          <Card title="Penalties">
            {pens.length ? pens.map((g, i) => <div key={i} style={{ fontSize: 12, padding: '3px 0' }}><span className="dim">{periodLabel(g.period)} {clockLabel(g.clock, 1200)}</span> {g.text.replace(/^PENALTY: /, '')}</div>) : <span className="muted">None.</span>}
          </Card>
        </div>
      </div>
    </>
  );
}

function Rink({ snap, homeColor, awayColor }: { snap: GameSnapshot; homeColor: string; awayColor: string }) {
  // Home attacks to the right.
  const z = snap.zone;
  const home = snap.possession === 0;
  const ownEnd = home ? 40 : 160;
  const oppEnd = home ? 160 : 40;
  const x = z === 'D' ? ownEnd : z === 'O' ? oppEnd : 100;
  const wobble = ((Math.floor(snap.clock * 7) % 9) - 4) * 3;
  const y = 42 + wobble;
  return (
    <svg className="rink" viewBox="0 0 200 85">
      <rect x="2" y="2" width="196" height="81" rx="24" fill="var(--bg2)" stroke="var(--line2)" strokeWidth="1.5" />
      <line x1="100" y1="2" x2="100" y2="83" stroke="#ef4444" strokeWidth="1.5" opacity="0.7" />
      <line x1="72" y1="2" x2="72" y2="83" stroke="#3b82f6" strokeWidth="2" opacity="0.7" />
      <line x1="128" y1="2" x2="128" y2="83" stroke="#3b82f6" strokeWidth="2" opacity="0.7" />
      <line x1="14" y1="6" x2="14" y2="79" stroke="#ef4444" strokeWidth="0.8" opacity="0.6" />
      <line x1="186" y1="6" x2="186" y2="79" stroke="#ef4444" strokeWidth="0.8" opacity="0.6" />
      <circle cx="100" cy="42.5" r="10" fill="none" stroke="#3b82f6" strokeWidth="0.8" opacity="0.6" />
      <path d="M14 37 a6 6 0 0 1 0 11" fill="#60a5fa33" stroke="#ef4444" strokeWidth="0.6" />
      <path d="M186 37 a6 6 0 0 0 0 11" fill="#60a5fa33" stroke="#ef4444" strokeWidth="0.6" />
      <circle cx="40" cy="24" r="7" fill="none" stroke="#ef4444" strokeWidth="0.6" opacity="0.5" />
      <circle cx="40" cy="61" r="7" fill="none" stroke="#ef4444" strokeWidth="0.6" opacity="0.5" />
      <circle cx="160" cy="24" r="7" fill="none" stroke="#ef4444" strokeWidth="0.6" opacity="0.5" />
      <circle cx="160" cy="61" r="7" fill="none" stroke="#ef4444" strokeWidth="0.6" opacity="0.5" />
      <rect x="2" y="2" width="40" height="81" rx="24" fill={homeColor} opacity="0.06" />
      <rect x="158" y="2" width="40" height="81" rx="24" fill={awayColor} opacity="0.06" />
      <circle cx={x} cy={y} r="3.5" fill="#f8fafc" stroke={home ? homeColor : awayColor} strokeWidth="2" style={{ transition: 'cx 0.4s, cy 0.4s' }} />
      <text x="100" y="80" textAnchor="middle" fontSize="6" fill="var(--dim)">
        {home ? '→' : '←'} {z === 'O' ? 'attacking zone' : z === 'D' ? 'own zone' : 'neutral zone'}
      </text>
    </svg>
  );
}
