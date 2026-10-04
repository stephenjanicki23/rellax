import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useGame, runSim, mutate, toast } from '../store';
import { navigate } from '../router';

import { GameSim, simulateGame } from '../../engine/sim/engine';
import { buildGameInput } from '../../engine/league/gameInput';
import { prepareUserGame } from '../../engine/league/season';
import { describe, periodLabel } from '../../engine/sim/commentary';
import type { GameEvent, GameInput, GameResult, GameSnapshot } from '../../engine/sim/gameTypes';
import type { ScheduledGame, Team } from '../../engine/types';
import { recordString } from '../../engine/league/standings';
import { playoffRoundName } from '../../engine/league/playoffs';
import { LiveRink } from '../rink/LiveRink';
import { Scoreboard, type Speed } from '../live/Scoreboard';
import { LiveFeed, type FeedLine } from '../live/LiveFeed';
import { GamePanels } from '../live/GamePanels';
import { Ticker, type TickerGame } from '../live/Ticker';
import { Intermission } from '../live/Intermission';
import '../live/live.css';
import { whistleHold, type RinkPlayer } from '../rink/director';
import type { RinkFeed } from '../rink/LiveRink';


/** Game seconds the engine runs ahead of the display. */
const LOOKAHEAD = 25;

/** Sim state after one engine step, queued until the playback clock reaches it. */
interface Frame {
  elapsed: number;
  snap: GameSnapshot;
}

export function LiveGame() {
  const { league } = useGame();
  const [game, setGame] = useState<ScheduledGame | undefined>(undefined);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const g = mutate((l) => prepareUserGame(l), { save: false });
    setGame(g);
    setReady(true);
  }, []);
  // Build the game input once; LiveView keeps the simulation in a ref.
  const input = useMemo(() => (game && game.id >= 0 ? buildGameInput(league, game.id, true) : null), [game]); // eslint-disable-line react-hooks/exhaustive-deps
  // Tonight's other games: simulated once now, revealed by the ticker in step with this game,
  // and recorded with exactly these results when the day is played.
  const [ticker, setTicker] = useState<TickerGame[]>([]);
  const tickerRef = useRef<TickerGame[]>([]);
  const others = useMemo(() => (game && game.id >= 0 ? league.schedule.filter((g) => g.day === game.day && g.id !== game.id && !g.played) : []), [game]); // eslint-disable-line react-hooks/exhaustive-deps
  const simOther = (g: ScheduledGame): TickerGame => ({ id: g.id, home: league.teams[g.home], away: league.teams[g.away], result: simulateGame(buildGameInput(league, g.id)) });
  useEffect(() => {
    // One game per tick, so simulating tonight's slate never freezes the live view.
    let i = 0;
    let id: ReturnType<typeof setTimeout>;
    const next = () => {
      const g = others[i++];
      if (!g) return;
      if (!tickerRef.current.some((t) => t.id === g.id)) tickerRef.current = [...tickerRef.current, simOther(g)];
      setTicker(tickerRef.current);
      id = setTimeout(next, 40);
    };
    id = setTimeout(next, 200);
    return () => clearTimeout(id);
  }, [others]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Every other game tonight (simulating any the ticker hasn't reached yet). */
  const allOthers = (): TickerGame[] => {
    for (const g of others) if (!tickerRef.current.some((t) => t.id === g.id)) tickerRef.current = [...tickerRef.current, simOther(g)];
    return tickerRef.current;
  };
  if (!ready) return null;
  if (!game || game.id < 0 || !input) {
    return (
      <div className="empty">
        <p>Your team doesn't play today.</p>
        <button className="btn primary" onClick={() => void runSim('toUserGame')}>
          Sim to next game day
        </button>
      </div>
    );
  }
  const home = league.teams[game.home];
  const away = league.teams[game.away];
  const rec = (id: number) => (league.standings[id] ? recordString(league.standings[id]) : '');
  return (
    <LiveView
      key={game.id}
      input={input}
      home={home}
      away={away}
      playoff={!!game.playoff}
      info={game.playoff ? `${playoffRoundName(league, game.playoff.round)} · G${game.playoff.game}` : home.arena}
      records={[rec(home.id), rec(away.id)]}
      finishLabel="Record result & continue →"
      ticker={ticker}
      seasonTotals={(id) => {
        const st = league.seasonStats[id]?.[game.playoff ? 'po' : 'reg'];
        return { g: st?.g ?? 0, a: (st?.a1 ?? 0) + (st?.a2 ?? 0) };
      }}
      onFinish={async (result) => {
        await runSim('day', new Map([[game.id, result], ...allOthers().map((t): [number, GameResult] => [t.id, t.result])]));
        toast('Result recorded. The rest of the league played tonight too.', 'good');
        navigate(`game/${game.id}`);
      }}
    />
  );
}

export interface LiveViewProps {
  input: GameInput;
  home: Team;
  away: Team;
  playoff: boolean;
  info: string;
  records?: [string, string];
  finishLabel: string;
  onFinish: (result: GameResult) => void | Promise<void>;
  /** Extra buttons shown once the game is over (e.g. Rematch). */
  extraActions?: ReactNode;
  /** Other games tonight for the scores ticker (franchise only). */
  ticker?: TickerGame[];
  /** Season goals/assists before this game, for the goal card (franchise only). */
  seasonTotals?: (playerId: number) => { g: number; a: number };
}

/** Live game presentation. Works for franchise games and standalone exhibitions. */
export function LiveView({ input, home, away, playoff, info, records, finishLabel, onFinish, extraActions, ticker, seasonTotals }: LiveViewProps) {
  const simRef = useRef<GameSim | null>(null);
  if (!simRef.current) simRef.current = new GameSim(input);
  const sim = simRef.current;
  const [speed, setSpeed] = useState<Speed>('pause');
  const [lines, setLines] = useState<FeedLine[]>([]);
  const uid = useRef(0);
  const [snap, setSnap] = useState<GameSnapshot>(() => sim.snapshot());
  const [finished, setFinished] = useState(false);
  const [applying, setApplying] = useState(false);
  const names = useMemo(() => {
    const m = new Map<number, string>();
    for (const t of sim.teams) for (const p of t.players) m.set(p.id, p.name);
    return m;
  }, [sim]);
  const ctx = useMemo(() => ({ name: (id?: number) => (id !== undefined ? names.get(id) ?? '?' : '?'), team: (s: 0 | 1) => (s === 0 ? home.name : away.name) }), [names, home, away]);

  // Intermission reports: the game pauses at the end of a period (unless the viewer skips them).
  const [report, setReport] = useState<{ period: number; t: number; title: string; label: string } | null>(null);
  const [finalOpen, setFinalOpen] = useState(false);
  const [skipReports, setSkipReports] = useState(() => {
    try {
      return localStorage.getItem('hgm.skipIntermissions') === '1';
    } catch {
      return false;
    }
  });
  const speedBefore = useRef<Speed>('1');
  const skipRef = useRef(skipReports);
  skipRef.current = skipReports;

  // Play-by-play lines are emitted by the rink as it shows each play, so the text never runs ahead of the ice.
  const pushEvents = (evs: GameEvent[]) => {
    const out: FeedLine[] = [];
    for (const e of evs) {
      const l = describe(e, ctx);
      if (l) out.push({ ...l, uid: ++uid.current });
      if (e.type === 'periodEnd' && !feed.done && !skipRef.current) {
        // Score as the period ends (from the goals shown so far).
        const goals = feed.items.filter((x) => x.e.type === 'goal' && x.e.t <= e.t);
        const tied = goals.filter((x) => x.e.team === 0).length === goals.filter((x) => x.e.team === 1).length;
        const regulationOver = e.period >= 3;
        // Intermissions after the 1st and 2nd, and before playoff overtime (regular-season OT follows right away).
        if (!regulationOver || (tied && playoff)) {
          const next = e.period + 1;
          setReport({
            period: e.period,
            t: e.t,
            title: regulationOver ? (e.period === 3 ? 'End of regulation' : `End of ${periodLabel(e.period, playoff)}`) : `${periodLabel(e.period, playoff)} intermission`,
            label: next > 3 ? `Start ${periodLabel(next, playoff)}` : `Start ${periodLabel(next, playoff)} period`,
          });
          setSpeed((sp) => {
            if (sp !== 'pause') speedBefore.current = sp;
            return 'pause';
          });
        }
      }
    }
    if (out.length) setLines((prev) => [...out.reverse(), ...prev].slice(0, 400));
  };
  const resumeFromReport = () => {
    setReport(null);
    setSpeed(speedBefore.current);
  };
  const setSkip = (v: boolean) => {
    setSkipReports(v);
    try {
      localStorage.setItem('hgm.skipIntermissions', v ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
  };
  // Goal replays pause live play while the rink rewinds.
  const onReplay = (on: boolean) => {
    if (on)
      setSpeed((sp) => {
        if (sp !== 'pause') speedBefore.current = sp;
        return 'pause';
      });
    else if (!report && !finished) setSpeed(speedBefore.current);
  };

  // Playback runs on game time: at N× the clock advances N game seconds per
  // real second while the puck is in play. At a whistle the clock stops for a
  // moment (as on TV) so the rink can show the reset. The engine advances a
  // whole possession per step, so it runs one step ahead and the display
  // catches up smoothly.
  const playRef = useRef<{ t: number; cur: Frame; queue: Frame[]; pending: GameEvent[]; hold: number; pres: number } | null>(null);
  if (!playRef.current) playRef.current = { t: 0, cur: { elapsed: 0, snap: sim.snapshot() }, queue: [], pending: [], hold: 0, pres: 0 };
  const [dispT, setDispT] = useState(0);
  // Shared with the rink without re-rendering: events (tagged with who was on the ice) and the presentation clock.
  const feed = useRef<RinkFeed>({ items: [], pres: 0, presAt: 0, rate: 0, done: false }).current;
  const rinkPlayers = useMemo<RinkPlayer[]>(
    () => ([input.home, input.away] as const).flatMap((t, team) => t.players.map((p) => ({ id: p.id, team: team as 0 | 1, pos: p.pos, number: p.number ?? null, first: p.first, last: p.last }))),
    [input],
  );

  const advanceTo = (t: number) => {
    const pb = playRef.current!;
    pb.t = t;
    let guard = 0;
    // Run the engine ahead of the display so the rink always knows where play is going next
    // (a possession can pass 10-15 s without an engine event). Nothing is revealed early: the
    // play-by-play and score follow what the rink shows.
    while (!sim.finished && sim.elapsed <= t + LOOKAHEAD && guard++ < 20000) {
      const evs = sim.step();
      const snapNow = sim.snapshot();
      pb.pending.push(...evs);
      pb.queue.push({ elapsed: sim.elapsed, snap: snapNow });
      for (const e of evs) feed.items.push({ e, ice: { period: snapNow.inShootout ? 5 : e.period, onIce: snapNow.onIce, goalies: snapNow.goalies } });
    }
    while (pb.queue.length && pb.queue[0].elapsed <= t) pb.cur = pb.queue.shift()!;
    const due = pb.pending.filter((e) => e.t <= t);
    if (due.length) {
      pb.pending = pb.pending.filter((e) => e.t > t);
      // The clock holds at every whistle (the rink schedules the same pauses).
      pb.hold += due.reduce((sum, e) => sum + whistleHold(e.type), 0);
    }
    setSnap(pb.cur.snap);
    setDispT(t);
    if (sim.finished && !pb.queue.length && !pb.pending.length) {
      setFinished((was) => {
        if (!was) setFinalOpen(true);
        return true;
      });
      setSpeed('pause');
    }
  };

  useEffect(() => {
    if (speed === 'pause' || finished) return;
    const rate = Number(speed);
    let last = performance.now();
    feed.rate = rate;
    const id = setInterval(() => {
      const pb = playRef.current!;
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      let adv = dt * rate;
      pb.pres += adv;
      feed.pres = pb.pres;
      feed.presAt = now;
      if (pb.hold > 0) {
        const use = Math.min(pb.hold, adv);
        pb.hold -= use;
        adv -= use;
      }
      advanceTo(pb.t + adv);
    }, 50);
    return () => {
      clearInterval(id);
      feed.rate = 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speed, finished]);

  const instant = () => {
    feed.done = true;
    advanceTo(Infinity);
  };

  const finalize = async () => {
    setApplying(true);
    await onFinish(sim.result());
    setApplying(false);
  };

  const s = snap;
  // Interpolate the clock toward the next queued engine state.
  const next = playRef.current.queue[0];
  const nextClock = next ? next.snap.clock - (next.elapsed - dispT) : -1;
  const period = next && nextClock >= 0 ? next.snap.period : s.period;
  const clock = next && nextClock >= 0 ? nextClock : s.clock;
  const meta = useMemo(() => new Map(rinkPlayers.map((p) => [p.id, p])), [rinkPlayers]);
  const label = (id: number) => {
    const p = meta.get(id);
    return p ? `${p.number != null ? `#${p.number} ` : ''}${p.last ?? ''}` : '';
  };
  const running = !finished && speed !== 'pause';
  const finalResult = useMemo(() => (finished ? sim.result() : null), [finished, sim]);

  return (
    <div className="live-screen">
      <Scoreboard
        home={home}
        away={away}
        snap={s}
        period={period}
        clock={clock}
        playoff={playoff}
        info={info}
        records={records}
        speed={speed}
        onSpeed={setSpeed}
        onInstant={instant}
        finished={finished}
        label={label}
        finalActions={
          <>
            <button className="btn primary" disabled={applying} onClick={() => void finalize()}>
              {finishLabel}
            </button>
            {extraActions}
          </>
        }
      />
      {ticker && ticker.length > 0 && <Ticker games={ticker} period={period} clock={clock} finished={finished} playoff={playoff} />}
      <div className="live-main">
        <div className="live-rink">
          {report && (
            <Intermission
              title={report.title}
              period={report.period}
              snap={s}
              items={feed.items.filter((x) => x.e.t <= report.t)}
              home={home}
              away={away}
              players={meta}
              playoff={playoff}
              onContinue={resumeFromReport}
              continueLabel={report.label}
              skip={skipReports}
              onSkip={setSkip}
            />
          )}
          {finalResult && finalOpen && (
            <Intermission
              title={finalResult.so ? 'Final / SO' : finalResult.ot ? 'Final / OT' : 'Final'}
              period={Math.max(3, Math.min(s.period, finalResult.periods))}
              snap={s}
              items={feed.items}
              home={home}
              away={away}
              players={meta}
              playoff={playoff}
              stars={finalResult.stars}
              onContinue={() => void finalize()}
              continueLabel={finishLabel}
              extra={
                <button className="btn" onClick={() => setFinalOpen(false)}>
                  Close
                </button>
              }
            />
          )}
          <LiveRink feed={feed} snap={s} home={home} away={away} players={rinkPlayers} playoff={playoff} onShown={pushEvents} seasonTotals={seasonTotals} onReplay={onReplay} />
          <div className="live-momentum" title="Momentum: which team is pushing the play">
            <span>{home.abbr}</span>
            <div className="momentum">
              <i style={{ left: s.momentum >= 0 ? '50%' : `${50 + s.momentum * 50}%`, width: `${Math.abs(s.momentum) * 50}%`, background: s.momentum >= 0 ? home.colors[0] : away.colors[0] }} />
            </div>
            <span>{away.abbr}</span>
          </div>
        </div>
        <aside className="live-side">
          <LiveFeed lines={lines} home={home} away={away} playoff={playoff} running={running} />
          <GamePanels snap={s} home={home} away={away} players={meta} lines={lines} playoff={playoff} />
        </aside>
      </div>
    </div>
  );
}

