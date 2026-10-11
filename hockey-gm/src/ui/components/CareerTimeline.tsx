import { useMemo } from 'react';
import type { League, Player, StatLine, TimelineEvent } from '../../engine/types';
import { careerTimeline, type CareerRow } from '../../engine/player/career';
import { points, savePct } from '../../engine/core/statline';
import { Card, TeamLogo } from './common';
import { seasonLabel } from '../format';
import { playerOvr } from '../menu/exhibition';
import { href } from '../router';

const ICON: Record<string, string> = {
  draft: '🎯',
  signing: '✍',
  extension: '✍',
  elc: '✍',
  arbitration: '⚖',
  offerSheet: '📄',
  trade: '⇄',
  waiverClaim: '⤵',
  release: '✂',
  buyout: '✂',
  termination: '✂',
  retirement: '🏁',
  milestone: '★',
  record: '📈',
};

const line = (p: Player, s: StatLine) => (p.pos === 'G' ? `${s.gp} GP · ${s.w}-${s.l}-${s.otl} · ${s.sa ? savePct(s).toFixed(3).replace(/^0/, '') : '—'} SV% · ${s.so} SO` : `${s.gp} GP · ${s.g} G · ${s.a1 + s.a2} A · ${points(s)} P · ${s.pm > 0 ? '+' : ''}${s.pm}`);

/** Points (or wins) per season as bars, with the player's rating as a line on its own scale. */
function CareerArc({ p, rows }: { p: Player; rows: CareerRow[] }) {
  const data = rows.filter((r) => r.reg || r.ca !== undefined);
  if (data.length < 2) return null;
  const g = p.pos === 'G';
  const val = (r: CareerRow) => (r.reg ? (g ? r.reg.w : points(r.reg)) : 0);
  const maxV = Math.max(1, ...data.map(val));
  const ovr = data.map((r) => (r.ca !== undefined ? playerOvr(r.ca) : null));
  const known = ovr.filter((x): x is number => x !== null);
  const lo = Math.min(...known, 60) - 3;
  const hi = Math.max(...known, 80) + 3;
  const W = data.length * 56;
  const H = 150;
  const bw = W / data.length;
  const y = (o: number) => H - ((o - lo) / (hi - lo)) * (H - 10) - 4;
  const pts = ovr.map((o, i) => (o === null ? null : `${i * bw + bw / 2},${y(o)}`)).filter(Boolean);
  return (
    <div className="career-arc">
      <svg viewBox={`0 0 ${W} ${H + 20}`} style={{ width: '100%', maxWidth: W * 1.6 }} role="img" aria-label="Career arc">
        {data.map((r, i) => {
          const h = (val(r) / maxV) * (H - 14);
          return (
            <g key={r.season}>
              <rect x={i * bw + bw * 0.18} y={H - h} width={bw * 0.64} height={h} rx={3} className={r.current ? 'arc-bar cur' : 'arc-bar'}>
                <title>{`${seasonLabel(r.season)}: ${val(r)} ${g ? 'wins' : 'points'}${r.current ? ' (in progress)' : ''}`}</title>
              </rect>
              {val(r) > 0 && (
                <text x={i * bw + bw / 2} y={H - h - 3} textAnchor="middle" className="arc-num">
                  {val(r)}
                </text>
              )}
              <text x={i * bw + bw / 2} y={H + 14} textAnchor="middle" className="arc-lbl">
                {`'${String(r.season + 1).slice(2)}`}
              </text>
            </g>
          );
        })}
        {pts.length > 1 && <polyline points={pts.join(' ')} className="arc-line" />}
        {ovr.map((o, i) =>
          o === null ? null : (
            <circle key={i} cx={i * bw + bw / 2} cy={y(o)} r={3.5} className="arc-dot">
              <title>{`${seasonLabel(data[i].season)}: ${o} overall`}</title>
            </circle>
          ),
        )}
      </svg>
      <div className="row muted" style={{ gap: 14, fontSize: 11 }}>
        <span>
          <i className="arc-key bar" /> {g ? 'Wins' : 'Points'}
        </span>
        {known.length > 0 && (
          <span>
            <i className="arc-key line" /> Overall rating at season end
          </span>
        )}
      </div>
    </div>
  );
}

function EventLine({ league, e }: { league: League; e: TimelineEvent }) {
  const team = e.teamIds?.length === 1 ? league.teams[e.teamIds[0]] : undefined;
  return (
    <li className={`tl-ev k-${e.kind}`}>
      <span className="tl-ico">{ICON[e.kind] ?? '•'}</span>
      {team && <TeamLogo team={team} size={14} />}
      <span>{e.text}</span>
    </li>
  );
}

/** The whole career: summary, arc, and every season with what happened in it. */
export function CareerTimeline({ league, p, version, ratings }: { league: League; p: Player; version: number; ratings: boolean }) {
  const data = useMemo(() => careerTimeline(league, p), [league, p, version]); // eslint-disable-line react-hooks/exhaustive-deps
  // Rating history is exact: only shown where the scouting picture is too.
  const rows = ratings ? data.rows : data.rows.map((r) => ({ ...r, ca: undefined }));
  const { summary, before } = data;
  const g = p.pos === 'G';
  const s = summary.reg;
  return (
    <div className="stack" style={{ gap: 14 }}>
      <Card title="Career at a glance">
        <div className="career-sum">
          <div>
            <b>{summary.seasons}</b>
            <span className="muted">season{summary.seasons === 1 ? '' : 's'}</span>
          </div>
          <div>
            <b>{s.gp}</b>
            <span className="muted">games</span>
          </div>
          {g ? (
            <>
              <div>
                <b>{s.w}</b>
                <span className="muted">wins</span>
              </div>
              <div>
                <b>{s.sa ? savePct(s).toFixed(3).replace(/^0/, '') : '—'}</b>
                <span className="muted">SV%</span>
              </div>
              <div>
                <b>{s.so}</b>
                <span className="muted">shutouts</span>
              </div>
            </>
          ) : (
            <>
              <div>
                <b>{s.g}</b>
                <span className="muted">goals</span>
              </div>
              <div>
                <b>{s.a1 + s.a2}</b>
                <span className="muted">assists</span>
              </div>
              <div>
                <b>{points(s)}</b>
                <span className="muted">points</span>
              </div>
            </>
          )}
          <div>
            <b>{summary.po.gp}</b>
            <span className="muted">playoff games{summary.po.gp ? ` · ${g ? `${summary.po.w} W` : `${points(summary.po)} P`}` : ''}</span>
          </div>
          {summary.cups.length > 0 && (
            <div>
              <b className="gold">{'♛'.repeat(Math.min(5, summary.cups.length))}</b>
              <span className="muted">
                {summary.cups.length} title{summary.cups.length > 1 ? 's' : ''} ({summary.cups.map((c) => c + 1).join(', ')})
              </span>
            </div>
          )}
        </div>
        <div className="stack" style={{ gap: 6, marginTop: 10 }}>
          {summary.teams.length > 0 && (
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              {summary.teams.map((t, i) => (
                <a key={i} className="pill" href={href(`team/${t.teamId}`)}>
                  <TeamLogo team={league.teams[t.teamId]} size={14} /> {league.teams[t.teamId].abbr} {t.from === t.to ? seasonLabel(t.from) : `${t.from}–${String(t.to + 1).slice(2)}`}
                </a>
              ))}
            </div>
          )}
          {summary.best && (
            <span>
              Best season: <b>{seasonLabel(summary.best.season)}</b> — {summary.best.label}
            </span>
          )}
          {ratings && summary.peakCa && (
            <span>
              Peak rating: <b>{playerOvr(summary.peakCa.ca)}</b> overall ({seasonLabel(summary.peakCa.season)})
            </span>
          )}
          {summary.awards.length > 0 && (
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              {summary.awards.map((a) => (
                <span key={a.award} className="pill gold" title={a.seasons.map(seasonLabel).join(', ')}>
                  🏆 {a.award.split(' (')[0]}
                  {a.count > 1 ? ` ×${a.count}` : ''}
                </span>
              ))}
            </div>
          )}
          {summary.injuryDays > 0 && <span className="muted">Days lost to injury: {summary.injuryDays}</span>}
          <span className="dim" style={{ fontSize: 11 }}>
            Counts what this save has recorded{before.nhlGamesBefore ? `; he had ${before.nhlGamesBefore} NHL games before it began, not broken down here` : ''}.
          </span>
        </div>
      </Card>
      {rows.length >= 2 && (
        <Card title="Career arc">
          <CareerArc p={p} rows={rows} />
        </Card>
      )}
      <Card title="Timeline">
        <ol className="timeline">
          {(before.draft || before.junior) && (
            <li className="tl-season pre">
              <div className="tl-head">
                <b>Before this save</b>
              </div>
              <ul className="tl-evs">
                {before.junior && <li className="tl-ev"><span className="tl-ico">🏒</span> Junior: {before.junior}</li>}
                {before.draft && <li className="tl-ev k-draft"><span className="tl-ico">🎯</span> {before.draft}</li>}
              </ul>
            </li>
          )}
          {rows.map((r) => (
            <li key={r.season} className={`tl-season${r.current ? ' cur' : ''}`}>
              <div className="tl-head">
                <b>{seasonLabel(r.season)}</b>
                <span className="muted">Age {r.age}</span>
                {r.teamId !== null && (
                  <span className="row" style={{ gap: 4 }}>
                    <TeamLogo team={league.teams[r.teamId]} size={16} /> {league.teams[r.teamId].abbr}
                  </span>
                )}
                {r.ca !== undefined && <span className="pill">{playerOvr(r.ca)} OVR</span>}
                {r.current && <span className="pill">In progress</span>}
              </div>
              {r.reg && <div className="tl-line">{line(p, r.reg)}</div>}
              {r.po && <div className="tl-line muted">Playoffs: {line(p, r.po)}</div>}
              {(r.awards.length > 0 || r.injuries.length > 0 || r.events.length > 0) && (
                <ul className="tl-evs">
                  {r.awards.map((a) => (
                    <li key={a} className="tl-ev k-award">
                      <span className="tl-ico">{a.endsWith('Champion') ? '♛' : '🏆'}</span> {a.split(' (')[0]}
                    </li>
                  ))}
                  {r.events.map((e, i) => (
                    <EventLine key={i} league={league} e={e} />
                  ))}
                  {r.injuries
                    .filter((i) => i.days >= 7)
                    .map((i, k) => (
                      <li key={`inj${k}`} className="tl-ev k-injury">
                        <span className="tl-ico">✚</span> {i.type} ({i.bodyPart}), out {i.days} days
                      </li>
                    ))}
                </ul>
              )}
            </li>
          ))}
          {!rows.length && <li className="muted">No NHL seasons in this save yet.</li>}
        </ol>
      </Card>
    </div>
  );
}
