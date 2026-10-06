import { useState } from 'react';
import { useGame, mutate, toast } from '../store';
import { Bar, BarChart, Card, Gauge, Stat } from '../components/common';
import { fmtMoney } from '../../engine/economy/contracts';
import { attr20 } from '../../engine/player/ability';
import { PROJECTS, booksOf, capacityOf, expectedFill, fans, marketTicketPrice, projectedProfit, setTicketPrice, startProject } from '../../engine/front/finances';
import { seasonLabel } from '../format';

const money = (k: number) => `${k < 0 ? '−' : ''}${fmtMoney(Math.abs(k))}`;

function moodText(m: number): string {
  return m >= 80 ? 'Electric' : m >= 65 ? 'Excited' : m >= 50 ? 'Steady' : m >= 35 ? 'Restless' : 'Angry';
}

/** Fans, attendance, ticket prices and the club's books. */
export function FinancesPage() {
  const { league } = useGame();
  const team = league.teams[league.userTeamId];
  const f = fans(league, team.id);
  const b = booksOf(f);
  const cap = capacityOf(team);
  const [price, setPrice] = useState(f.priceFactor);
  const avgAtt = f.season.homeGames ? Math.round(f.season.attendance / f.season.homeGames) : 0;
  const proj = projectedProfit(league, team.id);
  // Preview the seats a price would sell against a typical opponent.
  const previewFill = (() => {
    const old = f.priceFactor;
    f.priceFactor = price;
    const v = expectedFill(league, team, null, false);
    f.priceFactor = old;
    return v;
  })();
  const maxLine = Math.max(1, ...b.lines.map((l) => l.value));
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Finances</h1>
          <div className="sub">
            {team.arena} · capacity {cap.toLocaleString()} · market size {team.marketSize}/5
          </div>
        </div>
      </div>
      <div className="grid g4" style={{ marginBottom: 14 }}>
        <Card>
          <Gauge value={f.mood} label={`Fans — ${moodText(f.mood)}`} />
        </Card>
        <Card>
          <Stat k="Attendance" v={avgAtt ? avgAtt.toLocaleString() : '—'} sub={avgAtt ? `${((avgAtt / cap) * 100).toFixed(1)}% full · ${f.season.homeGames} home games` : 'No home games yet'} />
        </Card>
        <Card>
          <Stat k="Season to date" v={<span className={b.profit >= 0 ? 'txt-good' : 'txt-bad'}>{money(b.profit)}</span>} sub={`Revenue ${fmtMoney(b.revenue)} · expenses ${fmtMoney(b.expenses)}`} />
        </Card>
        <Card>
          <Stat k="Projected season" v={<span className={proj >= 0 ? 'txt-good' : 'txt-bad'}>{proj ? money(proj) : '—'}</span>} sub="Regular-season pace, before playoff gates" />
        </Card>
      </div>
      <div className="grid g-main">
        <div className="grid" style={{ alignContent: 'start' }}>
          <Card title="Ticket prices">
            <div className="stack" style={{ gap: 10 }}>
              <label className="row">
                <span style={{ width: 120 }} className="muted">
                  Average ticket
                </span>
                <input type="range" min={0.7} max={1.5} step={0.05} value={price} onChange={(e) => setPrice(Number(e.target.value))} style={{ flex: 1 }} />
                <b style={{ width: 120, textAlign: 'right' }}>
                  ${Math.round(marketTicketPrice(team) * price)} <span className="muted">({Math.round(price * 100)}%)</span>
                </b>
              </label>
              <div className="muted" style={{ fontSize: 12 }}>
                Market price ${marketTicketPrice(team)}. At this price you'd expect about <b>{Math.round(previewFill * 100)}%</b> of seats sold ({Math.round(previewFill * cap).toLocaleString()}) against a typical opponent. Pricier tickets earn more per seat but sell fewer and slowly wear on the fans.
              </div>
              <div className="row">
                <button
                  className="btn primary small"
                  disabled={price === f.priceFactor}
                  onClick={() => {
                    mutate((l) => setTicketPrice(l, price));
                    toast('Ticket prices updated.', 'good');
                  }}
                >
                  Set price
                </button>
              </div>
            </div>
          </Card>
          <Card title={`${seasonLabel(league.season)} books`} right={<span className="dim" style={{ fontSize: 11 }}>Estimates: NHL clubs don't publish their books</span>}>
            <div className="stack" style={{ gap: 6 }}>
              {b.lines.map((l) => (
                <div key={l.key} className="row" style={{ gap: 8, fontSize: 13 }}>
                  <span style={{ flex: '1 1 140px', minWidth: 0 }} className="muted">
                    {l.label}
                  </span>
                  <span style={{ flex: '1 1 120px', minWidth: 60 }}>
                    <Bar value={l.value} max={maxLine} color={l.kind === 'rev' ? 'var(--good)' : 'var(--bad)'} />
                  </span>
                  <b style={{ width: 80, textAlign: 'right' }}>
                    {l.kind === 'exp' && l.value ? '−' : ''}
                    {fmtMoney(l.value)}
                  </b>
                </div>
              ))}
              <div className="row" style={{ borderTop: '1px solid var(--line)', paddingTop: 6 }}>
                <b style={{ flex: 1 }}>Profit / loss</b>
                <b className={b.profit >= 0 ? 'txt-good' : 'txt-bad'}>{money(b.profit)}</b>
              </div>
            </div>
          </Card>
          {f.games.length > 0 && (
            <Card title="Home attendance">
              <BarChart data={f.games.map((g) => ({ label: g.opp, value: g.att }))} band={[0, cap]} labelEvery={Math.ceil(f.games.length / 12)} valueFmt={(v) => v.toLocaleString()} />
            </Card>
          )}
        </div>
        <div className="grid" style={{ alignContent: 'start' }}>
          <Card title="Facilities">
            <div className="stack" style={{ gap: 10 }}>
              <span>
                Facilities <b>{attr20(team.facilities)}/20</b> <span className="muted">— better facilities help young players develop</span>
              </span>
              {PROJECTS.map((p) => (
                <div key={p.id} className="trade-asset" style={{ alignItems: 'center' }}>
                  <div className="stack" style={{ gap: 2, flex: 1 }}>
                    <b>{p.label}</b>
                    <span className="muted" style={{ fontSize: 12 }}>
                      {p.note} Cost {fmtMoney(p.cost)}.
                    </span>
                  </div>
                  <button
                    className="btn small"
                    disabled={f.projectSeason === league.season}
                    title={f.projectSeason === league.season ? 'One project per season' : 'Fund it this season'}
                    onClick={() => {
                      const r = mutate((l) => startProject(l, p.id));
                      toast(r.message, r.ok ? 'good' : 'bad');
                    }}
                  >
                    Fund
                  </button>
                </div>
              ))}
            </div>
          </Card>
          <Card title="Past seasons" tight>
            {f.history.length ? (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Season</th>
                    <th className="num">Revenue</th>
                    <th className="num">Profit</th>
                    <th className="num">Crowd</th>
                    <th className="num">Fans</th>
                  </tr>
                </thead>
                <tbody>
                  {[...f.history].reverse().map((h) => (
                    <tr key={h.season}>
                      <td>{seasonLabel(h.season)}</td>
                      <td className="num">{fmtMoney(h.revenue)}</td>
                      <td className={`num ${h.profit >= 0 ? 'txt-good' : 'txt-bad'}`}>{money(h.profit)}</td>
                      <td className="num">{h.fill}%</td>
                      <td className="num">{h.mood}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="muted" style={{ padding: 12 }}>The books close at the end of each season. Profit and fan mood shape the owner's budget for next year.</div>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
