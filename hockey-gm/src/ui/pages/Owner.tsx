import type { League, OwnerState } from '../../engine/types';
import { useGame, mutate, quitToMenu } from '../store';
import { Bar, Card, Modal, Stat, TeamLink, TeamLogo } from '../components/common';
import { FIRE_LINE, PRIORITY_LABEL, goalProgress, goalScore, gradeFor, securityLabel, stayOn, takeJob } from '../../engine/front/owner';
import { seasonLabel } from '../format';
import { href } from '../router';
import { capacityOf } from '../../engine/front/finances';

/** Goals with progress bars (shared by the Owner page and the dashboard). */
export function OwnerGoals({ league, o }: { league: League; o: OwnerState }) {
  return (
    <div className="stack" style={{ gap: 10 }}>
      {o.goals.map((g, i) => {
        const pr = goalProgress(league, g, o.teamId);
        return (
          <div key={i} className="stack" style={{ gap: 3 }}>
            <div className="row" style={{ gap: 6 }}>
              <span style={{ flex: 1 }}>{g.label}</span>
              <span className={`pill ${pr.met ? 'good' : pr.score < 0.6 ? 'bad' : ''}`}>{pr.met ? (league.phase === 'regular' ? 'On track' : 'Met') : pr.score < 0.6 ? 'Behind' : 'Close'}</span>
            </div>
            <Bar value={pr.pct * 100} max={100} color={pr.met ? 'var(--good)' : pr.score < 0.6 ? 'var(--bad)' : 'var(--warn)'} />
            <span className="dim" style={{ fontSize: 11 }}>
              {pr.value}
              {g.weight >= 3 ? ' · top priority' : ''}
            </span>
          </div>
        );
      })}
      {!o.goals.length && <span className="muted">The owner sets goals before the season.</span>}
    </div>
  );
}

export function SecurityMeter({ o }: { o: OwnerState }) {
  const lab = securityLabel(o.security);
  const color = lab.cls === 'good' ? 'var(--good)' : lab.cls === 'warn' ? 'var(--warn)' : 'var(--bad)';
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="muted">Job security</span>
        <b style={{ color }}>
          {lab.text} · {Math.round(o.security)}
        </b>
      </div>
      <div style={{ position: 'relative' }}>
        <Bar value={o.security} max={100} color={color} />
        <span title="Below this line the owner makes a change" style={{ position: 'absolute', left: `${FIRE_LINE}%`, top: -3, bottom: -3, width: 2, background: 'var(--bad)' }} />
      </div>
    </div>
  );
}

export function OwnerPage() {
  const { league } = useGame();
  const o = league.owner;
  if (!o) return <div className="empty">No owner yet.</div>;
  const team = league.teams[o.teamId];
  const score = goalScore(league, o);
  return (
    <>
      <div className="page-head">
        <TeamLogo team={team} size={44} />
        <div>
          <h1>Owner</h1>
          <div className="sub">
            {o.name} · {PRIORITY_LABEL[o.priority]} · Patience {o.patience >= 65 ? 'high' : o.patience >= 50 ? 'average' : 'low'}
          </div>
        </div>
      </div>
      <div className="grid g4" style={{ marginBottom: 14 }}>
        <Card>
          <SecurityMeter o={o} />
        </Card>
        <Card>
          <Stat k="Projected grade" v={o.goals.length ? gradeFor(score) : '—'} sub={`${seasonLabel(o.season)} goals`} />
        </Card>
        <Card>
          <Stat k="Seasons as GM" v={o.history.filter((h) => h.teamId === o.teamId).length} sub={`Hired ${seasonLabel(o.hiredSeason)}`} />
        </Card>
        <Card>
          <Stat k="Owner's priority" v={PRIORITY_LABEL[o.priority]} sub="Shapes the goals and how fast patience runs out" />
        </Card>
      </div>
      <div className="grid g-main">
        <div className="grid" style={{ alignContent: 'start' }}>
          <Card title={`${seasonLabel(o.season)} goals`}>
            <OwnerGoals league={league} o={o} />
          </Card>
          <Card title="Season reviews" tight>
            {o.history.length ? (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Season</th>
                    <th>Team</th>
                    <th>Record</th>
                    <th>Grade</th>
                    <th>Result</th>
                    <th className="num">Security</th>
                  </tr>
                </thead>
                <tbody>
                  {[...o.history].reverse().map((h) => (
                    <tr key={`${h.season}-${h.teamId}`}>
                      <td>{seasonLabel(h.season)}</td>
                      <td>
                        <TeamLink league={league} id={h.teamId} short />
                      </td>
                      <td>{h.record}</td>
                      <td>
                        <b className={h.grade === 'A' || h.grade === 'B' ? 'txt-good' : h.grade === 'C' ? '' : 'txt-bad'}>{h.grade}</b>
                      </td>
                      <td className="muted">{h.summary}</td>
                      <td className="num">
                        {h.security} <span className={h.change >= 0 ? 'txt-good' : 'txt-bad'}>({h.change >= 0 ? '+' : ''}{h.change})</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="muted" style={{ padding: 12 }}>The owner reviews your work at the end of each season.</div>
            )}
          </Card>
          {o.career.length > 0 && (
            <Card title="Previous jobs" tight>
              <table className="tbl">
                <tbody>
                  {o.career.map((c, i) => (
                    <tr key={i}>
                      <td>
                        <TeamLink league={league} id={c.teamId} logo />
                      </td>
                      <td>
                        {seasonLabel(c.from)} – {seasonLabel(c.to)}
                      </td>
                      <td className="muted">{c.seasons ? `${c.seasons} season${c.seasons === 1 ? '' : 's'}` : 'Part of a season'}</td>
                      <td>{c.cups ? <span className="pill accent">{c.cups}× Cup</span> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </div>
        <Card title="Messages from the owner">
          <div className="list">
            {o.messages.map((m, i) => (
              <div className="item" key={i} style={{ flexDirection: 'column', gap: 2, alignItems: 'flex-start' }}>
                <span className={m.tone === 'good' ? 'txt-good' : m.tone === 'bad' ? 'txt-bad' : ''}>“{m.text}”</span>
                <span className="dim" style={{ fontSize: 11 }}>{seasonLabel(m.season)}</span>
              </div>
            ))}
            {!o.messages.length && <span className="muted">Nothing yet.</span>}
          </div>
        </Card>
      </div>
    </>
  );
}

/** Dashboard card: job security and the season's goals at a glance. */
export function OwnerCard({ league }: { league: League }) {
  const o = league.owner;
  if (!o) return null;
  return (
    <Card title="Owner's goals" right={<a href={href('owner')}>Details →</a>}>
      <div className="stack" style={{ gap: 12 }}>
        <SecurityMeter o={o} />
        <FanLine league={league} />
        <OwnerGoals league={league} o={o} />
      </div>
    </Card>
  );
}

/** Shown over everything when the owner fires the GM. */
export function FiredDialog({ league }: { league: League }) {
  const o = league.owner;
  if (!o?.fired) return null;
  const old = league.teams[o.teamId];
  return (
    <Modal title="You've been fired" onClose={() => undefined} wide closable={false}>
      <div className="stack" style={{ gap: 12 }}>
        <div className="row" style={{ gap: 10 }}>
          <TeamLogo team={old} size={36} />
          <span>
            {o.name} has relieved you of your duties as general manager of the {old.city} {old.name}. <span className="muted">{o.fired.reason}</span>
          </span>
        </div>
        <h3 style={{ margin: 0 }}>Clubs that want to talk to you</h3>
        <div className="stack" style={{ gap: 8 }}>
          {o.fired.offers.map((id) => {
            const t = league.teams[id];
            const rec = league.standings[id];
            return (
              <div key={id} className="trade-asset" style={{ alignItems: 'center' }}>
                <TeamLogo team={t} size={34} />
                <div className="stack" style={{ gap: 2, flex: 1 }}>
                  <b>
                    {t.city} {t.name}
                  </b>
                  <span className="muted" style={{ fontSize: 12 }}>
                    {rec?.gp ? `${rec.w}-${rec.l}-${rec.otl} this season · ` : ''}
                    {t.strategy === 'rebuild' ? 'Rebuilding' : t.strategy === 'contend' ? 'Contending' : 'Middle of the pack'} · market {t.marketSize}/5
                  </span>
                </div>
                <button className="btn primary" onClick={() => mutate((l) => takeJob(l, id))}>
                  Take the job
                </button>
              </div>
            );
          })}
          {!o.fired.offers.length && <span className="muted">No club is calling right now.</span>}
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn ghost" onClick={() => quitToMenu()}>
            Retire to the main menu
          </button>
          <button className="btn" title="Turns off firing for this save" onClick={() => mutate((l) => stayOn(l))}>
            Ignore it and keep going
          </button>
        </div>
      </div>
    </Modal>
  );
}

function FanLine({ league }: { league: League }) {
  const t = league.teams[league.userTeamId];
  const f = t.fans;
  if (!f) return null;
  const att = f.season.homeGames ? f.season.attendance / f.season.homeGames : 0;
  return (
    <a href={href('finances')} className="row" style={{ fontSize: 12, gap: 10 }}>
      <span className="muted">Fans</span>
      <b className={f.mood >= 60 ? 'txt-good' : f.mood < 40 ? 'txt-bad' : ''}>{Math.round(f.mood)}</b>
      {att > 0 && (
        <>
          <span className="muted">Crowds</span>
          <b>{Math.round((att / capacityOf(t)) * 100)}%</b>
        </>
      )}
    </a>
  );
}
