import { useMemo } from 'react';
import { useGame, mutate, toast } from '../store';
import { Bar, Card, PlayerLink, Pos, Stat } from '../components/common';
import { playersOf } from '../../engine/league/helpers';
import { injuryLabel } from '../../engine/player/injuries';
import { MEDICAL_COST, MEDICAL_LABEL, canPlayThrough, manGamesLost, medicalLevel, playThrough, returnWindow, setMedicalLevel, shutDown } from '../../engine/team/medical';
import { staffBudget, staffSpend } from '../../engine/team/staffMarket';
import { fmtMoney } from '../../engine/economy/contracts';
import { shortDate } from '../format';

/** Medical staff, injured players, players playing hurt and load management. */
export function MedicalPage() {
  const { league, version } = useGame();
  const team = league.teams[league.userTeamId];
  const level = medicalLevel(team);
  const roster = useMemo(() => playersOf(league, team.id, ['active', 'prospect']), [league, version, team.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const injured = roster.filter((p) => p.injury).sort((a, b) => a.injury!.daysRemaining - b.injury!.daysRemaining);
  const hurt = roster.filter((p) => p.playingHurt);
  const vets = roster.filter((p) => p.status === 'active' && (league.season - p.birthYear >= 32 || p.pos === 'G')).sort((a, b) => b.fatigue - a.fatigue);
  const lost = manGamesLost(league, team.id);
  const avgLost = league.teams.reduce((s, t) => s + manGamesLost(league, t.id), 0) / league.teams.length;
  const run = (fn: () => { ok: boolean; message: string }) => {
    const r = mutate(() => fn());
    toast(r.message, r.ok ? 'good' : 'bad');
  };
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Medical</h1>
          <div className="sub">Your medical staff, the injury report, players playing hurt, and rest for veterans.</div>
        </div>
      </div>
      <div className="grid g3" style={{ marginBottom: 14 }}>
        <Card>
          <Stat k="Medical staff" v={`${MEDICAL_LABEL[level]} (${level}/5)`} sub={`${fmtMoney(MEDICAL_COST[level])} a season · staff budget ${fmtMoney(staffSpend(league, team))} of ${fmtMoney(staffBudget(team))}`} />
        </Card>
        <Card>
          <Stat k="Days lost to injury" v={lost} sub={`League average ${Math.round(avgLost)}`} />
        </Card>
        <Card>
          <Stat k="On the injury report" v={injured.length} sub={`${hurt.length} playing hurt`} />
        </Card>
      </div>
      <div className="grid g-main">
        <div className="grid" style={{ alignContent: 'start' }}>
          <Card title="Injury report" tight>
            {injured.length ? (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Player</th>
                    <th>Injury</th>
                    <th>Recovery</th>
                    <th>Expected back</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {injured.map((p) => {
                    const i = p.injury!;
                    const [lo, hi] = returnWindow(team, p);
                    const done = 1 - i.daysRemaining / Math.max(1, i.totalDays);
                    const no = canPlayThrough(p);
                    return (
                      <tr key={p.id}>
                        <td>
                          <Pos pos={p.pos} /> <PlayerLink p={p} />
                        </td>
                        <td>
                          {injuryLabel(i)}
                          {i.setbacks ? <span className="pill warn">{i.setbacks} setback{i.setbacks > 1 ? 's' : ''}</span> : null}
                        </td>
                        <td style={{ width: 70 }}>
                          <Bar value={done * 100} max={100} color="var(--good)" />
                        </td>
                        <td className="muted">{lo === hi ? shortDate(league.season, league.day + lo) : `${shortDate(league.season, league.day + lo)} – ${shortDate(league.season, league.day + hi)}`}</td>
                        <td>
                          {p.teamId === league.userTeamId && p.status === 'active' && (
                            <button className="btn small" disabled={!!no} title={no ?? 'Back in the lineup now: less effective, more likely to get hurt worse, heals at half speed'} onClick={() => run(() => playThrough(league, p))}>
                              Play through it
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <div className="muted" style={{ padding: 12 }}>Everyone is healthy.</div>
            )}
          </Card>
          {hurt.length > 0 && (
            <Card title="Playing hurt" tight>
              <table className="tbl">
                <tbody>
                  {hurt.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <Pos pos={p.pos} /> <PlayerLink p={p} />
                      </td>
                      <td className="muted">
                        {p.playingHurt!.type} · about {Math.ceil(p.playingHurt!.daysLeft)} days to heal while playing
                      </td>
                      <td>
                        <button className="btn small ghost" onClick={() => run(() => shutDown(league, p))}>
                          Shut him down
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
          <Card title="Load management" tight right={<span className="muted" style={{ fontSize: 12 }}>Rested players sit the second night of back-to-backs</span>}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Player</th>
                  <th className="num">Age</th>
                  <th>Fatigue</th>
                  <th>Rest on back-to-backs</th>
                </tr>
              </thead>
              <tbody>
                {vets.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Pos pos={p.pos} /> <PlayerLink p={p} />
                    </td>
                    <td className="num">{league.season - p.birthYear}</td>
                    <td style={{ width: 140 }}>
                      <Bar value={p.fatigue} max={100} color={p.fatigue > 50 ? 'var(--bad)' : p.fatigue > 25 ? 'var(--warn)' : 'var(--good)'} />
                    </td>
                    <td>
                      <input type="checkbox" checked={!!p.loadManaged} onChange={(e) => mutate((l) => (l.players[p.id].loadManaged = e.target.checked || undefined))} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
        <Card title="Medical staff">
          <div className="stack" style={{ gap: 8 }}>
            {[1, 2, 3, 4, 5].map((lv) => (
              <button key={lv} className={`trade-asset${lv === level ? ' me' : ''}`} style={{ background: lv === level ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'none', color: 'inherit', cursor: 'pointer', textAlign: 'left' }} onClick={() => run(() => setMedicalLevel(league, lv))}>
                <div className="stack" style={{ gap: 2, flex: 1 }}>
                  <b>
                    {MEDICAL_LABEL[lv]} {lv === level && <span className="pill accent">current</span>}
                  </b>
                  <span className="muted" style={{ fontSize: 12 }}>
                    {fmtMoney(MEDICAL_COST[lv])} a season · injury risk {lv < 3 ? '+' : lv > 3 ? '−' : '±'}
                    {Math.abs(Math.round((1.12 - 0.04 * lv - 1) * 100))}% · recovery {lv > 3 ? `${(lv - 3) * 12}% faster` : lv < 3 ? `${(3 - lv) * 12}% slower` : 'normal'} · fewer setbacks at higher levels
                  </span>
                </div>
              </button>
            ))}
            <span className="dim" style={{ fontSize: 11 }}>Medical staff are paid from the owner's staff budget, alongside the coaches.</span>
          </div>
        </Card>
      </div>
    </>
  );
}
