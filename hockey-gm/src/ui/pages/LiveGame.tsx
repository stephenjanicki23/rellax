import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useGame, runSim, mutate, toast } from '../store';
import { navigate } from '../router';

import { GameSim } from '../../engine/sim/engine';
import { buildGameInput } from '../../engine/league/gameInput';
import { prepareUserGame } from '../../engine/league/season';
import { describe } from '../../engine/sim/commentary';
import type { GameEvent, GameInput, GameResult, GameSnapshot } from '../../engine/sim/gameTypes';
import type { ScheduledGame, Team } from '../../engine/types';
import { recordString } from '../../engine/league/standings';
import { playoffRoundName } from '../../engine/league/playoffs';
import { LiveRink } from '../rink/LiveRink';
import { Scoreboard, type Speed } from '../live/Scoreboard';
import { LiveFeed, type FeedLine } from '../live/LiveFeed';
import { GamePanels } from '../live/GamePanels';
import '../live/live.css';
import { whistleHold, type RinkPlayer } from '../rink/director';
import type { RinkFeed } from '../rink/LiveRink';


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
      onFinish={async (result) => {
        await runSim('day', new Map([[game.id, result]]));
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
}

/** Live game presentation. Works for franchise games and standalone exhibitions. */
export function LiveView({ input, home, away, playoff, info, records, finishLabel, onFinish, extraActions }: LiveViewProps) {
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

  // Play-by-play lines are emitted by the rink as it shows each play, so the text never runs ahead of the ice.
  const pushEvents = (evs: GameEvent[]) => {
    const out: FeedLine[] = [];
    for (const e of evs) {
      const l = describe(e, ctx);
      if (l) out.push({ ...l, uid: ++uid.current });
    }
    if (out.length) setLines((prev) => [...out.reverse(), ...prev].slice(0, 400));
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
    while (!sim.finished && sim.elapsed <= t && guard++ < 20000) {
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
      setFinished(true);
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
      <div className="live-main">
        <div className="live-rink">
          <LiveRink feed={feed} snap={s} home={home} away={away} players={rinkPlayers} playoff={playoff} onShown={pushEvents} />
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

