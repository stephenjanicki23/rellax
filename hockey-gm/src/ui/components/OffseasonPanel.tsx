import type { League } from '../../engine/types';
import { mutate, toast } from '../store';
import { Card, PlayerLink, Pos } from './common';
import { formatMoney as fm } from '../../engine/cba/contractService';
import { submitQualifyingOffer, fileArbitration, walkAwayFromAward, resolveOfferSheet, isRestricted, QO_EXPIRY_DAY, ARB_HEARING_DAY } from '../../engine/cba/rfa';
import { rulesFor } from '../../engine/cba/rules';
import { capSeason } from '../../engine/cba/capManager';

const QO_STATUS: Record<string, { label: string; cls: string }> = {
  required: { label: 'Decision needed', cls: 'warn' },
  submitted: { label: 'Submitted', cls: 'good' },
  notSubmitted: { label: 'Not qualified', cls: 'bad' },
  accepted: { label: 'Accepted', cls: 'good' },
  rejected: { label: 'Rejected', cls: 'bad' },
  expired: { label: 'Expired', cls: '' },
};

/** Restricted free agency for the user's team: qualifying offers, arbitration and offer sheets against its RFAs. */
export function OffseasonPanel({ league }: { league: League }) {
  const me = league.userTeamId;
  const qos = league.qualifyingOffers.filter((q) => q.teamId === me && q.season === league.season);
  const cases = league.arbitration.filter((a) => a.teamId === me && a.season === league.season);
  const sheets = league.offerSheets.filter((o) => o.rightsTeamId === me && o.season === league.season);
  const r = rulesFor(capSeason(league));
  if (!qos.length && !cases.length && !sheets.length) return null;
  const resign = league.phase === 'resign';
  const fa = league.phase === 'freeAgency';
  const run = (fn: (l: League) => { ok: boolean; message: string }) => {
    const res = mutate(fn);
    toast(res.message, res.ok ? 'good' : 'bad');
  };
  return (
    <div className="stack" style={{ gap: 12, marginBottom: 14 }}>
      {sheets.some((s) => s.status === 'pending') && (
        <Card title="Offer sheets — match or take the picks">
          <div className="list">
            {sheets
              .filter((s) => s.status === 'pending')
              .map((s) => {
                const p = league.players[s.playerId];
                return (
                  <div className="item" key={s.id} style={{ flexWrap: 'wrap', alignItems: 'center' }}>
                    <span>
                      <b>{league.teams[s.fromTeamId].city}</b> signed <PlayerLink p={p} /> to an offer sheet: <b>{s.years} yr × {fm(s.aav)}</b>
                    </span>
                    <span className="muted" style={{ fontSize: 12 }}>
                      Compensation if you decline: {s.compensation.length ? s.compensation.map((c) => `round ${c}`).join(' + ') : 'none'} · decide by FA day {s.decisionDay + 1}
                    </span>
                    <span className="row" style={{ marginLeft: 'auto', gap: 6 }}>
                      <button className="btn small primary" onClick={() => run((l) => resolveOfferSheet(l, s.id, true))}>Match</button>
                      <button className="btn small danger" onClick={() => run((l) => resolveOfferSheet(l, s.id, false))}>Decline</button>
                    </span>
                  </div>
                );
              })}
          </div>
        </Card>
      )}
      {qos.length > 0 && (
        <Card
          title={`Qualifying offers (${qos.length})`}
          right={<span className="muted" style={{ fontSize: 12 }}>{resign ? 'Qualify an RFA to keep his rights; unqualified players become UFAs when free agency opens.' : `Qualified players can accept until FA day ${QO_EXPIRY_DAY}.`}</span>}
          tight
        >
          <table className="tbl">
            <thead>
              <tr>
                <th>Player</th>
                <th className="num">Previous salary</th>
                <th className="num">Qualifying offer</th>
                <th>Type</th>
                <th>Arb.</th>
                <th>Why</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {qos.map((q) => {
                const p = league.players[q.playerId];
                if (!p) return null;
                const st = QO_STATUS[q.status] ?? { label: q.status, cls: '' };
                const kase = cases.find((c) => c.playerId === q.playerId);
                return (
                  <tr key={q.playerId}>
                    <td>
                      <Pos pos={p.pos} /> <PlayerLink p={p} />
                    </td>
                    <td className="num">{fm(q.previousSalary)}</td>
                    <td className="num">
                      <b>{fm(q.amount)}</b>
                    </td>
                    <td>{q.oneWay ? 'One-way' : 'Two-way'}</td>
                    <td>{q.arbitrationEligible ? <span className="pill accent">eligible</span> : <span className="muted">no</span>}</td>
                    <td className="muted" style={{ fontSize: 12, whiteSpace: 'normal', minWidth: 200, maxWidth: 340 }}>{q.explanation}</td>
                    <td>
                      <span className={`pill ${st.cls}`}>{st.label}</span>
                    </td>
                    <td>
                      <span className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                        {resign && q.status !== 'submitted' && (
                          <button className="btn small primary" onClick={() => run((l) => submitQualifyingOffer(l, q.playerId, true))}>Qualify</button>
                        )}
                        {resign && q.status !== 'notSubmitted' && (
                          <button className="btn small" onClick={() => run((l) => submitQualifyingOffer(l, q.playerId, false))}>Don't qualify</button>
                        )}
                        {fa && isRestricted(p) && q.arbitrationEligible && !kase && q.previousSalary >= r.arbitration.clubElectThreshold && (
                          <button className="btn small" title={`Club-elected arbitration (prior salary ≥ ${fm(r.arbitration.clubElectThreshold)})`} onClick={() => run((l) => fileArbitration(l, q.playerId, 'club'))}>
                            Club arbitration
                          </button>
                        )}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
      {cases.length > 0 && (
        <Card title="Salary arbitration">
          <div className="list">
            {cases.map((c) => {
              const p = league.players[c.playerId];
              return (
                <div className="item" key={c.playerId} style={{ flexWrap: 'wrap', alignItems: 'flex-start' }}>
                  <div className="stack" style={{ gap: 2, flex: 1, minWidth: 260 }}>
                    <span>
                      <PlayerLink p={p} /> · {c.electedBy === 'player' ? 'player-elected' : 'club-elected'} · {c.years} yr
                    </span>
                    <span className="muted" style={{ fontSize: 12 }}>
                      Player asks {fm(c.playerAsk)} · club offers {fm(c.clubOffer)}
                      {c.status === 'filed' ? ` · hearing on FA day ${ARB_HEARING_DAY}` : ''}
                    </span>
                    {c.reasoning && <span className="muted" style={{ fontSize: 12 }}>{c.reasoning}</span>}
                  </div>
                  <span className={`pill ${c.status === 'awarded' ? 'good' : c.status === 'walkedAway' ? 'bad' : ''}`}>
                    {c.status === 'awarded' ? `Awarded ${fm(c.award ?? 0)}` : c.status === 'walkedAway' ? 'Walked away' : c.status === 'settled' ? 'Settled' : 'Filed'}
                  </span>
                  {c.status === 'awarded' && c.electedBy === 'player' && (c.award ?? 0) >= r.arbitration.walkAwayThreshold && (
                    <button className="btn small danger" title={`Walk-away right: awards of ${fm(r.arbitration.walkAwayThreshold)}+`} onClick={() => run((l) => walkAwayFromAward(l, c.playerId))}>
                      Walk away
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}
