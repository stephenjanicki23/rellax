import { useEffect, useMemo, useRef, useState } from 'react';
import type { GameEvent, GameSnapshot } from '../../engine/sim/gameTypes';
import type { Team } from '../../engine/types';
import { RINK, RinkDirector, attackDir, type Frame, type IceState, type RinkPlayer } from './director';
import './rink.css';

export interface LiveRinkProps {
  /** Events revealed so far, in order (the rink plays the new ones). */
  events: GameEvent[];
  snap: GameSnapshot;
  home: Pick<Team, 'abbr' | 'colors' | 'logo'>;
  away: Pick<Team, 'abbr' | 'colors' | 'logo'>;
  players: RinkPlayer[];
  /** Playback speed (game seconds per real second); 0 when paused. */
  rate: number;
}

/** Real-time length of one animation beat at a playback speed. */
const beatMs = (rate: number) => (rate <= 1 ? 650 : rate <= 2 ? 480 : rate <= 5 ? 320 : rate <= 10 ? 220 : rate <= 30 ? 140 : 90);

export function LiveRink({ events, snap, home, away, players, rate }: LiveRinkProps) {
  const meta = useMemo(() => new Map(players.map((p) => [p.id, p])), [players]);
  const dirRef = useRef<RinkDirector | null>(null);
  if (!dirRef.current) dirRef.current = new RinkDirector(meta, [home.abbr, away.abbr]);
  const director = dirRef.current;
  const seen = useRef(0);
  const queue = useRef<Frame[]>([]);
  const snapRef = useRef(snap);
  snapRef.current = snap;
  const ice = (): IceState => ({ period: snapRef.current.inShootout ? 5 : snapRef.current.period, onIce: snapRef.current.onIce, goalies: snapRef.current.goalies });
  const [frame, setFrame] = useState<Frame>(() => director.idle(ice()));
  const [flash, setFlash] = useState<Frame['flash']>(null);
  const [light, setLight] = useState<0 | 1 | null>(null);
  const [logoOk, setLogoOk] = useState(true);
  const beat = beatMs(rate || 1);

  // Turn newly revealed events into frames.
  useEffect(() => {
    if (events.length < seen.current) seen.current = 0;
    const fresh = events.slice(seen.current);
    seen.current = events.length;
    for (const e of fresh) queue.current.push(...director.apply(e, ice()));
    // Way behind (fast speeds / instant result): keep only the latest frames.
    if (queue.current.length > 6) queue.current = queue.current.slice(-3);
    if (rate === 0 && queue.current.length) {
      setFrame(queue.current[queue.current.length - 1]);
      queue.current = [];
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events]);

  // Play the queue one beat at a time; drift a little when nothing is happening.
  useEffect(() => {
    if (rate === 0) return;
    let idleBeats = 0;
    const id = setInterval(() => {
      const next = queue.current.shift();
      if (next) {
        idleBeats = 0;
        setFrame(next);
        if (next.flash) setFlash(next.flash);
        if (next.goalLight !== null) setLight(next.goalLight);
      } else if (++idleBeats >= Math.max(1, Math.round(900 / beat))) {
        idleBeats = 0;
        setFrame(director.idle(ice()));
      }
    }, beat);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rate, beat]);

  useEffect(() => {
    if (!flash) return;
    const id = setTimeout(() => setFlash(null), flash.kind === 'goal' ? 2600 : 1300);
    return () => clearTimeout(id);
  }, [flash]);
  useEffect(() => {
    if (light === null) return;
    const id = setTimeout(() => setLight(null), 2600);
    return () => clearTimeout(id);
  }, [light]);

  const period = snap.inShootout ? 5 : snap.period;
  const homeDir = attackDir(0, period);
  const colors = [home.colors, away.colors] as const;
  const speed = frame.motion === 'shot' ? beat * 0.45 : frame.motion === 'pass' ? beat * 0.6 : beat * 0.95;
  const onIce = Object.keys(frame.players).map(Number);
  const goalieIds = new Set([snap.goalies[0], snap.goalies[1]]);
  const lightNetX = light === null ? null : attackDir(light, period) > 0 ? RINK.goalR : RINK.goalL;

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
          {/* Centre ice logo */}
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
          {/* Creases and nets */}
          <path d="M11 36.5 A6 6 0 0 1 11 48.5 Z" fill="#7cb7e8" fillOpacity="0.55" stroke="#c8102e" strokeWidth="0.3" />
          <path d="M189 36.5 A6 6 0 0 0 189 48.5 Z" fill="#7cb7e8" fillOpacity="0.55" stroke="#c8102e" strokeWidth="0.3" />
          <rect x="7.6" y="39.5" width="3.4" height="6" rx="1" fill="none" stroke="#c8102e" strokeWidth="0.6" />
          <rect x="189" y="39.5" width="3.4" height="6" rx="1" fill="none" stroke="#c8102e" strokeWidth="0.6" />
          {lightNetX !== null && <circle className="goal-light" cx={lightNetX} cy={RINK.cy} r="14" />}
          {/* Shot map for the current period */}
          {director.shots
            .filter((s) => s.period === period)
            .map((s, i) =>
              s.kind === 'goal' ? (
                <text key={i} x={s.x} y={s.y + 1.4} className="shot-mk" textAnchor="middle" fill={s.team === 0 ? home.colors[0] : away.colors[0]} fontSize="4.2">
                  ★
                </text>
              ) : (
                <circle key={i} cx={s.x} cy={s.y} r="1.1" className="shot-mk" fill={s.kind === 'save' ? (s.team === 0 ? home.colors[0] : away.colors[0]) : 'none'} stroke={s.team === 0 ? home.colors[0] : away.colors[0]} strokeWidth="0.35" />
              ),
            )}
          {/* Players */}
          {onIce.map((id) => {
            const m = meta.get(id);
            if (!m) return null;
            const pt = frame.players[id];
            const isG = goalieIds.has(id) || (m.pos === 'G');
            const [c1, c2] = colors[m.team];
            const fill = m.team === 0 ? c1 : '#ffffff';
            const ring = m.team === 0 ? c2 : c1;
            const text = m.team === 0 ? textOn(c1) : c1;
            return (
              <g key={id} className="pl" style={{ transform: `translate(${pt.x}px, ${pt.y}px)`, transitionDuration: `${speed}ms` }}>
                {frame.carrier === id && <circle r="4.6" className="carrier" />}
                {isG ? <rect x="-3.2" y="-3.6" width="6.4" height="7.2" rx="1.6" fill={fill} stroke={ring} strokeWidth="0.7" /> : <circle r="3.3" fill={fill} stroke={ring} strokeWidth="0.7" />}
                <text y="1.15" textAnchor="middle" fontSize={m.number !== null && m.number >= 10 ? 3 : 3.3} fontWeight="800" fill={text}>
                  {m.number ?? ''}
                </text>
              </g>
            );
          })}
          {/* Puck */}
          <g className="pk" style={{ transform: `translate(${frame.puck.x}px, ${frame.puck.y}px)`, transitionDuration: `${frame.motion === 'still' ? 0 : speed}ms` }}>
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
