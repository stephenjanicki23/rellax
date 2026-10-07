import { useMemo, useState } from 'react';
import { useGame, mutate, nextPhase } from '../store';
import { Card, PlayerLink, Pos, Table, TeamLogo, type Column } from '../components/common';
import { NegotiationModal } from '../components/Negotiation';
import { playerColumns } from '../playerCells';
import { faPool, makeOffer, demandFor, pendingOffersFor, FA_DAYS, DAY_ONE_WAVES, faSignings, leaningToward, offerStanding, signingVerdict, withdrawOffer } from '../../engine/economy/freeAgency';
import type { League } from '../../engine/types';
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
      key: 'lean',
      label: 'Leaning',
      title: 'The club whose offer he likes best so far (the rumour mill)',
      render: (p) => {
        const t = leaningToward(league, p.id);
        return t === null ? <span className="dim">—</span> : <span className={t === me ? 'txt-good' : ''}>{league.teams[t].abbr}</span>;
      },
    },
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
  const wave = league.faWave ?? 0;
  const dayOne = fa && league.faDay === 0;
  const clock = dayOne ? `July 1 · ${DAY_ONE_WAVES[wave]} ET` : fa ? `July ${league.faDay + 1}` : '';
  const nextLabel = dayOne && wave < DAY_ONE_WAVES.length - 1 ? `Advance to ${DAY_ONE_WAVES[wave + 1]}` : league.faDay + 2 > FA_DAYS ? 'Close free agency' : `Advance to July ${league.faDay + 2}`;
  return (
    <>
      <div className="page-head">
        <h1>Free Agency</h1>
        <span className="sub">
          {fa ? `${clock}${dayOne ? ' — the market is open' : ''} · day ${league.faDay + 1} of ${FA_DAYS}. Players weigh money, role, winning, location and loyalty, and may wait for better offers.` : 'Unsigned free agents can be signed at any time; they decide on the spot outside the July frenzy.'}
        </span>
        <div className="actions">
          {fa && (
            <button className="btn primary" onClick={() => void nextPhase()}>
              {nextLabel}
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
      <div className={fa ? 'grid g-main' : ''} style={{ alignItems: 'start' }}>
        <Card tight>
          <Table rows={pool} columns={[...playerColumns(league, { potential: true, fit: true }), ...extra]} rowKey={(p) => p.id} initialSort={{ key: 'ca' }} limit={200} empty="The free-agent pool is empty." />
        </Card>
        {fa && (
          <div className="grid" style={{ alignContent: 'start' }}>
            <MyOffers league={league} onImprove={setNeg} />
            <Ticker league={league} />
            <TopBoard league={league} />
          </div>
        )}
      </div>
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
          submit={(salary, years, x) => mutate((l) => makeOffer(l, me, neg, salary, years, x))}
        />
      )}
    </>
  );
}

const when = (day: number, wave?: number) => (day === 0 ? `Jul 1 · ${DAY_ONE_WAVES[wave ?? DAY_ONE_WAVES.length - 1]}` : `Jul ${day + 1}`);

/** The user's offers: is he leading, or has someone outbid him? */
function MyOffers({ league, onImprove }: { league: League; onImprove: (p: Player) => void }) {
  const me = league.userTeamId;
  const mine = league.faOffers.filter((o) => o.teamId === me);
  return (
    <Card title={`Your offers (${mine.length})`} tight>
      {!mine.length ? (
        <div className="muted" style={{ padding: 12 }}>No offers out. Make one from the list: players can sign elsewhere at any time.</div>
      ) : (
        <div className="list">
          {mine.map((o) => {
            const p = league.players[o.playerId];
            const st = offerStanding(league, o.playerId, me);
            if (!p) return null;
            return (
              <div key={o.playerId} className="item" style={{ flexWrap: 'wrap', gap: 6 }}>
                <span style={{ flex: 1, minWidth: 140 }}>
                  <Pos pos={p.pos} /> <PlayerLink p={p} />
                  <span className="muted" style={{ fontSize: 12 }}> · {o.years} × {fmtMoney(o.salary)}</span>
                </span>
                {st && (st.leading ? <span className="pill good">Leading{st.of > 1 ? ` (${st.of} offers)` : ''}</span> : <span className="pill bad" title={`Leaning toward ${league.teams[st.leaderTeamId].city}`}>Outbid · {st.rank} of {st.of}</span>)}
                <button className="btn small" onClick={() => onImprove(p)}>Improve</button>
                <button className="btn small ghost" onClick={() => mutate((l) => withdrawOffer(l, o.playerId))}>Withdraw</button>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

/** Every signing this summer, newest first, with a verdict against market value. */
function Ticker({ league }: { league: League }) {
  const list = faSignings(league).slice(0, 14);
  return (
    <Card title="Signing ticker" tight>
      {!list.length ? (
        <div className="muted" style={{ padding: 12 }}>The phones are ringing. Signings will appear here as players commit.</div>
      ) : (
        <div className="list">
          {list.map((e, i) => {
            const p = league.players[e.playerId];
            const v = signingVerdict(e.salary, e.value);
            return (
              <div key={`${e.playerId}-${i}`} className={`item${e.teamId === league.userTeamId ? ' feed-pick me' : ''}`} style={{ gap: 8 }}>
                <span className="dim" style={{ fontSize: 11, width: 88, whiteSpace: 'nowrap' }}>{when(e.day, e.wave)}</span>
                <TeamLogo team={league.teams[e.teamId]} size={20} />
                <div className="stack" style={{ gap: 1, flex: 1, minWidth: 0 }}>
                  <span>{p ? <><Pos pos={p.pos} /> <PlayerLink p={p} /></> : 'Free agent'}</span>
                  <span className="muted" style={{ fontSize: 11 }}>
                    {e.years} yr · {fmtMoney(e.salary)} AAV{e.fromTeamId !== undefined && e.fromTeamId !== e.teamId ? ` · from ${league.teams[e.fromTeamId]?.abbr ?? ''}` : e.fromTeamId === e.teamId ? ' · re-signs' : ''}
                  </span>
                </div>
                <span className={`pill ${v.tone === 'good' ? 'good' : v.tone === 'bad' ? 'bad' : ''}`} title={`Market value about ${fmtMoney(e.value)} a year`}>{v.tag}</span>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

/** The top free agents of the summer: who's signed where, who's still deciding. */
function TopBoard({ league }: { league: League }) {
  const signed = faSignings(league);
  const signedIds = new Map(signed.map((e) => [e.playerId, e]));
  const open = faPool(league).filter((p) => !isRestricted(p));
  const board = [
    ...open.map((p) => ({ p, value: contractValue(p, league).value, signing: undefined as (typeof signed)[number] | undefined })),
    ...signed.map((e) => ({ p: league.players[e.playerId], value: e.value, signing: e })).filter((x) => !!x.p),
  ]
    .filter((x, i, arr) => arr.findIndex((y) => y.p.id === x.p.id) === i)
    .sort((a, b) => b.value - a.value)
    .slice(0, 12);
  return (
    <Card title="Top free agents" tight>
      <table className="tbl">
        <tbody>
          {board.map(({ p, value, signing }, i) => {
            const lean = signing ? null : leaningToward(league, p.id);
            const n = signing ? 0 : pendingOffersFor(league, p.id).length;
            return (
              <tr key={p.id} className={signing?.teamId === league.userTeamId ? 'me' : ''}>
                <td className="rank">{i + 1}</td>
                <td>
                  <Pos pos={p.pos} /> <PlayerLink p={p} full={false} />
                </td>
                <td className="num muted" style={{ fontSize: 12 }}>{fmtMoney(value)}</td>
                <td style={{ fontSize: 12 }}>
                  {signing || signedIds.get(p.id) ? (
                    <span className="row" style={{ gap: 4 }}>
                      <TeamLogo team={league.teams[(signing ?? signedIds.get(p.id))!.teamId]} size={16} /> signed
                    </span>
                  ) : n ? (
                    <span className="muted">{n} offer{n > 1 ? 's' : ''}{lean !== null ? ` · leaning ${league.teams[lean].abbr}` : ''}</span>
                  ) : (
                    <span className="dim">no offers yet</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}
