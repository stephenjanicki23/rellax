import { useMemo, useState } from 'react';
import { useGame, mutate, toast } from '../store';
import { Card, PlayerLink, Pos, Stars, TeamLogo } from '../components/common';
import { playersOf } from '../../engine/league/helpers';
import { balanceTrade, checkTrade, describeAsset, evaluateTrade, executeTrade, projectedPickNumber, validateTrade, type TradeAsset, type TradeProposal } from '../../engine/economy/trade';
import { estimate } from '../../engine/economy/scouting';
import { fmtMoney } from '../../engine/economy/contracts';
import { trimRoster, ensureDressable } from '../../engine/economy/roster';
import type { League } from '../../engine/types';
import { shortDate } from '../format';
import { activeClause } from '../../engine/cba/contract';
import { capSeason } from '../../engine/cba/capManager';

const key = (a: TradeAsset) => `${a.kind}-${a.id}`;
const clauseOf = (league: League, p: League['players'][number]) => {
  const cl = p.contract ? activeClause(p.contract, capSeason(league)) : null;
  return cl ? cl.kind : null;
};

function AssetList({ league, teamId, selected, toggle }: { league: League; teamId: number; selected: TradeAsset[]; toggle: (a: TradeAsset) => void }) {
  const players = playersOf(league, teamId, ['active', 'prospect']).sort((a, b) => estimate(league, b).ca - estimate(league, a).ca);
  const picks = league.draftPicks.filter((p) => p.ownerId === teamId && p.playerId === undefined).sort((a, b) => a.season - b.season || a.round - b.round);
  const sel = new Set(selected.map(key));
  return (
    <div style={{ maxHeight: 520, overflow: 'auto' }}>
      <table className="tbl">
        <tbody>
          {players.map((p) => {
            const a: TradeAsset = { kind: 'player', id: p.id };
            const e = estimate(league, p);
            return (
              <tr key={p.id} className={sel.has(key(a)) ? 'me' : ''} onClick={() => toggle(a)} style={{ cursor: 'pointer' }}>
                <td>
                  <input type="checkbox" readOnly checked={sel.has(key(a))} />
                </td>
                <td>
                  <Pos pos={p.pos} />
                </td>
                <td>
                  <PlayerLink p={p} /> {p.status === 'prospect' && <span className="pill">minors</span>} {clauseOf(league, p) && <span className="pill warn">{clauseOf(league, p)}</span>}
                </td>
                <td className="num">{league.season - p.birthYear}</td>
                <td>
                  <Stars value={e.ca} />
                </td>
                <td className="num muted">{p.contract ? `${fmtMoney(p.contract.salary)}×${p.contract.years}` : ''}</td>
              </tr>
            );
          })}
          {picks.map((pk) => {
            const a: TradeAsset = { kind: 'pick', id: pk.id };
            return (
              <tr key={`pk${pk.id}`} className={sel.has(key(a)) ? 'me' : ''} onClick={() => toggle(a)} style={{ cursor: 'pointer' }}>
                <td>
                  <input type="checkbox" readOnly checked={sel.has(key(a))} />
                </td>
                <td>
                  <span className="pos">PK</span>
                </td>
                <td colSpan={3}>{describeAsset(league, a)}</td>
                <td className="num muted">{pk.round === 1 ? `~#${projectedPickNumber(league, pk)}` : ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function TradesPage() {
  const { league, version } = useGame();
  const me = league.userTeamId;
  const [partner, setPartner] = useState(me === 0 ? 1 : 0);
  const [give, setGive] = useState<TradeAsset[]>([]);
  const [get, setGet] = useState<TradeAsset[]>([]);
  const [retain, setRetain] = useState<Record<number, number>>({});
  const retainList = give.filter((a) => a.kind === 'player' && retain[a.id]).map((a) => ({ playerId: a.id, pct: retain[a.id] }));
  const proposal: TradeProposal = { from: me, to: partner, give, get, retain: retainList };
  const ev = useMemo(() => (give.length || get.length ? evaluateTrade(league, proposal) : null), [league, version, partner, give, get, retain]);
  const chk = useMemo(() => (give.length || get.length ? checkTrade(league, proposal) : null), [league, version, partner, give, get, retain]);
  const toggle = (list: TradeAsset[], set: (l: TradeAsset[]) => void) => (a: TradeAsset) => set(list.some((x) => key(x) === key(a)) ? list.filter((x) => key(x) !== key(a)) : [...list, a]);
  const partnerTeam = league.teams[partner];
  const ratio = ev ? ev.valueIn / Math.max(1, ev.valueOut * 1.08) : 0;
  const recent = league.transactions.filter((t) => t.kind === 'trade').slice(0, 12);
  const offers = league.tradeOffers;
  const respond = (id: number, accept: boolean) => {
    const o = league.tradeOffers.find((x) => x.id === id);
    if (!o) return;
    if (accept) {
      const p: TradeProposal = { from: o.from, to: me, give: o.give, get: o.get };
      const errs = validateTrade(league, p);
      if (errs.length) return toast(errs[0], 'bad');
      mutate((l) => {
        executeTrade(l, p);
        for (const id2 of [me, o.from]) {
          trimRoster(l, id2);
          ensureDressable(l, id2);
        }
        l.tradeOffers = l.tradeOffers.filter((x) => x.id !== id);
      });
      toast('Trade completed.', 'good');
    } else {
      mutate((l) => (l.tradeOffers = l.tradeOffers.filter((x) => x.id !== id)));
    }
  };

  const propose = () => {
    const r = evaluateTrade(league, proposal);
    if (!r.accept) return toast(r.reason, 'bad');
    mutate((l) => {
      executeTrade(l, proposal);
      for (const id of [me, partner]) {
        trimRoster(l, id);
        ensureDressable(l, id);
      }
    });
    toast('Trade accepted!', 'good');
    setGive([]);
    setGet([]);
  };

  return (
    <>
      <div className="page-head">
        <h1>Trades</h1>
        <span className="sub">
          {league.phase === 'regular' ? (league.day <= league.tradeDeadlineDay ? `Trade deadline: ${shortDate(league.season, league.tradeDeadlineDay)}` : 'The trade deadline has passed.') : 'Offseason trading is open.'}
        </span>
      </div>
      {offers.length > 0 && (
        <Card title={`Incoming offers (${offers.length})`} className="">
          <div className="list">
            {offers.map((o) => (
              <div className="item" key={o.id} style={{ alignItems: 'center', flexWrap: 'wrap' }}>
                <TeamLogo team={league.teams[o.from]} size={22} />
                <div className="stack" style={{ gap: 2, flex: 1, minWidth: 260 }}>
                  <span>{o.note}</span>
                  <span className="muted" style={{ fontSize: 12 }}>
                    They offer: <b>{o.give.map((a) => describeAsset(league, a)).join(', ')}</b> — for <b>{o.get.map((a) => describeAsset(league, a)).join(', ')}</b>
                  </span>
                </div>
                <button className="btn small primary" onClick={() => respond(o.id, true)}>Accept</button>
                <button className="btn small" onClick={() => { setPartner(o.from); setGive(o.get); setGet(o.give); }}>Counter…</button>
                <button className="btn small danger" onClick={() => respond(o.id, false)}>Decline</button>
              </div>
            ))}
          </div>
        </Card>
      )}
      <div className="card row" style={{ marginBottom: 12, marginTop: offers.length ? 12 : 0 }}>
        <span className="muted">Trade partner</span>
        <select
          value={partner}
          onChange={(e) => {
            setPartner(Number(e.target.value));
            setGet([]);
          }}
        >
          {league.teams.filter((t) => t.id !== me).map((t) => (
            <option key={t.id} value={t.id}>
              {t.city} {t.name} ({t.strategy})
            </option>
          ))}
        </select>
        <span className="muted">
          GM {partnerTeam.gm.name} · {partnerTeam.strategy === 'rebuild' ? 'Rebuilding — values youth, prospects and picks' : partnerTeam.strategy === 'contend' ? 'Contending — wants proven, current help' : 'Balanced approach'}
        </span>
      </div>
      <div className="grid trade-grid">
        <Card title={<div className="row"><TeamLogo team={league.teams[me]} size={20} /><h3>You give</h3></div>} tight>
          <AssetList league={league} teamId={me} selected={give} toggle={toggle(give, setGive)} />
        </Card>
        <Card title="Deal">
          <div className="stack" style={{ gap: 10 }}>
            <div>
              <h3 style={{ marginBottom: 4 }}>You send</h3>
              {give.length ? give.map((a) => <div key={key(a)}>{describeAsset(league, a)}</div>) : <span className="dim">Nothing selected</span>}
            </div>
            <div>
              <h3 style={{ marginBottom: 4 }}>You receive</h3>
              {get.length ? get.map((a) => <div key={key(a)}>{describeAsset(league, a)}</div>) : <span className="dim">Nothing selected</span>}
            </div>
            {give.some((a) => a.kind === 'player' && league.players[a.id]?.contract) && (
              <div className="stack" style={{ gap: 4 }}>
                <span className="muted" style={{ fontSize: 12 }}>Salary retention (you keep part of the cap hit)</span>
                {give
                  .filter((a) => a.kind === 'player' && league.players[a.id]?.contract)
                  .map((a) => (
                    <label key={a.id} className="row" style={{ gap: 6, fontSize: 12 }}>
                      <span style={{ flex: 1 }}>{describeAsset(league, a)}</span>
                      <select value={retain[a.id] ?? 0} onChange={(e) => setRetain({ ...retain, [a.id]: Number(e.target.value) })}>
                        {[0, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5].map((v) => (
                          <option key={v} value={v}>{v ? `${Math.round(v * 100)}% retained` : 'No retention'}</option>
                        ))}
                      </select>
                    </label>
                  ))}
              </div>
            )}
            {chk && (
              <table className="tbl" style={{ fontSize: 12 }}>
                <thead>
                  <tr>
                    <th>Cap</th>
                    <th className="num">Before → after</th>
                    <th className="num">Space</th>
                  </tr>
                </thead>
                <tbody>
                  {chk.cap.map((c) => (
                    <tr key={c.teamId}>
                      <td>{league.teams[c.teamId].abbr}</td>
                      <td className={`num ${c.ok ? '' : 'bad'}`}>
                        <span className="muted">{fmtMoney(c.before)} →</span> {fmtMoney(c.after)}
                      </td>
                      <td className={`num ${c.spaceAfter < 0 ? 'bad' : 'good'}`}>{fmtMoney(c.spaceAfter)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {chk?.consents.map((c) => (
              <div key={c.playerId} className={c.granted ? 'good' : 'bad'} style={{ fontSize: 12 }}>
                {c.reason}
              </div>
            ))}
            {chk?.warnings.map((w) => (
              <div key={w} className="warn" style={{ fontSize: 12 }}>
                {w}
              </div>
            ))}
            {chk && chk.ok && <div className="good" style={{ fontSize: 12 }}>Trade is valid under the CBA (cap, clauses, retention, roster).</div>}
            {ev && (
              <>
                <div>
                  <div className="row muted" style={{ justifyContent: 'space-between', fontSize: 12 }}>
                    <span>{partnerTeam.abbr} GM's reaction</span>
                    <b className={ev.accept ? 'good' : ratio > 0.75 ? 'warn' : 'bad'}>{ev.accept ? 'Interested' : ratio > 0.75 ? 'Close' : 'Not interested'}</b>
                  </div>
                  <div className="bar" style={{ height: 8 }}>
                    <i style={{ width: `${Math.min(100, ratio * 100)}%`, background: ev.accept ? 'var(--good)' : ratio > 0.75 ? 'var(--warn)' : 'var(--bad)' }} />
                  </div>
                </div>
                {ev.errors.filter((e) => !chk?.consents.some((c) => c.reason === e)).map((e) => (
                  <div key={e} className="bad" style={{ fontSize: 12 }}>
                    {e}
                  </div>
                ))}
              </>
            )}
            <div className="row">
              <button className="btn primary" disabled={!ev} onClick={propose}>
                Propose trade
              </button>
              <button
                className="btn"
                disabled={!get.length}
                onClick={() => {
                  const b = balanceTrade(league, proposal);
                  if (!b) return toast(`${partnerTeam.abbr} can't find a combination of your assets that works.`, 'bad');
                  setGive(b.give);
                  toast(`${partnerTeam.abbr} would do it with these assets added.`);
                }}
              >
                What would it take?
              </button>
              <button className="btn ghost" onClick={() => { setGive([]); setGet([]); setRetain({}); }}>
                Clear
              </button>
            </div>
          </div>
        </Card>
        <Card title={<div className="row"><TeamLogo team={partnerTeam} size={20} /><h3>You get</h3></div>} tight>
          <AssetList league={league} teamId={partner} selected={get} toggle={toggle(get, setGet)} />
        </Card>
      </div>
      <Card title="Recent trades around the league" className="" >
        <div className="list">
          {recent.map((t) => (
            <div className="item" key={t.id}>
              <span className="dim" style={{ minWidth: 60 }}>{t.season}</span>
              <span>{t.description}</span>
            </div>
          ))}
          {!recent.length && <div className="muted">No trades yet.</div>}
        </div>
      </Card>
    </>
  );
}
