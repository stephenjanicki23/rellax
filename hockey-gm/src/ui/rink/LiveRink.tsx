import { useEffect, useMemo, useRef, useState } from 'react';
import type { GameEvent, GameSnapshot } from '../../engine/sim/gameTypes';
import type { Team } from '../../engine/types';
import { clockLabel, periodLabel } from '../../engine/sim/commentary';
import { RINK, RinkDirector, attackDir, type RinkPlayer, type ShotMark } from './director';
import { RinkMotion, RinkTimeline, type Key, type TimelineItem } from './motion';
import { teamBar } from '../teamColors';
import './rink.css';

/** Shared, mutable link between the live view's playback loop and the rink (read every frame). */
export interface RinkFeed {
  /** Every event the engine has produced so far, tagged with who was on the ice. */
  items: TimelineItem[];
  /** Presentation clock (game seconds plus whistle pauses) at `presAt`. */
  pres: number;
  /** performance.now() when `pres` was last updated. */
  presAt: number;
  /** Playback speed; 0 when paused. */
  rate: number;
  /** Instant result was used: jump to the end. */
  done: boolean;
}

type RinkTeam = Pick<Team, 'abbr' | 'colors' | 'logo' | 'city' | 'name'>;

export interface LiveRinkProps {
  /** Called with the engine events the rink has just shown (drives the play-by-play). */
  onShown?: (events: GameEvent[]) => void;
  /** Season goals/assists before this game (franchise games), for the goal card. */
  seasonTotals?: (playerId: number) => { g: number; a: number };
  feed: RinkFeed;
  snap: GameSnapshot;
  home: RinkTeam;
  away: RinkTeam;
  players: RinkPlayer[];
  playoff?: boolean;
  /** A goal replay started (true) or ended (false); the live view pauses play meanwhile. */
  onReplay?: (on: boolean) => void;
}

interface Trajectory {
  id: number;
  from: { x: number; y: number };
  to: { x: number; y: number };
  kind: ShotMark['kind'];
  team: 0 | 1;
}

interface Chip {
  id: number;
  text: string;
  team: 0 | 1 | null;
  tone: 'info' | 'penalty' | 'save';
}

/** The stoppage banner: why play stopped, then who is taking the faceoff. */
interface Stoppage {
  id: number;
  title: string;
  sub: string;
  team: 0 | 1 | null;
  tone: 'whistle' | 'penalty' | 'faceoff';
}

interface GoalInfo {
  /** Season totals including this goal: scorer's goals, assisters' assists (franchise games). */
  counts?: { scorer?: number; assists: (number | undefined)[] };
  id: number;
  event: GameEvent;
}

const STEP = 1 / 120;
/** Last name under each marker (shortened so neighbours stay readable). */
const surname = (m: RinkPlayer): string => {
  const n = (m.last ?? '').toUpperCase();
  return n.length > 11 ? `${n.slice(0, 10)}.` : n;
};

/** Fine grain for the ice surface, generated once (static image: no per-frame filter cost). */
let noiseUrl: string | null = null;
function iceNoise(): string | null {
  if (noiseUrl || typeof document === 'undefined') return noiseUrl;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  if (!g) return null;
  const img = g.createImageData(256, 256);
  let seed = 7;
  for (let i = 0; i < img.data.length; i += 4) {
    seed = (seed * 16807) % 2147483647;
    const v = 200 + (seed % 56);
    img.data[i] = img.data[i + 1] = v;
    img.data[i + 2] = 255;
    img.data[i + 3] = seed % 7 === 0 ? 40 : 14;
  }
  g.putImageData(img, 0, 0);
  // A few skate scratches.
  g.strokeStyle = 'rgba(150,170,190,0.18)';
  g.lineWidth = 0.6;
  for (let i = 0; i < 40; i++) {
    seed = (seed * 16807) % 2147483647;
    const x = seed % 256;
    seed = (seed * 16807) % 2147483647;
    const y = seed % 256;
    g.beginPath();
    g.moveTo(x, y);
    g.quadraticCurveTo(x + 30, y + 6, x + 60, y - 4);
    g.stroke();
  }
  noiseUrl = c.toDataURL();
  return noiseUrl;
}

/** Replay window around a goal (presentation seconds before/after the puck goes in) and slow-motion rate. */
const REPLAY_BEFORE = 6.5;
const REPLAY_AFTER = 1.4;
const REPLAY_RATE = 0.45;

export function LiveRink({ feed, snap, home, away, players, playoff = false, onShown, seasonTotals, onReplay }: LiveRinkProps) {
  const replayCb = useRef(onReplay);
  replayCb.current = onReplay;
  // Last goal shown (for the replay button) and the replay in progress.
  const lastGoal = useRef<{ s: number; event: GameEvent } | null>(null);
  const replay = useRef<{ from: number; to: number; resume: number; started: boolean } | null>(null);
  const [replayable, setReplayable] = useState<GameEvent | null>(null);
  const [replaying, setReplaying] = useState(false);
  const totalsRef = useRef(seasonTotals);
  totalsRef.current = seasonTotals;
  // Goals and assists already shown in this game (added to the season totals on the goal card).
  const tally = useRef(new Map<number, { g: number; a: number }>());
  const meta = useMemo(() => new Map(players.map((p) => [p.id, p])), [players]);
  const shownRef = useRef(onShown);
  shownRef.current = onShown;
  const engine = useRef<{ tl: RinkTimeline; motion: RinkMotion; consumed: number } | null>(null);
  if (!engine.current) {
    const tl = new RinkTimeline(new RinkDirector(meta, [home.abbr, away.abbr]));
    engine.current = { tl, motion: new RinkMotion(tl, meta), consumed: 0 };
  }
  const els = useRef(new Map<number, SVGGElement>());
  const heads = useRef(new Map<number, SVGGElement>());
  const puckEl = useRef<SVGGElement | null>(null);
  const trailEl = useRef<SVGPolylineElement | null>(null);
  const [ids, setIds] = useState<number[]>([]);
  const [carrier, setCarrier] = useState<number | null>(null);
  const [possTeam, setPossTeam] = useState<0 | 1 | null>(null);
  const [active, setActive] = useState<number[]>([]);
  const [injured, setInjured] = useState<number[]>([]);
  const [penalized, setPenalized] = useState<number[]>([]);
  const [savePulse, setSavePulse] = useState<{ id: number; n: number } | null>(null);
  const [trajs, setTrajs] = useState<Trajectory[]>([]);
  const [chips, setChips] = useState<Chip[]>([]);
  const [goal, setGoal] = useState<GoalInfo | null>(null);
  const [light, setLight] = useState<0 | 1 | null>(null);
  const [shots, setShots] = useState<ShotMark[]>([]);
  const [showMap, setShowMap] = useState(false);
  const [period, setPeriod] = useState(1);
  const [stop, setStop] = useState<Stoppage | null>(null);
  const [foDot, setFoDot] = useState<{ x: number; y: number } | null>(null);
  const [logoOk, setLogoOk] = useState(true);
  const noise = useMemo(() => iceNoise(), []);
  const seq = useRef(0);

  useEffect(() => {
    const { tl, motion } = engine.current!;
    let raf = 0;
    let last = performance.now();
    let idKey = '';
    let carrierNow: number | null = null;
    let possNow: 0 | 1 | null = null;
    const trail: { x: number; y: number }[] = [];
    let prevPuck = { ...motion.puck.pos };
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (ms: number, fn: () => void) => {
      const t = setTimeout(() => {
        timers.delete(t);
        fn();
      }, ms);
      timers.add(t);
    };
    const chip = (text: string, team: 0 | 1 | null, tone: Chip['tone'], ms = 1600) => {
      const c = { id: ++seq.current, text, team, tone };
      setChips((prev) => [...prev.slice(-2), c]);
      later(ms, () => setChips((prev) => prev.filter((x) => x.id !== c.id)));
    };
    let shown: GameEvent[] = [];
    const abbr = (t: 0 | 1) => (t === 0 ? home : away).abbr;
    const who = (id: number | undefined) => {
      const m = id === undefined ? undefined : meta.get(id);
      return m ? `${m.number != null ? `#${m.number} ` : ''}${m.last ?? ''}` : '';
    };
    const stopFor = (title: string, sub: string, team: 0 | 1 | null, tone: Stoppage['tone'] = 'whistle') => setStop({ id: ++seq.current, title, sub, team, tone });
    const onKey = (k: Key) => {
      if (k.event) shown.push(k.event);
      if (k.faceoff?.phase === 'lineup') {
        const f = k.faceoff;
        const [h, a] = f.team === 0 ? [f.p1, f.p2] : [f.p2, f.p1];
        stopFor('Faceoff', `${who(h)} (${home.abbr}) vs ${who(a)} (${away.abbr})`, null, 'faceoff');
        setFoDot(f.dot);
      } else if (k.faceoff?.phase === 'drop') {
        setStop(null);
        setFoDot(null);
      }
      setPeriod((p) => (p !== k.period ? k.period : p));
      if (k.goalLight !== null) {
        setLight(k.goalLight);
        later(3200, () => setLight(null));
      }
      if (k.mark) {
        const m = k.mark;
        setShots((prev) => [...prev, m]);
        const tr = { id: ++seq.current, from: { x: m.x, y: m.y }, to: { ...k.puck }, kind: m.kind, team: m.team };
        setTrajs((prev) => [...prev.slice(-5), tr]);
        later(1900, () => setTrajs((prev) => prev.filter((x) => x.id !== tr.id)));
      }
      const e = k.event;
      if (!e) return;
      const actors = [e.p1, e.p2].filter((x): x is number => x !== undefined);
      if (actors.length && e.type !== 'lineChange') {
        setActive(actors);
        later(1400, () => setActive((prev) => (prev === actors ? [] : prev)));
      }
      switch (e.type) {
        case 'goal': {
          lastGoal.current = { s: k.s, event: e };
          setReplayable(e);
          const bump = (id: number | undefined, k: 'g' | 'a') => {
            if (id === undefined) return;
            const t = tally.current.get(id) ?? { g: 0, a: 0 };
            t[k]++;
            tally.current.set(id, t);
          };
          bump(e.p1, 'g');
          bump(e.p2, 'a');
          bump(e.p3, 'a');
          const totals = totalsRef.current;
          const season = (id: number | undefined, k: 'g' | 'a') => (id === undefined || !totals ? undefined : totals(id)[k] + (tally.current.get(id)?.[k] ?? 0));
          setGoal({ id: ++seq.current, event: e, counts: totals ? { scorer: season(e.p1, 'g'), assists: [season(e.p2, 'a'), season(e.p3, 'a')] } : undefined });
          break;
        }
        case 'save':
          if (e.p1 !== undefined) setSavePulse({ id: e.p1, n: ++seq.current });
          if (e.data?.big) chip('BIG SAVE', e.team, 'save');
          break;
        case 'penalty':
        case 'fight':
          if (e.type === 'fight') stopFor('Fight', `${who(e.p1)} and ${who(e.p2)} drop the gloves · 5 minutes each`, null, 'penalty');
          else stopFor(`Penalty · ${abbr(e.team)}`, `${who(e.p1)} · ${e.data?.minutes ?? 2} minutes for ${(e.data?.penalty ?? 'an infraction').toLowerCase()}`, e.team, 'penalty');
          if (e.p1 !== undefined) setPenalized((prev) => [...prev, e.p1!, ...(e.type === 'fight' && e.p2 !== undefined ? [e.p2] : [])]);
          break;
        case 'injury':
          stopFor('Whistle', `Play stopped: ${who(e.p1)} is hurt`, e.team);
          if (e.p1 !== undefined) {
            const id = e.p1;
            setInjured((prev) => [...prev, id]);
            later(6000, () => setInjured((prev) => prev.filter((x) => x !== id)));
          }
          break;
        case 'icing':
          stopFor(`Icing · ${abbr(e.team)}`, `${abbr(e.team)} sent it the length of the ice · faceoff in the ${abbr(e.team)} zone, no change allowed`, e.team);
          break;
        case 'offside':
          stopFor(`Offside · ${abbr(e.team)}`, `${who(e.p1)} was over the blue line ahead of the puck · faceoff in the neutral zone`, e.team);
          break;
        case 'freeze':
          stopFor('Whistle', `${who(e.p1)} covers the puck · faceoff in the ${abbr(e.team)} zone`, e.team);
          break;
        case 'goalieChange':
          stopFor(`Goalie change · ${abbr(e.team)}`, `${who(e.p1)} comes in`, e.team);
          break;
        case 'goal':
          setStop(null);
          break;
        case 'entry':
          if (e.data?.oddMan) chip('ODD-MAN RUSH', e.team, 'info', 1300);
          break;
        case 'lineChange':
          chip(`${(e.team === 0 ? home : away).abbr} LINE CHANGE`, e.team, 'info', 1200);
          break;
        case 'goaliePulled':
          chip(`${(e.team === 0 ? home : away).abbr} EMPTY NET`, e.team, 'penalty', 2400);
          break;
        case 'periodStart':
          setShots([]);
          stopFor(e.period > 3 ? 'Overtime' : `${periodLabel(e.period, playoff)} period`, 'Opening faceoff at centre ice', null);
          break;
        case 'periodEnd':
          stopFor('End of period', e.period > 3 ? 'Overtime is over' : `End of the ${periodLabel(e.period, playoff).toLowerCase()} period`, null);
          setFoDot(null);
          break;
        case 'gameEnd':
          setStop(null);
          break;
      }
    };
    const frame = (now: number) => {
      const eng = engine.current!;
      if (feed.items.length > eng.consumed) {
        tl.add(feed.items.slice(eng.consumed));
        eng.consumed = feed.items.length;
      }
      const realDt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const rp = replay.current;
      if (rp) {
        // Replay: rewind, play the goal again in slow motion (no play-by-play, no new marks), then return.
        if (!rp.started) {
          motion.seek(rp.from);
          trail.length = 0;
          rp.started = true;
        }
        let adv = realDt * REPLAY_RATE;
        while (adv > 1e-6) {
          const d = Math.min(STEP, adv);
          motion.step(d);
          adv -= d;
        }
        if (motion.P >= rp.to) {
          motion.seek(rp.resume);
          trail.length = 0;
          replay.current = null;
          setReplaying(false);
          replayCb.current?.(false);
        }
      }
      const target = feed.done ? tl.end : Math.min(tl.end, feed.pres + (feed.rate ? ((now - feed.presAt) / 1000) * feed.rate : 0));
      const lag = rp ? 0 : target - motion.P;
      const P0 = motion.P;
      if (rp) {
        /* replaying: the live timeline waits */
      } else if (lag > Math.max(8, feed.rate * 0.75) || (feed.done && lag > 0.5)) {
        motion.snapTo(target - (feed.done ? 0 : 0.5), onKey);
        trail.length = 0;
      } else if (feed.rate > 0 || lag > 0) {
        const catchUp = lag > 0.6 ? 1 + Math.min(1.5, (lag - 0.6) / 2) : lag < -0.2 ? 0.6 : 1;
        let adv = Math.max(0, Math.min(realDt * Math.max(feed.rate, 1) * catchUp, lag + 0.05));
        if (feed.rate === 0) adv = Math.min(adv, lag);
        while (adv > 1e-6) {
          const d = Math.min(STEP, adv);
          motion.step(d, onKey);
          adv -= d;
        }
      }
      if (shown.length) {
        shownRef.current?.(shown);
        shown = [];
      }
      // Paint players: position, plus a heading chevron when skating.
      for (const [id, b] of motion.bodies) {
        const el = els.current.get(id);
        if (el) el.setAttribute('transform', `translate(${b.pos.x.toFixed(2)} ${b.pos.y.toFixed(2)})`);
        const hd = heads.current.get(id);
        if (hd) {
          const sp = Math.hypot(b.vel.x, b.vel.y);
          if (sp > 5 && !b.goalie) {
            hd.setAttribute('transform', `rotate(${((Math.atan2(b.vel.y, b.vel.x) * 180) / Math.PI).toFixed(1)})`);
            hd.style.opacity = String(Math.min(1, (sp - 5) / 12));
          } else hd.style.opacity = '0';
        }
      }
      // Puck, with a faint trail when it is really moving.
      const pk = motion.puck.pos;
      const dP = motion.P - P0;
      const speed = dP > 0 ? Math.hypot(pk.x - prevPuck.x, pk.y - prevPuck.y) / dP : 0;
      prevPuck = { ...pk };
      if (puckEl.current) puckEl.current.setAttribute('transform', `translate(${pk.x.toFixed(2)} ${pk.y.toFixed(2)})`);
      if (speed > 38 && motion.puck.mode.kind !== 'carried') trail.push({ ...pk });
      else trail.splice(0, Math.max(1, Math.ceil(trail.length / 3)));
      if (trail.length > 9) trail.splice(0, trail.length - 9);
      if (trailEl.current) {
        trailEl.current.setAttribute('points', trail.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '));
        trailEl.current.style.opacity = trail.length > 1 ? String(Math.min(0.45, speed / 260)) : '0';
      }
      const nextIds = [...motion.bodies.keys()].sort((a, b) => a - b);
      const key = nextIds.join(',');
      if (key !== idKey) {
        idKey = key;
        setIds(nextIds);
        setPenalized((prev) => prev.filter((x) => motion.bodies.has(x)));
      }
      const c = motion.puck.mode.kind === 'carried' ? motion.puck.mode.carrier : null;
      if (c !== carrierNow) {
        carrierNow = c;
        setCarrier(c);
      }
      const pt = c !== null ? (meta.get(c)?.team ?? null) : null;
      if (pt !== null && pt !== possNow) {
        possNow = pt;
        setPossTeam(pt);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      for (const t of timers) clearTimeout(t);
    };
  }, [feed, meta, home, away, playoff]);

  useEffect(() => {
    if (!goal) return;
    const id = setTimeout(() => setGoal(null), 4800);
    return () => clearTimeout(id);
  }, [goal]);
  useEffect(() => {
    if (!savePulse) return;
    const id = setTimeout(() => setSavePulse(null), 900);
    return () => clearTimeout(id);
  }, [savePulse]);

  const startReplay = () => {
    const g = lastGoal.current;
    if (!g || replay.current) return;
    const m = engine.current!.motion;
    replay.current = { from: Math.max(0, g.s - REPLAY_BEFORE), to: g.s + REPLAY_AFTER, resume: m.P, started: false };
    setGoal(null);
    setReplaying(true);
    replayCb.current?.(true);
  };

  const homeDir = attackDir(0, period);
  const teams = [home, away] as const;
  const colors = [home.colors, away.colors] as const;
  const lightNetX = light === null ? null : attackDir(light, period) > 0 ? RINK.goalR : RINK.goalL;
  const motion = engine.current.motion;
  const activeSet = new Set(active);
  const injuredSet = new Set(injured);
  const penSet = new Set(penalized);
  const name = (id: number | undefined) => (id === undefined ? '' : (meta.get(id)?.last ?? ''));
  const num = (id: number | undefined) => (id === undefined ? '' : meta.get(id)?.number != null ? `#${meta.get(id)!.number} ` : '');

  return (
    <div className="rink-wrap">
      <div className="rink-head">
        <span className="rink-dir" style={{ '--tc': teamBar(home.colors) } as React.CSSProperties}>
          {homeDir < 0 && <i>◀</i>}
          {home.abbr}
          {homeDir > 0 && <i>▶</i>}
          {possTeam === 0 && <em className="poss-dot" title="Has the puck" />}
        </span>
        <span className="rink-tools">
          <span className="rink-chip-row">
          {chips.map((c) => (
            <span key={c.id} className={`rink-chip ${c.tone}`} style={c.team !== null ? ({ '--tc': teamBar(colors[c.team]) } as React.CSSProperties) : undefined}>
              {c.text}
            </span>
          ))}
          </span>

          <button className={`rink-toggle ${showMap ? 'on' : ''}`} onClick={() => setShowMap((v) => !v)} title="Show every shot this period">
            Shot map
          </button>
          {replayable && (
            <button
              className={`rink-toggle ${replaying ? 'on' : ''}`}
              disabled={replaying}
              onClick={startReplay}
              title={`Watch ${meta.get(replayable.p1 ?? -1)?.last ?? 'the last'} goal again in slow motion`}
            >
              ↺ Replay goal
            </button>
          )}
        </span>
        <span className="rink-dir right" style={{ '--tc': teamBar(away.colors) } as React.CSSProperties}>
          {possTeam === 1 && <em className="poss-dot" title="Has the puck" />}
          {homeDir > 0 && <i>◀</i>}
          {away.abbr}
          {homeDir < 0 && <i>▶</i>}
        </span>
      </div>
      <div className="rink-stage">
        <svg className="rink2" viewBox="-4 -4 208 93" role="img" aria-label="Live rink">
          <defs>
            <radialGradient id="ice-g" cx="50%" cy="45%" r="70%">
              <stop offset="0" stopColor="#fbfdff" />
              <stop offset="0.7" stopColor="#eef4f8" />
              <stop offset="1" stopColor="#dde7ee" />
            </radialGradient>
            <radialGradient id="vignette" cx="50%" cy="50%" r="62%">
              <stop offset="0.72" stopColor="#000" stopOpacity="0" />
              <stop offset="1" stopColor="#0b1a2a" stopOpacity="0.16" />
            </radialGradient>
            <linearGradient id="crease-g" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor="#5aa3e0" stopOpacity="0.75" />
              <stop offset="1" stopColor="#8cc3ee" stopOpacity="0.45" />
            </linearGradient>
            <pattern id="mesh" width="0.9" height="0.9" patternUnits="userSpaceOnUse">
              <path d="M0 0 L0.9 0.9 M0.9 0 L0 0.9" stroke="#ffffff" strokeWidth="0.12" opacity="0.8" />
            </pattern>
            <clipPath id="boards">
              <rect x="0" y="0" width="200" height="85" rx="28" />
            </clipPath>
          </defs>
          {/* Boards and glass */}
          <rect x="-3.2" y="-3.2" width="206.4" height="91.4" rx="31" fill="#2a2e34" />
          <rect x="-1.2" y="-1.2" width="202.4" height="87.4" rx="29.2" fill="none" stroke="#e8b923" strokeWidth="0.3" opacity="0.55" />
          <rect x="0" y="0" width="200" height="85" rx="28" fill="url(#ice-g)" />
          <g clipPath="url(#boards)">
            {noise && <image href={noise} x="0" y="0" width="200" height="85" preserveAspectRatio="none" opacity="0.55" />}
            {home.logo && logoOk && <image href={home.logo} x={RINK.cx - 13} y={RINK.cy - 13} width="26" height="26" opacity="0.2" onError={() => setLogoOk(false)} />}
            {/* Lines */}
            <rect x="99.5" y="0" width="1" height="85" fill="#c8102e" />
            <line x1="100" y1="0" x2="100" y2="85" stroke="#fff" strokeWidth="0.22" strokeDasharray="1.1 1.1" />
            <rect x="74.5" y="0" width="1" height="85" fill="#0038a8" />
            <rect x="124.5" y="0" width="1" height="85" fill="#0038a8" />
            <line x1="11" y1="0" x2="11" y2="85" stroke="#c8102e" strokeWidth="0.17" />
            <line x1="189" y1="0" x2="189" y2="85" stroke="#c8102e" strokeWidth="0.17" />
            {/* Centre ice and referee crease */}
            <circle cx="100" cy="42.5" r="15" fill="none" stroke="#0038a8" strokeWidth="0.28" />
            <circle cx="100" cy="42.5" r="0.75" fill="#0038a8" />
            <path d="M90 85 A10 10 0 0 1 110 85" fill="none" stroke="#c8102e" strokeWidth="0.2" />
            {/* End-zone faceoff circles with hash marks */}
            {[31, 169].map((x) =>
              [20.5, 64.5].map((y) => (
                <g key={`${x}-${y}`}>
                  <circle cx={x} cy={y} r="15" fill="none" stroke="#c8102e" strokeWidth="0.28" />
                  {[-1, 1].map((sx) =>
                    [-1, 1].map((sy) => <line key={`${sx}${sy}`} x1={x + sx * 2.9} y1={y + sy * 14.7} x2={x + sx * 2.9} y2={y + sy * 16.7} stroke="#c8102e" strokeWidth="0.25" />),
                  )}
                  {[-1, 1].map((sx) => (
                    <path key={sx} d={`M${x + sx * 2} ${y - 0.75} h${sx * 3} M${x + sx * 2} ${y + 0.75} h${sx * 3}`} stroke="#c8102e" strokeWidth="0.18" />
                  ))}
                  <circle cx={x} cy={y} r="1" fill="#c8102e" />
                </g>
              )),
            )}
            {[80, 120].map((x) => [20.5, 64.5].map((y) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1" fill="#c8102e" />))}
            {/* Goalie trapezoids */}
            <path d="M11 31.5 L0 28.5 M11 53.5 L0 56.5" stroke="#c8102e" strokeWidth="0.18" />
            <path d="M189 31.5 L200 28.5 M189 53.5 L200 56.5" stroke="#c8102e" strokeWidth="0.18" />
            {/* Creases */}
            <path d="M11 38.5 L15.5 38.5 A6 6 0 0 1 15.5 46.5 L11 46.5 Z" fill="url(#crease-g)" stroke="#c8102e" strokeWidth="0.2" />
            <path d="M189 38.5 L184.5 38.5 A6 6 0 0 0 184.5 46.5 L189 46.5 Z" fill="url(#crease-g)" stroke="#c8102e" strokeWidth="0.2" transform="" />
            {/* Nets */}
            {[
              { x: 7.6, flip: false },
              { x: 189, flip: true },
            ].map((n) => (
              <g key={n.x}>
                <rect x={n.x + (n.flip ? 0.5 : -0.4)} y="39.9" width="3.4" height="6" rx="1.3" fill="#000" opacity="0.15" />
                <rect x={n.x} y="39.5" width="3.4" height="6" rx="1.3" fill="url(#mesh)" stroke="#c8102e" strokeWidth="0.55" />
              </g>
            ))}
            <rect x="0" y="0" width="200" height="85" fill="url(#vignette)" />
            {lightNetX !== null && <circle className="goal-light" cx={lightNetX} cy={RINK.cy} r="13" />}
            {/* Optional shot map */}
            {showMap &&
              shots
                .filter((s) => s.period === period)
                .map((s, i) =>
                  s.kind === 'goal' ? (
                    <text key={i} x={s.x} y={s.y + 1.3} className="shot-mk" textAnchor="middle" fill={colors[s.team][0]} fontSize="4">
                      ★
                    </text>
                  ) : (
                    <circle key={i} cx={s.x} cy={s.y} r="1" className="shot-mk" fill={s.kind === 'save' ? colors[s.team][0] : 'none'} stroke={colors[s.team][0]} strokeWidth="0.3" />
                  ),
                )}
            {foDot && <circle className="fo-dot" cx={foDot.x} cy={foDot.y} r="4" />}
            {/* Shot trajectories (fade out) */}
            {trajs.map((t) => (
              <g key={t.id} className={`traj ${t.kind}`}>
                <line x1={t.from.x} y1={t.from.y} x2={t.to.x} y2={t.to.y} />
                <circle cx={t.from.x} cy={t.from.y} r="0.7" />
                {t.kind === 'block' && <path d={`M${t.to.x - 1} ${t.to.y - 1} l2 2 M${t.to.x + 1} ${t.to.y - 1} l-2 2`} className="x" />}
              </g>
            ))}
            {/* Players */}
            {ids.map((id) => {
              const m = meta.get(id);
              if (!m) return null;
              const b = motion.bodies.get(id);
              const isG = m.pos === 'G' || snap.goalies[m.team] === id;
              const [c1, c2] = colors[m.team];
              const fill = m.team === 0 ? c1 : '#ffffff';
              const ring = m.team === 0 ? (lum(c2) > 0.85 && lum(c1) > 0.6 ? '#111' : c2) : c1;
              const text = m.team === 0 ? textOn(c1) : c1;
              const isCarrier = carrier === id;
              const isActive = activeSet.has(id);
              return (
                <g
                  key={id}
                  className={`pm${isCarrier ? ' carrying' : ''}${isActive ? ' active' : ''}`}
                  ref={(el) => {
                    if (el) els.current.set(id, el);
                    else els.current.delete(id);
                  }}
                  transform={b ? `translate(${b.pos.x} ${b.pos.y})` : undefined}
                >
                  <ellipse className="shadow" cx="0.6" cy="1" rx={isG ? 3.8 : 3.3} ry={isG ? 3 : 2.6} />
                  {!isG && (
                    <g
                      ref={(el) => {
                        if (el) heads.current.set(id, el);
                        else heads.current.delete(id);
                      }}
                      style={{ opacity: 0 }}
                    >
                      <path d="M3.4 -1.5 L5.6 0 L3.4 1.5 Z" fill={m.team === 0 ? c1 : c1} opacity="0.85" />
                    </g>
                  )}
                  {isCarrier && <circle className="carrier-ring" r="4.9" style={{ stroke: m.team === 0 ? c1 : c1 }} />}
                  {savePulse?.id === id && <circle key={savePulse.n} className="save-pulse" r="4" />}
                  {isG ? (
                    <g>
                      <rect x="-3.6" y="-3.1" width="7.2" height="6.2" rx="2.2" fill={fill} stroke={ring} strokeWidth="0.7" />
                      <rect x="-3.6" y="-0.45" width="7.2" height="0.9" fill={ring} opacity="0.55" />
                    </g>
                  ) : (
                    <circle r="3.15" fill={fill} stroke={ring} strokeWidth="0.65" />
                  )}
                  {isActive && <circle className="active-ring" r={isG ? 4.6 : 3.95} />}
                  <text className="num" y="1.1" textAnchor="middle" fontSize={m.number !== null && m.number >= 10 ? 2.9 : 3.2} fill={text}>
                    {m.number ?? ''}
                  </text>
                  <text className="nm" y={isG ? 6.1 : 5.7} textAnchor="middle">
                    {surname(m)}
                  </text>
                  {injuredSet.has(id) && (
                    <g transform="translate(2.8 -2.8)">
                      <circle r="1.3" fill="#d62828" stroke="#fff" strokeWidth="0.25" />
                      <path d="M-0.6 0 H0.6 M0 -0.6 V0.6" stroke="#fff" strokeWidth="0.35" />
                    </g>
                  )}
                  {penSet.has(id) && (
                    <g transform="translate(-3 -3.2)">
                      <rect x="-1.9" y="-0.9" width="3.8" height="1.8" rx="0.5" fill="#f6c445" />
                      <text y="0.55" textAnchor="middle" fontSize="1.3" fontWeight="800" fill="#111">
                        PEN
                      </text>
                    </g>
                  )}
                </g>
              );
            })}
            {/* Puck */}
            <polyline ref={trailEl} className="puck-trail" points="" />
            <g ref={puckEl} transform={`translate(${motion.puck.pos.x} ${motion.puck.pos.y})`}>
              {/* A soft halo so the puck reads against dark jerseys and the boards. */}
              <circle r="2.3" className="puck-halo" />
              <ellipse cx="0.35" cy="0.5" rx="1.2" ry="0.95" fill="#000" opacity="0.25" />
              <circle r="1.15" fill="#0c0c0c" stroke="#ffffff" strokeWidth="0.35" />
            </g>
          </g>
        </svg>
        <div className="rink-chips">
          {stop && !replaying && (
            <div key={stop.id} className={`rink-stop ${stop.tone}`} style={stop.team !== null ? ({ '--tc': teamBar(colors[stop.team]) } as React.CSSProperties) : undefined}>
              <span className="rs-tag">{stop.tone === 'faceoff' ? 'Faceoff' : stop.tone === 'penalty' ? 'Penalty' : 'Whistle'}</span>
              <span className="rs-body">
                <b>{stop.title}</b>
                <span>{stop.sub}</span>
              </span>
            </div>
          )}
        </div>
        {replaying && replayable && (
          <div className="replay-banner" style={{ '--tc': teamBar(colors[replayable.team]) } as React.CSSProperties}>
            <span className="rb-tag">Replay</span>
            <span>
              {num(replayable.p1)}
              {name(replayable.p1)} · {teams[replayable.team].abbr}
            </span>
          </div>
        )}
        {goal && !replaying && (
          <div key={goal.id} className="goal-card" style={{ '--tc': teamBar(colors[goal.event.team]) } as React.CSSProperties}>
            <div className="gc-head">
              <span className="gc-label">GOAL</span>
              <span className="gc-team">
                {teams[goal.event.team].city} {teams[goal.event.team].name}
              </span>
            </div>
            <div className="gc-scorer">
              {num(goal.event.p1)}
              <b>
                {meta.get(goal.event.p1 ?? -1)?.first ?? ''} {name(goal.event.p1)}
              </b>
              {goal.counts?.scorer !== undefined && <span className="gc-count" title="Goals this season">({goal.counts.scorer})</span>}
            </div>
            <div className="gc-assists">
              {goal.event.p2 !== undefined
                ? `Assists: ${[goal.event.p2, goal.event.p3]
                    .filter((x): x is number => x !== undefined)
                    .map((x, i) => `${num(x)}${name(x)}${goal.counts?.assists[i] !== undefined ? ` (${goal.counts.assists[i]})` : ''}`)
                    .join(', ')}`
                : 'Unassisted'}
              {goal.event.data?.strength && goal.event.data.strength !== 'EV' ? ` · ${goal.event.data.strength}` : ''}
              {goal.event.data?.en ? ' · Empty net' : ''}
            </div>
            <div className="gc-time">
              {clockLabel(goal.event.clock, goal.event.period > 3 && !playoff ? 300 : 1200)} · {goal.event.period > 3 ? 'Overtime' : `${periodLabel(goal.event.period, playoff)} Period`}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function lum(hex: string): number {
  const n = parseInt(hex.replace('#', ''), 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

/** Black or white text, whichever reads on a jersey colour. */
function textOn(hex: string): string {
  return lum(hex) > 0.62 ? '#111' : '#fff';
}
