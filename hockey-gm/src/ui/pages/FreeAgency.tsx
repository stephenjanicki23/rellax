import { useMemo, useState } from 'react';
import { useGame, mutate, nextPhase } from '../store';
import { Card, Table, type Column } from '../components/common';
import { NegotiationModal } from '../components/Negotiation';
import { playerColumns } from '../playerCells';
import { faPool, makeOffer, demandFor, pendingOffersFor, FA_DAYS } from '../../engine/economy/freeAgency';
import { capSpace, fmtMoney } from '../../engine/economy/contracts';
import { rosterSize } from '../../engine/economy/roster';
import type { Player, Position } from '../../engine/types';

export function FreeAgencyPage() {
  const { league, version } = useGame();
  const [neg, setNeg] = useState<Player | null>(null);
  const [pos, setPos] = useState<'all' | Position>('all');
  const pool = useMemo(() => faPool(league).filter((p) => pos === 'all' || p.pos === pos), [league, version, pos]);
  const me = league.userTeamId;
  const myOffers = league.faOffers.filter((o) => o.teamId === me);
  const fa = league.phase === 'freeAgency';
  const extra: Column<Player>[] = [
    { key: 'ask', label: 'Asking', num: true, render: (p) => { const d = demandFor(league, p); return `${fmtMoney(d.salary)} × ${d.years}`; }, sort: (p) => demandFor(league, p).salary },
    { key: 'offers', label: 'Offers', num: true, render: (p) => pendingOffersFor(league, p.id).length || '—', sort: (p) => pendingOffersFor(league, p.id).length },
    {
      key: 'act',
      label: '',
      render: (p) => {
        const mine = myOffers.find((o) => o.playerId === p.id);
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
      </div>
      <Card tight>
        <Table rows={pool} columns={[...playerColumns(league, { potential: true }), ...extra]} rowKey={(p) => p.id} initialSort={{ key: 'ca' }} limit={200} empty="The free-agent pool is empty." />
      </Card>
      {neg && (
        <NegotiationModal
          player={neg}
          freeAgent
          title={`Offer to ${neg.first} ${neg.last}`}
          onClose={() => setNeg(null)}
          submit={(salary, years) => mutate((l) => makeOffer(l, me, neg, salary, years))}
        />
      )}
    </>
  );
}
