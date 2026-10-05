import { useMemo, useState, type ReactNode } from 'react';
import type { League, Player, Position, Team } from '../../engine/types';
import { href } from '../router';
import { stars as starValue } from '../../engine/player/ability';

/** Image URLs that failed to load this session (offline, blocked CDN), so we stop retrying them. */
const brokenImages = new Set<string>();

export function TeamLogo({ team, size = 28 }: { team: Pick<Team, 'abbr' | 'colors'> & { logo?: string }; size?: number }) {
  const [, setBroken] = useState(0);
  const [a, b] = team.colors;
  if (team.logo && !brokenImages.has(team.logo)) {
    const src = team.logo;
    return (
      <img
        src={src}
        width={size}
        height={size}
        alt={team.abbr}
        loading="lazy"
        style={{ flex: 'none', objectFit: 'contain' }}
        onError={() => {
          brokenImages.add(src);
          setBroken((n) => n + 1);
        }}
      />
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-label={team.abbr} style={{ flex: 'none' }}>
      <path d="M20 2 L36 8 L34 26 Q30 34 20 38 Q10 34 6 26 L4 8 Z" fill={a} stroke={b} strokeWidth="2.5" />
      <text x="20" y="24.5" textAnchor="middle" fontSize={team.abbr.length > 3 ? 9 : 11} fontWeight="800" fill={b} fontFamily="system-ui, sans-serif">
        {team.abbr}
      </text>
    </svg>
  );
}

/** Player headshot in a team-coloured circle; renders `fallback` when there is no photo or it fails to load. */
export function Headshot({ p, size = 48, color, fallback = null }: { p: Pick<Player, 'headshot' | 'first' | 'last'>; size?: number; color?: string; fallback?: ReactNode }) {
  const [, setBroken] = useState(0);
  if (!p.headshot || brokenImages.has(p.headshot)) return <>{fallback}</>;
  const src = p.headshot;
  return (
    <img
      className="headshot"
      src={src}
      width={size}
      height={size}
      alt={`${p.first} ${p.last}`}
      loading="lazy"
      style={{ background: `radial-gradient(circle at 50% 35%, ${color ?? '#3a3d43'}, #101113 75%)` }}
      onError={() => {
        brokenImages.add(src);
        setBroken((n) => n + 1);
      }}
    />
  );
}

export function TeamLink({ league, id, short = false, logo = false }: { league: League; id: number | null | undefined; short?: boolean; logo?: boolean }) {
  if (id === null || id === undefined || !league.teams[id]) return <span className="dim">FA</span>;
  const t = league.teams[id];
  return (
    <a href={href(`team/${id}`)} className="row" style={{ display: 'inline-flex', gap: 6 }}>
      {logo && <TeamLogo team={t} size={18} />}
      {short ? t.abbr : `${t.city} ${t.name}`}
    </a>
  );
}

export function PlayerLink({ p, full = true }: { p: Player | undefined; full?: boolean }) {
  if (!p) return <span className="dim">—</span>;
  return <a href={href(`player/${p.id}`)}>{full ? `${p.first} ${p.last}` : `${p.first[0]}. ${p.last}`}</a>;
}

export function Pos({ pos }: { pos: Position }) {
  return <span className={`pos ${pos}`}>{pos}</span>;
}

export function Stars({ value, range }: { value: number; range?: [number, number] }) {
  const s = starValue(value);
  const full = Math.floor(s);
  const half = s - full >= 0.5;
  const title = range ? `${range[0]}–${range[1]}` : String(Math.round(value));
  return (
    <span className="stars" title={title}>
      {'★'.repeat(full)}
      {half ? '⯨' : ''}
      <span className="off">{'★'.repeat(5 - full - (half ? 1 : 0))}</span>
    </span>
  );
}

export function Bar({ value, max = 200, color }: { value: number; max?: number; color?: string }) {
  const w = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="bar">
      <i style={{ width: `${w}%`, background: color }} />
    </div>
  );
}

export function attrColor(v20: number): string {
  if (v20 >= 16) return 'var(--good)';
  if (v20 >= 12) return 'var(--accent)';
  if (v20 >= 8) return 'var(--warn)';
  return 'var(--bad)';
}

export function Card({ title, right, children, tight, className }: { title?: ReactNode; right?: ReactNode; children: ReactNode; tight?: boolean; className?: string }) {
  return (
    <div className={`card ${tight ? 'tight' : ''} ${className ?? ''}`}>
      {(title || right) && (
        <div className="card-head">
          {typeof title === 'string' ? <h3>{title}</h3> : title}
          {right && <div className="right">{right}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

export function Stat({ k, v, sub }: { k: string; v: ReactNode; sub?: ReactNode }) {
  return (
    <div className="stat">
      <span className="k">{k}</span>
      <span className="v">{v}</span>
      {sub && <span className="muted" style={{ fontSize: 12 }}>{sub}</span>}
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string }[]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="tabs">
      {tabs.map((t) => (
        <button key={t.id} className={t.id === value ? 'on' : ''} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Seg<T extends string>({ options, value, onChange }: { options: { id: T; label: string }[]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={o.id} className={o.id === value ? 'on' : ''} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Modal({ children, onClose, title, wide, closable = true }: { children: ReactNode; onClose: () => void; title?: string; wide?: boolean; closable?: boolean }) {
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className={`modal${wide ? ' wide' : ''}`} onClick={(e) => e.stopPropagation()}>
        {title && (
          <div className="row" style={{ marginBottom: 12 }}>
            <h2>{title}</h2>
            {closable && (
              <button className="btn small ghost" style={{ marginLeft: 'auto' }} onClick={onClose}>
                ✕
              </button>
            )}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

export interface Column<T> {
  key: string;
  label: string;
  title?: string;
  render: (row: T, i: number) => ReactNode;
  sort?: (row: T) => number | string;
  num?: boolean;
  defaultDesc?: boolean;
}

export function Table<T>({
  rows,
  columns,
  initialSort,
  rowKey,
  rowClass,
  limit,
  empty = 'Nothing to show',
}: {
  rows: T[];
  columns: Column<T>[];
  initialSort?: { key: string; desc?: boolean };
  rowKey: (row: T) => string | number;
  rowClass?: (row: T, i: number) => string | undefined;
  limit?: number;
  empty?: string;
}) {
  const [sort, setSort] = useState<{ key: string; desc: boolean } | null>(initialSort ? { key: initialSort.key, desc: initialSort.desc ?? true } : null);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sort) return rows;
    const f = col.sort;
    return [...rows].sort((a, b) => {
      const va = f(a);
      const vb = f(b);
      const cmp = typeof va === 'string' || typeof vb === 'string' ? String(va).localeCompare(String(vb)) : (va as number) - (vb as number);
      return sort.desc ? -cmp : cmp;
    });
  }, [rows, sort, columns]);
  const shown = limit ? sorted.slice(0, limit) : sorted;
  if (!rows.length) return <div className="empty">{empty}</div>;
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                title={c.title}
                className={`${c.num ? 'num' : ''} ${sort?.key === c.key ? 'sorted' : ''}`}
                onClick={() => c.sort && setSort((s) => (s?.key === c.key ? { key: c.key, desc: !s.desc } : { key: c.key, desc: c.defaultDesc ?? !!c.num }))}
              >
                {c.label}
                {sort?.key === c.key ? (sort.desc ? ' ▾' : ' ▴') : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((r, i) => (
            <tr key={rowKey(r)} className={rowClass?.(r, i)}>
              {columns.map((c) => (
                <td key={c.key} className={c.num ? 'num' : ''}>
                  {c.render(r, i)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Simple SVG histogram / bar chart. */
export function BarChart({ data, height = 140, color = 'var(--accent)', band, labelEvery = 1, valueFmt }: { data: { label: string; value: number }[]; height?: number; color?: string; band?: [number, number]; labelEvery?: number; valueFmt?: (v: number) => string }) {
  const w = Math.max(240, data.length * 22);
  const max = Math.max(1e-9, ...data.map((d) => d.value));
  const bw = w / data.length;
  return (
    <svg className="chart" viewBox={`0 0 ${w} ${height + 18}`} width="100%" preserveAspectRatio="none" style={{ maxHeight: height + 30 }}>
      {[0.25, 0.5, 0.75].map((g) => (
        <line key={g} className="gridline" x1={0} x2={w} y1={height * (1 - g)} y2={height * (1 - g)} />
      ))}
      {data.map((d, i) => {
        const h = (d.value / max) * (height - 4);
        const inBand = band ? i >= band[0] && i <= band[1] : true;
        return (
          <g key={d.label}>
            <rect x={i * bw + 2} y={height - h} width={bw - 4} height={h} rx={2} fill={color} opacity={inBand ? 0.9 : 0.4}>
              <title>{`${d.label}: ${valueFmt ? valueFmt(d.value) : d.value}`}</title>
            </rect>
            {i % labelEvery === 0 && (
              <text x={i * bw + bw / 2} y={height + 13} textAnchor="middle">
                {d.label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** Small multi-series line chart. */
export function LineChart({ series, height = 120, yFmt }: { series: { label: string; color: string; values: number[] }[]; height?: number; yFmt?: (v: number) => string }) {
  const n = Math.max(2, ...series.map((s) => s.values.length));
  const all = series.flatMap((s) => s.values);
  if (!all.length) return <div className="empty">No data yet</div>;
  const min = Math.min(...all);
  const max = Math.max(...all);
  const w = 400;
  const y = (v: number) => (max === min ? height / 2 : height - 6 - ((v - min) / (max - min)) * (height - 12));
  const x = (i: number) => 30 + (i / (n - 1)) * (w - 36);
  return (
    <svg className="chart" viewBox={`0 0 ${w} ${height}`} width="100%">
      {[min, (min + max) / 2, max].map((v, i) => (
        <g key={i}>
          <line className="gridline" x1={30} x2={w} y1={y(v)} y2={y(v)} />
          <text x={2} y={y(v) + 3}>
            {yFmt ? yFmt(v) : Math.round(v)}
          </text>
        </g>
      ))}
      {series.map((s) => (
        <polyline key={s.label} fill="none" stroke={s.color} strokeWidth={2} points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ')}>
          <title>{s.label}</title>
        </polyline>
      ))}
    </svg>
  );
}

export function Gauge({ value, max = 100, label }: { value: number; max?: number; label: string }) {
  const pctV = Math.max(0, Math.min(1, value / max));
  const color = pctV > 0.66 ? 'var(--good)' : pctV > 0.4 ? 'var(--warn)' : 'var(--bad)';
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="muted">{label}</span>
        <b style={{ color }}>{Math.round(value)}</b>
      </div>
      <Bar value={value} max={max} color={color} />
    </div>
  );
}

export function moraleLabel(m: number): { text: string; cls: string } {
  if (m >= 80) return { text: 'Superb', cls: 'good' };
  if (m >= 65) return { text: 'Good', cls: 'good' };
  if (m >= 45) return { text: 'Okay', cls: 'muted' };
  if (m >= 30) return { text: 'Poor', cls: 'warn' };
  return { text: 'Very poor', cls: 'bad' };
}
