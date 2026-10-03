import { useMemo, useState } from 'react';
import { useGame, mutate, toast, ask } from '../store';
import { Card, PlayerLink, Pos, Table, TeamLogo, Tabs, type Column } from '../components/common';
import { teamCapSheet, capProjection, capSeason, type CapRow } from '../../engine/cba/capManager';
import { rulesFor } from '../../engine/cba/rules';
import { contractValue } from '../../engine/cba/market';
import { formatMoney as fm } from '../../engine/cba/contractService';
import { canPlaceOnLTIR, placeOnLTIR, previewBuyout, buyoutPlayer, inBuyoutWindow } from '../../engine/cba/capActions';
import { claimOnWaivers, waiverPriority, needsWaivers } from '../../engine/cba/waivers';
import { contractDbInfo } from '../../engine/cba/import';
import { demote } from '../../engine/economy/roster';
import { seasonLabel } from '../format';
import type { Transaction } from '../../engine/types';
import { navigate, useRoute } from '../router';

type View = 'sheet' | 'projection' | 'waivers' | 'log';

const LOG_KINDS: { id: string; label: string; kinds: Transaction['kind'][] }[] = [
  { id: 'all', label: 'All', kinds: [] },
  { id: 'sign', label: 'Signings', kinds: ['signing', 'extension', 'elc', 'qualifyingOffer', 'arbitration', 'offerSheet'] },
  { id: 'trade', label: 'Trades', kinds: ['trade'] },
  { id: 'waive', label: 'Waivers', kinds: ['waivers', 'waiverClaim', 'waiverClear'] },
  { id: 'cap', label: 'Buyouts / LTIR', kinds: ['buyout', 'ltir', 'ltirActivate', 'termination'] },
  { id: 'move', label: 'Call-ups', kinds: ['callup', 'senddown', 'release'] },
];

export function CapPage() {
  const { league, version } = useGame();
  const route = useRoute();
  const teamId = route.param !== undefined && league.teams[Number(route.param)] ? Number(route.param) : league.userTeamId;
  const mine = teamId === league.userTeamId;
  const [view, setView] = useState<View>('sheet');
  const [logKind, setLogKind] = useState('all');
  const [logScope, setLogScope] = useState<'team' | 'league'>('team');
  const season = capSeason(league);
  const sheet = useMemo(() => teamCapSheet(league, teamId), [league, version, teamId]);
  const proj = useMemo(() => capProjection(league, teamId, 5, (p) => contractValue(p, league).value), [league, version, teamId]);
  const r = rulesFor(season);
  const db = contractDbInfo();
  const team = league.teams[teamId];
  const offseason = league.phase === 'draft' || league.phase === 'resign' || league.phase === 'freeAgency';

  const act = (row: CapRow) => {
    if (!mine) return null;
    const p = league.players[row.playerId];
    const ltir = canPlaceOnLTIR(league, p);
    const window = inBuyoutWindow(league);
    return (
      <span className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
        {ltir.ok && (
          <button className="btn small" title={ltir.explanation} onClick={() => { const res = mutate((l) => placeOnLTIR(l, l.players[p.id])); toast(res.message, res.ok ? 'good' : 'bad'); }}>
            LTIR
          </button>
        )}
        {p.status === 'active' && !offseason && needsWaivers(league, p).required && (
          <button className="btn small" title="Place on waivers for assignment to the minors" onClick={async () => { if (await ask(`Place ${row.name} on waivers? Any team may claim him for 24 hours.`, 'Waive')) { const res = mutate((l) => demote(l, l.players[p.id])); toast(res.message, res.ok ? 'info' : 'bad'); } }}>
            Waive
          </button>
        )}
        {window && row.yearsLeft > 1 && (
          <button
            className="btn small danger"
            onClick={async () => {
              const pv = previewBuyout(league, p);
              if (!pv.allowed) return toast(pv.errors[0], 'bad');
              const lines = Object.entries(pv.capCharges).map(([s, v]) => `${seasonLabel(Number(s))}: ${fm(v)}`).join(' · ');
              if (!(await ask(`Buy out ${row.name}? Cost ${fm(pv.totalCost)} (${Math.round(pv.ratio * 100)}% of remaining salary). Cap charges — ${lines}. Cap savings over the original term: ${fm(pv.savings)}.`, 'Buy out'))) return;
              const res = mutate((l) => buyoutPlayer(l, l.players[p.id]));
              toast(res.ok ? `${row.name} bought out.` : res.errors[0], res.ok ? 'good' : 'bad');
            }}
          >
            Buy out
          </button>
        )}
      </span>
    );
  };

  const cols: Column<CapRow>[] = [
    { key: 'pos', label: 'Pos', render: (x) => <Pos pos={x.pos} /> },
    { key: 'name', label: 'Player', render: (x) => <PlayerLink p={league.players[x.playerId]} />, sort: (x) => x.name, defaultDesc: false },
    { key: 'age', label: 'Age', num: true, render: (x) => x.age },
    { key: 'st', label: 'Status', render: (x) => <span className={`pill ${x.status === 'LTIR' ? 'bad' : x.status === 'IR' ? 'warn' : x.status === 'Minors' ? '' : 'accent'}`}>{x.status}</span>, sort: (x) => x.status },
    { key: 'hit', label: 'Cap hit', num: true, render: (x) => <b>{fm(x.capHit)}</b>, sort: (x) => x.capHit },
    { key: 'aav', label: 'AAV', num: true, render: (x) => fm(x.aav), sort: (x) => x.aav },
    { key: 'cash', label: 'Salary this yr', num: true, render: (x) => fm(x.cash), sort: (x) => x.cash },
    { key: 'yrs', label: 'Yrs', num: true, render: (x) => x.yearsLeft, sort: (x) => x.yearsLeft },
    { key: 'exp', label: 'Expires', render: (x) => <span>{seasonLabel(x.endSeason)} <span className="muted">{expiryOf(x)}</span></span>, sort: (x) => x.endSeason },
    {
      key: 'flags',
      label: 'Terms',
      render: (x) => (
        <span className="row" style={{ gap: 3, flexWrap: 'wrap' }}>
          {x.type === 'ELC' && <span className="pill">ELC</span>}
          {x.twoWay && <span className="pill">2-way</span>}
          {x.clause && <span className="pill warn">{x.clause}</span>}
          {x.retainedPct > 0 && <span className="pill">{Math.round(x.retainedPct * 100)}% ret.</span>}
          {x.thirtyFivePlus && <span className="pill">35+</span>}
          {x.buried && <span className="pill">buried</span>}
          {x.perfBonus > 0 && <span className="pill" title="Potential performance bonuses: allowed over the cap via the bonus cushion; any overage is charged to next season">+{fm(x.perfBonus)} bonus</span>}
          {x.source === 'estimated' && <span className="pill dim" title="No contract data imported for this player; contract is a structural estimate">est.</span>}
        </span>
      ),
    },
    { key: 'act', label: '', render: act },
  ];
  const expiryOf = (x: CapRow) => {
    const p = league.players[x.playerId];
    const c = p.contract?.endSeason === x.endSeason ? p.contract : p.contract?.next;
    return c?.expiryStatus ?? (x.endSeason + 1 - p.birthYear >= 27 ? 'UFA' : 'RFA');
  };

  const pct = (v: number) => `${Math.max(0, Math.min(100, (v / sheet.upper) * 100))}%`;
  const logRows = league.transactions.filter((t) => {
    const k = LOG_KINDS.find((x) => x.id === logKind)!;
    return (!k.kinds.length || k.kinds.includes(t.kind)) && (logScope === 'league' || t.teamIds.includes(teamId));
  });
  const priority = waiverPriority(league);
  const pending = league.waivers.filter((w) => (w.status ?? 'pending') === 'pending');

  return (
    <>
      <div className="page-head">
        <h1 className="row" style={{ gap: 10 }}>
          <TeamLogo team={team} size={30} /> Salary Cap
        </h1>
        <span className="sub">
          {seasonLabel(season)} · upper limit {fm(r.upperLimit)} · floor {fm(r.lowerLimit)} · minimum salary {fm(r.minimumSalary)}
          {/PROJECTED/.test(r.sources.upperLimit ?? '') ? ' · projected cap' : ''}
        </span>
        <div className="actions">
          <select value={teamId} onChange={(e) => navigate(`cap/${e.target.value}`)}>
            {league.teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.city} {t.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid g4" style={{ marginBottom: 12 }}>
        <Card>
          <div className="stat">
            <span className="k">Cap hit</span>
            <span className="v">{fm(sheet.total)}</span>
            <span className="muted">{sheet.rows.length} contracts / {r.contractLimit}</span>
          </div>
        </Card>
        <Card>
          <div className="stat">
            <span className="k">Cap space</span>
            <span className={`v ${sheet.space < 0 ? 'bad' : 'good'}`}>{fm(sheet.space)}</span>
            <span className="muted">{offseason ? `Offseason limit ${fm(sheet.effectiveLimit)} (+${Math.round(r.offseasonOveragePct * 100)}%)` : 'Upper limit + LTIR relief'}</span>
          </div>
        </Card>
        <Card>
          <div className="stat">
            <span className="k">Dead cap</span>
            <span className="v">{fm(sheet.deadCap)}</span>
            <span className="muted">Buyouts {fm(sheet.buyouts)} · retained {fm(sheet.retained)}</span>
          </div>
        </Card>
        <Card>
          <div className="stat">
            <span className="k">Compliance</span>
            <span className={`v ${sheet.compliant && !sheet.belowFloor ? 'good' : 'bad'}`}>{!sheet.compliant ? 'Over the cap' : sheet.belowFloor ? 'Below floor' : 'Compliant'}</span>
            <span className="muted">LTIR relief {fm(sheet.ltirRelief)} · bonuses {fm(sheet.perfBonusPotential)}</span>
          </div>
        </Card>
      </div>

      <Card title="Cap breakdown">
        <div className="capbar" style={{ display: 'flex', height: 18, borderRadius: 6, overflow: 'hidden', background: 'var(--bg-3, rgba(127,127,127,.15))', position: 'relative' }}>
          <i title={`Forwards ${fm(sheet.forwards)}`} style={{ width: pct(sheet.forwards), background: 'var(--accent)' }} />
          <i title={`Defense ${fm(sheet.defense)}`} style={{ width: pct(sheet.defense), background: 'var(--good)' }} />
          <i title={`Goalies ${fm(sheet.goalies)}`} style={{ width: pct(sheet.goalies), background: 'var(--warn)' }} />
          <i title={`Buried ${fm(sheet.buried)}`} style={{ width: pct(sheet.buried), background: 'var(--muted, #888)' }} />
          <i title={`Dead cap ${fm(sheet.deadCap)}`} style={{ width: pct(sheet.deadCap), background: 'var(--bad)' }} />
        </div>
        <div className="row muted" style={{ gap: 14, fontSize: 12, marginTop: 6, flexWrap: 'wrap' }}>
          <span><b style={{ color: 'var(--accent)' }}>■</b> Forwards {fm(sheet.forwards)}</span>
          <span><b style={{ color: 'var(--good)' }}>■</b> Defense {fm(sheet.defense)}</span>
          <span><b style={{ color: 'var(--warn)' }}>■</b> Goalies {fm(sheet.goalies)}</span>
          <span>■ Buried {fm(sheet.buried)}</span>
          <span><b style={{ color: 'var(--bad)' }}>■</b> Dead cap {fm(sheet.deadCap)}</span>
          <span style={{ marginLeft: 'auto' }}>Floor {fm(sheet.lower)} · Upper {fm(sheet.upper)}</span>
        </div>
      </Card>

      <div style={{ marginTop: 12 }}>
        <Tabs
          value={view}
          onChange={setView}
          tabs={[
            { id: 'sheet', label: 'Cap sheet' },
            { id: 'projection', label: 'Future cap' },
            { id: 'waivers', label: `Waivers${pending.length ? ` (${pending.length})` : ''}` },
            { id: 'log', label: 'Transactions' },
          ]}
        />
      </div>

      {view === 'sheet' && (
        <div className="grid g-main" style={{ marginTop: 12 }}>
          <Card title="Contracts" tight>
            <Table rows={sheet.rows} columns={cols} rowKey={(x) => x.playerId} initialSort={{ key: 'hit' }} />
          </Card>
          <div className="stack" style={{ gap: 12 }}>
            <Card title="Dead cap & retained salary">
              <div className="list">
                {sheet.dead.map((d, i) => (
                  <div className="item" key={i} style={{ alignItems: 'flex-start' }}>
                    <div className="stack" style={{ gap: 2 }}>
                      <span>
                        {d.playerId !== undefined && league.players[d.playerId] ? <PlayerLink p={league.players[d.playerId]} /> : d.name}{' '}
                        <span className="pill">{DEAD_LABEL[d.kind] ?? d.kind}</span>
                      </span>
                      {d.note && <span className="muted" style={{ fontSize: 12 }}>{d.note}</span>}
                    </div>
                    <b style={{ marginLeft: 'auto' }}>{fm(d.amount)}</b>
                  </div>
                ))}
                {!sheet.dead.length && <div className="muted">No dead cap this season.</div>}
              </div>
            </Card>
            <Card title="Rules in force">
              <div className="kv" style={{ fontSize: 12 }}>
                <span className="k">Max term</span>
                <span>{r.maxTermOwnTeam} yrs (own) · {r.maxTermExternal} yrs (others)</span>
                <span className="k">Max salary</span>
                <span>{fm(r.maxSalary)}</span>
                <span className="k">Retention</span>
                <span>≤{Math.round(r.retention.maxPct * 100)}% · {r.retention.maxContractsPerTeam} per team · {r.retention.maxTimesPerContract}× per contract</span>
                <span className="k">Buried allowance</span>
                <span>min + {fm(r.buriedAllowance)}</span>
                <span className="k">Active roster</span>
                <span>{r.rosterMax} (IR/LTIR excluded)</span>
                <span className="k">Playoff cap</span>
                <span>{r.playoffCap ? 'Dressed lineup + dead cap ≤ upper limit' : 'Not in force'}</span>
                <span className="k">Contract data</span>
                <span>{db.count ? `${db.count} real contracts (${db.asOf ?? 'undated'})` : 'Estimated (no contract database imported)'}</span>
              </div>
            </Card>
          </div>
        </div>
      )}

      {view === 'projection' && (
        <Card title="Future cap projection" tight>
          <table className="tbl">
            <thead>
              <tr>
                <th>Season</th>
                <th className="num">Upper limit</th>
                <th className="num">Committed</th>
                <th className="num">Dead cap</th>
                <th className="num">Space</th>
                <th className="num" title="Expected cost of re-signing restricted free agents">RFA raises</th>
                <th className="num">Projected space</th>
                <th className="num">Contracts</th>
                <th>Expiring after previous season</th>
              </tr>
            </thead>
            <tbody>
              {proj.map((y) => (
                <tr key={y.season}>
                  <td>
                    {seasonLabel(y.season)} {y.projected && <span className="pill dim">proj.</span>}
                  </td>
                  <td className="num">{fm(y.upper)}</td>
                  <td className="num">{fm(y.committed)}</td>
                  <td className="num">{fm(y.deadCap)}</td>
                  <td className={`num ${y.space < 0 ? 'bad' : ''}`}>{fm(y.space)}</td>
                  <td className="num">{fm(y.rfaHolds)}</td>
                  <td className={`num ${y.projectedSpace < 0 ? 'bad' : 'good'}`}>
                    <b>{fm(y.projectedSpace)}</b>
                  </td>
                  <td className="num">{y.contracts}</td>
                  <td style={{ fontSize: 12 }}>
                    {y.expiring.slice(0, 6).map((e) => (
                      <span key={e.playerId} style={{ marginRight: 8 }}>
                        {e.name} <span className={`pill ${e.status === 'RFA' ? 'accent' : 'warn'}`}>{e.status}</span>
                      </span>
                    ))}
                    {y.expiring.length > 6 && <span className="muted">+{y.expiring.length - 6} more</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {view === 'waivers' && (
        <div className="grid g-main" style={{ marginTop: 12 }}>
          <Card title="On waivers" tight>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Player</th>
                  <th>From</th>
                  <th className="num">Cap hit</th>
                  <th>Placed</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {pending.map((w) => {
                  const p = league.players[w.playerId];
                  const claimed = w.claims.includes(league.userTeamId);
                  return (
                    <tr key={w.playerId}>
                      <td>
                        <Pos pos={p.pos} /> <PlayerLink p={p} />
                      </td>
                      <td>{league.teams[w.fromTeamId].abbr}</td>
                      <td className="num">{p.contract ? fm(p.contract.salary) : '—'}</td>
                      <td className="muted">{w.reason === 'release' ? 'Unconditional' : 'For assignment'}</td>
                      <td>
                        {w.fromTeamId !== league.userTeamId && (
                          <button className={`btn small ${claimed ? '' : 'primary'}`} disabled={claimed} onClick={() => { const res = mutate((l) => claimOnWaivers(l, l.userTeamId, w.playerId)); toast(res.message, res.ok ? 'good' : 'bad'); }}>
                            {claimed ? 'Claim placed' : 'Claim'}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {!pending.length && (
                  <tr>
                    <td colSpan={5} className="muted">
                      Nobody is on waivers right now.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </Card>
          <Card title="Waiver priority">
            <div className="list" style={{ fontSize: 12 }}>
              {priority.map((id, i) => (
                <div className={`item ${id === league.userTeamId ? 'me' : ''}`} key={id}>
                  <span className="dim" style={{ minWidth: 22 }}>{i + 1}</span>
                  <TeamLogo team={league.teams[id]} size={16} /> {league.teams[id].city} {league.teams[id].name}
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      {view === 'log' && (
        <Card
          title="Transaction log"
          right={
            <span className="row" style={{ gap: 6 }}>
            <select value={logScope} onChange={(e) => setLogScope(e.target.value as 'team' | 'league')}>
              <option value="team">{team.abbr} only</option>
              <option value="league">League-wide</option>
            </select>
            <select value={logKind} onChange={(e) => setLogKind(e.target.value)}>
              {LOG_KINDS.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </select>
            </span>
          }
        >
          <div className="list" style={{ fontSize: 13 }}>
            {logRows.slice(0, 200).map((t) => (
              <div className="item" key={t.id}>
                <span className="dim" style={{ minWidth: 64 }}>{seasonLabel(t.season)}</span>
                <span className="pill" style={{ minWidth: 70, textAlign: 'center' }}>{t.kind}</span>
                <span>{t.description}</span>
              </div>
            ))}
            {!logRows.length && <div className="muted">No transactions.</div>}
          </div>
        </Card>
      )}
    </>
  );
}

const DEAD_LABEL: Record<string, string> = {
  buyout: 'Buyout',
  retained: 'Retained',
  bonusOverage: 'Bonus overage',
  thirtyFivePlus: '35+',
  termination: 'Termination',
  recapture: 'Recapture',
  other: 'Other',
};
