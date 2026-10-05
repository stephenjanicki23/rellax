import { useMemo, useState, type ReactNode } from 'react';
import type { AttrKey, Player } from '../../engine/types';
import { ATTR_GROUPS, GOALIE_ATTR_GROUPS } from '../../engine/types';
import { useGame } from '../store';
import { useRoute, navigate } from '../router';
import { Card, Headshot, PlayerLink, Pos, Stars, TeamLink } from '../components/common';
import { displayedAttr, estimate } from '../../engine/economy/scouting';
import { attr20 } from '../../engine/player/ability';
import { ARCHETYPES } from '../../engine/player/archetypes';
import { PERSONALITIES } from '../../engine/player/personality';
import { fmtMoney } from '../../engine/economy/contracts';
import { addStatLine, assists, emptyStatLine, gaa, points, savePct } from '../../engine/core/statline';
import { attrLabel } from '../attrLabels';
import { lastRealSeason } from '../../engine/data/nhl/realStats';

const MAX = 4;

interface Row {
  label: string;
  /** Numeric value used to pick the best (higher is better unless `low`). */
  value: (p: Player) => number | null;
  show: (p: Player) => ReactNode;
  low?: boolean;
}

/** Up to four players side by side; the best value in each row is highlighted. */
export function ComparePage() {
  const { league } = useGame();
  const r = useRoute();
  const ids = (r.query.get('ids') ?? '')
    .split(',')
    .map(Number)
    .filter((id) => id && league.players[id])
    .slice(0, MAX);
  const players = ids.map((id) => league.players[id]);
  const setIds = (next: number[]) => navigate(`compare?ids=${next.join(',')}`);
  const goalies = players.length > 0 && players.every((p) => p.pos === 'G');
  const mixed = players.some((p) => p.pos === 'G') && !goalies;

  const season = (p: Player) => league.seasonStats[p.id]?.reg;
  const career = (p: Player) => p.career.filter((c) => !c.playoffs).reduce((acc, c) => addStatLine(acc, c.stats), addStatLine(emptyStatLine(), season(p) ?? emptyStatLine()));
  const rows: { section: string; rows: Row[] }[] = [
    {
      section: 'Profile',
      rows: [
        { label: 'Age', value: (p) => league.season - p.birthYear, show: (p) => league.season - p.birthYear, low: true },
        { label: 'Ability (scouted)', value: (p) => estimate(league, p).ca, show: (p) => <Stars value={estimate(league, p).ca} /> },
        { label: 'Potential (scouted)', value: (p) => estimate(league, p).pa, show: (p) => <Stars value={estimate(league, p).pa} /> },
        { label: 'Type', value: () => null, show: (p) => ARCHETYPES[p.archetype]?.label ?? '' },
        { label: 'Personality', value: () => null, show: (p) => PERSONALITIES[p.personality].label },
        { label: 'Contract', value: (p) => (p.contract ? -p.contract.salary : null), show: (p) => (p.contract ? `${fmtMoney(p.contract.salary)} × ${p.contract.years}` : 'None') },
      ],
    },
    {
      section: 'This season',
      rows: goalies
        ? [
            { label: 'GP', value: (p) => season(p)?.gp ?? 0, show: (p) => season(p)?.gp ?? 0 },
            { label: 'W-L', value: (p) => season(p)?.w ?? 0, show: (p) => (season(p) ? `${season(p)!.w}-${season(p)!.l}` : '—') },
            { label: 'SV%', value: (p) => (season(p)?.sa ? savePct(season(p)!) : null), show: (p) => (season(p)?.sa ? savePct(season(p)!).toFixed(3).replace(/^0/, '') : '—') },
            { label: 'GAA', value: (p) => (season(p)?.gtoi ? gaa(season(p)!) : null), show: (p) => (season(p)?.gtoi ? gaa(season(p)!).toFixed(2) : '—'), low: true },
          ]
        : [
            { label: 'GP', value: (p) => season(p)?.gp ?? 0, show: (p) => season(p)?.gp ?? 0 },
            { label: 'Goals', value: (p) => season(p)?.g ?? 0, show: (p) => season(p)?.g ?? 0 },
            { label: 'Assists', value: (p) => (season(p) ? assists(season(p)!) : 0), show: (p) => (season(p) ? assists(season(p)!) : 0) },
            { label: 'Points', value: (p) => (season(p) ? points(season(p)!) : 0), show: (p) => <b>{season(p) ? points(season(p)!) : 0}</b> },
            { label: 'Points / game', value: (p) => (season(p)?.gp ? points(season(p)!) / season(p)!.gp : null), show: (p) => (season(p)?.gp ? (points(season(p)!) / season(p)!.gp).toFixed(2) : '—') },
            { label: '+/-', value: (p) => season(p)?.pm ?? 0, show: (p) => season(p)?.pm ?? 0 },
            { label: 'TOI / game', value: (p) => (season(p)?.gp ? season(p)!.toi / season(p)!.gp : null), show: (p) => (season(p)?.gp ? `${Math.floor(season(p)!.toi / season(p)!.gp / 60)}:${String(Math.round((season(p)!.toi / season(p)!.gp) % 60)).padStart(2, '0')}` : '—') },
          ],
    },
    {
      section: 'Last NHL season (real)',
      rows: [
        {
          label: goalies ? 'GP · SV%' : 'GP · PTS',
          value: (p) => {
            const r2 = lastRealSeason(p.nhlId);
            return goalies ? (r2?.goalie?.sv ?? null) : r2?.skater ? r2.skater.g + r2.skater.a : null;
          },
          show: (p) => {
            const r2 = lastRealSeason(p.nhlId);
            if (goalies) return r2?.goalie ? `${r2.goalie.gp} GP · ${r2.goalie.sv.toFixed(3).replace(/^0/, '')}` : '—';
            return r2?.skater ? `${r2.skater.gp} GP · ${r2.skater.g}G ${r2.skater.a}A` : '—';
          },
        },
      ],
    },
    {
      section: 'Career (this league)',
      rows: goalies
        ? [{ label: 'GP · W', value: (p) => career(p).w, show: (p) => `${career(p).gp} · ${career(p).w}` }]
        : [
            { label: 'GP', value: (p) => career(p).gp, show: (p) => career(p).gp },
            { label: 'Points', value: (p) => points(career(p)), show: (p) => points(career(p)) },
          ],
    },
  ];
  const groups = mixed ? [] : goalies ? GOALIE_ATTR_GROUPS : ATTR_GROUPS;

  const best = (row: Row): number | null => {
    const vals = players.map(row.value).filter((v): v is number => v !== null);
    if (vals.length < 2 || new Set(vals).size === 1) return null;
    return row.low ? Math.min(...vals) : Math.max(...vals);
  };
  const cell = (row: Row, p: Player, b: number | null) => (
    <td key={p.id} className={b !== null && row.value(p) === b ? 'cmp-best' : ''}>
      {row.show(p)}
    </td>
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Compare players</h1>
          <div className="sub">Up to {MAX} players side by side. The best value in each row is highlighted; ratings are your scouts' view.</div>
        </div>
      </div>
      <Card>
        <PlayerSearch exclude={ids} disabled={ids.length >= MAX} onPick={(id) => setIds([...ids, id])} />
      </Card>
      {players.length === 0 ? (
        <div className="empty" style={{ marginTop: 14 }}>
          Add players above, or use “Compare” on any player's page.
        </div>
      ) : (
        <Card tight className="cmp-card">
          <div style={{ overflowX: 'auto' }}>
            <table className="tbl cmp">
              <thead>
                <tr>
                  <th />
                  {players.map((p) => (
                    <th key={p.id}>
                      <div className="stack" style={{ gap: 4, alignItems: 'flex-start', textTransform: 'none', letterSpacing: 0 }}>
                        <Headshot p={p} size={44} />
                        <span className="row" style={{ gap: 6 }}>
                          <Pos pos={p.pos} /> <PlayerLink p={p} />
                        </span>
                        <span className="muted" style={{ fontSize: 11 }}>
                          {p.teamId !== null ? <TeamLink league={league} id={p.teamId} short /> : 'Free agent'}
                        </span>
                        <button className="btn small ghost" onClick={() => setIds(ids.filter((x) => x !== p.id))}>
                          Remove
                        </button>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((sec) => (
                  <Section key={sec.section} title={sec.section} span={players.length + 1}>
                    {sec.rows.map((row) => {
                      const b = best(row);
                      return (
                        <tr key={row.label}>
                          <td className="muted">{row.label}</td>
                          {players.map((p) => cell(row, p, b))}
                        </tr>
                      );
                    })}
                  </Section>
                ))}
                {groups.map((g) => (
                  <Section key={g.label} title={g.label} span={players.length + 1}>
                    {g.keys.map((k: AttrKey) => {
                      const row: Row = { label: attrLabel(k), value: (p) => displayedAttr(league, p, k).value, show: (p) => attr20(displayedAttr(league, p, k).value) };
                      const b = best(row);
                      return (
                        <tr key={k}>
                          <td className="muted">{row.label}</td>
                          {players.map((p) => cell(row, p, b))}
                        </tr>
                      );
                    })}
                  </Section>
                ))}
              </tbody>
            </table>
          </div>
          {mixed && <div className="muted" style={{ padding: 12 }}>Attributes are compared only between skaters, or only between goalies.</div>}
        </Card>
      )}
    </>
  );
}

function Section({ title, span, children }: { title: string; span: number; children: ReactNode }) {
  return (
    <>
      <tr className="cmp-section">
        <td colSpan={span}>{title}</td>
      </tr>
      {children}
    </>
  );
}

function PlayerSearch({ exclude, disabled, onPick }: { exclude: number[]; disabled: boolean; onPick: (id: number) => void }) {
  const { league } = useGame();
  const [q, setQ] = useState('');
  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (s.length < 2) return [];
    return Object.values(league.players)
      .filter((p) => p.status !== 'retired' && !exclude.includes(p.id) && `${p.first} ${p.last}`.toLowerCase().includes(s))
      .sort((a, b) => b.ca - a.ca)
      .slice(0, 8);
  }, [q, league, exclude]);
  return (
    <div className="stack" style={{ gap: 6 }}>
      <input placeholder={disabled ? `Compare up to ${MAX} players` : 'Add a player: type a name…'} value={q} disabled={disabled} onChange={(e) => setQ(e.target.value)} />
      {matches.length > 0 && (
        <div className="list">
          {matches.map((p) => (
            <button
              key={p.id}
              className="item"
              style={{ background: 'none', border: 0, borderBottom: '1px solid var(--line)', color: 'inherit', textAlign: 'left', cursor: 'pointer' }}
              onClick={() => {
                onPick(p.id);
                setQ('');
              }}
            >
              <Pos pos={p.pos} /> {p.first} {p.last}
              <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>
                {p.teamId !== null ? league.teams[p.teamId].abbr : p.status === 'draft' ? 'Draft' : 'FA'} · {league.season - p.birthYear}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
