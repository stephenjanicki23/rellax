import { useMemo } from 'react';
import { useGame, runSim } from '../store';
import { Card, PlayerLink, TeamLogo } from '../components/common';
import { navigate } from '../router';
import { shortDate } from '../format';
import { daysToDeadline } from '../../engine/league/deadline';
import { marketRole, tradeBlock } from '../../engine/ai/tradeMarket';
import { describeAsset } from '../../engine/economy/trade';
import { standingRows } from '../../engine/league/standings';
import { capSpace, fmtMoney } from '../../engine/economy/contracts';

const ICON: Record<string, string> = { trade: '⇄', rumor: '…', call: '📞', close: '⏱' };

/** Deadline centre: countdown, the deal and rumour feed, incoming calls, buyers and sellers. */
export function DeadlinePage() {
  const { league, version } = useGame();
  const d = daysToDeadline(league);
  const feed = league.deadlineFeed?.season === league.season ? [...league.deadlineFeed.events].reverse() : [];
  const roles = useMemo(() => {
    const rows = standingRows(league);
    return league.teams
      .filter((t) => t.id !== league.userTeamId)
      .map((t) => ({ t, role: marketRole(league, t), pts: rows.find((r) => r.team.id === t.id)?.pts ?? 0, space: capSpace(league, t.id) }));
  }, [league, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const buyers = roles.filter((r) => r.role === 'buyer').sort((a, b) => b.pts - a.pts);
  const sellers = roles.filter((r) => r.role === 'seller').sort((a, b) => a.pts - b.pts);
  const block = tradeBlock(league);
  const passed = league.phase !== 'regular' || d < 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Deadline Centre</h1>
          <div className="sub">
            {passed ? 'The trade deadline has passed.' : d === 0 ? 'Deadline day: trades close at 3:00 PM ET.' : `Trade deadline: ${shortDate(league.season, league.tradeDeadlineDay)} · ${d} day${d === 1 ? '' : 's'} to go`}
          </div>
        </div>
        {!passed && (
          <div className="actions">
            {d > 0 && (
              <button className="btn" onClick={() => void runSim('deadline')}>
                Sim to deadline day
              </button>
            )}
            <button className="btn primary" onClick={() => navigate('trades')}>
              Make a trade
            </button>
          </div>
        )}
      </div>
      {!passed && d === 0 && (
        <div className="banner" style={{ marginBottom: 14 }}>
          <b>⏱ Deadline day</b>
          <span className="muted">Every trade you want must be done before you advance the day. Teams are calling and deals are coming in all day.</span>
        </div>
      )}
      <div className="grid g-main">
        <div className="grid" style={{ alignContent: 'start' }}>
          {league.tradeOffers.length > 0 && (
            <Card title={`On the phone (${league.tradeOffers.length})`}>
              <div className="list">
                {league.tradeOffers.map((o) => (
                  <div className="item" key={o.id} style={{ alignItems: 'center', flexWrap: 'wrap' }}>
                    <TeamLogo team={league.teams[o.from]} size={22} />
                    <span style={{ flex: 1, minWidth: 220 }}>
                      {o.note}
                      <div className="muted" style={{ fontSize: 12 }}>
                        They offer {o.give.map((a) => describeAsset(league, a)).join(', ')} for {o.get.map((a) => describeAsset(league, a)).join(', ')}
                      </div>
                    </span>
                    <button className="btn small primary" onClick={() => navigate(`trades?review=${o.id}`)}>
                      Review
                    </button>
                  </div>
                ))}
              </div>
            </Card>
          )}
          <Card title="Deadline feed">
            {feed.length ? (
              <div className="list">
                {feed.map((e, i) => (
                  <div className="item" key={i} style={{ alignItems: 'flex-start', gap: 10 }}>
                    <span style={{ width: 70, flex: 'none' }} className={e.kind === 'close' ? 'txt-bad' : 'muted'}>
                      {e.time ?? shortDate(league.season, e.day)}
                    </span>
                    <span style={{ width: 18, flex: 'none', textAlign: 'center' }}>{ICON[e.kind]}</span>
                    <span style={{ flex: 1 }}>
                      {e.teamIds.slice(0, 2).map((id) => (
                        <TeamLogo key={id} team={league.teams[id]} size={16} />
                      ))}{' '}
                      <span className={e.kind === 'trade' ? '' : 'muted'}>{e.text}</span>
                      {e.teamIds.includes(league.userTeamId) && e.kind === 'trade' && <span className="pill accent">your deal</span>}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="muted">The feed fills up over the two weeks before the deadline: every deal, rumour and call.</div>
            )}
          </Card>
        </div>
        <div className="grid" style={{ alignContent: 'start' }}>
          <Card title="Buyers" tight>
            <table className="tbl">
              <tbody>
                {buyers.slice(0, 10).map((r) => (
                  <tr key={r.t.id}>
                    <td>
                      <TeamLogo team={r.t} size={16} /> {r.t.abbr}
                    </td>
                    <td className="num">{r.pts} pts</td>
                    <td className="num muted">{r.space < 0 ? `${fmtMoney(-r.space)} over` : `${fmtMoney(r.space)} space`}</td>
                  </tr>
                ))}
                {!buyers.length && (
                  <tr>
                    <td className="muted">No clear buyers yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </Card>
          <Card title="Sellers" tight>
            <table className="tbl">
              <tbody>
                {sellers.slice(0, 10).map((r) => (
                  <tr key={r.t.id}>
                    <td>
                      <TeamLogo team={r.t} size={16} /> {r.t.abbr}
                    </td>
                    <td className="num">{r.pts} pts</td>
                    <td className="num muted">{r.t.strategy === 'rebuild' ? 'rebuilding' : 'out of the race'}</td>
                  </tr>
                ))}
                {!sellers.length && (
                  <tr>
                    <td className="muted">No clear sellers yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </Card>
          <Card title="Your trade block">
            {block.length ? (
              <div className="list">
                {block.map((p) => (
                  <div className="item" key={p.id}>
                    <PlayerLink p={p} />
                  </div>
                ))}
              </div>
            ) : (
              <span className="muted">Nobody on the block. Add players from the Trades page and the calls will come.</span>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
