import { useMemo, useState } from 'react';
import { useGame, mutate, toast } from '../store';
import { Card, PlayerLink, Pos, Table, Stars, type Column } from '../components/common';
import { NegotiationModal } from '../components/Negotiation';
import { playersOf } from '../../engine/league/helpers';
import { expiringPlayers, extensionEligible, offerContract, arbitrate, resignAsk, willingness } from '../../engine/economy/freeAgency';
import { fmtMoney, futureCommitments, isRFA, payroll } from '../../engine/economy/contracts';
import { releasePlayer } from '../../engine/economy/roster';
import type { Player } from '../../engine/types';
import { seasonLabel } from '../format';
import { OffseasonPanel } from '../components/OffseasonPanel';
import { href } from '../router';
import { capSeason } from '../../engine/cba/capManager';

export function ContractsPage() {
  const { league, version } = useGame();
  const teamId = league.userTeamId;
  const [neg, setNeg] = useState<Player | null>(null);
  const expiring = useMemo(() => (league.phase === 'resign' ? expiringPlayers(league, teamId) : extensionEligible(league, teamId)), [league, version, teamId]);
  const all = useMemo(() => playersOf(league, teamId, ['active', 'prospect']).filter((p) => p.contract).sort((a, b) => (b.contract?.salary ?? 0) - (a.contract?.salary ?? 0)), [league, version, teamId]);
  const commits = futureCommitments(league, teamId, 5);
  const resign = league.phase === 'resign';

  const expCols: Column<Player>[] = [
    { key: 'pos', label: 'Pos', render: (p) => <Pos pos={p.pos} /> },
    { key: 'name', label: 'Player', render: (p) => <PlayerLink p={p} />, sort: (p) => p.last, defaultDesc: false },
    { key: 'age', label: 'Age', num: true, render: (p) => league.season - p.birthYear },
    { key: 'ca', label: 'Ability', render: (p) => <Stars value={p.ca} />, sort: (p) => p.ca },
    { key: 'type', label: 'Status', render: (p) => (isRFA(p, league.season) ? <span className="pill accent">RFA</span> : <span className="pill warn">UFA</span>) },
    { key: 'cur', label: 'Current', num: true, render: (p) => fmtMoney(p.contract!.salary) },
    { key: 'ask', label: 'Asking', num: true, render: (p) => { const a = resignAsk(league, p); return `${fmtMoney(a.salary)} × ${a.years}`; } },
    { key: 'will', label: 'Willing', num: true, render: (p) => { const w = willingness(league, p); return <span className={w > 0.65 ? 'good' : w > 0.4 ? 'warn' : 'bad'}>{Math.round(w * 100)}%</span>; }, sort: (p) => willingness(league, p) },
    {
      key: 'act',
      label: '',
      render: (p) => (
        <span className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
          <button className="btn small primary" onClick={() => setNeg(p)}>
            {resign ? 'Negotiate' : 'Extend'}
          </button>
          {resign && isRFA(p, league.season) && (
            <button
              className="btn small"
              title="An arbitrator splits the difference between the player's ask and your offer. Binding for both sides."
              onClick={() => {
                const r = mutate((l) => arbitrate(l, p));
                toast(r.message, r.ok ? 'good' : 'bad');
              }}
            >
              Arbitration
            </button>
          )}
          {resign && (
            <button className="btn small danger" onClick={() => { const r = mutate((l) => releasePlayer(l, p, 'decline to re-sign')); if (!r.ok) toast(r.message, 'bad'); }}>
              Let go
            </button>
          )}
        </span>
      ),
    },
  ];

  return (
    <>
      <div className="page-head">
        <h1>Contracts</h1>
        <span className="sub">
          Payroll {fmtMoney(payroll(league, teamId))} of {fmtMoney(league.cap.upper)} · floor {fmtMoney(league.cap.floor)}
        </span>
      </div>
      <OffseasonPanel league={league} />
      <Card
        title={resign ? `Expiring contracts (${expiring.length})` : `Extension candidates — final year (${expiring.length})`}
        right={<span className="muted" style={{ fontSize: 12 }}>{resign ? 'Unsigned players become free agents when free agency opens.' : 'Extensions take effect next season.'}</span>}
        tight
      >
        <Table rows={expiring} columns={expCols} rowKey={(p) => p.id} empty={resign ? 'No expiring contracts.' : 'Nobody is entering the final year of his deal.'} />
      </Card>
      <div className="grid g-main" style={{ marginTop: 14 }}>
        <Card title="All contracts" tight>
          <Table
            rows={all}
            rowKey={(p) => p.id}
            columns={[
              { key: 'pos', label: 'Pos', render: (p) => <Pos pos={p.pos} /> },
              { key: 'name', label: 'Player', render: (p) => <PlayerLink p={p} />, sort: (p) => p.last, defaultDesc: false },
              { key: 'st', label: 'Where', render: (p) => (p.status === 'prospect' ? <span className="muted">Minors</span> : 'Active') },
              { key: 'sal', label: 'Cap hit', num: true, render: (p) => fmtMoney(p.contract!.salary), sort: (p) => p.contract!.salary },
              { key: 'yrs', label: 'Years', num: true, render: (p) => p.contract!.years, sort: (p) => p.contract!.years },
              { key: 'type', label: 'Type', render: (p) => `${p.contract!.type}${p.contract!.ntc ? ' · NTC' : ''}` },
              { key: 'next', label: 'Extension', render: (p) => (p.contract!.next ? `${fmtMoney(p.contract!.next.salary)} × ${p.contract!.next.years}` : '—') },
            ]}
          />
        </Card>
        <Card title="Future commitments" right={<a href={href('cap')} className="muted" style={{ fontSize: 12 }}>Full cap sheet →</a>}>
          <div className="list">
            {commits.map((c, i) => (
              <div className="item" key={i}>
                <span>{seasonLabel(capSeason(league) + i)}</span>
                <b style={{ marginLeft: 'auto' }}>{fmtMoney(c)}</b>
              </div>
            ))}
          </div>
        </Card>
      </div>
      {neg && (
        <NegotiationModal
          player={neg}
          title={`${resign ? 'Re-sign' : 'Extend'} ${neg.first} ${neg.last}`}
          onClose={() => setNeg(null)}
          submit={(salary, years) => mutate((l) => offerContract(l, neg, salary, years))}
        />
      )}
    </>
  );
}
