import { useMemo, useState } from 'react';
import { useGame } from '../store';
import { Card, Table } from '../components/common';
import { playerColumns } from '../playerCells';
import type { Player, Position } from '../../engine/types';

export function PlayersPage() {
  const { league, version } = useGame();
  const [q, setQ] = useState('');
  const [pos, setPos] = useState<'all' | Position | 'F'>('all');
  const [where, setWhere] = useState<'league' | 'fa' | 'prospects' | 'retired' | string>('league');
  const [maxAge, setMaxAge] = useState(45);
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return Object.values(league.players).filter((p: Player) => {
      if (where === 'league' && p.status !== 'active') return false;
      if (where === 'fa' && p.status !== 'fa') return false;
      if (where === 'prospects' && p.status !== 'prospect' && p.status !== 'draft') return false;
      if (where === 'retired' && p.status !== 'retired') return false;
      if (!['league', 'fa', 'prospects', 'retired'].includes(where) && String(p.teamId) !== where) return false;
      if (pos === 'F' && !(p.pos === 'C' || p.pos === 'LW' || p.pos === 'RW')) return false;
      if (pos !== 'all' && pos !== 'F' && p.pos !== pos) return false;
      if (league.season - p.birthYear > maxAge) return false;
      if (s && !`${p.first} ${p.last}`.toLowerCase().includes(s)) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [league, version, q, pos, where, maxAge]);
  return (
    <>
      <div className="page-head">
        <h1>Players</h1>
        <span className="sub">{rows.length} players. Ratings for other teams' players are scouting estimates.</span>
      </div>
      <div className="card row" style={{ marginBottom: 12 }}>
        <input type="search" placeholder="Search name…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 200 }} />
        <select value={where} onChange={(e) => setWhere(e.target.value)}>
          <option value="league">All rostered players</option>
          <option value="fa">Free agents</option>
          <option value="prospects">Prospects & draft-eligible</option>
          <option value="retired">Retired</option>
          {league.teams.map((t) => (
            <option key={t.id} value={String(t.id)}>
              {t.city} {t.name}
            </option>
          ))}
        </select>
        <select value={pos} onChange={(e) => setPos(e.target.value as typeof pos)}>
          <option value="all">All positions</option>
          <option value="F">Forwards</option>
          <option value="C">C</option>
          <option value="LW">LW</option>
          <option value="RW">RW</option>
          <option value="D">D</option>
          <option value="G">G</option>
        </select>
        <label className="row muted">
          Max age
          <input type="number" min={17} max={45} value={maxAge} onChange={(e) => setMaxAge(Number(e.target.value))} style={{ width: 60 }} />
        </label>
      </div>
      <Card tight>
        <Table rows={rows} columns={playerColumns(league, { team: true, stats: true })} rowKey={(p) => p.id} initialSort={{ key: 'ca' }} limit={300} />
      </Card>
    </>
  );
}
