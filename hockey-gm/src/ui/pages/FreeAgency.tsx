import { useMemo, useState } from 'react';
import { useGame, mutate, nextPhase } from '../store';
import { Card, Table, type Column } from '../components/common';
import { NegotiationModal } from '../components/Negotiation';
import { playerColumns } from '../playerCells';
import { faPool, makeOffer, demandFor, pendingOffersFor, FA_DAYS } from '../../engine/economy/freeAgency';
import { capSpace, fmtMoney } from '../../engine/economy/contracts';
import { rosterSize } from '../../engine/economy/roster';
import type { Player, Position } from '../../engine/types';
import { isRestricted, submitOfferSheet } from '../../engine/cba/rfa';
import { contractValue } from '../../engine/cba/market';

export function FreeAgencyPage() {
  const { league, version } = useGame();
  const [neg, setNeg] = useState<Player | null>(null);
  const [sheet, setSheet] = useState<Player | null>(null);
  const [pos, setPos] = useState<'all' | Position>('all');
  const [status, setStatus] = useState<'all' | 'UFA' | 'RFA'>('all');
  const [maxAge, setMaxAge] = useState(45);
  const [maxAsk, setMaxAsk] = useState(0);
  const [q, setQ] = useState('');
  const pool = useMemo(
    () =>
      faPool(league).filter((p) => {
        if (pos !== 'all' && p.pos !== pos) return false;
        if (status !== 'all' && (isRestricted(p) ? 'RFA' : 'UFA') !== status) return false;
        if (league.season + 1 - p.birthYear > maxAge) return false;
        if (maxAsk && demandFor(league, p).salary > maxAsk) return false;
        if (q && !`${p.first} ${p.last}`.toLowerCase().includes(q.toLowerCase())) return false;
        return true;
      }),
    [league, version, pos, status, maxAge, maxAsk, q],
  );
  const me = league.userTeamId;
  const myOffers = league.faOffers.filter((o) => o.teamId === me);
  const fa = league.phase === 'freeAgency';
  const extra: Column<Player>[] = [
    {
      key: 'fa',
      label: 'Status',
      render: (p) => (isRestricted(p) ? <span className="pill accent" title={`Restricted — ${league.teams[p.rightsTeamId!]?.city} hold his rights`}>RFA · {league.teams[p.rightsTeamId!]?.abbr}</span> : <span className="pill warn">UFA</span>),
      sort: (p) => (isRestricted(p) ? 1 : 0),
    },
    { key: 'mv', label: 'Value', num: true, render: (p) => fmtMoney(contractValue(p, league).value), sort: (p) => contractValue(p, league).value },
    { key: 'ask', label: 'Asking', num: true, render: (p) => { const d = demandFor(league, p); return `${fmtMoney(d.salary)} × ${d.years}`; }, sort: (p) => demandFor(league, p).salary },
    { key: 'offers', label: 'Offers', num: true, render: (p) => pendingOffersFor(league, p.id).length || '—', sort: (p) => pendingOffersFor(league, p.id).length },
    {
      key: 'act',
      label: '',
      render: (p) => {
        const mine = myOffers.find((o) => o.playerId === p.id);
        const pendingSheet = league.offerSheets.find((o) => o.playerId === p.id && o.status === 'pending');
        if (isRestricted(p) && p.rightsTeamId !== me)
          return (
            <button className="btn small" disabled={!fa || !!pendingSheet} title="Restricted free agent: submit an offer sheet; his team may match or take draft-pick compensation" onClick={() => setSheet(p)}>
              {pendingSheet ? 'Offer sheet pending' : 'Offer sheet'}
            </button>
          );
        return (
          <button className={`btn small ${mine ? '' : 'primary'}`} onClick={() => setNeg(p)}>
            {mine ? `Offered ${fmtMoney(mine.salary)}` : 'Make offer'}
          </button>
        );
      },
    },
  ];
  return (
    <>
      <div className="page-head">
        <h1>Free Agency</h1>
        <span className="sub">
          {fa ? `Day ${league.faDay + 1} of ${FA_DAYS}. Players weigh money, role, winning, location and loyalty — and may wait for better offers.` : 'Unsigned free agents can be signed at any time; they decide on the spot outside the July frenzy.'}
        </span>
        <div className="actions">
          {fa && (
            <button className="btn primary" onClick={() => void nextPhase()}>
              Advance to day {league.faDay + 2 > FA_DAYS ? 'end' : league.faDay + 2}
            </button>
          )}
        </div>
      </div>
      <div className="grid g4" style={{ marginBottom: 14 }}>
        <Card><div className="stat"><span className="k">Cap space</span><span className="v">{fmtMoney(capSpace(league, me))}</span></div></Card>
        <Card><div className="stat"><span className="k">Committed in offers</span><span className="v">{fmtMoney(myOffers.reduce((s, o) => s + o.salary, 0))}</span></div></Card>
        <Card><div className="stat"><span className="k">Roster</span><span className="v">{rosterSize(league, me)}/{league.config.economics.rosterMax}</span></div></Card>
        <Card><div className="stat"><span className="k">Free agents</span><span className="v">{faPool(league).length}</span></div></Card>
      </div>
      <div className="card row" style={{ marginBottom: 12 }}>
        <span className="muted">Position</span>
        <select value={pos} onChange={(e) => setPos(e.target.value as typeof pos)}>
          <option value="all">All</option>
          {(['C', 'LW', 'RW', 'D', 'G'] as Position[]).map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
        <span className="muted">Status</span>
        <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
          <option value="all">All</option>
          <option value="UFA">UFA</option>
          <option value="RFA">RFA</option>
        </select>
        <span className="muted">Max age</span>
        <select value={maxAge} onChange={(e) => setMaxAge(Number(e.target.value))}>
          {[45, 35, 32, 30, 27, 25, 23].map((a) => (
            <option key={a} value={a}>{a === 45 ? 'Any' : a}</option>
          ))}
        </select>
        <span className="muted">Max ask</span>
        <select value={maxAsk} onChange={(e) => setMaxAsk(Number(e.target.value))}>
          {[0, 1000, 2000, 4000, 6000, 9000].map((a) => (
            <option key={a} value={a}>{a ? fmtMoney(a) : 'Any'}</option>
          ))}
        </select>
        <input placeholder="Search name" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 160 }} />
      </div>
      <Card tight>
        <Table rows={pool} columns={[...playerColumns(league, { potential: true }), ...extra]} rowKey={(p) => p.id} initialSort={{ key: 'ca' }} limit={200} empty="The free-agent pool is empty." />
      </Card>
      {sheet && (
        <NegotiationModal
          player={sheet}
          offerSheet
          title={`Offer sheet to ${sheet.first} ${sheet.last} (${league.teams[sheet.rightsTeamId!]?.abbr} rights)`}
          onClose={() => setSheet(null)}
          submit={(salary, years) => mutate((l) => submitOfferSheet(l, me, sheet.id, { aav: salary, years }))}
        />
      )}
      {neg && (
        <NegotiationModal
          player={neg}
          freeAgent={!isRestricted(neg)}
          title={`Offer to ${neg.first} ${neg.last}`}
          onClose={() => setNeg(null)}
          submit={(salary, years) => mutate((l) => makeOffer(l, me, neg, salary, years))}
        />
      )}
    </>
  );
}
