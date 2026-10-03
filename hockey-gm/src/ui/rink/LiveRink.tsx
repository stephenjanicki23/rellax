import { useEffect, useMemo, useRef, useState } from 'react';
import type { GameSnapshot } from '../../engine/sim/gameTypes';
import type { Team } from '../../engine/types';
import { RINK, RinkDirector, attackDir, type Flash, type RinkPlayer, type ShotMark } from './director';
import { RinkMotion, RinkTimeline, type Key, type TimelineItem } from './motion';
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

export interface LiveRinkProps {
  feed: RinkFeed;
  snap: GameSnapshot;
  home: Pick<Team, 'abbr' | 'colors' | 'logo'>;
  away: Pick<Team, 'abbr' | 'colors' | 'logo'>;
  players: RinkPlayer[];
}

const STEP = 1 / 120;

export function LiveRink({ feed, snap, home, away, players }: LiveRinkProps) {
  const meta = useMemo(() => new Map(players.map((p) => [p.id, p])), [players]);
  const engine = useRef<{ tl: RinkTimeline; motion: RinkMotion; consumed: number } | null>(null);
  if (!engine.current) {
    const tl = new RinkTimeline(new RinkDirector(meta, [home.abbr, away.abbr]));
    engine.current = { tl, motion: new RinkMotion(tl, meta), consumed: 0 };
  }
  const els = useRef(new Map<number, SVGGElement>());
  const puckEl = useRef<SVGGElement | null>(null);
  const [ids, setIds] = useState<number[]>([]);
  const [carrier, setCarrier] = useState<number | null>(null);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [light, setLight] = useState<0 | 1 | null>(null);
  const [shots, setShots] = useState<ShotMark[]>([]);
  const [period, setPeriod] = useState(1);
  const [logoOk, setLogoOk] = useState(true);

  useEffect(() => {
    const { tl, motion } = engine.current!;
    let raf = 0;
    let last = performance.now();
    let idKey = '';
    let carrierNow: number | null = null;
    const onKey = (k: Key) => {
      if (k.flash) setFlash(k.flash);
      if (k.goalLight !== null) setLight(k.goalLight);
      if (k.mark) setShots((prev) => [...prev, k.mark!]);
      setPeriod((p) => (p !== k.period ? k.period : p));
    };
    const frame = (now: number) => {
      const eng = engine.current!;
      // Schedule any new events.
      if (feed.items.length > eng.consumed) {
        tl.add(feed.items.slice(eng.consumed));
        eng.consumed = feed.items.length;
      }
      const realDt = Math.min(0.1, (now - last) / 1000);
      last = now;
      // Where the game says we should be, extrapolated between playback ticks.
      const target = feed.done ? tl.end : Math.min(tl.end, feed.pres + (feed.rate ? ((now - feed.presAt) / 1000) * feed.rate : 0));
      const lag = target - motion.P;
      if (lag > Math.max(8, feed.rate * 0.75) || (feed.done && lag > 0.5)) {
        motion.snapTo(target - (feed.done ? 0 : 0.5), onKey);
      } else if (feed.rate > 0 || lag > 0) {
        // Run at playback speed, easing to catch up (or slow down) so we stay in sync.
        const catchUp = lag > 0.6 ? 1 + Math.min(1.5, (lag - 0.6) / 2) : lag < -0.2 ? 0.6 : 1;
        let adv = Math.max(0, Math.min(realDt * Math.max(feed.rate, 1) * catchUp, lag + 0.05));
        if (feed.rate === 0) adv = Math.min(adv, lag);
        while (adv > 1e-6) {
          const d = Math.min(STEP, adv);
          motion.step(d, onKey);
          adv -= d;
        }
      }
      // Paint.
      for (const [id, b] of motion.bodies) {
        const el = els.current.get(id);
        if (el) el.setAttribute('transform', `translate(${b.pos.x.toFixed(2)} ${b.pos.y.toFixed(2)})`);
      }
      if (puckEl.current) puckEl.current.setAttribute('transform', `translate(${motion.puck.pos.x.toFixed(2)} ${motion.puck.pos.y.toFixed(2)})`);
      const nextIds = [...motion.bodies.keys()].sort((a, b) => a - b);
      const key = nextIds.join(',');
      if (key !== idKey) {
        idKey = key;
        setIds(nextIds);
      }
      const c = motion.puck.mode.kind === 'carried' ? motion.puck.mode.carrier : null;
      if (c !== carrierNow) {
        carrierNow = c;
        setCarrier(c);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [feed]);

  useEffect(() => {
    if (!flash) return;
    const id = setTimeout(() => setFlash(null), flash.kind === 'goal' ? 2800 : 1300);
    return () => clearTimeout(id);
  }, [flash]);
  useEffect(() => {
    if (light === null) return;
    const id = setTimeout(() => setLight(null), 3000);
    return () => clearTimeout(id);
  }, [light]);
  useEffect(() => setShots((prev) => prev.filter((s) => s.period === period)), [period]);

  const homeDir = attackDir(0, period);
  const colors = [home.colors, away.colors] as const;
  const lightNetX = light === null ? null : attackDir(light, period) > 0 ? RINK.goalR : RINK.goalL;
  const motion = engine.current.motion;

  return (
    <div className="rink-wrap">
      <div className="rink-head">
        <span className="rink-team">
          {homeDir < 0 && <i className="arrow">◀</i>}
          <b style={{ color: 'var(--text)' }}>{home.abbr}</b>
          {homeDir > 0 && <i className="arrow">▶</i>}
        </span>
        <span className="rink-key">
          <span className="sw" style={{ background: home.colors[0], borderColor: home.colors[1] }} /> Home
          <span className="sw" style={{ background: '#fff', borderColor: away.colors[0] }} /> Away
          <span className="mk goal">★</span> Goal <span className="mk save">●</span> Shot <span className="mk miss">○</span> Miss/block
        </span>
        <span className="rink-team">
          {homeDir > 0 && <i className="arrow">◀</i>}
          <b style={{ color: 'var(--text)' }}>{away.abbr}</b>
          {homeDir < 0 && <i className="arrow">▶</i>}
        </span>
      </div>
      <svg className="rink2" viewBox={`0 0 ${RINK.w} ${RINK.h}`} role="img" aria-label="Live rink">
        <defs>
          <linearGradient id="ice" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#f4f8fb" />
            <stop offset="1" stopColor="#dfe8ef" />
          </linearGradient>
          <clipPath id="boards">
            <rect x="0.5" y="0.5" width="199" height="84" rx="28" />
          </clipPath>
        </defs>
        <rect x="0.5" y="0.5" width="199" height="84" rx="28" fill="url(#ice)" stroke="#1d2024" strokeWidth="1.4" />
        <g clipPath="url(#boards)">
          {home.logo && logoOk && <image href={home.logo} x={RINK.cx - 11} y={RINK.cy - 11} width="22" height="22" opacity="0.22" onError={() => setLogoOk(false)} />}
          <line x1="100" y1="0" x2="100" y2="85" stroke="#c8102e" strokeWidth="1" />
          <line x1="100" y1="0" x2="100" y2="85" stroke="#fff" strokeWidth="0.25" strokeDasharray="1.2 1.2" />
          <line x1="75" y1="0" x2="75" y2="85" stroke="#0038a8" strokeWidth="1" />
          <line x1="125" y1="0" x2="125" y2="85" stroke="#0038a8" strokeWidth="1" />
          <line x1="11" y1="0" x2="11" y2="85" stroke="#c8102e" strokeWidth="0.25" />
          <line x1="189" y1="0" x2="189" y2="85" stroke="#c8102e" strokeWidth="0.25" />
          <circle cx="100" cy="42.5" r="15" fill="none" stroke="#0038a8" strokeWidth="0.35" />
          <circle cx="100" cy="42.5" r="0.7" fill="#0038a8" />
          {[31, 169].map((x) =>
            [20.5, 64.5].map((y) => (
              <g key={`${x}-${y}`}>
                <circle cx={x} cy={y} r="15" fill="none" stroke="#c8102e" strokeWidth="0.35" />
                <circle cx={x} cy={y} r="1" fill="#c8102e" />
              </g>
            )),
          )}
          {[80, 120].map((x) => [20.5, 64.5].map((y) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1" fill="#c8102e" />))}
          <path d="M11 36.5 A6 6 0 0 1 11 48.5 Z" fill="#7cb7e8" fillOpacity="0.55" stroke="#c8102e" strokeWidth="0.3" />
          <path d="M189 36.5 A6 6 0 0 0 189 48.5 Z" fill="#7cb7e8" fillOpacity="0.55" stroke="#c8102e" strokeWidth="0.3" />
          <rect x="7.6" y="39.5" width="3.4" height="6" rx="1" fill="none" stroke="#c8102e" strokeWidth="0.6" />
          <rect x="189" y="39.5" width="3.4" height="6" rx="1" fill="none" stroke="#c8102e" strokeWidth="0.6" />
          {lightNetX !== null && <circle className="goal-light" cx={lightNetX} cy={RINK.cy} r="14" />}
          {shots.map((s, i) =>
            s.kind === 'goal' ? (
              <text key={i} x={s.x} y={s.y + 1.4} className="shot-mk" textAnchor="middle" fill={colors[s.team][0]} fontSize="4.2">
                ★
              </text>
            ) : (
              <circle key={i} cx={s.x} cy={s.y} r="1.1" className="shot-mk" fill={s.kind === 'save' ? colors[s.team][0] : 'none'} stroke={colors[s.team][0]} strokeWidth="0.35" />
            ),
          )}
          {ids.map((id) => {
            const m = meta.get(id);
            if (!m) return null;
            const b = motion.bodies.get(id);
            const isG = m.pos === 'G' || snap.goalies[m.team] === id;
            const [c1, c2] = colors[m.team];
            const fill = m.team === 0 ? c1 : '#ffffff';
            const ring = m.team === 0 ? c2 : c1;
            const text = m.team === 0 ? textOn(c1) : c1;
            return (
              <g
                key={id}
                className="pl"
                ref={(el) => {
                  if (el) els.current.set(id, el);
                  else els.current.delete(id);
                }}
                transform={b ? `translate(${b.pos.x} ${b.pos.y})` : undefined}
              >
                {carrier === id && <circle r="4.6" className="carrier" />}
                {isG ? <rect x="-3.2" y="-3.6" width="6.4" height="7.2" rx="1.6" fill={fill} stroke={ring} strokeWidth="0.7" /> : <circle r="3.3" fill={fill} stroke={ring} strokeWidth="0.7" />}
                <text y="1.15" textAnchor="middle" fontSize={m.number !== null && m.number >= 10 ? 3 : 3.3} fontWeight="800" fill={text}>
                  {m.number ?? ''}
                </text>
              </g>
            );
          })}
          <g ref={puckEl} transform={`translate(${motion.puck.pos.x} ${motion.puck.pos.y})`}>
            <circle r="1.25" fill="#0a0a0a" stroke="#fff" strokeWidth="0.3" />
          </g>
        </g>
      </svg>
      {flash && (
        <div key={flash.id} className={`rink-flash ${flash.kind}`} style={flash.team !== null ? { borderColor: colors[flash.team][0] } : undefined}>
          {flash.text}
        </div>
      )}
    </div>
  );
}

/** Black or white text, whichever reads on a jersey colour. */
function textOn(hex: string): string {
  const n = parseInt(hex.replace('#', ''), 16);
  const l = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return l > 0.62 ? '#111' : '#fff';
}
