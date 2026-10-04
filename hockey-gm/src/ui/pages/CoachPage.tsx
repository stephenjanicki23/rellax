import { useGame } from '../store';
import { Card, Stat, TeamLink, TeamLogo } from '../components/common';
import { CoachRatingBars, coachAge, recordText } from '../components/CoachBits';
import { coachOverall, coachTotals, coachTraits, PHILOSOPHY_LABEL } from '../../engine/team/coaching';
import { ROLE_LABEL } from '../../engine/team/staffMarket';
import { attr20 } from '../../engine/player/ability';
import { fmtMoney } from '../../engine/economy/contracts';
import { coachRecordsInfo } from '../../engine/data/nhl/coachRecords';
import type { CoachSeasonLine, League } from '../../engine/types';
import { seasonLabel } from '../format';
import { href } from '../router';

interface Row extends CoachSeasonLine {
  current?: boolean;
}

/** A coach's profile: ratings, strengths and weaknesses, honours and his season-by-season record. */
export function CoachPage({ id }: { id: number }) {
  const { league } = useGame();
  const c = league.coaches[id];
  if (!c) return <div className="empty">Coach not found.</div>;
  const team = c.teamId !== null ? league.teams[c.teamId] : undefined;
  const t = coachTotals(c);
  const { strengths, weaknesses } = coachTraits(c);
  const rows: Row[] = [
    ...c.career.filter((l) => (l.role ?? 'head') === 'head'),
    ...(c.stints ?? []).map((s) => ({ season: s.season, teamId: s.teamId, role: 'head' as const, gp: s.gp, w: s.w, l: s.l, otl: s.otl, pw: s.pw, pl: s.pl, playoffs: '', interim: s.interim, current: true })),
  ];
  const staffRows = c.career.filter((l) => l.role && l.role !== 'head');
  const info = coachRecordsInfo();
  const teamCell = (r: Row) =>
    r.teamId !== null && league.teams[r.teamId] ? (
      <TeamLink league={league} id={r.teamId} short logo />
    ) : (
      <span className="muted">{r.team ?? '—'}</span>
    );
  return (
    <>
      <div className="page-head">
        {team && <TeamLogo team={team} size={52} />}
        <div>
          <h1>
            {c.first} {c.last} {c.interim && <span className="pill warn">Interim</span>}
          </h1>
          <div className="sub">
            {c.retired ? 'Retired' : team ? (
              <>
                {ROLE_LABEL[c.role]}, <a href={href(`team/${team.id}`)}>{team.city} {team.name}</a>
              </>
            ) : (
              `Available · ${ROLE_LABEL[c.role]}`
            )}
            {c.birthKnown !== false ? ` · Age ${coachAge(league, c)}` : ''} · {PHILOSOPHY_LABEL[c.philosophy]}
          </div>
          {c.styleNote && <div className="muted" style={{ fontSize: 12 }}>{c.styleNote}</div>}
        </div>
      </div>
      <div className="grid g4" style={{ marginBottom: 14 }}>
        <Card><Stat k="Overall" v={`${attr20(coachOverall(c))}/20`} sub={`Reputation ${c.reputation}`} /></Card>
        <Card><Stat k="NHL record" v={t.gp ? recordText(t) : '—'} sub={t.gp ? `${t.gp} GP · ${(t.ptsPct * 100).toFixed(1)} pts% · ${t.seasons} seasons` : 'No NHL head-coaching games'} /></Card>
        <Card><Stat k="Playoffs" v={t.pw + t.pl ? `${t.pw}-${t.pl}` : '—'} sub={t.cups ? `${t.cups}× Stanley Cup champion` : t.pw + t.pl ? `${((t.pw / (t.pw + t.pl)) * 100).toFixed(0)}% win rate` : ''} /></Card>
        <Card><Stat k="Contract" v={c.contract ? fmtMoney(c.contract.salary) : '—'} sub={c.contract ? `${c.contract.years} season${c.contract.years > 1 ? 's' : ''} left` : c.background ?? ''} /></Card>
      </div>
      <div className="grid g-main">
        <Card title={<h3>Head-coaching record</h3>} right={c.real ? <span className="dim" style={{ fontSize: 11 }} title={info.source}>Through {seasonLabel(info.to)}: real NHL record</span> : null} tight>
          {rows.length ? (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Season</th>
                  <th>Team</th>
                  <th className="num">GP</th>
                  <th className="num">W</th>
                  <th className="num">L</th>
                  <th className="num" title="Ties (before 2005-06) / overtime losses">T/OTL</th>
                  <th className="num">Pts%</th>
                  <th className="num">Playoffs</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {[...rows].reverse().map((r, i) => {
                  const gp = r.gp ?? r.w + r.l + (r.t ?? 0) + r.otl;
                  return (
                    <tr key={i} className={r.current ? 'me' : ''}>
                      <td>
                        {seasonLabel(r.season)}
                        {r.current ? '*' : ''}
                      </td>
                      <td>
                        {teamCell(r)} {r.interim && <span className="pill" title="Interim head coach">int.</span>}
                      </td>
                      <td className="num">{gp}</td>
                      <td className="num">{r.w}</td>
                      <td className="num">{r.l}</td>
                      <td className="num">{r.t ? `${r.t}/${r.otl}` : r.otl}</td>
                      <td className="num">{gp ? ((2 * r.w + (r.t ?? 0) + r.otl) / (2 * gp)).toFixed(3).replace(/^0/, '') : '—'}</td>
                      <td className="num">{(r.pw ?? 0) + (r.pl ?? 0) ? `${r.pw}-${r.pl}` : ''}</td>
                      <td>{r.cup ? <span className="pill accent">Stanley Cup</span> : <span className="muted">{r.current ? 'In progress' : r.playoffs}</span>}</td>
                    </tr>
                  );
                })}
                <tr>
                  <td>
                    <b>Career</b>
                  </td>
                  <td />
                  <td className="num"><b>{t.gp}</b></td>
                  <td className="num"><b>{t.w}</b></td>
                  <td className="num"><b>{t.l}</b></td>
                  <td className="num"><b>{t.t ? `${t.t}/${t.otl}` : t.otl}</b></td>
                  <td className="num"><b>{t.gp ? t.ptsPct.toFixed(3).replace(/^0/, '') : '—'}</b></td>
                  <td className="num"><b>{t.pw + t.pl ? `${t.pw}-${t.pl}` : ''}</b></td>
                  <td>{t.cups ? <b>{t.cups} Cup{t.cups > 1 ? 's' : ''}</b> : null}</td>
                </tr>
              </tbody>
            </table>
          ) : (
            <div className="muted" style={{ padding: 12 }}>
              {c.role === 'head' ? 'Has not coached an NHL game yet.' : `No head-coaching record. ${c.background ?? ''}`}
            </div>
          )}
          {staffRows.length > 0 && (
            <div className="muted" style={{ padding: '8px 12px', fontSize: 12 }}>
              On staff: {staffRows.map((l) => `${seasonLabel(l.season)} ${l.teamId !== null ? league.teams[l.teamId]?.abbr : ''} (${l.role === 'goalie' ? 'goalie coach' : 'assistant'})`).join(' · ')}
            </div>
          )}
        </Card>
        <div className="stack" style={{ gap: 14 }}>
          {team && c.role === 'head' && league.standings[team.id]?.gp ? <TeamUnderCoach league={league} teamId={team.id} /> : null}
          <Card title={<h3>Strengths and weaknesses</h3>}>
            <div className="stack" style={{ gap: 6 }}>
              {strengths.map((s) => (
                <div key={s.key}>
                  <span className="pill good">▲ {s.label}</span> <span className="muted" style={{ fontSize: 12 }}>{s.detail}</span>
                </div>
              ))}
              {weaknesses.map((s) => (
                <div key={s.key}>
                  <span className="pill bad">▼ {s.label}</span> <span className="muted" style={{ fontSize: 12 }}>{s.detail}</span>
                </div>
              ))}
            </div>
          </Card>
          <Card title={<h3>Ratings</h3>}>
            <CoachRatingBars c={c} />
          </Card>
          <Card title={<h3>Honours</h3>}>
            {c.awards?.length ? (
              <div className="stack" style={{ gap: 4 }}>
                {[...c.awards].reverse().map((a, i) => (
                  <div key={i} className="row">
                    <span className={`pill ${a.award === 'Stanley Cup' ? 'accent' : ''}`}>{a.award}</span>
                    <span className="muted">{seasonLabel(a.season)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <span className="muted">None yet.</span>
            )}
            {c.background && <div className="dim" style={{ fontSize: 11, marginTop: 8 }}>{c.background}</div>}
          </Card>
        </div>
      </div>
    </>
  );
}

/** How his team plays this season, measured against the league (where a coach's strengths show up). */
function TeamUnderCoach({ league, teamId }: { league: League; teamId: number }) {
  const recs = league.teams.map((t) => league.standings[t.id]).filter((r) => r?.gp);
  const r = league.standings[teamId];
  const stats: { k: string; v: (x: typeof r) => number; fmt: (v: number) => string; low?: boolean }[] = [
    { k: 'Goals for / game', v: (x) => x.gf / x.gp, fmt: (v) => v.toFixed(2) },
    { k: 'Goals against / game', v: (x) => x.ga / x.gp, fmt: (v) => v.toFixed(2), low: true },
    { k: 'Power play', v: (x) => (x.ppOpp ? x.ppg / x.ppOpp : 0), fmt: (v) => `${(v * 100).toFixed(1)}%` },
    { k: 'Penalty kill', v: (x) => (x.tsh ? 1 - x.ppga / x.tsh : 0), fmt: (v) => `${(v * 100).toFixed(1)}%` },
    { k: 'Penalty minutes / game', v: (x) => x.pim / x.gp, fmt: (v) => v.toFixed(1), low: true },
    { k: 'Shots for / game', v: (x) => x.sf / x.gp, fmt: (v) => v.toFixed(1) },
  ];
  const ord = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;
  return (
    <Card title={<h3>His team this season</h3>}>
      <div className="stack" style={{ gap: 4, fontSize: 12 }}>
        {stats.map((s) => {
          const mine = s.v(r);
          const rank = 1 + recs.filter((x) => (s.low ? s.v(x) < mine : s.v(x) > mine)).length;
          return (
            <div key={s.k} className="row">
              <span className="muted" style={{ flex: 1 }}>{s.k}</span>
              <b>{s.fmt(mine)}</b>
              <span className={rank <= 8 ? 'pill good' : rank > recs.length - 8 ? 'pill bad' : 'pill'} style={{ minWidth: 38, textAlign: 'center' }}>{ord(rank)}</span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
